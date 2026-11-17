import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  compareSharing,
  shareTable,
  userFullAccess,
  userRecordSharing,
  type HttpRequest,
  type OrgObjectSharing,
} from '../src/index.js';

/** Answers SOQL by matcher (an Error answers 400) and readMetadata with the given XML. */
function fakeOrg(answers: Array<[RegExp, unknown[] | Error]>, metadataXml = '') {
  const soql: string[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    if (r.path.includes('/Soap/m/')) return { status: 200, headers: {}, body: metadataXml };
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    soql.push(q);
    const hit = answers.find(([re]) => re.test(q))?.[1] ?? [];
    if (hit instanceof Error) return { status: 400, headers: {}, body: JSON.stringify([{ message: hit.message }]) };
    return { status: 200, headers: {}, body: JSON.stringify({ totalSize: hit.length, done: true, records: hit }) };
  }, '62.0');
  return { client, soql };
}

const USER = '005000000000001AAA';
const PROFILE_PS = '0PS000000000001AAA';
const FINANCE = '0PS000000000002AAA';
const GROUP_PS = '0PS000000000003AAA';

const assignments = [
  {
    PermissionSetId: PROFILE_PS,
    PermissionSet: {
      Name: 'X00e',
      Label: 'X00e',
      IsOwnedByProfile: true,
      ProfileId: '00e000000000001AAA',
      Profile: { Name: 'Sales' },
    },
  },
  { PermissionSetId: FINANCE, PermissionSet: { Name: 'Finance', Label: 'Finance', IsOwnedByProfile: false } },
  {
    PermissionSetId: GROUP_PS,
    PermissionSet: { Name: 'Grp', Label: 'Grp', IsOwnedByProfile: false },
    PermissionSetGroupId: '0PG000000000001AAA',
    PermissionSetGroup: { MasterLabel: 'Support' },
  },
];

describe("a user's full access", () => {
  it('combines the profile, permission sets and groups, each row with where it comes from', async () => {
    const { client } = fakeOrg(
      [
        [/FROM PermissionSetAssignment/, assignments],
        [
          /FROM ObjectPermissions/,
          [
            { ParentId: PROFILE_PS, SobjectType: 'Account', PermissionsRead: true },
            { ParentId: FINANCE, SobjectType: 'Account', PermissionsRead: true, PermissionsEdit: true },
            { ParentId: FINANCE, SobjectType: 'Invoice__c', PermissionsRead: false },
          ],
        ],
        [
          /FROM FieldPermissions/,
          [
            { ParentId: PROFILE_PS, Field: 'Account.Phone', PermissionsRead: true, PermissionsEdit: false },
            { ParentId: GROUP_PS, Field: 'Account.Phone', PermissionsRead: true, PermissionsEdit: true },
            { ParentId: GROUP_PS, Field: 'Case.', PermissionsRead: true },
          ],
        ],
        [
          /FROM SetupEntityAccess/,
          [{ ParentId: FINANCE, SetupEntityId: '01p000000000001AAA', SetupEntityType: 'ApexClass' }],
        ],
        [/FROM ApexClass WHERE Id IN/, [{ Id: '01p000000000001AAA', Name: 'InvoiceService' }]],
        [
          /FROM PermissionSetTabSetting/,
          [
            { ParentId: PROFILE_PS, Name: 'standard-Account', Visibility: 'DefaultOff' },
            { ParentId: FINANCE, Name: 'standard-Account', Visibility: 'Visible' },
          ],
        ],
        [/SELECT FullName FROM Profile/, [{ FullName: 'Sales' }]],
        [
          /FROM PermissionSetGroupComponent/,
          [{ PermissionSetGroupId: '0PG000000000001AAA', PermissionSet: { Name: 'Agents' } }],
        ],
        [/FROM ProfileLayout/, [{ Layout: { Name: 'Account Layout' }, RecordTypeId: null, TableEnumOrId: 'Account' }]],
      ],
      '<result><records xsi:type="Profile"><fullName>Sales</fullName><recordTypeVisibilities><default>true</default><recordType>Account.Customer</recordType><visible>true</visible></recordTypeVisibilities></records><records xsi:type="PermissionSet"><fullName>Agents</fullName><recordTypeVisibilities><recordType>Case.Support</recordType><visible>true</visible></recordTypeVisibilities></records></result>'
    );
    const { holders, sections } = await userFullAccess(client, USER);
    expect(holders.map((h) => h.via)).toEqual(['Profile: Sales', 'Finance', 'Group: Support']);
    const get = (id: string) => sections.find((s) => s.id === id)!;
    expect(get('objects').rows).toEqual([
      { Object: 'Account', Read: '✓', Edit: '✓', Via: 'Profile: Sales (Read) · Finance (Read, Edit)' },
    ]);
    expect(get('fields').rows).toEqual([
      { Object: 'Account', Field: 'Phone', Access: 'Read, Edit', Via: 'Profile: Sales (Read) · Group: Support (Edit)' },
    ]);
    expect(get('classes').rows).toEqual([{ Class: 'InvoiceService', Via: 'Finance' }]);
    expect(get('tabs').rows[0]).toMatchObject({ Tab: 'Account', Visibility: 'Visible' });
    expect(get('recordTypes').rows).toEqual([
      { Object: 'Account', 'Record type': 'Customer', Default: '✓', Via: 'Profile: Sales' },
      { Object: 'Case', 'Record type': 'Support', Default: '', Via: 'Group: Support' },
    ]);
    expect(get('layouts').rows[0]).toMatchObject({
      Object: 'Account',
      'Record type': '(master)',
      Layout: 'Account Layout',
    });
  });

  it('counts records owned and shared, by who and why; open defaults are not counted', async () => {
    const { client, soql } = fakeOrg([
      [
        /FROM EntityDefinition/,
        [
          { QualifiedApiName: 'Account', InternalSharingModel: 'Private', ExternalSharingModel: 'Private' },
          { QualifiedApiName: 'Lead', InternalSharingModel: 'ReadWrite', ExternalSharingModel: 'Private' },
          { QualifiedApiName: 'Secret__c', InternalSharingModel: 'Private' },
        ],
      ],
      [/SELECT UserRoleId, UserType FROM User/, [{ UserRoleId: '00E000000000001AAA', UserType: 'Standard' }]],
      [/SELECT GroupId FROM GroupMember WHERE UserOrGroupId = /, [{ GroupId: '00G000000000001AAA' }]],
      [/SELECT ParentRoleId FROM UserRole/, [{ ParentRoleId: null }]],
      [/FROM Group WHERE RelatedId IN/, [{ Id: '00G000000000002AAA', Type: 'Role', RelatedId: '00E000000000001AAA' }]],
      [/Type = 'Organization'/, [{ Id: '00G000000000003AAA' }]],
      [/FROM Account WHERE OwnerId/, [{ n: 4 }]],
      [/FROM Lead WHERE OwnerId/, [{ n: 2 }]],
      [
        /FROM AccountShare/,
        [
          { UserOrGroupId: USER, RowCause: 'Manual', n: 1 },
          { UserOrGroupId: '00G000000000001AAA', RowCause: 'Rule', n: 5 },
          { UserOrGroupId: '00G000000000002AAA', RowCause: 'Rule', n: 2 },
        ],
      ],
    ]);
    const r = await userRecordSharing(client, USER, [
      { Object: 'Account', Read: '✓', 'View all': '✓' },
      { Object: 'Lead', Read: '✓' },
    ]);
    expect(r.rows).toEqual([
      {
        Object: 'Account',
        Default: 'Private',
        'External default': 'Private',
        'View all': 'View all',
        Owned: 4,
        'Shared with them': 1,
        'Through groups & queues': 5,
        'Through role': 2,
        Reasons: 'Manual: 1 · Sharing rule: 7',
      },
      {
        Object: 'Lead',
        Default: 'Public Read/Write',
        'External default': 'Private',
        'View all': '',
        Owned: 2,
        Reasons: 'everyone sees every record',
      },
    ]);
    expect(soql.some((q) => q.includes('LeadShare'))).toBe(false);
    expect(shareTable('Invoice__c')).toBe('Invoice__Share');
  });
});

describe('sharing of two orgs', () => {
  const rules = (body: string) => `<SharingRules>${body}</SharingRules>`;
  const rule = (name: string, access: string) =>
    `<sharingCriteriaRules><fullName>${name}</fullName><label>${name}</label><accessLevel>${access}</accessLevel><sharedTo><group>Support</group></sharedTo><criteriaItems><field>Status</field><operation>equals</operation><value>Open</value></criteriaItems></sharingCriteriaRules>`;
  it('compares defaults and every rule by name', () => {
    const a: OrgObjectSharing[] = [
      {
        object: 'Case',
        label: 'Case',
        internal: 'Private',
        external: 'Private',
        rules: 2,
        xml: rules(rule('Open_Cases', 'Edit') + rule('Only_A', 'Read')),
      },
      { object: 'Lead', label: 'Lead', internal: 'Read', external: 'Private', rules: 0 },
    ];
    const b: OrgObjectSharing[] = [
      {
        object: 'Case',
        label: 'Case',
        internal: 'Private',
        external: 'Private',
        rules: 1,
        xml: rules(rule('Open_Cases', 'Read')),
      },
      { object: 'Lead', label: 'Lead', internal: 'ReadWrite', external: 'Private', rules: 0 },
    ];
    const [cases, leads] = compareSharing(a, b);
    expect(cases.defaultsDiffer).toBe(false);
    expect(cases.rules.map((r) => [r.name, r.status])).toEqual([
      ['Only_A', 'only in A'],
      ['Open_Cases', 'different'],
    ]);
    expect(cases.rules[1].a).toContain('Read/Write');
    expect(leads.defaultsDiffer).toBe(true);
    expect(leads.rulesDiffer).toBe(false);
  });
});
