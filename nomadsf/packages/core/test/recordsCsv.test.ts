import { describe, expect, it } from 'vitest';
import { SalesforceClient, applyCsv, compareCsv, parseCsv, planCsv, type HttpRequest } from '../src/index.js';

const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
const field = (name: string, type = 'string', extra: Record<string, unknown> = {}) => ({
  name,
  label: name,
  type,
  createable: true,
  updateable: true,
  referenceTo: [],
  relationshipName: null,
  idLookup: false,
  ...extra,
});

function fakeOrg() {
  const sent: unknown[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    if (r.path.endsWith('/sobjects/Contact/describe'))
      return json({
        fields: [
          field('Id', 'id', { createable: false, updateable: false, idLookup: true }),
          field('Email', 'email', { idLookup: true }),
          field('LastName'),
          field('DoNotCall', 'boolean'),
          field('Birthdate', 'date'),
          field('AccountId', 'reference', { referenceTo: ['Account'], relationshipName: 'Account' }),
        ],
      });
    if (r.method !== 'GET') {
      const body = JSON.parse(r.body ?? '{}') as { records: unknown[] };
      sent.push({ method: r.method, records: body.records });
      return json(body.records.map(() => ({ success: true, errors: [] })));
    }
    const soql = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    if (soql.includes('FROM Account'))
      return json({ totalSize: 1, done: true, records: [{ Id: '001000000000002AAA', Name: 'Globex' }] });
    return json({
      totalSize: 1,
      done: true,
      records: [
        {
          Id: '003000000000001AAA',
          Email: 'ann@acme.com',
          LastName: 'Lee',
          DoNotCall: true,
          Birthdate: '1990-05-01',
          Account: { attributes: {}, Name: 'Acme' },
        },
      ],
    });
  }, '62.0');
  return { client, sent };
}

describe('a CSV of records next to the org', () => {
  const csv = parseCsv(
    'Id,Email,LastName,DoNotCall,Birthdate,Account.Name,Legacy__x\n' +
      'OLDID1,ANN@acme.com,Lee-Smith,TRUE,1990-05-01,Globex,1\n' +
      'OLDID2,new@acme.com,New,false,,Globex,2\n' +
      'OLDID3,,Nobody,,,,\n'
  );

  it('matches rows by a key, compares by value as Salesforce means it, lookups by name', async () => {
    const { client } = fakeOrg();
    const plan = await planCsv(client, 'Contact', csv.columns, 'Email');
    expect(plan.ignored).toEqual(['Legacy__x']);
    expect(plan.columns.find((c) => c.column === 'Account.Name')).toMatchObject({
      field: 'AccountId',
      lookup: { sobject: 'Account', nameField: 'Name' },
    });
    const results = await compareCsv(client, plan, csv);
    expect(results.map((r) => [r.key, r.status])).toEqual([
      ['ANN@acme.com', 'different'],
      ['new@acme.com', 'only in CSV'],
      ['', 'no key'],
    ]);
    expect(results[0].differences.map((d) => `${d.column}: ${d.org} → ${d.csv}`)).toEqual([
      'LastName: Lee → Lee-Smith',
      'Account.Name: Acme → Globex',
    ]);
  });

  it('updates what differs and inserts what is missing, with lookups found by name', async () => {
    const { client, sent } = fakeOrg();
    const plan = await planCsv(client, 'Contact', csv.columns, 'Email');
    const results = await compareCsv(client, plan, csv);
    const r = await applyCsv(client, plan, csv, results);
    expect(r).toEqual({ updated: 1, inserted: 1, failed: [] });
    expect(sent).toEqual([
      {
        method: 'PATCH',
        records: [
          {
            attributes: { type: 'Contact' },
            Id: '003000000000001AAA',
            LastName: 'Lee-Smith',
            AccountId: '001000000000002AAA',
          },
        ],
      },
      {
        method: 'POST',
        records: [
          {
            attributes: { type: 'Contact' },
            Email: 'new@acme.com',
            LastName: 'New',
            DoNotCall: false,
            AccountId: '001000000000002AAA',
          },
        ],
      },
    ]);
  });
});
