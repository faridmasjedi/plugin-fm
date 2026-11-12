import { describe, expect, it } from 'vitest';
import { copySheets, fromCopySheets, type UserCopy } from '../src/index.js';

const report = [
  {
    name: 'Details',
    columns: ['Label', 'API name', 'Value'],
    rows: [
      { Label: 'Username', 'API name': 'Username', Value: 'dina@x.com' },
      { Label: 'Email', 'API name': 'Email', Value: 'dina@x.com' },
      { Label: 'Profile ID', 'API name': 'ProfileId', Value: '00e000000000001AAA' },
      { Label: 'Last Name', 'API name': 'LastName', Value: 'Patel' },
    ],
  },
  {
    name: 'Permission sets',
    columns: ['Label', 'Name', 'ExpirationDate'],
    rows: [{ Label: 'S', Name: 'Sales', ExpirationDate: '' }],
  },
  {
    name: 'Groups & queues',
    columns: ['Name', 'Kind', 'DeveloperName', 'Member', 'Owner'],
    rows: [
      { Name: 'Q', Kind: 'Queue', DeveloperName: 'Cases_Q', Member: '✓', Owner: '' },
      { Name: 'Mine', Kind: 'Personal group', DeveloperName: 'Mine', Member: '', Owner: '✓' },
    ],
  },
  { name: 'Login history', columns: ['LoginTime'], rows: [{ LoginTime: '2026-11-12' }] },
];

describe('an Everything workbook in Open a saved copy', () => {
  it('reads an older one as the user, not as records', () => {
    const r = fromCopySheets(report);
    expect(r.tables).toHaveLength(0);
    expect(r.olderReport).toBe(true);
    expect(r.users[0].username).toBe('dina@x.com');
    const lines = r.users[0].lines.map((l) => `${l.Section}:${l.Name}`);
    expect(lines).toContain('field:LastName');
    expect(lines).not.toContain('field:ProfileId');
    expect(lines).toContain('permissionSet:Sales');
    expect(lines).toContain('group:Cases_Q');
    expect(lines).not.toContain('group:Mine');
  });
  it('takes the user sheet when the workbook carries it', () => {
    const user: UserCopy = {
      username: 'dina@x.com',
      lines: [
        { Section: 'info', Name: 'user', Value: 'dina@x.com' },
        { Section: 'lookup', Name: 'ProfileId', Value: 'Standard User' },
      ],
    };
    const sheets = [...report, ...copySheets({ records: {}, users: [user], metadata: [] })].map((s) => ({
      name: s.name,
      columns: s.columns,
      rows: s.rows.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, String(v)]))),
    }));
    const r = fromCopySheets(sheets);
    expect(r.tables).toHaveLength(0);
    expect(r.olderReport).toBe(false);
    expect(r.users[0].lines).toContainEqual({ Section: 'lookup', Name: 'ProfileId', Value: 'Standard User' });
  });
});
