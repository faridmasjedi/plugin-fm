import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  OLD_ID_FIELD,
  SalesforceClient,
  ensureOldIdFields,
  loadWithOldIds,
  oldIdFieldPackage,
  parseCsv,
  removeOldIdFields,
  toCsv,
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
const ref = (name: string, to: string[]) => f(name, 'reference', { referenceTo: to });
const SCHEMA: Record<string, DataField[]> = {
  Account: [f('Id', 'id'), f('Name'), ref('ParentId', ['Account'])],
  Case: [f('Id', 'id'), f('Subject'), ref('AccountId', ['Account']), ref('ParentId', ['Case'])],
  Task: [f('Id', 'id'), f('Subject'), ref('WhatId', ['Account', 'Case'])],
};

const unzipList = (b64: string): string[] => {
  const dir = mkdtempSync(join(tmpdir(), 'nsf-oldids-'));
  try {
    writeFileSync(join(dir, 'p.zip'), Buffer.from(b64, 'base64'));
    return execFileSync('unzip', ['-Z1', join(dir, 'p.zip')])
      .toString()
      .trim()
      .split('\n')
      .sort();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const unzipFile = (b64: string, name: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'nsf-oldids-'));
  try {
    writeFileSync(join(dir, 'p.zip'), Buffer.from(b64, 'base64'));
    execFileSync('unzip', ['-q', join(dir, 'p.zip'), name, '-d', dir]);
    return readFileSync(join(dir, name), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** A fake org with metadata deploys (the old-Id field appears after one) and Bulk API 2.0 upserts. */
function bulkOrg() {
  const records = new Map<string, Record<string, string> & { type: string }>();
  const fields = new Set<string>(); // "Account.NomadSF_Old_Id__c" once deployed
  const deploys: string[] = [];
  const jobs = new Map<
    string,
    { object: string; operation: string; ext?: string; csv?: string; ok?: string; failed?: string; query?: string }
  >();
  let n = 0;
  let assigned = false;
  const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
  const xml = (body: string) => ({ status: 200, headers: {}, body });
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const path = decodeURIComponent(r.path).replace(/\+/g, ' ');
    const body = r.body ?? '';
    const desc = /\/sobjects\/(\w+)\/describe/.exec(path);
    if (desc) {
      const extra = fields.has(`${desc[1]}.${OLD_ID_FIELD}`)
        ? [f(OLD_ID_FIELD, 'string', { externalId: true, unique: true, createable: assigned, updateable: assigned })]
        : [];
      return json({ fields: [...(SCHEMA[desc[1]] ?? []), ...extra] });
    }
    if (path.includes('/tooling/query'))
      return json({
        totalSize: 3,
        done: true,
        records: Object.keys(SCHEMA).map((o) => ({
          attributes: {},
          QualifiedApiName: o,
          IsCustomizable: o !== 'Task',
        })),
      });
    if (body.includes('<met:deploy>')) {
      const zip = /<met:ZipFile>([^<]+)/.exec(body)![1];
      const files = unzipList(zip);
      deploys.push(files.join(','));
      if (files.includes('destructiveChanges.xml')) {
        const destructive = unzipFile(zip, 'destructiveChanges.xml');
        for (const m of destructive.matchAll(/<members>([\w.]+)<\/members>/g)) fields.delete(m[1]);
      } else
        for (const file of files.filter((x) => x.startsWith('objects/')))
          fields.add(`${file.slice(8, -7)}.${OLD_ID_FIELD}`);
      return xml('<result><id>0Af000000000001AAA</id></result>');
    }
    if (body.includes('checkDeployStatus'))
      return xml(
        '<result><id>0Af000000000001AAA</id><done>true</done><status>Succeeded</status><success>true</success><details></details></result>'
      );
    if (path.includes('/query') && path.includes('q=')) {
      const soql = path.split('q=')[1];
      if (soql.includes('FROM PermissionSetAssignment WHERE PermissionSetId'))
        return json({ totalSize: 0, done: true, records: [] });
      if (soql.includes('FROM PermissionSetAssignment'))
        return json({ totalSize: 1, done: true, records: [{ attributes: {}, Id: '0PaA00000000001AAA' }] });
      if (soql.includes('FROM PermissionSet'))
        return json({ totalSize: 1, done: true, records: [{ attributes: {}, Id: '0PSA00000000001AAA' }] });
      return json({ totalSize: 0, done: true, records: [] });
    }
    if (path.endsWith('/sobjects/PermissionSetAssignment') && r.method === 'POST') {
      assigned = true;
      return json({ id: '0PaA00000000001AAA', success: true });
    }
    if (path.includes('/composite/sobjects?') && r.method === 'DELETE')
      return json([{ id: '0PaA00000000001AAA', success: true }]);
    if (path.includes('/Soap/u/'))
      return xml(
        '<result><userId>005A00000000001AAA</userId><organizationId>00DA00000000001</organizationId></result>'
      );
    // Bulk API 2.0 ingest
    if (path.endsWith('/jobs/ingest') && r.method === 'POST') {
      const b = JSON.parse(body) as { object: string; operation: string; externalIdFieldName?: string };
      const id = `750${String(++n).padStart(12, '0')}`;
      jobs.set(id, { object: b.object, operation: b.operation, ext: b.externalIdFieldName });
      return json({ id, state: 'Open' });
    }
    const batches = /\/jobs\/ingest\/(\w+)\/batches/.exec(path);
    if (batches && r.method === 'PUT') {
      const job = jobs.get(batches[1])!;
      const table = parseCsv(body);
      const ok: Array<Record<string, string>> = [];
      const failed: Array<Record<string, string>> = [];
      for (const row of table.rows) {
        if (job.object === 'Case' && row.Subject === 'Rejected') {
          failed.push({ sf__Id: '', sf__Error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION:Not allowed', ...row });
          continue;
        }
        const existing = [...records.values()].find(
          (x) => x.type === job.object && x[OLD_ID_FIELD] === row[OLD_ID_FIELD]
        );
        if (existing) {
          for (const [k, v] of Object.entries(row)) if (v !== '') existing[k] = v;
          ok.push({ sf__Id: existing.Id, sf__Created: 'false', ...row });
        } else {
          const id = `${job.object.slice(0, 3)}N${String(++n).padStart(14, '0')}`;
          records.set(id, { ...row, Id: id, type: job.object });
          ok.push({ sf__Id: id, sf__Created: 'true', ...row });
        }
      }
      const cols = (rows: Array<Record<string, string>>) => [...new Set(rows.flatMap((x) => Object.keys(x)))];
      job.ok = ok.length ? toCsv(cols(ok), ok) : '';
      job.failed = failed.length ? toCsv(cols(failed), failed) : '';
      return { status: 201, headers: {}, body: '' };
    }
    const state = /\/jobs\/ingest\/(\w+)$/.exec(path);
    if (state) return json({ id: state[1], state: 'JobComplete', numberRecordsProcessed: 1, numberRecordsFailed: 0 });
    const results = /\/jobs\/ingest\/(\w+)\/(successfulResults|failedResults|unprocessedrecords)/.exec(path);
    if (results) {
      const job = jobs.get(results[1])!;
      return {
        status: 200,
        headers: {},
        body:
          results[2] === 'successfulResults' ? job.ok ?? '' : results[2] === 'failedResults' ? job.failed ?? '' : '',
      };
    }
    // Bulk query (readOldIds)
    if (path.endsWith('/jobs/query') && r.method === 'POST') {
      const id = `751${String(++n).padStart(12, '0')}`;
      jobs.set(id, { object: '', operation: 'query', query: (JSON.parse(body) as { query: string }).query });
      return json({ id, state: 'UploadComplete' });
    }
    const q = /\/jobs\/query\/(\w+)(\/results)?/.exec(path);
    if (q && !q[2]) return json({ id: q[1], state: 'JobComplete' });
    if (q) {
      const object = /FROM (\w+)/.exec(jobs.get(q[1])!.query!)![1];
      const rows = [...records.values()].filter((x) => x.type === object && x[OLD_ID_FIELD]);
      return {
        status: 200,
        headers: { 'sforce-locator': 'null', 'sforce-numberofrecords': String(rows.length) },
        body: toCsv(['Id', OLD_ID_FIELD], rows),
      };
    }
    if (path.endsWith('/composite/sobjects') && r.method === 'POST') {
      const b = JSON.parse(body) as { records: Array<Record<string, string> & { attributes: { type: string } }> };
      return json(
        b.records.map((rec) => {
          const id = `${rec.attributes.type.slice(0, 3)}R${String(++n).padStart(14, '0')}`;
          const { attributes, ...rest } = rec;
          records.set(id, { ...rest, Id: id, type: attributes.type });
          return { id, success: true };
        })
      );
    }
    return { status: 404, headers: {}, body: '[]' };
  }, '62.0');
  return { client, records, fields, deploys, jobs };
}

describe('old Ids in the target org', () => {
  it('builds the field and permission set package', () => {
    const pkg = oldIdFieldPackage(['Account'], ['Account', 'Case'], '62.0');
    expect(unzipList(pkg.zipBase64)).toEqual([
      'objects/Account.object',
      'package.xml',
      'permissionsets/NomadSF_Old_Ids.permissionset',
    ]);
    expect(unzipFile(pkg.zipBase64, 'objects/Account.object')).toContain('<externalId>true</externalId>');
    expect(unzipFile(pkg.zipBase64, 'permissionsets/NomadSF_Old_Ids.permissionset')).toContain(
      `<field>Case.${OLD_ID_FIELD}</field>`
    );
    expect(pkg.packageXml).toContain(`<members>Account.${OLD_ID_FIELD}</members>`);
  });

  it('creates the field, gives access, loads with Bulk upserts, re-runs without duplicates, and removes the fields', async () => {
    const org = bulkOrg();
    const steps: string[] = [];
    const status = await ensureOldIdFields(org.client, ['Account', 'Case', 'Task'], (t) => steps.push(t), {
      pollMs: 1,
    });
    expect(status.map((s) => [s.object, s.status])).toEqual([
      ['Account', 'ready'],
      ['Case', 'ready'],
      ['Task', 'unsupported'],
    ]);
    expect(org.deploys[0]).toBe(
      'objects/Account.object,objects/Case.object,package.xml,permissionsets/NomadSF_Old_Ids.permissionset'
    );

    const loads = Object.keys(SCHEMA).map((name) => ({ name, source: SCHEMA[name], target: SCHEMA[name] }));
    const rows = {
      Account: [
        { Id: '001S00000000001AAA', Name: 'HQ', ParentId: '' },
        { Id: '001S00000000002AAA', Name: 'Branch', ParentId: '001S00000000001AAA' },
      ],
      Case: [
        { Id: '500S00000000001AAA', Subject: 'Broken', AccountId: '001S00000000002AAA', ParentId: '' },
        {
          Id: '500S00000000002AAA',
          Subject: 'Follow-up',
          AccountId: '001S00000000002AAA',
          ParentId: '500S00000000001AAA',
        },
        { Id: '500S00000000003AAA', Subject: 'Rejected', AccountId: '001S00000000001AAA', ParentId: '' },
      ],
      Task: [{ Id: '00TS00000000001AAA', Subject: 'Call', WhatId: '500S00000000001AAA' }],
    };
    const maps = { users: new Map(), recordTypes: new Map(), queues: new Map() };
    const result = await loadWithOldIds(org.client, loads, rows, { maps, withoutField: ['Task'], pollMs: 1 });
    const t = (oldId: string) => org.records.get(result.ids[oldId])!;
    expect(t('001S00000000001AAA')[OLD_ID_FIELD]).toBe('001S00000000001AAA');
    expect(t('001S00000000002AAA').ParentId).toBe(result.ids['001S00000000001AAA']);
    expect(t('500S00000000001AAA').AccountId).toBe(result.ids['001S00000000002AAA']);
    expect(t('500S00000000002AAA').ParentId).toBe(result.ids['500S00000000001AAA']);
    // Task cannot have the field: created through the in-browser map, polymorphic lookup translated
    expect(t('00TS00000000001AAA').WhatId).toBe(result.ids['500S00000000001AAA']);
    expect(result.objects.map((o) => [o.name, o.created, o.failed])).toEqual([
      ['Account', 2, 0],
      ['Case', 2, 1],
      ['Task', 1, 0],
    ]);
    expect(result.failures[0]).toMatchObject({ object: 'Case', sourceId: '500S00000000003AAA' });
    expect(result.created.map((c) => c.object)).toEqual(['Task', 'Case', 'Account']);

    // Running again updates the same records (upsert on the old Id)
    const size = org.records.size;
    const again = await loadWithOldIds(
      org.client,
      loads.slice(0, 1),
      { Account: [{ ...rows.Account[0], Name: 'HQ v2' }] },
      { maps, pollMs: 1 }
    );
    expect(again.objects[0]).toMatchObject({ created: 0, updated: 1 });
    expect(org.records.size).toBe(size);
    expect(t('001S00000000001AAA').Name).toBe('HQ v2');

    const removed = await removeOldIdFields(org.client, ['Account', 'Case', 'Task'], undefined, { pollMs: 1 });
    expect(removed.removed).toEqual(['Account', 'Case']);
    expect(org.deploys.at(-1)).toBe('destructiveChanges.xml,package.xml');
    expect(org.fields.size).toBe(0);
  });
});
