import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  lifecycleTemplate,
  lifecycleWarnings,
  memorySink,
  newLifecycleJob,
  parseCsv,
  runLifecycle,
  toCsv,
  type BackupManifest,
  type DataField,
  type HttpRequest,
  type LifecycleJob,
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
const SCHEMA: Record<string, DataField[]> = {
  Case: [
    f('Id', 'id', { updateable: false }),
    f('Subject'),
    f('Status'),
    f('SystemModstamp', 'datetime', { updateable: false }),
  ],
  Contact: [
    f('Id', 'id', { updateable: false }),
    f('LastName'),
    f('FirstName'),
    f('Email', 'email'),
    f('Phone', 'phone'),
    f('MailingStreet', 'textarea'),
  ],
};

/** An org with records, SOQL COUNT(), Bulk queries and Bulk updates / deletes. */
function lifecycleOrg() {
  const records = new Map<string, Record<string, string> & { type: string }>();
  const add = (type: string, id: string, fields: Record<string, string>) =>
    records.set(id, { type, Id: id, ...fields });
  for (let i = 1; i <= 5; i++)
    add('Case', `500A0000000000${i}AAA`, { Subject: `Old ${i}`, Status: i <= 3 ? 'Closed' : 'New' });
  add('Contact', '003A00000000001AAA', {
    LastName: 'Lee',
    FirstName: 'Ann',
    Email: 'ann@acme.com',
    Phone: '123',
    MailingStreet: '1 Main St',
  });
  add('Contact', '003A00000000002AAA', {
    LastName: 'Kim',
    FirstName: 'Bo',
    Email: '',
    Phone: '456',
    MailingStreet: '',
  });
  const jobs = new Map<string, { query?: string; object?: string; operation?: string; ok?: string; failed?: string }>();
  let n = 0;
  const match = (r: Record<string, string>, soql: string) => {
    const where = /WHERE \((.*)\)/.exec(soql)?.[1] ?? /WHERE (.*)$/.exec(soql)?.[1];
    if (!where) return true;
    const m = /(\w+) = '(.*)'/.exec(where);
    return m ? r[m[1]] === m[2] : true;
  };
  const select = (soql: string) => {
    const type = /FROM (\w+)/.exec(soql)![1];
    return [...records.values()].filter((r) => r.type === type && match(r, soql));
  };
  const json = (b: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(b) });
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const path = decodeURIComponent(r.path).replace(/\+/g, ' ');
    const desc = /\/sobjects\/(\w+)\/describe/.exec(path);
    if (desc) return json({ fields: SCHEMA[desc[1]] });
    if (path.includes('/query?q=SELECT COUNT()'))
      return json({ totalSize: select(path.split('q=')[1]).length, done: true, records: [] });
    if (path.endsWith('/jobs/query') && r.method === 'POST') {
      const id = `750${++n}`;
      jobs.set(id, { query: (JSON.parse(r.body!) as { query: string }).query });
      return json({ id, state: 'UploadComplete' });
    }
    const q = /\/jobs\/query\/(\w+)(\/results)?/.exec(path);
    if (q && !q[2]) return json({ id: q[1], state: 'JobComplete' });
    if (q) {
      const soql = jobs.get(q[1])!.query!;
      const fields = /SELECT (.+?) FROM/.exec(soql)![1].split(', ');
      const rows = select(soql);
      return {
        status: 200,
        headers: { 'sforce-locator': 'null', 'sforce-numberofrecords': String(rows.length) },
        body: toCsv(fields, rows),
      };
    }
    if (path.endsWith('/jobs/ingest') && r.method === 'POST') {
      const b = JSON.parse(r.body!) as { object: string; operation: string };
      const id = `752${++n}`;
      jobs.set(id, { object: b.object, operation: b.operation });
      return json({ id });
    }
    const batch = /\/jobs\/ingest\/(\w+)\/batches/.exec(path);
    if (batch) {
      const job = jobs.get(batch[1])!;
      const rows = parseCsv(r.body!).rows;
      const ok: Array<Record<string, string>> = [];
      for (const row of rows) {
        if (job.operation === 'update') {
          const rec = records.get(row.Id)!;
          for (const [k, v] of Object.entries(row)) if (k !== 'Id' && v !== '') rec[k] = v === '#N/A' ? '' : v;
        } else records.delete(row.Id);
        ok.push({ sf__Id: row.Id, sf__Created: 'false', ...row });
      }
      job.ok = toCsv(['sf__Id', 'sf__Created', ...Object.keys(rows[0] ?? {})], ok);
      return { status: 201, headers: {}, body: '' };
    }
    const state = /\/jobs\/ingest\/(\w+)$/.exec(path);
    if (state) return json({ id: state[1], state: 'JobComplete' });
    const results = /\/jobs\/ingest\/(\w+)\/(successfulResults|failedResults|unprocessedrecords)/.exec(path);
    if (results)
      return {
        status: 200,
        headers: {},
        body: results[2] === 'successfulResults' ? jobs.get(results[1])!.ok ?? '' : '',
      };
    return { status: 404, headers: {}, body: '[]' };
  }, '62.0');
  return { client, records };
}

const manifest = { kind: 'full', objects: [{ name: 'Case', rows: 5 }] } as unknown as BackupManifest;

function job(steps: LifecycleJob['steps'], approval = true): LifecycleJob {
  return { ...newLifecycleJob('acme', 'Retention'), id: 'l1', steps, approval };
}

const archiveStep = {
  id: 'a',
  type: 'archive' as const,
  object: 'Case',
  where: "Status = 'Closed'",
  backupJobId: 'b1',
};

describe('lifecycle jobs', () => {
  it('dry run: counts only, nothing changes, no approval asked', async () => {
    const org = lifecycleOrg();
    let asked = 0;
    const run = await runLifecycle(
      org.client,
      job([
        { id: 'b', type: 'backup', backupJobId: 'b1' },
        { id: 'c', type: 'check', object: 'Case', where: "Status = 'Closed'", max: 10 },
        archiveStep,
        { id: 'n', type: 'anonymize', object: 'Contact' },
      ]),
      {
        dryRun: true,
        approve: async () => (asked++, true),
        runBackup: async () => manifest,
        archiveSink: async () => ({ sink: memorySink(), root: 'job' }),
      }
    );
    expect(run.status).toBe('done');
    expect(asked).toBe(0);
    expect(run.steps.map((s) => [s.type, s.status, s.matched])).toEqual([
      ['backup', 'dry', undefined],
      ['check', 'done', 3],
      ['archive', 'dry', 3],
      ['anonymize', 'dry', 2],
    ]);
    expect(run.steps[3].message).toBe(
      'Would anonymize LastName, FirstName, Email, Phone, MailingStreet on 2 record(s).'
    );
    expect(org.records.size).toBe(7);
  });

  it('a Check over its limit stops before anything changes', async () => {
    const org = lifecycleOrg();
    const run = await runLifecycle(org.client, job([{ id: 'c', type: 'check', object: 'Case', max: 2 }, archiveStep]), {
      dryRun: false,
      approve: async () => true,
      runBackup: async () => manifest,
      archiveSink: async () => ({ sink: memorySink(), root: 'job' }),
    });
    expect(run.status).toBe('stopped');
    expect(run.steps.map((s) => s.status)).toEqual(['stopped', 'skipped']);
    expect(run.steps[0].message).toContain('5 records, more than the limit of 2');
    expect(org.records.size).toBe(7);
  });

  it('waits for approval; declined stops, approved archives (verified) and deletes, then anonymizes', async () => {
    const declined = lifecycleOrg();
    const stop = await runLifecycle(declined.client, job([archiveStep]), {
      dryRun: false,
      approve: async (run) => {
        expect(run.status).toBe('waiting');
        return false;
      },
      runBackup: async () => manifest,
      archiveSink: async () => ({ sink: memorySink(), root: 'job' }),
    });
    expect(stop.status).toBe('stopped');
    expect(stop.approval).toMatchObject({ declined: true });
    expect(declined.records.size).toBe(7);

    const org = lifecycleOrg();
    const sink = memorySink();
    const run = await runLifecycle(org.client, job([archiveStep, { id: 'n', type: 'anonymize', object: 'Contact' }]), {
      dryRun: false,
      user: 'ann@acme.com',
      approve: async () => true,
      runBackup: async () => manifest,
      archiveSink: async () => ({ sink, root: 'Backups-b1' }),
    });
    expect(run.status).toBe('done');
    expect(run.approval).toMatchObject({ by: 'ann@acme.com' });
    expect(run.steps[0]).toMatchObject({ status: 'done', matched: 3, changed: 3 });
    const archived = [...sink.files.keys()];
    expect(archived.some((p) => /^Backups-b1\/archives\/l1-\w+\/Case\/part-0001\.csv$/.test(p))).toBe(true);
    expect(String(sink.files.get(archived.find((p) => p.endsWith('part-0001.csv'))!))).toContain('Old 1');
    expect([...org.records.values()].filter((r) => r.type === 'Case').map((r) => r.Subject)).toEqual([
      'Old 4',
      'Old 5',
    ]);
    // Anonymized: fake values, empty ones stay empty, cleared "blank" rule fields emptied
    const ann = org.records.get('003A00000000001AAA')!;
    expect(ann.Email).toMatch(/@example\.invalid$/);
    expect(ann.LastName).not.toBe('Lee');
    expect(org.records.get('003A00000000002AAA')!.Email).toBe('');
  });

  it('never deletes what could not be read back from the archive', async () => {
    const org = lifecycleOrg();
    const broken = { ...memorySink(), read: async () => undefined };
    const run = await runLifecycle(org.client, job([archiveStep], false), {
      dryRun: false,
      approve: async () => true,
      runBackup: async () => manifest,
      archiveSink: async () => ({ sink: broken, root: 'x' }),
    });
    expect(run.status).toBe('failed');
    expect(run.steps[0].message).toBe('The archive could not be read back; nothing was deleted.');
    expect(org.records.size).toBe(7);
  });

  it('warns about risky jobs and offers templates', () => {
    expect(lifecycleWarnings(job([{ id: 'd', type: 'delete', object: 'Case' }], false))).toEqual([
      'Step 1 has no condition: every Case record is included.',
      'Without approval, add a Check step before the steps that change data, so an unexpected volume stops the run.',
      'Consider a Backup step first: anonymize and delete cannot be undone.',
    ]);
    const retention = lifecycleTemplate('retention', 'acme');
    expect(retention.steps.map((s) => s.type)).toEqual(['check', 'archive']);
    expect(lifecycleWarnings(retention)).toEqual(['Step 2: choose a backup.']);
  });
});
