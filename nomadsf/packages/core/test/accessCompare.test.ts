import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  accessOverview,
  compareConnectedApps,
  comparePermissionSets,
  findSameUser,
  findUserInBoth,
  sameHolder,
  sameUsername,
  usersWithInBoth,
  type HttpRequest,
} from '../src/index.js';

/** Answers each SOQL with the rows of the first matcher it fits, and describes with the given fields. */
function fakeOrg(answers: Array<[RegExp, unknown[]]>, describes: Record<string, unknown[]> = {}) {
  const soql: string[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const described = /\/sobjects\/(\w+)\/describe/.exec(r.path);
    if (described) return { status: 200, headers: {}, body: JSON.stringify({ fields: describes[described[1]] ?? [] }) };
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    soql.push(q);
    const rows = answers.find(([re]) => re.test(q))?.[1] ?? [];
    return { status: 200, headers: {}, body: JSON.stringify({ totalSize: rows.length, done: true, records: rows }) };
  }, '62.0');
  return { client, soql };
}

describe('the same user in two orgs', () => {
  it('matches equal usernames and sandbox suffixes, not other people', () => {
    expect(sameUsername('ann@acme.com', 'ann@acme.com')).toBe(true);
    expect(sameUsername('ann@acme.com', 'Ann@Acme.com.uat')).toBe(true);
    expect(sameUsername('ann@acme.com.dev', 'ann@acme.com')).toBe(true);
    expect(sameUsername('ann@acme.com', 'ann@acme.community')).toBe(false);
    expect(sameUsername('ann@acme.com.dev', 'ann@acme.com.uat')).toBe(true);
    expect(sameUsername('ann@acme.com.dev', 'ben@acme.com.dev')).toBe(false);
    expect(sameUsername('ann@acme.com', 'ann@acme.com.dev.x')).toBe(false);
    expect(sameUsername('', 'ann@acme.com')).toBe(false);
  });

  it('finds the user without the sandbox suffix, preferring the exact username', async () => {
    const { client, soql } = fakeOrg([
      [
        /FROM User/,
        [
          { Id: '005000000000002AAA', Name: 'Ann', Username: 'ann@acme.com.uat', IsActive: true },
          {
            Id: '005000000000001AAA',
            Name: 'Ann',
            Username: 'ann@acme.com',
            IsActive: true,
            Profile: { Name: 'Admin' },
          },
        ],
      ],
    ]);
    const found = await findSameUser(client, 'ann@acme.com.dev');
    expect(found).toMatchObject({ Id: '005000000000001AAA', Profile: 'Admin' });
    expect(soql[0]).toContain("Username IN ('ann@acme.com.dev', 'ann@acme.com')");
    expect(soql[0]).toContain("Username LIKE 'ann@acme.com.%'");
    expect(await findSameUser(client, "o'brien")).toBeNull();
  });
});

describe('a user in both orgs', () => {
  it('pairs the matches of both orgs by username, and finds a renamed user by username', async () => {
    const user = (Id: string, Name: string, Username: string) => ({ Id, Name, Username, IsActive: true });
    const a = fakeOrg([
      [/FROM User WHERE Username LIKE '%ann%'/, [user('005000000000001AAA', 'Ann Lee', 'ann@acme.com.dev')]],
    ]);
    const b = fakeOrg([
      [/FROM User WHERE Username LIKE '%ann%'/, [user('005000000000009AAA', 'Ann Other', 'ann.o@acme.com.uat')]],
      [/Username IN \('ann@acme.com.dev'/, [user('005000000000002AAA', 'Ann Lee-Smith', 'ann@acme.com.uat')]],
    ]);
    const rows = await findUserInBoth(a.client, b.client, 'ann');
    expect(rows.map((r) => [r.Name, r.in, r.usernameA, r.usernameB])).toEqual([
      ['Ann Lee', 'both', 'ann@acme.com.dev', 'ann@acme.com.uat'],
      ['Ann Other', 'only in B', '', 'ann.o@acme.com.uat'],
    ]);
  });

  it('pairs users with another username by their name', async () => {
    const a = fakeOrg([
      [/FROM User WHERE/, [{ Id: '005000000000001AAA', Name: 'Farid M', Username: 'farid@fm.com', IsActive: true }]],
    ]);
    const b = fakeOrg([
      [
        /FROM User WHERE Username LIKE '%farid%'/,
        [{ Id: '005000000000002AAA', Name: 'Farid M', Username: 'farid@scratch.com', IsActive: true }],
      ],
    ]);
    const rows = await findUserInBoth(a.client, b.client, 'farid');
    expect(rows.map((r) => [r.in, r.usernameA, r.usernameB, r.idA, r.idB])).toEqual([
      ['both (by name)', 'farid@fm.com', 'farid@scratch.com', '005000000000001AAA', '005000000000002AAA'],
    ]);
  });
});

describe('who has it in two orgs', () => {
  it('matches holders by API name and lists users in both, or only in one', async () => {
    expect(
      sameHolder(
        [
          { kind: 'permset', id: '0PS000000000009AAA', label: 'Sales (new)', detail: 'Sales_Ops' },
          { kind: 'profile', id: '00e000000000009AAA', label: 'Support', detail: 'Salesforce' },
        ],
        { kind: 'permset', id: '0PS000000000001AAA', label: 'Sales', detail: 'sales_ops' }
      )?.id
    ).toBe('0PS000000000009AAA');
    const user = (n: number, Username: string) => ({
      Assignee: { Id: `00500000000000${n}AAA`, Name: Username.split('@')[0], Username, IsActive: true },
    });
    const a = fakeOrg([[/PermissionSetAssignment/, [user(1, 'ann@acme.com.dev'), user(2, 'ben@acme.com.dev')]]]);
    const b = fakeOrg([[/PermissionSetAssignment/, [user(3, 'ann@acme.com'), user(4, 'cat@acme.com')]]]);
    const rows = await usersWithInBoth(a.client, { kind: 'permset', id: '0PS000000000001AAA' }, b.client, {
      kind: 'permset',
      id: '0PS000000000002AAA',
    });
    expect(rows.map((r) => [r.Name, r.in, r.usernameB])).toEqual([
      ['ben', 'only in A', ''],
      ['cat', 'only in B', 'cat@acme.com'],
      ['ann', 'both', 'ann@acme.com'],
    ]);
    const missing = await usersWithInBoth(a.client, { kind: 'permset', id: '0PS000000000001AAA' }, b.client, undefined);
    expect(missing.every((r) => r.in === 'only in A')).toBe(true);
  });
});

describe('every profile and permission set of two orgs', () => {
  const perms = [
    { name: 'PermissionsApiEnabled', type: 'boolean' },
    { name: 'PermissionsModifyAllData', type: 'boolean' },
  ];
  const set = (Id: string, Name: string, extra: Record<string, unknown> = {}) => ({
    Id,
    Name,
    Label: Name.replace(/_/g, ' '),
    Type: 'Regular',
    IsOwnedByProfile: false,
    ...extra,
  });

  it('keys profiles by name and permission sets by API name, and counts what differs', async () => {
    const a = fakeOrg(
      [
        [
          /FROM PermissionSet/,
          [
            set('0PS000000000001AAA', 'X00e1', {
              IsOwnedByProfile: true,
              Profile: { Name: 'Admin' },
              PermissionsModifyAllData: true,
            }),
            set('0PS000000000002AAA', 'Sales_Ops', { PermissionsApiEnabled: true }),
            set('0PS000000000003AAA', 'Only_Dev'),
          ],
        ],
        [
          /FROM ObjectPermissions/,
          [{ ParentId: '0PS000000000002AAA', SobjectType: 'Account', PermissionsRead: true, PermissionsEdit: true }],
        ],
      ],
      { PermissionSet: perms }
    );
    const b = fakeOrg(
      [
        [
          /FROM PermissionSet/,
          [
            set('0PS000000000011AAA', 'X00e9', {
              IsOwnedByProfile: true,
              Profile: { Name: 'Admin' },
              PermissionsModifyAllData: true,
            }),
            set('0PS000000000012AAA', 'Sales_Ops'),
          ],
        ],
        [/FROM ObjectPermissions/, [{ ParentId: '0PS000000000012AAA', SobjectType: 'Account', PermissionsRead: true }]],
      ],
      { PermissionSet: [perms[0]] }
    );
    const rows = await accessOverview(a.client, b.client);
    expect(rows.map((r) => [r.kind, r.name, r.status, r.systemPermissions, r.objectAccess])).toEqual([
      ['Permission set', 'Only Dev', 'only in A', '', ''],
      ['Permission set', 'Sales Ops', 'different', 1, 1],
      // Modify All Data is not a field in B's describe: left out
      ['Profile', 'Admin', 'same', 0, 0],
    ]);
    expect(rows[1]).toMatchObject({ idA: '0PS000000000002AAA', idB: '0PS000000000012AAA' });
  });

  it('compares one pair across orgs, with field access', async () => {
    const side = (edit: boolean) =>
      fakeOrg(
        [
          [/FROM PermissionSet WHERE Id/, [{ PermissionsApiEnabled: true }]],
          [
            /FROM FieldPermissions/,
            [{ SobjectType: 'Account', Field: 'Account.Phone', PermissionsRead: true, PermissionsEdit: edit }],
          ],
        ],
        { PermissionSet: [{ name: 'PermissionsApiEnabled', label: 'API Enabled', type: 'boolean' }] }
      ).client;
    expect(await comparePermissionSets(side(true), '0PS000000000001AAA', '0PS000000000002AAA', side(false))).toEqual([
      {
        area: 'Field access',
        item: 'Account.Phone',
        a: 'Read, Edit',
        b: 'Read',
        change: { kind: 'field', field: 'Account.Phone', read: true, edit: true },
      },
    ]);
  });
});

describe('connected apps of two orgs', () => {
  it('lists apps only in one org, and settings and access that differ', async () => {
    const side = (admin: boolean, extraApp: string, grants: unknown[]) =>
      fakeOrg(
        [
          [
            /FROM ConnectedApplication ORDER BY Name/,
            [
              { Id: '0H4000000000001AAA', Name: 'Partner API' },
              { Id: '0H4000000000002AAA', Name: extraApp },
            ],
          ],
          [
            /FROM ConnectedApplication$/,
            [{ Id: '0H4000000000001AAA', Name: 'Partner API', OptionsAllowAdminApprovedUsersOnly: admin }],
          ],
          [/FROM SetupEntityAccess/, grants],
        ],
        { ConnectedApplication: [{ name: 'OptionsAllowAdminApprovedUsersOnly', label: 'Admin approved users only' }] }
      ).client;
    const grant = (Name: string) => ({
      SetupEntityId: '0H4000000000001AAA',
      Parent: { Name, Type: 'Regular', IsOwnedByProfile: false },
    });
    const { apps } = await compareConnectedApps(
      side(true, 'Old Dashboard', [grant('Integration')]),
      side(false, 'New Portal', [])
    );
    expect(apps.map((x) => [x.name, x.status])).toEqual([
      ['Old Dashboard', 'only in A'],
      ['New Portal', 'only in B'],
      ['Partner API', 'different'],
    ]);
    expect(apps[2].differences).toEqual([
      { area: 'Setting', item: 'Admin approved users only', a: 'true', b: 'false' },
      { area: 'Who may use it', item: 'Permission set: Integration', a: '✓', b: '' },
    ]);
  });
});
