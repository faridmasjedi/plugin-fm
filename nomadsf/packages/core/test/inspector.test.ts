import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  coerceFieldValue,
  extractRecordId,
  inspectRecord,
  loginAsPath,
  orgLimits,
  restExplorer,
  updateRecord,
  type HttpRequest,
} from '../src/index.js';

function fake(handler: (r: HttpRequest) => { status?: number; json?: unknown }) {
  const calls: HttpRequest[] = [];
  const client = new SalesforceClient(async (r) => {
    calls.push(r);
    const out = handler(r);
    return { status: out.status ?? 200, headers: {}, body: out.json === undefined ? '' : JSON.stringify(out.json) };
  }, '62.0');
  return { calls, client };
}

describe('inspector', () => {
  it('finds record Ids in Ids and URLs', () => {
    expect(extractRecordId('001000000000001AAA')).toBe('001000000000001AAA');
    expect(extractRecordId('https://x.lightning.force.com/lightning/r/Account/001000000000001AAA/view')).toBe(
      '001000000000001AAA'
    );
    expect(extractRecordId('https://x.my.salesforce.com/001000000000001')).toBe('001000000000001');
    expect(extractRecordId('not an id')).toBeUndefined();
  });

  it('reads every field of a record by its key prefix', async () => {
    const { client } = fake((r) => {
      if (r.path.endsWith('/sobjects'))
        return { json: { sobjects: [{ name: 'Account', keyPrefix: '001', queryable: true }] } };
      if (r.path.endsWith('/describe'))
        return {
          json: {
            label: 'Account',
            fields: [
              {
                name: 'Name',
                label: 'Name',
                type: 'string',
                updateable: true,
                nillable: false,
                calculated: false,
                nameField: true,
              },
              { name: 'Id', label: 'Id', type: 'id', updateable: false, nillable: false, calculated: false },
            ],
          },
        };
      return { json: { Id: '001000000000001AAA', Name: 'Acme' } };
    });
    const record = await inspectRecord(client, '001000000000001AAA');
    expect(record).toMatchObject({ sobject: 'Account', name: 'Acme' });
    expect(record.fields.map((f) => [f.name, f.value])).toEqual([
      ['Id', '001000000000001AAA'],
      ['Name', 'Acme'],
    ]);
  });

  it('converts edits by type and patches only changes', async () => {
    expect(coerceFieldValue({ name: 'A', type: 'boolean' }, 'TRUE')).toBe(true);
    expect(coerceFieldValue({ name: 'A', type: 'currency' }, '12.5')).toBe(12.5);
    expect(coerceFieldValue({ name: 'A', type: 'string' }, '  ')).toBeNull();
    expect(() => coerceFieldValue({ name: 'A', type: 'int' }, 'x')).toThrow('number');
    expect(() => coerceFieldValue({ name: 'A', type: 'date' }, '1/2/2026')).toThrow('YYYY');
    const { calls, client } = fake(() => ({ status: 204 }));
    await updateRecord(client, 'Account', '001000000000001AAA', { Name: 'B' });
    expect(calls[0]).toMatchObject({
      method: 'PATCH',
      path: '/services/data/v62.0/sobjects/Account/001000000000001AAA',
    });
    await expect(updateRecord(client, 'Account', '001000000000001AAA', {})).rejects.toThrow('Nothing');
  });

  it('sorts limits by usage', async () => {
    const { client } = fake(() => ({
      json: { DailyApiRequests: { Max: 100, Remaining: 25 }, DataStorageMB: { Max: 5, Remaining: 5 } },
    }));
    const limits = await orgLimits(client);
    expect(limits[0]).toEqual({ name: 'DailyApiRequests', max: 100, remaining: 25, used: 75, percent: 75 });
  });

  it('explores REST paths and returns errors as answers', async () => {
    const { calls, client } = fake((r) =>
      r.path.includes('bad') ? { status: 404, json: [{ message: 'Not found' }] } : { json: {} }
    );
    await restExplorer(client, { method: 'GET', path: 'limits' });
    expect(calls[0].path).toBe('/services/data/v62.0/limits');
    await restExplorer(client, { method: 'GET', path: '/services/data/vXX.X/sobjects' });
    expect(calls[1].path).toBe('/services/data/v62.0/sobjects');
    expect(await restExplorer(client, { method: 'GET', path: '/bad' })).toMatchObject({
      status: 404,
      body: 'Not found',
    });
  });

  it('builds login-as links', () => {
    expect(loginAsPath('00D000000000001', '005000000000001AAA')).toMatch(
      /^\/servlet\/servlet\.su\?oid=00D000000000001&suorgadminid=005000000000001AAA/
    );
    expect(() => loginAsPath('x', 'y')).toThrow();
  });
});
