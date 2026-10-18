import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  bulkCompatible,
  bulkQuery,
  openQuery,
  queryMore,
  toCsvFiles,
  type HttpRequest,
} from '../src/index.js';

function fake(
  handler: (r: HttpRequest) => { status?: number; json?: unknown; body?: string; headers?: Record<string, string> }
) {
  const calls: HttpRequest[] = [];
  const client = new SalesforceClient(async (r) => {
    calls.push(r);
    const out = handler(r);
    return { status: out.status ?? 200, headers: out.headers ?? {}, body: out.body ?? JSON.stringify(out.json ?? {}) };
  }, '62.0');
  return { calls, client };
}

describe('large results', () => {
  it('reads a query page by page with a cursor', async () => {
    const { calls, client } = fake((r) =>
      r.path.includes('/query/01g-2000')
        ? { json: { totalSize: 3, done: true, records: [{ Id: '3', Owner: { Name: 'B' } }] } }
        : {
            json: {
              totalSize: 3,
              done: false,
              nextRecordsUrl: '/services/data/v62.0/query/01g-2000',
              records: [{ Id: '1' }, { Id: '2' }],
            },
          }
    );
    let cursor = await openQuery(client, 'SELECT Id FROM Account');
    expect(cursor).toMatchObject({ totalSize: 3, truncated: true, next: '/query/01g-2000' });
    expect(cursor.rows).toHaveLength(2);
    cursor = await queryMore(client, cursor);
    expect(cursor.rows.map((r) => r.Id)).toEqual(['1', '2', '3']);
    expect(cursor.columns).toEqual(['Id', 'Owner.Name']);
    expect(cursor).toMatchObject({ truncated: false, next: undefined });
    expect(await queryMore(client, cursor)).toBe(cursor);
    expect(calls[1].path).toBe('/services/data/v62.0/query/01g-2000');
  });

  it('knows which queries Bulk API can export', () => {
    expect(bulkCompatible('SELECT Id, Account.Name FROM Contact', false)).toBe(true);
    expect(bulkCompatible('SELECT Id, (SELECT Id FROM Contacts) FROM Account', false)).toBe(false);
    expect(bulkCompatible('SELECT Id FROM ApexClass', true)).toBe(false);
  });

  it('splits loaded rows into CSV files with a header each', () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({ Id: String(i) }));
    const files = toCsvFiles(['Id'], rows, 2);
    expect(files).toHaveLength(3);
    expect(files.map((f) => f.trim().split('\n'))).toEqual([
      ['Id', '0', '1'],
      ['Id', '2', '3'],
      ['Id', '4'],
    ]);
    expect(toCsvFiles(['Id'], [], 2)).toEqual(['Id\n']);
  });

  it('hands every Bulk API chunk over as its own file', async () => {
    const chunks = ['Id\n1\n2\n', 'Id\n3\n'];
    const { calls, client } = fake((r) => {
      if (r.method === 'POST') return { json: { id: '750x', state: 'UploadComplete' } };
      if (!r.path.includes('/results'))
        return { json: { id: '750x', state: 'JobComplete', numberRecordsProcessed: 3 } };
      const second = r.path.includes('locator=L2');
      return {
        body: chunks[second ? 1 : 0],
        headers: { 'sforce-numberofrecords': second ? '1' : '2', 'sforce-locator': second ? 'null' : 'L2' },
      };
    });
    const files: Array<[string, number, number]> = [];
    const result = await bulkQuery(client, 'SELECT Id FROM Account', {
      rowsPerFile: 2,
      pollMs: 1,
      onFile: (csv, i, n) => void files.push([csv, i, n]),
    });
    expect(files).toEqual([
      ['Id\n1\n2\n', 0, 2],
      ['Id\n3\n', 1, 1],
    ]);
    expect(result).toMatchObject({ rows: 3, files: 2, csv: '' });
    expect(calls.find((c) => c.path.includes('/results'))!.path).toContain('maxRecords=2');
    const joined = await bulkQuery(client, 'SELECT Id FROM Account', { rowsPerFile: 2, pollMs: 1 });
    expect(joined.csv).toBe('Id\n1\n2\n3\n');
  });
});
