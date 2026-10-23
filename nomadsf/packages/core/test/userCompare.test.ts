import { describe, expect, it } from 'vitest';
import { SalesforceClient, compareUsersFully, type HttpRequest } from '../src/index.js';

function fakeOrg(answers: Array<[RegExp, unknown[]]>) {
  return new SalesforceClient(async (r: HttpRequest) => {
    if (r.path.includes('/describe')) return { status: 200, headers: {}, body: JSON.stringify({ fields: [] }) };
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    const rows = answers.find(([re]) => re.test(q))?.[1] ?? [];
    return { status: 200, headers: {}, body: JSON.stringify({ totalSize: rows.length, done: true, records: rows }) };
  }, '62.0');
}

const user = (profile: string) =>
  [
    /FROM User WHERE Id/,
    [
      {
        Name: 'Ann',
        Username: 'ann@x',
        IsActive: true,
        Profile: { Name: profile, UserLicense: { Name: 'Salesforce' } },
        ProfileId: '00e000000000001AAA',
      },
    ],
  ] as [RegExp, unknown[]];
const assignment = (Label: string, Name: string, Id: string, group?: { id: string; label: string; name: string }) => ({
  PermissionSetId: Id,
  PermissionSet: { Label, Name, IsOwnedByProfile: false, Type: group ? 'Group' : 'Regular' },
  PermissionSetGroupId: group?.id ?? null,
  PermissionSetGroup: group ? { MasterLabel: group.label, DeveloperName: group.name } : null,
});

describe('two users side by side', () => {
  it('pairs profile, permission sets and groups (with the sets to compare), and keeps the last logins', async () => {
    const a = fakeOrg([
      user('Sales'),
      [
        /FROM PermissionSetAssignment WHERE AssigneeId/,
        [
          assignment('Sales Ops', 'Sales_Ops', '0PS00000000000AAAA'),
          assignment('Only A', 'Only_A', '0PS00000000000BAAA'),
          assignment('Team', 'Team_G', '0PS00000000000GAAA', { id: '0PG000000000001AAA', label: 'Team', name: 'Team' }),
        ],
      ],
      [/FROM PermissionSet WHERE ProfileId/, [{ Id: '0PS0000000000P1AAA' }]],
      [
        /FROM PermissionSet WHERE PermissionSetGroupId IN/,
        [{ Id: '0PS00000000000GAAA', PermissionSetGroupId: '0PG000000000001AAA' }],
      ],
      [/FROM LoginHistory/, [{ LoginTime: '2026-10-20T10:00:00.000+0000', Status: 'Success' }]],
    ]);
    const b = fakeOrg([
      user('Sales Rep'),
      [/FROM PermissionSetAssignment WHERE AssigneeId/, [assignment('Sales Ops', 'Sales_Ops', '0PS00000000000ZAAA')]],
      [/FROM PermissionSet WHERE ProfileId/, [{ Id: '0PS0000000000P2AAA' }]],
    ]);
    const result = await compareUsersFully(a, '005000000000001AAA', '005000000000002AAA', b);
    expect(result.details.find((d) => d.field === 'Profile')).toEqual({
      field: 'Profile',
      a: 'Sales',
      b: 'Sales Rep',
      same: false,
    });
    expect(result.details.find((d) => d.field === 'User license')?.same).toBe(true);
    expect(result.items.map((i) => [i.area, i.item, i.in, i.idA, i.idB])).toEqual([
      ['Profile', 'Sales ↔ Sales Rep', 'both', '0PS0000000000P1AAA', '0PS0000000000P2AAA'],
      ['Permission set', 'Only A', 'only in A', '0PS00000000000BAAA', undefined],
      ['Permission set', 'Sales Ops', 'both', '0PS00000000000AAAA', '0PS00000000000ZAAA'],
      ['Permission set group', 'Team', 'only in A', '0PS00000000000GAAA', undefined],
    ]);
    expect(result.loginsA).toHaveLength(1);
    expect(result.loginsB).toEqual([]);
  });
});
