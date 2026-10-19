import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  backupCandidates,
  backupSoql,
  chooseFields,
  describeSchedule,
  estimateBackup,
  isDue,
  memorySink,
  newBackupJob,
  nextKind,
  nextRun,
  parseDataPicks,
  parseObjectList,
  readIndex,
  resolveObjects,
  runBackup,
  type DataField,
  type DataObject,
  type HttpRequest,
} from '../src/index.js';

const field = (name: string, type = 'string', extra: Partial<DataField> = {}): DataField => ({
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

const objects: DataObject[] = [
  { name: 'Account', label: 'Account', custom: false, queryable: true, createable: true, replicateable: true },
  { name: 'AccountShare', label: 'Account Share', custom: false, queryable: true, createable: true },
  { name: 'AccountHistory', label: 'Account History', custom: false, queryable: true, createable: false },
  { name: 'Invoice__c', label: 'Invoice', custom: true, queryable: true, createable: true, replicateable: true },
  { name: 'Invoice__Share', label: 'Invoice Share', custom: true, queryable: true, createable: true },
  { name: 'Setting__mdt', label: 'Setting', custom: true, queryable: true, createable: false },
  { name: 'Order_Event__e', label: 'Order Event', custom: true, queryable: true, createable: true },
];

describe('backup selection', () => {
  it('keeps business objects only', () => {
    expect(backupCandidates(objects).map((o) => o.name)).toEqual(['Account', 'Invoice__c']);
  });

  it('resolves picked, custom, standard and all, with exclusions and per-object settings', () => {
    const candidates = backupCandidates(objects);
    const job = newBackupJob('org');
    expect(
      resolveObjects(
        {
          ...job,
          scope: 'picked',
          objects: [{ name: 'Invoice__c', where: "Status__c = 'Paid'" }, { name: 'Gone__c' }],
        },
        candidates
      )
    ).toEqual([{ name: 'Invoice__c', where: "Status__c = 'Paid'" }]);
    expect(resolveObjects({ ...job, scope: 'custom' }, candidates).map((o) => o.name)).toEqual(['Invoice__c']);
    expect(resolveObjects({ ...job, scope: 'standard' }, candidates).map((o) => o.name)).toEqual(['Account']);
    expect(
      resolveObjects(
        { ...job, scope: 'all', exclude: ['Account'], objects: [{ name: 'Invoice__c', where: 'Amount__c > 0' }] },
        candidates
      )
    ).toEqual([{ name: 'Invoice__c', where: 'Amount__c > 0' }]);
  });

  it('chooses fields: all, only, all except; never without Id and SystemModstamp; no compound fields', () => {
    const fields = [
      field('Id', 'id'),
      field('Name'),
      field('Phone'),
      field('BillingAddress', 'address'),
      field('SystemModstamp', 'datetime'),
    ];
    expect(chooseFields(fields)).toEqual(['Id', 'SystemModstamp', 'Name', 'Phone']);
    expect(chooseFields(fields, { mode: 'only', fields: ['Phone', 'Nope'] })).toEqual([
      'Id',
      'SystemModstamp',
      'Phone',
    ]);
    expect(chooseFields(fields, { mode: 'except', fields: ['Phone', 'Id'] })).toEqual(['Id', 'SystemModstamp', 'Name']);
  });

  it('builds the SOQL with the condition and the incremental filter', () => {
    expect(backupSoql('Account', ['Id', 'Name'])).toBe('SELECT Id, Name FROM Account');
    expect(backupSoql('Account', ['Id'], "WHERE Type = 'Customer'", '2026-10-01T00:00:00.000Z')).toBe(
      "SELECT Id FROM Account WHERE (Type = 'Customer') AND SystemModstamp > 2026-10-01T00:00:00.000Z"
    );
    expect(backupSoql('Account', [], undefined, '2026-10-01T00:00:00.000Z', true)).toBe(
      'SELECT Id, SystemModstamp FROM Account WHERE SystemModstamp > 2026-10-01T00:00:00.000Z AND IsDeleted = true'
    );
    expect(() => backupSoql('Account', ['Id'], 'Name = 1 LIMIT 5')).toThrow('LIMIT');
    expect(() => backupSoql('Account; DELETE', ['Id'])).toThrow('Invalid');
  });
});

describe('schedules', () => {
  it('finds the next daily and weekly run', () => {
    const at = new Date(2026, 9, 19, 10, 0); // Monday 10:00
    expect(nextRun({ every: 'daily', time: '02:00' }, at)).toEqual(new Date(2026, 9, 20, 2, 0));
    expect(nextRun({ every: 'daily', time: '23:30' }, at)).toEqual(new Date(2026, 9, 19, 23, 30));
    expect(nextRun({ every: 'weekly', time: '02:00', weekday: 1 }, at)).toEqual(new Date(2026, 9, 26, 2, 0));
    expect(nextRun({ every: 'weekly', time: '02:00', weekday: 3 }, at)).toEqual(new Date(2026, 9, 21, 2, 0));
    expect(nextRun({ every: 'off' }, at)).toBeUndefined();
    expect(() => nextRun({ every: 'daily', time: '25:00' }, at)).toThrow('HH:MM');
    expect(describeSchedule({ every: 'weekly', time: '02:00', weekday: 1 })).toBe('Mondays at 02:00');
  });

  it('is due once the scheduled moment after the last run has passed', () => {
    const daily = { every: 'daily' as const, time: '02:00' };
    const last = new Date(2026, 9, 18, 2, 5);
    expect(isDue(daily, last, new Date(2026, 9, 19, 1, 0))).toBe(false);
    expect(isDue(daily, last, new Date(2026, 9, 19, 2, 1))).toBe(true);
    // Chrome closed for three days: one run, not three
    expect(isDue(daily, last, new Date(2026, 9, 22, 9, 0))).toBe(true);
    expect(isDue({ every: 'off' }, undefined, new Date())).toBe(false);
  });

  it('runs full first, then incremental, and full again after fullEveryDays', () => {
    const job = { ...newBackupJob('org'), incremental: true, fullEveryDays: 7 };
    const now = new Date('2026-10-19T02:00:00Z');
    expect(nextKind(job, undefined, now)).toBe('full');
    const index = {
      job,
      runs: [{ folder: 'a', kind: 'full' as const, finishedAt: '2026-10-15T02:00:00Z', rows: 5, failed: 0 }],
    };
    expect(nextKind(job, index, now)).toBe('incremental');
    expect(nextKind(job, index, new Date('2026-10-23T02:00:00Z'))).toBe('full');
    expect(nextKind({ ...job, incremental: false }, index, now)).toBe('full');
    // A full run with failures does not count
    expect(nextKind(job, { job, runs: [{ ...index.runs[0], failed: 1 }] }, now)).toBe('full');
  });
});

/** Fake org answering describe, queries and Bulk API 2.0 query jobs. */
function fakeOrg() {
  const jobs: Array<{ id: string; query: string; operation: string }> = [];
  const json = (body: unknown, headers: Record<string, string> = {}) => ({
    status: 200,
    headers,
    body: JSON.stringify(body),
  });
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const path = decodeURIComponent(r.path).replace(/\+/g, ' ');
    if (path.endsWith('/sobjects')) return json({ sobjects: objects });
    if (path.endsWith('/sobjects/Account/describe'))
      return json({
        fields: [
          field('Id', 'id'),
          field('Name'),
          field('BillingAddress', 'address'),
          field('IsDeleted', 'boolean'),
          field('SystemModstamp', 'datetime'),
        ],
      });
    if (path.endsWith('/sobjects/Invoice__c/describe'))
      return json({ fields: [field('Id', 'id'), field('Amount__c', 'currency'), field('SystemModstamp', 'datetime')] });
    if (path.includes('FROM Organization'))
      return json({
        totalSize: 1,
        done: true,
        records: [{ attributes: {}, Id: '00D000000000001', Name: 'Acme', IsSandbox: true }],
      });
    if (path.includes('SELECT COUNT() FROM Account')) return json({ totalSize: 42, done: true, records: [] });
    if (path.includes('SELECT COUNT() FROM Invoice__c'))
      return {
        status: 400,
        headers: {},
        body: JSON.stringify([{ message: 'No such column', errorCode: 'INVALID_FIELD' }]),
      };
    if (path.endsWith('/jobs/query') && r.method === 'POST') {
      const body = JSON.parse(r.body ?? '{}') as { query: string; operation: string };
      if (body.query.includes('FROM Invoice__c'))
        return {
          status: 400,
          headers: {},
          body: JSON.stringify([{ message: 'Bulk API is not supported for this object', errorCode: 'API_ERROR' }]),
        };
      const job = { id: `750${jobs.length}`, ...body };
      jobs.push(job);
      return json({ id: job.id, state: 'UploadComplete' });
    }
    const status = /\/jobs\/query\/(750\d+)$/.exec(path);
    if (status) return json({ id: status[1], state: 'JobComplete', numberRecordsProcessed: 2 });
    const results = /\/jobs\/query\/(750\d+)\/results/.exec(path);
    if (results) {
      const job = jobs.find((j) => j.id === results[1])!;
      if (job.query.includes('IsDeleted = true'))
        return {
          status: 200,
          headers: { 'sforce-numberofrecords': '1', 'sforce-locator': 'null' },
          body: 'Id,SystemModstamp\n001D,2026-10-19T00:00:00.000Z\n',
        };
      return {
        status: 200,
        headers: { 'sforce-numberofrecords': '2', 'sforce-locator': 'null' },
        body: '"Id","SystemModstamp","Name","IsDeleted"\n"001A","2026-10-18T00:00:00.000Z","Acme","false"\n"001B","2026-10-18T00:00:00.000Z","Globex","false"\n',
      };
    }
    return { status: 404, headers: {}, body: '[]' };
  }, '62.0');
  return { client, jobs };
}

describe('running a backup', () => {
  it('writes CSV files and a manifest, then runs incrementally with deleted Ids', async () => {
    const { client, jobs } = fakeOrg();
    const sink = memorySink();
    const job = {
      ...newBackupJob('acme'),
      id: 'b1',
      name: 'Nightly sales',
      scope: 'all' as const,
      schedule: { every: 'daily' as const, time: '02:00' },
    };
    const steps: string[] = [];
    const first = await runBackup(client, job, sink, {
      now: new Date('2026-10-18T02:00:00Z'),
      onProgress: (s) => steps.push(`${s.object}:${s.state}`),
    });
    expect(first.kind).toBe('full');
    expect(first.org).toEqual({ id: '00D000000000001', name: 'Acme', isSandbox: true });
    const account = first.objects.find((o) => o.name === 'Account')!;
    expect(account).toMatchObject({
      rows: 2,
      files: ['Account/part-0001.csv'],
      fields: ['Id', 'SystemModstamp', 'Name', 'IsDeleted'],
    });
    // One object failing is recorded; the others still run
    expect(first.objects.find((o) => o.name === 'Invoice__c')!.error).toContain('not supported');
    expect(first.schema.Account.map((f) => f.name)).toContain('BillingAddress');
    expect(jobs[0].query).toBe('SELECT Id, SystemModstamp, Name, IsDeleted FROM Account');
    expect(sink.files.get('Nightly-sales-b1/2026-10-18T02-00-00Z/Account/part-0001.csv')).toContain('Globex');
    expect(steps).toContain('Account:saving');
    expect(await sink.list('Nightly-sales-b1')).toEqual(['2026-10-18T02-00-00Z', 'backups.json']);

    // Invoice failed, so the "full" run is not a base: fix it by excluding the object
    const fixed = { ...job, exclude: ['Invoice__c'] };
    const full = await runBackup(client, fixed, sink, { now: new Date('2026-10-18T03:00:00Z') });
    expect(full.kind).toBe('full');
    const second = await runBackup(client, fixed, sink, { now: new Date('2026-10-19T02:00:00Z') });
    expect(second.kind).toBe('incremental');
    expect(second.since).toBe('2026-10-18T02:55:00.000Z');
    expect(jobs.at(-2)!.query).toBe(
      'SELECT Id, SystemModstamp, Name, IsDeleted FROM Account WHERE SystemModstamp > 2026-10-18T02:55:00.000Z'
    );
    expect(jobs.at(-1)!).toMatchObject({ operation: 'queryAll' });
    expect(second.objects[0]).toMatchObject({ deleted: 1, files: ['Account/part-0001.csv', 'Account/deleted.csv'] });
    const index = await readIndex(sink, fixed);
    expect(index!.runs.map((r) => r.kind)).toEqual(['full', 'full', 'incremental']);
  });

  it('estimates the records per object', async () => {
    const { client } = fakeOrg();
    const counts = await estimateBackup(client, [{ name: 'Account' }, { name: 'Invoice__c' }]);
    expect(counts.get('Account')).toBe(42);
    expect(String(counts.get('Invoice__c'))).toContain('No such column');
  });
});

describe('choosing objects by name or with AI', () => {
  const list = [
    { name: 'Account', label: 'Account' },
    { name: 'Invoice__c', label: 'Invoice' },
    { name: 'Opportunity', label: 'Opportunity' },
  ];

  it('reads a typed list: API names or labels, any case, commas / semicolons / new lines', () => {
    expect(parseObjectList('account, Invoice;\nOPPORTUNITY,  Nope__c, account', list)).toEqual({
      found: ['Account', 'Invoice__c', 'Opportunity'],
      unknown: ['Nope__c'],
    });
  });

  it('keeps only existing objects from an AI answer, with safe conditions and field choices', () => {
    const answer = [
      'Here you go:',
      '```json',
      JSON.stringify({
        objects: [
          { name: 'Account', where: "WHERE Type = 'Customer'", fields: { mode: 'all' } },
          {
            name: 'opportunity',
            where: 'CreatedDate = LAST_N_YEARS:2',
            relatedOnly: true,
            fields: { mode: 'except', fields: ['Description', 'bad field'] },
          },
          { name: 'Ghost__c' },
          { name: 'Invoice__c', where: 'Amount__c > 0 LIMIT 5' },
        ],
        note: 'Customers and their recent deals.',
      }),
      '```',
    ].join('\n');
    expect(parseDataPicks(answer, list)).toEqual({
      picks: [
        { name: 'Account', where: "Type = 'Customer'" },
        {
          name: 'Opportunity',
          where: 'CreatedDate = LAST_N_YEARS:2',
          relatedOnly: true,
          fields: { mode: 'except', fields: ['Description'] },
        },
        { name: 'Invoice__c' },
      ],
      unknown: ['Ghost__c'],
      note: 'Customers and their recent deals.',
    });
    expect(() => parseDataPicks('no json here', list)).toThrow('did not answer');
  });
});
