import { describe, expect, it } from 'vitest';
import { SalesforceClient, usersAccessMap, whoCanAccess, type HttpRequest } from '../src/index.js';

function fakeOrg(answers: Array<[RegExp, unknown[]]>, permissionFields: string[]) {
  const soql: string[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    if (r.path.includes('/describe'))
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ fields: permissionFields.map((name) => ({ name, type: 'boolean' })) }),
      };
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    soql.push(q);
    const rows = answers.find(([re]) => re.test(q))?.[1] ?? [];
    return { status: 200, headers: {}, body: JSON.stringify({ totalSize: rows.length, done: true, records: rows }) };
  }, '62.0');
  return { client, soql };
}

describe('every user and their access', () => {
  it('collects sets, groups, licenses and powerful permissions from every source', async () => {
    const { client, soql } = fakeOrg(
      [
        [
          /FROM User/,
          [
            { Id: '005000000000001AAA', Name: 'Ann', Profile: { Name: 'Admin' }, UserRole: { Name: 'CEO' } },
            { Id: '005000000000002AAA', Name: 'Ben' },
          ],
        ],
        [
          /FROM PermissionSetAssignment/,
          [
            {
              AssigneeId: '005000000000001AAA',
              PermissionSet: { Label: 'x', IsOwnedByProfile: true, PermissionsModifyAllData: true },
            },
            {
              AssigneeId: '005000000000001AAA',
              PermissionSet: { Label: 'Sales Ops', Type: 'Regular', PermissionsApiEnabled: true },
            },
            {
              AssigneeId: '005000000000002AAA',
              PermissionSet: { Label: 'g', Type: 'Group', PermissionsApiEnabled: true },
              PermissionSetGroup: { MasterLabel: 'Team' },
            },
          ],
        ],
        [
          /FROM PermissionSetLicenseAssign/,
          [{ AssigneeId: '005000000000002AAA', PermissionSetLicense: { MasterLabel: 'CRM Analytics' } }],
        ],
      ],
      ['PermissionsModifyAllData', 'PermissionsApiEnabled']
    );
    const rows = await usersAccessMap(client);
    expect(rows[0]).toMatchObject({
      Name: 'Ann',
      Profile: 'Admin',
      Role: 'CEO',
      PermissionSets: 'Sales Ops',
      'Modify All Data': '✓',
      'API Enabled': '✓',
      'View All Data': '',
    });
    expect(rows[1]).toMatchObject({
      Name: 'Ben',
      Groups: 'Team',
      PermissionSetLicenses: 'CRM Analytics',
      'API Enabled': '✓',
    });
    // Only permission fields the org has are asked for
    expect(soql.find((q) => q.includes('FROM PermissionSetAssignment'))).not.toContain('PermissionsViewAllData');
  });
});

describe('who can use an object', () => {
  it('sums object and field access per user, through each source, with View All Data', async () => {
    const { client } = fakeOrg(
      [
        [
          /FROM ObjectPermissions/,
          [
            {
              ParentId: '0PS000000000001AAA',
              Parent: { IsOwnedByProfile: true, Profile: { Name: 'Sales' } },
              PermissionsRead: true,
              PermissionsEdit: true,
            },
            {
              ParentId: '0PS000000000002AAA',
              Parent: { Label: 'Deleters', Type: 'Regular' },
              PermissionsRead: true,
              PermissionsDelete: true,
            },
          ],
        ],
        [/FROM FieldPermissions/, [{ ParentId: '0PS000000000001AAA', PermissionsRead: true, PermissionsEdit: false }]],
        [
          /FROM PermissionSet WHERE PermissionsViewAllData = true/,
          [{ Id: '0PS000000000003AAA', Label: 'Auditor', Type: 'Regular', PermissionsViewAllData: true }],
        ],
        [
          /FROM PermissionSetAssignment/,
          [
            {
              AssigneeId: '005000000000001AAA',
              Assignee: { Name: 'Ann', Username: 'ann@x' },
              PermissionSetId: '0PS000000000001AAA',
            },
            {
              AssigneeId: '005000000000001AAA',
              Assignee: { Name: 'Ann', Username: 'ann@x' },
              PermissionSetId: '0PS000000000002AAA',
            },
            {
              AssigneeId: '005000000000002AAA',
              Assignee: { Name: 'Ben', Username: 'ben@x' },
              PermissionSetId: '0PS000000000003AAA',
            },
          ],
        ],
      ],
      ['PermissionsViewAllData', 'PermissionsModifyAllData']
    );
    const { rows } = await whoCanAccess(client, 'Account', 'Phone');
    expect(rows.map((r) => [r.Name, r.Read, r.Edit, r.Delete, r.ViewAll, r.FieldRead, r.FieldEdit, r.Through])).toEqual(
      [
        ['Ann', '✓', '✓', '✓', '', '✓', '', 'Profile: Sales; Permission set: Deleters'],
        ['Ben', '✓', '', '', '✓', '✓', '', 'Permission set: Auditor (View All Data)'],
      ]
    );
    await expect(whoCanAccess(client, "Account' OR")).rejects.toThrow('Invalid object');
  });
});
