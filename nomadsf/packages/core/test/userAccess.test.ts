import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  connectedAppsReport,
  effectivePermissions,
  groupKind,
  userAccess,
  type HttpRequest,
} from '../src/index.js';

const USER = '005000000000001AAA';
const OWNER_ORG = '00D000000000001AAA';

/** Answers each SOQL by its FROM object (and the PermissionSet describe). */
function fakeOrg(byObject: Record<string, unknown[] | Error>) {
  const soql: string[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    if (r.path.endsWith('/sobjects/PermissionSet/describe'))
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          fields: [
            { name: 'PermissionsApiEnabled', label: 'API Enabled', type: 'boolean' },
            { name: 'PermissionsModifyAllData', label: 'Modify All Data', type: 'boolean' },
            { name: 'Label', label: 'Label', type: 'string' },
          ],
        }),
      };
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    soql.push(q);
    const from = /FROM (\w+)/.exec(q)?.[1] ?? '';
    const rows = byObject[from] ?? [];
    if (rows instanceof Error) return { status: 400, headers: {}, body: JSON.stringify([{ message: rows.message }]) };
    return { status: 200, headers: {}, body: JSON.stringify({ totalSize: rows.length, done: true, records: rows }) };
  }, '62.0');
  return { client, soql };
}

describe('user access', () => {
  it('names groups: public group, queue, personal group', () => {
    expect(groupKind('Regular', OWNER_ORG)).toBe('Public group');
    expect(groupKind('Regular', USER)).toBe('Personal group');
    expect(groupKind('Queue', OWNER_ORG)).toBe('Queue');
  });

  it("splits a user's assignments into permission sets and groups, and lists groups, licenses and OAuth apps", async () => {
    const { client } = fakeOrg({
      PermissionSetAssignment: [
        { PermissionSetId: '0PS000000000001AAA', PermissionSet: { Label: 'Profile PS', IsOwnedByProfile: true } },
        {
          PermissionSetId: '0PS000000000002AAA',
          PermissionSet: { Label: 'Sales', Name: 'Sales', IsOwnedByProfile: false, Type: 'Regular' },
        },
        {
          PermissionSetId: '0PS000000000003AAA',
          PermissionSet: { Label: 'Group PS', IsOwnedByProfile: false, Type: 'Group' },
          PermissionSetGroupId: '0PG000000000001AAA',
          PermissionSetGroup: { MasterLabel: 'Support', DeveloperName: 'Support' },
        },
      ],
      PermissionSetLicenseAssign: [
        { PermissionSetLicense: { MasterLabel: 'Data Cloud', DeveloperName: 'DC', Status: 'Active' } },
      ],
      GroupMember: [
        { GroupId: '00G000000000001AAA', Group: { Name: 'All Sales', Type: 'Regular', OwnerId: OWNER_ORG } },
        { GroupId: '00G000000000002AAA', Group: { Name: 'Support queue', Type: 'Queue', OwnerId: OWNER_ORG } },
      ],
      Group: [{ Id: '00G000000000003AAA', Name: 'My people', Type: 'Regular', OwnerId: USER }],
      OauthToken: [{ AppName: 'Salesforce CLI', UseCount: 4, LastUsedDate: '2026-10-01', CreatedDate: '2026-01-01' }],
    });
    const access = await userAccess(client, USER);
    expect(access.permissionSets.map((p) => p.Label)).toEqual(['Sales']);
    expect(access.permissionSetGroups.map((p) => p.Label)).toEqual(['Support']);
    expect(access.licenses[0]).toMatchObject({ Label: 'Data Cloud', Status: 'Active' });
    expect(access.groups.map((g) => [g.Kind, g.Name])).toEqual([
      ['Personal group', 'My people'],
      ['Public group', 'All Sales'],
      ['Queue', 'Support queue'],
    ]);
    expect(access.oauthApps).toEqual([
      { App: 'Salesforce CLI', Uses: 4, LastUsed: '2026-10-01', Connected: '2026-01-01' },
    ]);
    await expect(userAccess(client, "005' OR Id != '")).rejects.toThrow('Invalid user Id');
  });

  it('combines system permissions from the profile, permission sets and groups, with what grants each', async () => {
    const { client, soql } = fakeOrg({
      PermissionSetAssignment: [
        { PermissionSetId: '0PS000000000001AAA' },
        { PermissionSetId: '0PS000000000002AAA' },
        { PermissionSetId: '0PS000000000003AAA', PermissionSetGroup: { MasterLabel: 'Support' } },
      ],
      PermissionSet: [
        {
          Id: '0PS000000000001AAA',
          Label: 'x',
          IsOwnedByProfile: true,
          Profile: { Name: 'Standard User' },
          PermissionsApiEnabled: true,
        },
        { Id: '0PS000000000002AAA', Label: 'Integrations', IsOwnedByProfile: false, PermissionsApiEnabled: true },
        { Id: '0PS000000000003AAA', Label: 'g', IsOwnedByProfile: false, PermissionsModifyAllData: true },
      ],
    });
    const perms = await effectivePermissions(client, USER);
    expect(perms).toEqual([
      { api: 'ApiEnabled', label: 'API Enabled', grantedBy: ['Profile: Standard User', 'Integrations'] },
      { api: 'ModifyAllData', label: 'Modify All Data', grantedBy: ['Group: Support'] },
    ]);
    expect(soql.at(-1)).toContain('PermissionsApiEnabled, PermissionsModifyAllData FROM PermissionSet WHERE Id IN');
  });
});

describe('connected apps report', () => {
  it('merges connected apps, external client apps and OAuth tokens per app, with users', async () => {
    const { client } = fakeOrg({
      ConnectedApplication: [{ Name: 'Mobile', CreatedDate: '2025-01-01' }],
      ExternalClientApplication: new Error("sObject type 'ExternalClientApplication' is not supported."),
      OauthToken: [
        {
          Id: '1',
          AppName: 'Mobile',
          UserId: 'U1',
          User: { Name: 'Ann', Username: 'ann@x', IsActive: true },
          UseCount: 3,
          LastUsedDate: '2026-02-01',
        },
        {
          Id: '2',
          AppName: 'Mobile',
          UserId: 'U2',
          User: { Name: 'Ben', Username: 'ben@x', IsActive: false },
          UseCount: 1,
          LastUsedDate: '2026-03-01',
        },
        {
          Id: '3',
          AppName: 'Salesforce CLI',
          UserId: 'U1',
          User: { Name: 'Ann', Username: 'ann@x' },
          UseCount: 9,
          LastUsedDate: '2026-01-01',
        },
      ],
    });
    const report = await connectedAppsReport(client);
    expect(report.apps.map((a) => [a.name, a.kind, a.users, a.tokens, a.uses, a.lastUsed])).toEqual([
      ['Mobile', 'Connected app', 2, 2, 4, '2026-03-01'],
      ['Salesforce CLI', 'OAuth only', 1, 1, 9, '2026-01-01'],
    ]);
    expect(report.tokens[1]).toMatchObject({ App: 'Mobile', User: 'Ben', Active: 'no' });
    expect(report.notes[0]).toMatch(/^External client apps:/);
  });
});
