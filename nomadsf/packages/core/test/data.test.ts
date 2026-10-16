import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  assignAccess,
  bulkIngest,
  bulkQuery,
  deleteByQuery,
  parseCsv,
  removeAccess,
  toCsv,
  type HttpRequest,
  type HttpResponse,
} from '../src/index.js';

type Answer = Partial<HttpResponse> & { json?: unknown };

function fake(handler: (r: HttpRequest, calls: HttpRequest[]) => Answer) {
  const calls: HttpRequest[] = [];
  const client = new SalesforceClient(async (r) => {
    calls.push(r);
    const out = handler(r, calls);
    return {
      status: out.status ?? 200,
      headers: out.headers ?? {},
      body: out.json !== undefined ? JSON.stringify(out.json) : out.body ?? '',
    };
  }, '62.0');
  return { client, calls };
}

describe('csv', () => {
  it('parses quotes, escaped quotes and newlines inside fields', () => {
    const t = parseCsv('﻿Id,Name,Note\r\n1,"Acme, Inc","He said ""hi""\nsecond line"\n2,Beta,\n');
    expect(t.columns).toEqual(['Id', 'Name', 'Note']);
    expect(t.rows).toEqual([
      { Id: '1', Name: 'Acme, Inc', Note: 'He said "hi"\nsecond line' },
      { Id: '2', Name: 'Beta', Note: '' },
    ]);
  });

  it('round-trips through toCsv', () => {
    const rows = [{ A: 'x,y', B: 'say "q"', C: null }];
    expect(parseCsv(toCsv(['A', 'B', 'C'], rows)).rows).toEqual([{ A: 'x,y', B: 'say "q"', C: '' }]);
  });
});

describe('bulk query', () => {
  it('waits for the job and follows the result locator, keeping one header row', async () => {
    let polls = 0;
    const { client, calls } = fake((r) => {
      if (r.method === 'POST' && r.path.endsWith('/jobs/query'))
        return { json: { id: '750Q', state: 'UploadComplete' } };
      if (r.path.endsWith('/jobs/query/750Q'))
        return { json: { id: '750Q', state: ++polls < 2 ? 'InProgress' : 'JobComplete' } };
      if (r.path.includes('/results') && !r.path.includes('locator'))
        return { body: 'Id,Name\n1,A\n', headers: { 'sforce-locator': 'L2', 'sforce-numberofrecords': '1' } };
      return { body: 'Id,Name\n2,B\n', headers: { 'sforce-locator': 'null', 'sforce-numberofrecords': '1' } };
    });
    const r = await bulkQuery(client, 'SELECT Id, Name FROM Account', { pollMs: 1, includeDeleted: true });
    expect(r).toMatchObject({ jobId: '750Q', rows: 2, csv: 'Id,Name\n1,A\n2,B\n' });
    expect(JSON.parse(calls[0].body ?? '{}')).toMatchObject({ operation: 'queryAll', contentType: 'CSV' });
    expect(calls.some((c) => c.path.includes('locator=L2'))).toBe(true);
  });

  it('reports a failed job', async () => {
    const { client } = fake((r) =>
      r.method === 'POST'
        ? { json: { id: '750F', state: 'UploadComplete' } }
        : { json: { id: '750F', state: 'Failed', errorMessage: 'INVALID_FIELD' } }
    );
    await expect(bulkQuery(client, 'SELECT Nope FROM Account', { pollMs: 1 })).rejects.toThrow('INVALID_FIELD');
  });
});

describe('bulk ingest', () => {
  it('creates, uploads, closes and polls the job, then returns the result files', async () => {
    const { client, calls } = fake((r) => {
      if (r.method === 'POST') return { json: { id: '750I', state: 'Open' } };
      if (r.method === 'PUT' || r.method === 'PATCH')
        return {
          status: r.method === 'PUT' ? 201 : 200,
          json: r.method === 'PATCH' ? { id: '750I', state: 'UploadComplete' } : undefined,
        };
      if (r.path.endsWith('/jobs/ingest/750I'))
        return { json: { id: '750I', state: 'JobComplete', numberRecordsProcessed: 2, numberRecordsFailed: 1 } };
      if (r.path.includes('failedResults'))
        return { body: '"sf__Id","sf__Error",Name\n"","REQUIRED_FIELD_MISSING",X\n' };
      return { body: '"sf__Id","sf__Created",Name\n' };
    });
    const r = await bulkIngest(
      client,
      { object: 'Account', operation: 'upsert', externalIdField: 'Ext__c', csv: 'Ext__c,Name\r\n1,A\r\n2,\r\n' },
      { pollMs: 1 }
    );
    expect(r).toMatchObject({ jobId: '750I', state: 'JobComplete', processed: 2, failed: 1 });
    expect(parseCsv(r.failedCsv).rows[0].sf__Error).toBe('REQUIRED_FIELD_MISSING');
    expect(JSON.parse(calls[0].body ?? '{}')).toMatchObject({
      object: 'Account',
      operation: 'upsert',
      externalIdFieldName: 'Ext__c',
    });
    const upload = calls.find((c) => c.method === 'PUT');
    expect(upload?.path).toBe('/services/data/v62.0/jobs/ingest/750I/batches');
    expect(upload?.body).toBe('Ext__c,Name\n1,A\n2,\n');
    expect(JSON.parse(calls.find((c) => c.method === 'PATCH')?.body ?? '{}')).toEqual({ state: 'UploadComplete' });
  });

  it('refuses an upsert without an external ID field', async () => {
    const { client } = fake(() => ({ json: {} }));
    await expect(bulkIngest(client, { object: 'Account', operation: 'upsert', csv: 'Id\n1\n' })).rejects.toThrow(
      'external ID'
    );
  });

  it('delete by query selects only Ids of the main object, then deletes them', async () => {
    const { client, calls } = fake((r) => {
      if (r.method === 'POST' && r.path.endsWith('/jobs/query')) return { json: { id: 'Q', state: 'UploadComplete' } };
      if (r.path.endsWith('/jobs/query/Q')) return { json: { id: 'Q', state: 'JobComplete' } };
      if (r.path.includes('/jobs/query/Q/results'))
        return { body: 'Id\n500A\n500B\n', headers: { 'sforce-numberofrecords': '2' } };
      if (r.method === 'POST') return { json: { id: 'I', state: 'Open' } };
      if (r.path.endsWith('/jobs/ingest/I'))
        return { json: { id: 'I', state: 'JobComplete', numberRecordsProcessed: 2, numberRecordsFailed: 0 } };
      return { json: { id: 'I', state: 'UploadComplete' } };
    });
    const r = await deleteByQuery(
      client,
      "SELECT Id, Subject, (SELECT Id FROM Tasks) FROM Case WHERE Subject LIKE 'TEST%'",
      { pollMs: 1, hardDelete: true }
    );
    expect(JSON.parse(calls[0].body ?? '{}').query).toBe("SELECT Id FROM Case WHERE Subject LIKE 'TEST%'");
    expect(JSON.parse(calls.find((c) => c.path.endsWith('/jobs/ingest'))?.body ?? '{}')).toMatchObject({
      object: 'Case',
      operation: 'hardDelete',
    });
    expect(r?.processed).toBe(2);
  });
});

describe('access', () => {
  it('skips users who already have the permission set and batches the rest', async () => {
    const { client, calls } = fake((r) => {
      if (r.method === 'GET')
        return { json: { totalSize: 1, done: true, records: [{ AssigneeId: '005000000000001AAA' }] } };
      const body = JSON.parse(r.body ?? '{}') as { records: unknown[] };
      return { json: body.records.map(() => ({ id: '0Pa', success: true, errors: [] })) };
    });
    const r = await assignAccess(
      client,
      { kind: 'group', id: '0PG000000000001AAA' },
      ['005000000000001AAA', '005000000000002AAA', 'bad'],
      '2026-12-31'
    );
    expect(r).toEqual({ assigned: 1, skipped: 2, errors: [] });
    const post = JSON.parse(calls.find((c) => c.method === 'POST')?.body ?? '{}');
    expect(post.records).toEqual([
      {
        attributes: { type: 'PermissionSetAssignment' },
        AssigneeId: '005000000000002AAA',
        PermissionSetGroupId: '0PG000000000001AAA',
        ExpirationDate: '2026-12-31',
      },
    ]);
  });

  it('removes only assignment ids and reports errors', async () => {
    const { client, calls } = fake(() => ({
      json: [
        { success: true, errors: [] },
        { success: false, errors: [{ message: 'nope' }] },
      ],
    }));
    const r = await removeAccess(client, ['0Pa000000000001AAA', '0Pa000000000002AAA', '005000000000001AAA']);
    expect(r).toEqual({ removed: 1, errors: ['nope'] });
    expect(calls[0].path).toContain('ids=0Pa000000000001AAA,0Pa000000000002AAA&');
  });
});
