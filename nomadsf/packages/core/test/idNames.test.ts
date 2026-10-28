import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  addToSelect,
  idColumns,
  lookupIdNames,
  withIdNames,
  type HttpRequest,
} from '../src/index.js';

const U1 = '005000000000001AAA';
const U2 = '005000000000002AAA';
const C1 = '003000000000001AAA';
const L1 = '00Q000000000001AAA';

function fakeOrg() {
  const queries: string[] = [];
  const describe = (nameField: string, extra: string[] = []) => ({
    queryable: true,
    fields: [
      { name: 'Id', nameField: false },
      { name: nameField, nameField: true },
      ...extra.map((n) => ({ name: n, nameField: false })),
    ],
  });
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
    if (r.path.endsWith('/sobjects'))
      return json({
        sobjects: [
          { name: 'User', keyPrefix: '005', queryable: true },
          { name: 'Contact', keyPrefix: '003', queryable: true },
          { name: 'Lead', keyPrefix: '00Q', queryable: true },
        ],
      });
    if (r.path.endsWith('/User/describe')) return json(describe('Name', ['Username']));
    if (r.path.endsWith('/Contact/describe') || r.path.endsWith('/Lead/describe')) return json(describe('Name'));
    const soql = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    queries.push(soql);
    const people: Record<string, Record<string, unknown>> = {
      [U1]: {
        Name: 'Farid Masjedi',
        Username: 'farid@fm.plugin.com',
        Email: 'farid@example.com',
        Profile: { attributes: {}, Name: 'System Administrator' },
      },
      [U2]: { Name: 'Integration User', Username: 'int@fm.plugin.com', Email: 'int@example.com', Profile: null },
      [C1]: { Name: 'Ada Contact' },
      [L1]: { Name: 'Lee Lead' },
    };
    const ids = [...soql.matchAll(/'(\w{18})'/g)].map((m) => m[1]);
    return json({
      totalSize: ids.length,
      done: true,
      records: ids.map((Id) => ({ attributes: {}, Id, ...people[Id] })),
    });
  }, '62.0');
  return { client, queries };
}

describe('names for Id columns', () => {
  it('finds the columns that hold record Ids', () => {
    const rows = [{ Id: U1, UserId: U1, Status: 'Success', LoginTime: '2026-10-18' }];
    expect(idColumns(['Id', 'UserId', 'Status', 'LoginTime'], rows)).toEqual(['UserId']);
  });

  it('adds user names and usernames next to LoginHistory.UserId', async () => {
    const { client, queries } = fakeOrg();
    const rows = [
      { Id: '0Ya000000000001AAA', UserId: U1, Status: 'Success' },
      { Id: '0Ya000000000002AAA', UserId: U2, Status: 'Failed' },
      { Id: '0Ya000000000003AAA', UserId: U1, Status: 'Success' },
    ];
    const lookup = await lookupIdNames(client, ['Id', 'UserId', 'Status'], rows);
    const shown = withIdNames(['Id', 'UserId', 'Status'], rows, lookup);
    expect(shown.columns).toEqual(['Id', 'UserId', 'UserId → Name', 'UserId → Username', 'Status']);
    expect(shown.rows[1]).toMatchObject({
      'UserId → Name': 'Integration User',
      'UserId → Username': 'int@fm.plugin.com',
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/^SELECT Id, Name, Username FROM User WHERE Id IN/);

    // Loading more rows only asks for new Ids
    const more = [...rows, { Id: '0Ya000000000004AAA', UserId: U2, Status: 'Success' }];
    await lookupIdNames(client, ['Id', 'UserId', 'Status'], more, { known: lookup });
    expect(queries).toHaveLength(1);
  });

  it('handles a column mixing Contacts and Leads', async () => {
    const { client } = fakeOrg();
    const rows = [
      { Id: '00T000000000001AAA', WhoId: C1 },
      { Id: '00T000000000002AAA', WhoId: L1 },
      { Id: '00T000000000003AAA', WhoId: null },
    ];
    const shown = withIdNames(['Id', 'WhoId'], rows, await lookupIdNames(client, ['Id', 'WhoId'], rows));
    expect(shown.rows.map((r) => r['WhoId → Name'])).toEqual(['Ada Contact', 'Lee Lead', '']);
  });

  it('adds the fields chosen for an object, paths included, after the name', async () => {
    const { client, queries } = fakeOrg();
    const rows = [
      { Id: '0Ya000000000001AAA', UserId: U1 },
      { Id: '0Ya000000000002AAA', UserId: U2 },
    ];
    const lookup = await lookupIdNames(client, ['Id', 'UserId'], rows, {
      related: { User: ['Email', 'Profile.Name', 'Id', 'bad field; DELETE'] },
    });
    expect(queries[0]).toMatch(/^SELECT Id, Name, Username, Email, Profile\.Name FROM User WHERE Id IN/);
    expect(lookup.objects).toEqual({ UserId: ['User'] });
    const shown = withIdNames(['Id', 'UserId'], rows, lookup);
    expect(shown.columns).toEqual([
      'Id',
      'UserId',
      'UserId → Name',
      'UserId → Username',
      'UserId → Email',
      'UserId → Profile.Name',
    ]);
    expect(shown.rows[0]['UserId → Profile.Name']).toBe('System Administrator');
    expect(shown.rows[1]['UserId → Profile.Name']).toBe('');
  });

  it('can leave the names out and read only the chosen fields', async () => {
    const { client, queries } = fakeOrg();
    const rows = [{ Id: '0Ya000000000001AAA', UserId: U1 }];
    const lookup = await lookupIdNames(client, ['Id', 'UserId'], rows, { names: false, related: { User: ['Email'] } });
    expect(queries[0]).toMatch(/^SELECT Id, Email FROM User/);
    expect(withIdNames(['Id', 'UserId'], rows, lookup).columns).toEqual(['Id', 'UserId', 'UserId → Email']);
  });

  it('only finds the objects when nothing is to be read', async () => {
    const { client, queries } = fakeOrg();
    const rows = [
      { Id: '00T000000000001AAA', WhoId: C1 },
      { Id: '00T000000000002AAA', WhoId: L1 },
    ];
    const lookup = await lookupIdNames(client, ['Id', 'WhoId'], rows, { names: false });
    expect(queries).toHaveLength(0);
    expect(lookup.objects).toEqual({ WhoId: ['Contact', 'Lead'] });
  });
});

describe('addToSelect', () => {
  it('adds fields before the top-level FROM', () => {
    expect(addToSelect('SELECT Id, Subject FROM Case LIMIT 5', ['Account.Name', 'Account.CreatedDate'])).toBe(
      'SELECT Id, Subject, Account.Name, Account.CreatedDate FROM Case LIMIT 5'
    );
  });
  it('skips subqueries, strings and fields already there', () => {
    const soql = "SELECT Id, account.name, (SELECT Id FROM Contacts) FROM Account WHERE Name = ' from x'";
    expect(addToSelect(soql, ['Account.Name', 'Owner.Name'])).toBe(
      "SELECT Id, account.name, (SELECT Id FROM Contacts), Owner.Name FROM Account WHERE Name = ' from x'"
    );
    expect(addToSelect('SELECT Id\nFROM Case', ['Id'])).toBe('SELECT Id\nFROM Case');
  });
});
