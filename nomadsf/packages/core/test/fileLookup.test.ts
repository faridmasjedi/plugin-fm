import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  distinctValues,
  estimateQueries,
  idObjects,
  joinBack,
  lookupValues,
  parseCsv,
  type HttpRequest,
} from '../src/index.js';

const P1 = '00e000000000001AAA';
const P2 = '00e000000000002AAA';

function fakeOrg(records: Array<Record<string, unknown>>) {
  const queries: string[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const json = (b: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(b) });
    if (r.path.endsWith('/sobjects'))
      return json({
        sobjects: [
          { name: 'Profile', keyPrefix: '00e', queryable: true },
          { name: 'User', keyPrefix: '005', queryable: true },
        ],
      });
    const soql = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    queries.push(soql);
    const inList = /IN \((.*)\)$/.exec(soql)![1];
    const wanted = [...inList.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\'/g, "'").toLowerCase());
    const field = /WHERE (\w+) IN/.exec(soql)![1];
    const hits = records.filter(
      (rec) =>
        wanted.includes(String(rec[field]).toLowerCase()) ||
        (field === 'Id' && wanted.some((w) => String(rec.Id).toLowerCase().startsWith(w)))
    );
    return json({ totalSize: hits.length, done: true, records: hits.map((h) => ({ attributes: {}, ...h })) });
  }, '62.0');
  return { client, queries };
}

describe('look up a file column in Salesforce', () => {
  const csv = parseCsv(
    `Username,ProfileId\nann@x.com,${P1}\nbob@x.com,${P2.slice(
      0,
      15
    )}\ncid@x.com,${P1}\ndan@x.com,00e00000000009Z\neve@x.com,\n`
  );

  it('finds the object of an Id column and the distinct values', async () => {
    const { client } = fakeOrg([]);
    const values = distinctValues(csv.rows, 'ProfileId');
    expect(values).toHaveLength(3);
    expect(await idObjects(client, values)).toEqual(['Profile']);
    expect(await idObjects(client, distinctValues(csv.rows, 'Username'))).toBeUndefined();
    expect(estimateQueries(401)).toBe(3);
  });

  it('looks Ids up (15 or 18 characters) and joins the fields back onto the file', async () => {
    const { client, queries } = fakeOrg([
      { Id: P1, Name: 'System Administrator', 'UserLicense.Name': 'Salesforce' },
      { Id: P2, Name: 'Standard User', 'UserLicense.Name': 'Salesforce' },
    ]);
    const values = distinctValues(csv.rows, 'ProfileId');
    const result = await lookupValues(client, {
      sobject: 'Profile',
      matchField: 'Id',
      values,
      fields: ['Name', 'UserLicense.Name'],
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^SELECT Id, Name, UserLicense\.Name FROM Profile WHERE Id IN \(/);
    const joined = joinBack(csv.rows, csv.columns, 'ProfileId', true, ['Name', 'UserLicense.Name'], result.found);
    expect(joined.columns).toEqual([
      'Username',
      'ProfileId',
      'ProfileId → Found',
      'ProfileId → Name',
      'ProfileId → UserLicense.Name',
    ]);
    expect(joined.rows.map((r) => [r['ProfileId → Found'], r['ProfileId → Name']])).toEqual([
      ['yes', 'System Administrator'],
      ['yes', 'Standard User'],
      ['yes', 'System Administrator'],
      ['no', ''],
      ['', ''],
    ]);
    expect(joined.notFound).toBe(1);
  });

  it('gives looked-up columns their own names when the file already has them (export with names for Ids)', () => {
    const rows = [{ Id: '500A', ContactId: P1, 'ContactId → Name': 'Old name' }];
    const found = new Map([[P1.slice(0, 15), [{ Id: P1, Name: 'New name', Email: 'a@b.c' }]]]);
    const joined = joinBack(rows, ['Id', 'ContactId', 'ContactId → Name'], 'ContactId', true, ['Name', 'Email'], found);
    expect(joined.columns).toEqual([
      'Id',
      'ContactId',
      'ContactId → Found',
      'ContactId → Name (lookup)',
      'ContactId → Email',
      'ContactId → Name',
    ]);
    expect(new Set(joined.columns).size).toBe(joined.columns.length);
    expect(joined.rows[0]['ContactId → Name']).toBe('Old name');
    expect(joined.rows[0]['ContactId → Name (lookup)']).toBe('New name');
  });

  it('matches text case-insensitively, escapes quotes and batches by 200', async () => {
    const users = [{ Id: '005000000000001AAA', Username: "O'Brien@x.com", Name: "Pat O'Brien" }];
    const { client, queries } = fakeOrg(users);
    const values = ["o'brien@X.com", ...Array.from({ length: 250 }, (_, i) => `user${i}@x.com`)];
    const result = await lookupValues(client, { sobject: 'User', matchField: 'Username', values, fields: ['Name'] });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("'o\\'brien@X.com'");
    const joined = joinBack([{ Login: "o'brien@X.com" }], ['Login'], 'Login', false, ['Name'], result.found);
    expect(joined.rows[0]).toMatchObject({ 'Login → Found': 'yes', 'Login → Name': "Pat O'Brien" });
  });

  it('reports values that match several records', () => {
    const found = new Map([['ann', [{ Name: 'A1' }, { Name: 'A2' }]]]);
    expect(joinBack([{ First: 'Ann' }], ['First'], 'First', false, ['Name'], found).rows[0]).toMatchObject({
      'First → Found': 'several (2)',
      'First → Name': 'A1',
    });
  });
});
