import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  holdersOf,
  licenseReport,
  securityReport,
  usersWith,
  type HttpRequest,
} from '../src/index.js';

/** Answers each SOQL with the rows of the first matcher it fits. */
function fakeOrg(answers: Array<[RegExp, unknown[] | Error]>) {
  const soql: string[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    soql.push(q);
    const hit = answers.find(([re]) => re.test(q));
    const rows = hit?.[1] ?? [];
    if (rows instanceof Error) return { status: 400, headers: {}, body: JSON.stringify([{ message: rows.message }]) };
    return { status: 200, headers: {}, body: JSON.stringify({ totalSize: rows.length, done: true, records: rows }) };
  }, '62.0');
  return { client, soql };
}

describe('who has it', () => {
  it('lists profiles with their license, and the users of a profile', async () => {
    const { client, soql } = fakeOrg([
      [/FROM Profile/, [{ Id: '00e000000000001AAA', Name: 'Support Agent', UserLicense: { Name: 'Salesforce' } }]],
      [
        /FROM User WHERE ProfileId/,
        [{ Id: '005000000000001AAA', Name: 'Tom', IsActive: true, Profile: { Name: 'Support Agent' } }],
      ],
    ]);
    expect(await holdersOf(client, 'profile')).toEqual([
      { kind: 'profile', id: '00e000000000001AAA', label: 'Support Agent', detail: 'Salesforce' },
    ]);
    const users = await usersWith(client, { kind: 'profile', id: '00e000000000001AAA' });
    expect(users[0]).toMatchObject({ Name: 'Tom', 'Profile.Name': 'Support Agent' });
    expect(soql.at(-1)).toContain("WHERE ProfileId = '00e000000000001AAA'");
    await expect(usersWith(client, { kind: 'role', id: "x' OR Id != '" })).rejects.toThrow('Invalid Id');
  });

  it('reads license assignees without the Assignee. prefix, and queue members as users', async () => {
    const { client } = fakeOrg([
      [/FROM PermissionSetLicenseAssign/, [{ Assignee: { Id: '005000000000001AAA', Name: 'Ann', IsActive: true } }]],
      [/FROM GroupMember/, [{ UserOrGroupId: '005000000000002AAA' }, { UserOrGroupId: '00G000000000009AAA' }]],
      [/FROM User WHERE Id IN/, [{ Id: '005000000000002AAA', Name: 'Ben', IsActive: true }]],
    ]);
    expect((await usersWith(client, { kind: 'license', id: '0PL000000000001AAA' }))[0]).toMatchObject({ Name: 'Ann' });
    const members = await usersWith(client, { kind: 'queue', id: '00G000000000001AAA' });
    expect(members.map((m) => m.Name)).toEqual(['Ben', '+ 1 group(s) or role(s) as members']);
  });
});

describe('security report', () => {
  it('merges powerful permissions per user with what grants them, and lists unassigned permission sets', async () => {
    const assignment = (perm: string) =>
      [
        new RegExp(`Permissions${perm} = true`),
        [
          {
            Assignee: { Id: '005000000000001AAA', Name: 'Alex', Username: 'alex@x' },
            PermissionSet: { Label: 'x', IsOwnedByProfile: true, Profile: { Name: 'System Administrator' } },
          },
        ],
      ] as [RegExp, unknown[]];
    const { client } = fakeOrg([
      [/FROM SecurityHealthCheck$/, [{ Score: '66' }]],
      [/FROM SecurityHealthCheckRisks/, new Error('not available')],
      assignment('ModifyAllData'),
      assignment('ApiEnabled'),
      [/FROM PermissionSet WHERE IsOwnedByProfile = false/, [{ Id: '0PS000000000002AAA', Label: 'Unused' }]],
      [/FROM User WHERE IsActive = true/, [{ Name: 'Old account', LastLoginDate: null }]],
    ]);
    const report = await securityReport(client, 90);
    expect(report.score).toBe(66);
    expect(report.powerUsers).toEqual([
      {
        Name: 'Alex',
        Username: 'alex@x',
        Permissions: 'Modify All Data, API Enabled',
        Count: 2,
        GrantedBy: 'Profile: System Administrator',
      },
    ]);
    expect(report.unusedPermissionSets.map((p) => p.Label)).toEqual(['Unused']);
    expect(report.dormant).toHaveLength(1);
    expect(report.notes[0]).toMatch(/^Health Check risks:/);
  });
});

describe('licenses', () => {
  it('lists user and permission set licenses with the share used', async () => {
    const { client } = fakeOrg([
      [
        /FROM UserLicense/,
        [{ Id: '100000000000001AAA', Name: 'Salesforce', Status: 'Active', TotalLicenses: 4, UsedLicenses: 3 }],
      ],
      [
        /FROM PermissionSetLicense/,
        [
          {
            Id: '0PL000000000001AAA',
            MasterLabel: 'Data Cloud',
            Status: 'Active',
            TotalLicenses: 0 + 8,
            UsedLicenses: 2,
          },
        ],
      ],
    ]);
    expect((await licenseReport(client)).map((l) => [l.kind, l.name, l.used, l.total, l.percent])).toEqual([
      ['User license', 'Salesforce', 3, 4, 75],
      ['Permission set license', 'Data Cloud', 2, 8, 25],
    ]);
  });
});
