import { describe, expect, it } from 'vitest';
import { copySheets, fromCopySheets, managersFirst, type UserCopy } from '../src/index.js';

const user = (username: string, manager?: string): UserCopy => ({
  username,
  lines: [
    { Section: 'info', Name: 'user', Value: username },
    ...(manager ? [{ Section: 'lookup' as const, Name: 'ManagerId', Value: manager }] : []),
    { Section: 'permissionSet', Name: 'Sales', Value: '' },
  ],
});

describe('users for a sandbox', () => {
  it('puts a manager before the people who report to them', () => {
    const list = [user('ann@x.com', 'bob@x.com'), user('bob@x.com', 'cy@x.com'), user('cy@x.com'), user('dee@x.com')];
    expect(managersFirst(list).map((u) => u.username)).toEqual(['cy@x.com', 'bob@x.com', 'ann@x.com', 'dee@x.com']);
  });
  it('survives a loop of managers', () => {
    const list = [user('a@x.com', 'b@x.com'), user('b@x.com', 'a@x.com')];
    expect(managersFirst(list)).toHaveLength(2);
  });
  it('goes through the workbook sheets and back', () => {
    const users = [user('ann@x.com'), user('bob@x.com', 'ann@x.com')];
    const metadata = [{ type: 'PermissionSet' as const, name: 'Sales', xml: '<PermissionSet/>' }];
    const sheets = copySheets({ records: {}, users, metadata });
    const tables = sheets.map((s) => ({
      name: s.name,
      columns: s.columns,
      rows: s.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v)]))),
    }));
    const back = fromCopySheets(tables);
    expect(back.users).toEqual(users);
    expect(back.metadata).toEqual(metadata);
    expect(back.tables).toEqual([]);
  });
});
