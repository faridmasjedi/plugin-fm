import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  backupStateAt,
  baseUsername,
  defaultMasking,
  fieldPlan,
  gatherRows,
  loadOrder,
  loadRecords,
  maskValue,
  memorySink,
  orgMaps,
  planMigration,
  previewRestore,
  restoreDeleted,
  restoreValues,
  runMigration,
  sameValue,
  transformRow,
  undoLoad,
  type DataField,
  type HttpRequest,
} from '../src/index.js';

const f = (name: string, type = 'string', extra: Partial<DataField> = {}): DataField => ({
  name,
  label: name,
  type,
  referenceTo: [],
  createable: true,
  updateable: true,
  calculated: false,
  externalId: false,
  nillable: true,
  defaultedOnCreate: false,
  unique: false,
  ...extra,
});
const ref = (name: string, to: string[], extra: Partial<DataField> = {}) =>
  f(name, 'reference', { referenceTo: to, ...extra });

const schemas: Record<string, DataField[]> = {
  Account: [
    f('Id', 'id'),
    f('Name'),
    ref('ParentId', ['Account']),
    ref('OwnerId', ['User']),
    ref('RecordTypeId', ['RecordType']),
    ref('Primary_Contact__c', ['Contact']),
    f('SystemModstamp', 'datetime', { createable: false }),
  ],
  Contact: [
    f('Id', 'id'),
    f('LastName', 'string', { nillable: false }),
    f('FirstName'),
    f('Email', 'email'),
    f('Phone', 'phone'),
    ref('AccountId', ['Account']),
    ref('OwnerId', ['User', 'Group']),
  ],
  Opportunity: [
    f('Id', 'id'),
    f('Name'),
    ref('AccountId', ['Account'], { nillable: false }),
    f('Amount', 'currency'),
    f('IsPrivate', 'boolean'),
    f('Score__c', 'double', { createable: false, calculated: true }),
  ],
};

describe('load order', () => {
  it('puts parents first, defers self lookups and breaks circles at an optional lookup', () => {
    const { order, deferred } = loadOrder(['Opportunity', 'Contact', 'Account'], schemas);
    // Account <-> Contact is a circle; Account.Primary_Contact__c is optional, so Account goes first
    expect(order[0]).toBe('Account');
    expect([...order].sort()).toEqual(['Account', 'Contact', 'Opportunity']);
    expect(deferred.Account.sort()).toEqual(['ParentId', 'Primary_Contact__c']);
    expect(deferred.Contact).toBeUndefined();
  });

  it('plans the fields: writable in the target, missing, read-only', () => {
    const plan = fieldPlan({
      source: schemas.Opportunity,
      target: schemas.Opportunity.filter((x) => x.name !== 'Amount'),
    });
    expect(plan).toEqual({ write: ['Name', 'AccountId', 'IsPrivate'], missing: ['Amount'], readOnly: ['Score__c'] });
  });
});

describe('transforming rows', () => {
  it('maps lookups, owners, record types; masks; leaves out empty values', () => {
    const ids = new Map([['001S1', '001T1']]);
    const maps = {
      users: new Map([['005S1', '005T1']]),
      recordTypes: new Map([['012S1', '012T1']]),
      queues: new Map([['00GS1', '00GT1']]),
      defaultOwner: '005DEF',
    };
    const load = {
      name: 'Contact',
      source: schemas.Contact,
      target: schemas.Contact,
      mask: defaultMasking(schemas.Contact),
    };
    expect(load.mask).toEqual({ FirstName: 'name', LastName: 'name', Email: 'email', Phone: 'phone' });
    const row = {
      Id: '003S1',
      LastName: 'Doe',
      FirstName: '',
      Email: 'jane@acme.com',
      Phone: '123',
      AccountId: '001S1',
      OwnerId: '00GS1',
    };
    const t = transformRow(row, load, ['LastName', 'FirstName', 'Email', 'Phone', 'AccountId', 'OwnerId'], [], {
      ids,
      maps,
      keepUnmapped: false,
    });
    expect(t.record).toEqual({
      LastName: maskValue('name', 'Doe'),
      Email: maskValue('email', 'jane@acme.com'),
      Phone: maskValue('phone', '123'),
      AccountId: '001T1',
      OwnerId: '00GT1',
    });
    expect(String(t.record.Email)).toMatch(/@example\.invalid$/);
    // Same value, same fake value
    expect(maskValue('email', 'jane@acme.com')).toBe(maskValue('email', 'jane@acme.com'));
    // Unknown owner -> default owner; unknown lookup dropped (or kept in the same org)
    const other = transformRow(
      { Id: '003S2', LastName: 'X', AccountId: '001S9', OwnerId: '005S9' },
      { ...load, mask: {} },
      ['LastName', 'AccountId', 'OwnerId'],
      [],
      { ids, maps, keepUnmapped: false }
    );
    expect(other.record).toEqual({ LastName: 'X', OwnerId: '005DEF' });
    expect(other.dropped).toEqual(['AccountId']);
    const same = transformRow(
      { Id: '003S2', LastName: 'X', AccountId: '001S9' },
      { ...load, mask: {} },
      ['LastName', 'AccountId'],
      [],
      { ids, maps, keepUnmapped: true }
    );
    expect(same.record.AccountId).toBe('001S9');
  });

  it('normalizes sandbox usernames and compares values across formats', () => {
    expect(baseUsername('Ann@Acme.com.uat', true)).toBe('ann@acme.com');
    expect(baseUsername('ann@acme.com', false)).toBe('ann@acme.com');
    expect(sameValue('100.0', '100')).toBe(true);
    expect(sameValue('2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000+0000')).toBe(true);
    expect(sameValue('true', 'true')).toBe(true);
    expect(sameValue('', 'x')).toBe(false);
    expect(sameValue('12 Main St', '12 Main Street')).toBe(false);
  });
});

/** A fake org that stores records and answers sObject Collections, queries and undelete. */
function fakeOrg(prefix: string, seed: Record<string, Array<Record<string, unknown>>> = {}) {
  const records = new Map<string, Record<string, unknown> & { type: string }>();
  const recycle = new Map<string, Record<string, unknown> & { type: string }>();
  for (const [type, list] of Object.entries(seed)) for (const r of list) records.set(String(r.Id), { ...r, type });
  let n = 0;
  const calls: string[] = [];
  const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const path = decodeURIComponent(r.path).replace(/\+/g, ' ');
    if (path.endsWith('/composite/sobjects') && r.method === 'POST') {
      const body = JSON.parse(r.body ?? '{}') as {
        records: Array<Record<string, unknown> & { attributes: { type: string } }>;
      };
      calls.push(`create ${body.records[0]?.attributes.type} ${body.records.length}`);
      return json(
        body.records.map((rec) => {
          if (rec.attributes.type === 'Opportunity' && !rec.AccountId)
            return {
              success: false,
              errors: [
                { statusCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing', fields: ['AccountId'] },
              ],
            };
          const id = `${prefix}${rec.attributes.type.slice(0, 3)}${String(++n).padStart(12, '0')}`;
          const { attributes, ...fields } = rec;
          records.set(id, { ...fields, Id: id, type: attributes.type });
          return { id, success: true, errors: [] };
        })
      );
    }
    if (path.endsWith('/composite/sobjects') && r.method === 'PATCH') {
      const body = JSON.parse(r.body ?? '{}') as { records: Array<Record<string, unknown>> };
      calls.push(`update ${body.records.length}`);
      return json(
        body.records.map((rec) => {
          const existing = records.get(String(rec.Id));
          if (!existing)
            return { success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'entity is deleted' }] };
          const { attributes: _a, ...fields } = rec;
          Object.assign(existing, fields);
          return { id: rec.Id, success: true, errors: [] };
        })
      );
    }
    if (path.includes('/composite/sobjects?') && r.method === 'DELETE') {
      const ids = /ids=([^&]+)/.exec(path)![1].split(',');
      calls.push(`delete ${ids.length}`);
      return json(
        ids.map((id) =>
          records.delete(id)
            ? { id, success: true }
            : { id, success: false, errors: [{ statusCode: 'X', message: 'not found' }] }
        )
      );
    }
    if (r.path.includes('/Soap/u/') && (r.body ?? '').includes('<urn:undelete>')) {
      const ids = [...(r.body ?? '').matchAll(/<urn:ids>(\w+)<\/urn:ids>/g)].map((m) => m[1]);
      return {
        status: 200,
        headers: {},
        body: ids
          .map((id) => {
            const rec = recycle.get(id);
            if (rec) {
              recycle.delete(id);
              records.set(id, rec);
              return `<result><id>${id}</id><success>true</success></result>`;
            }
            return `<result><id>${id}</id><success>false</success><errors><message>not in recycle bin</message></errors></result>`;
          })
          .join(''),
      };
    }
    if (path.includes('/query') && path.includes('q=')) {
      const soql = path.split('q=')[1];
      if (soql.startsWith('SELECT Id, Username')) return json({ totalSize: 2, done: true, records: seed.User ?? [] });
      if (soql.includes('FROM RecordType')) return json({ totalSize: 0, done: true, records: seed.RecordType ?? [] });
      if (soql.includes("FROM Group WHERE Type = 'Queue'")) return json({ totalSize: 0, done: true, records: [] });
      const ids = [...soql.matchAll(/'(\w+)'/g)].map((m) => m[1]);
      const fields = /SELECT (.+?) FROM/.exec(soql)![1].split(', ');
      const pool = soql.includes('IsDeleted = true') ? recycle : records;
      const found = ids.map((id) => pool.get(id)).filter(Boolean) as Array<Record<string, unknown>>;
      return json({
        totalSize: found.length,
        done: true,
        records: found.map((rec) =>
          Object.fromEntries([['attributes', {}], ...fields.map((x) => [x, rec[x] ?? null])])
        ),
      });
    }
    return { status: 404, headers: {}, body: '[]' };
  }, '62.0');
  return { client, records, recycle, calls };
}

describe('loading records', () => {
  const rows = {
    Account: [
      { Id: '001S1', Name: 'Parent', ParentId: '', OwnerId: '005S1', Primary_Contact__c: '003S1' },
      { Id: '001S2', Name: 'Child', ParentId: '001S1', OwnerId: '005S9', Primary_Contact__c: '' },
    ],
    Contact: [{ Id: '003S1', LastName: 'Doe', AccountId: '001S2', OwnerId: '005S1' }],
    Opportunity: [
      { Id: '006S1', Name: 'Deal', AccountId: '001S1', Amount: '100.0', IsPrivate: 'false' },
      { Id: '006S2', Name: 'Orphan', AccountId: '001S404', Amount: '', IsPrivate: '' },
    ],
  };
  const loads = Object.keys(schemas).map((name) => ({ name, source: schemas[name], target: schemas[name] }));

  it('creates parents first, rewires lookups, links self and circular lookups in a second pass, and undoes', async () => {
    const target = fakeOrg('T');
    const steps: string[] = [];
    const result = await loadRecords(target.client, loads, rows, {
      maps: { users: new Map([['005S1', '005T1']]), recordTypes: new Map(), queues: new Map(), defaultOwner: '005DEF' },
      onProgress: (s) => steps.push(`${s.object}:${s.phase}`),
    });
    const t = (id: string) => target.records.get(result.ids[id])!;
    expect(t('001S1')).toMatchObject({ Name: 'Parent', OwnerId: '005T1' });
    expect(t('001S1').ParentId).toBeUndefined();
    expect(t('001S2')).toMatchObject({ Name: 'Child', OwnerId: '005DEF', ParentId: result.ids['001S1'] });
    expect(t('003S1')).toMatchObject({ AccountId: result.ids['001S2'] });
    expect(t('001S1').Primary_Contact__c).toBe(result.ids['003S1']);
    expect(t('006S1')).toMatchObject({ AccountId: result.ids['001S1'], Amount: '100.0', IsPrivate: false });
    expect(result.objects.map((o) => [o.name, o.created, o.failed])).toEqual([
      ['Account', 2, 0],
      ['Contact', 1, 0],
      ['Opportunity', 1, 1],
    ]);
    expect(result.failures).toEqual([
      {
        object: 'Opportunity',
        sourceId: '006S2',
        error: 'REQUIRED_FIELD_MISSING: Required fields are missing (AccountId)',
      },
    ]);
    expect(result.objects[2].dropped).toEqual({ AccountId: 1 });
    expect(steps).toContain('Account:linking');
    expect(result.created.map((c) => c.object)).toEqual(['Opportunity', 'Contact', 'Account']);

    // Run again with the Id map: updates, no duplicates
    const again = await loadRecords(
      target.client,
      loads,
      { Account: [{ ...rows.Account[0], Name: 'Parent v2' }] },
      {
        maps: { users: new Map(), recordTypes: new Map(), queues: new Map() },
        known: result.ids,
      }
    );
    expect(again.objects[0]).toMatchObject({ created: 0, updated: 1 });
    expect(t('001S1').Name).toBe('Parent v2');

    const undo = await undoLoad(target.client, result.created);
    expect(undo).toEqual({ deleted: 4, failed: [] });
    expect(target.records.size).toBe(0);
  });

  it('matches users by username across sandboxes', async () => {
    const source = fakeOrg('S', {
      User: [{ attributes: {}, Id: '005S1', Username: 'ann@acme.com.dev', IsActive: true }],
    });
    const target = fakeOrg('T', {
      User: [
        { attributes: {}, Id: '005T1', Username: 'ann@acme.com.uat', IsActive: true },
        { attributes: {}, Id: '005T2', Username: 'bob@acme.com.uat', IsActive: false },
      ],
    });
    const maps = await orgMaps(source.client, target.client, { sourceSandbox: true, targetSandbox: true });
    expect([...maps.users]).toEqual([['005S1', '005T1']]);
  });
});

describe('migration plan and seeding', () => {
  it('plans with masking and gathers only related records from a backup', async () => {
    const both = Object.fromEntries(Object.entries(schemas).map(([n, s]) => [n, { source: s, target: s }]));
    const plan = planMigration(
      [
        { name: 'Opportunity', relatedOnly: true },
        { name: 'Account', where: "Name = 'Parent'" },
        { name: 'Contact', relatedOnly: true, fields: { mode: 'except', fields: ['Phone'] } },
        { name: 'Ghost__c' },
      ],
      { ...both, Ghost__c: { source: [f('Id', 'id')], target: [] } },
      { mask: true, maskOverrides: { Contact: { Email: 'none' } } }
    );
    expect(plan.missingObjects).toEqual(['Ghost__c']);
    expect(plan.order[0]).toBe('Account');
    expect([...plan.order].sort()).toEqual(['Account', 'Contact', 'Opportunity']);
    const contact = plan.objects.find((o) => o.name === 'Contact')!;
    expect(contact.read).not.toContain('Phone');
    expect(contact.mask).toEqual({ LastName: 'name', FirstName: 'name' });
    expect(contact.links).toEqual([{ field: 'AccountId', to: 'Account' }]);

    const backupRows = {
      Account: new Map([['001S1', { Id: '001S1', Name: 'Parent' }]]),
      Contact: new Map([
        ['003S1', { Id: '003S1', LastName: 'Doe', AccountId: '001S1' }],
        ['003S2', { Id: '003S2', LastName: 'Other', AccountId: '001S9' }],
      ]),
      Opportunity: new Map([['006S1', { Id: '006S1', Name: 'Deal', AccountId: '001S1' }]]),
    };
    const gathered = await gatherRows({ kind: 'backup', rows: backupRows }, plan);
    expect(gathered.Contact.map((r) => r.Id)).toEqual(['003S1']);
    expect(gathered.Opportunity.map((r) => r.Id)).toEqual(['006S1']);

    const target = fakeOrg('T');
    const result = await runMigration(target.client, plan, gathered, {
      maps: { users: new Map(), recordTypes: new Map(), queues: new Map() },
    });
    expect(result.objects.map((o) => o.created)).toEqual([1, 1, 1]);
    const contactRecord = target.records.get(result.ids['003S1'])!;
    expect(contactRecord.LastName).not.toBe('Doe');
  });
});

describe('restore', () => {
  async function backupWithRuns() {
    const sink = memorySink();
    const job = { id: 'b1', name: 'Nightly' };
    const root = 'Nightly-b1';
    const schema = {
      Account: [
        f('Id', 'id'),
        f('Name'),
        f('Phone', 'phone'),
        ref('ParentId', ['Account']),
        f('SystemModstamp', 'datetime', { createable: false, updateable: false }),
      ],
    };
    const manifest = (folder: string, kind: string, files: string[]) =>
      sink.write(
        `${root}/${folder}/manifest.json`,
        JSON.stringify({
          format: 1,
          kind,
          finishedAt: folder,
          schema,
          objects: [{ name: 'Account', files, rows: 0, deleted: 0, fields: [] }],
        })
      );
    await sink.write(
      `${root}/r1/Account/part-0001.csv`,
      'Id,Name,Phone,ParentId,SystemModstamp\n001A00000000001,Acme,111,,2026\n001A00000000002,Globex,222,001A00000000001,2026\n001A00000000003,Initech,333,,2026\n'
    );
    await manifest('r1', 'full', ['Account/part-0001.csv']);
    await sink.write(
      `${root}/r2/Account/part-0001.csv`,
      'Id,Name,Phone,ParentId,SystemModstamp\n001A00000000001,Acme Corp,111,,2026\n'
    );
    await sink.write(`${root}/r2/Account/deleted.csv`, 'Id,SystemModstamp\n001A00000000003,2026\n');
    await manifest('r2', 'incremental', ['Account/part-0001.csv', 'Account/deleted.csv']);
    await sink.write(
      `${root}/backups.json`,
      JSON.stringify({
        job,
        runs: [
          { folder: 'r1', kind: 'full', finishedAt: 'r1', rows: 3, failed: 0 },
          { folder: 'r2', kind: 'incremental', finishedAt: 'r2', rows: 1, failed: 0 },
        ],
      })
    );
    return { sink, job, schema };
  }

  it('rebuilds the records as they were at a run', async () => {
    const { sink, job } = await backupWithRuns();
    const atR1 = await backupStateAt(sink, job, 'r1');
    expect([...atR1.rows.Account.keys()]).toHaveLength(3);
    const atR2 = await backupStateAt(sink, job, 'r2');
    expect(atR2.runs).toEqual(['r1', 'r2']);
    expect([...atR2.rows.Account.values()].map((r) => r.Name)).toEqual(['Acme Corp', 'Globex']);
  });

  it('previews against the org, puts back values and brings back deleted records', async () => {
    const { sink, job, schema } = await backupWithRuns();
    const state = await backupStateAt(sink, job, 'r1');
    // Now: Acme renamed and its phone cleared; Globex deleted (in the bin); Initech gone for good
    const org = fakeOrg('T', { Account: [{ Id: '001A00000000001', Name: 'Acme Inc', Phone: null }] });
    org.recycle.set('001A00000000002', { Id: '001A00000000002', Name: 'Globex', type: 'Account' });
    const preview = await previewRestore(org.client, state, 'Account', schema.Account);
    expect(preview.fields).toEqual(['Name', 'Phone', 'ParentId']);
    expect(preview.changed).toEqual([
      {
        id: '001A00000000001',
        changes: [
          { field: 'Name', backup: 'Acme', now: 'Acme Inc' },
          { field: 'Phone', backup: '111', now: '' },
        ],
      },
    ]);
    expect(preview.deleted).toEqual([
      { id: '001A00000000002', inRecycleBin: true },
      { id: '001A00000000003', inRecycleBin: false },
    ]);

    const put = await restoreValues(
      org.client,
      'Account',
      [{ id: '001A00000000001', fields: { Name: 'Acme', Phone: '111' } }],
      schema.Account
    );
    expect(put).toEqual({ updated: 1, failures: [] });
    expect(org.records.get('001A00000000001')).toMatchObject({ Name: 'Acme', Phone: '111' });

    const back = await restoreDeleted(org.client, state, { Account: preview.deleted }, schema);
    expect(back.undeleted).toBe(1);
    expect(org.records.has('001A00000000002')).toBe(true);
    // Initech is created again with a new Id
    expect(back.load!.objects[0]).toMatchObject({ created: 1 });
    const newId = back.load!.ids['001A00000000003'];
    expect(org.records.get(newId)).toMatchObject({ Name: 'Initech', Phone: '333' });
  });
});
