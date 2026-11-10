import { describe, expect, it } from 'vitest';
import { SalesforceClient, listGroupMembers, opensMembers, whoIsIn, type HttpRequest } from '../src/index.js';

const R = (n: number) => `00E00000000000${n}AAA`;
const roles = [
  { Id: R(1), Name: 'Sales VP', ParentRoleId: null, PortalType: 'None' },
  { Id: R(2), Name: 'Sales Manager', ParentRoleId: R(1), PortalType: 'None' },
  { Id: R(3), Name: 'Partner Exec', ParentRoleId: R(2), PortalType: 'Partner' },
];
const users = [
  {
    Id: '005000000000001AAA',
    Name: 'Vera',
    Username: 'vera@x',
    IsActive: true,
    UserRoleId: R(1),
    UserRole: { Name: 'Sales VP' },
  },
  {
    Id: '005000000000002AAA',
    Name: 'Max',
    Username: 'max@x',
    IsActive: false,
    UserRoleId: R(2),
    UserRole: { Name: 'Sales Manager' },
  },
  {
    Id: '005000000000003AAA',
    Name: 'Pat',
    Username: 'pat@x',
    IsActive: true,
    UserRoleId: R(3),
    UserRole: { Name: 'Partner Exec' },
  },
];

const org = new SalesforceClient(async (r: HttpRequest) => {
  const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
  let records: unknown[] = [];
  if (/FROM GroupMember WHERE GroupId = '00G000000000000AAA'/.test(q))
    records = [
      { Id: '011000000000001AAA', UserOrGroupId: '00G000000000010AAA' },
      { Id: '011000000000002AAA', UserOrGroupId: '00G000000000020AAA' },
      { Id: '011000000000003AAA', UserOrGroupId: '00G000000000030AAA' },
    ];
  else if (/FROM GroupMember WHERE GroupId = '00G000000000030AAA'/.test(q))
    records = [{ Id: '011000000000009AAA', UserOrGroupId: '005000000000001AAA' }];
  else if (/FROM Group WHERE Id IN/.test(q))
    records = [
      { Id: '00G000000000010AAA', Type: 'Role', RelatedId: R(2) },
      { Id: '00G000000000020AAA', Type: 'RoleAndSubordinatesInternal', RelatedId: R(1) },
      { Id: '00G000000000030AAA', Type: 'Regular', Name: 'EMEA', DeveloperName: 'EMEA' },
    ];
  else if (/FROM UserRole WHERE Id IN/.test(q)) records = roles.filter((x) => q.includes(x.Id));
  else if (/FROM UserRole/.test(q)) records = roles;
  else if (/FROM User WHERE Id IN/.test(q)) records = users.filter((u) => q.includes(u.Id));
  else if (/FROM User WHERE UserRoleId IN/.test(q)) records = users.filter((u) => q.includes(u.UserRoleId));
  return { status: 200, headers: {}, body: JSON.stringify({ totalSize: records.length, done: true, records }) };
}, '62.0');

describe('who is inside a member of a group', () => {
  it('opens a role, a role and its internal subordinates, and a public group', async () => {
    const members = await listGroupMembers(org, '00G000000000000AAA');
    expect(members.map((m) => [m.Kind, m.Name, opensMembers(m)])).toEqual([
      ['Public group', 'EMEA', true],
      ['Role', 'Sales Manager', true],
      ['Role and subordinates', 'Sales VP', true],
    ]);
    const [group, role, below] = members;
    expect((await whoIsIn(org, role)).map((u) => [u.Name, u.Detail])).toEqual([['Max', 'max@x · inactive']]);
    // Internal subordinates only: the partner role below is left out
    expect((await whoIsIn(org, below)).map((u) => [u.Name, u.Detail])).toEqual([
      ['Max', 'max@x · role Sales Manager · inactive'],
      ['Vera', 'vera@x · role Sales VP'],
    ]);
    expect((await whoIsIn(org, group)).map((u) => u.Name)).toEqual(['Vera']);
  });
});
