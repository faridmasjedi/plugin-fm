import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  holderAccess,
  mergeAccess,
  mergeShares,
  userSharing,
  type HttpRequest,
} from '../src/index.js';

/** Answers SOQL by matcher (an Error answers 400), describes PermissionSet, and readMetadata with the given XML. */
function fakeOrg(answers: Array<[RegExp, unknown[] | Error]>, metadataXml = '') {
  const soql: string[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    if (r.path.includes('/describe'))
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ fields: [{ name: 'PermissionsApiEnabled', label: 'API Enabled', type: 'boolean' }] }),
      };
    if (r.path.includes('/Soap/m/')) return { status: 200, headers: {}, body: metadataXml };
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    soql.push(q);
    const hit = answers.find(([re]) => re.test(q))?.[1] ?? [];
    if (hit instanceof Error) return { status: 400, headers: {}, body: JSON.stringify([{ message: hit.message }]) };
    return { status: 200, headers: {}, body: JSON.stringify({ totalSize: hit.length, done: true, records: hit }) };
  }, '62.0');
  return { client, soql };
}

const PS = '0PS000000000001AAA';

describe('what a holder allows', () => {
  it('reads every section of a profile, with names, record types and layouts; a failing section says why', async () => {
    const { client } = fakeOrg(
      [
        [
          /FROM PermissionSet WHERE Id = .* AND|SELECT Id, Name, NamespacePrefix/,
          [{ Id: PS, Name: 'X00e', IsOwnedByProfile: true, ProfileId: '00e000000000001AAA' }],
        ],
        [/FROM ObjectPermissions/, [{ SobjectType: 'Account', PermissionsRead: true, PermissionsEdit: true }]],
        [/FROM FieldPermissions/, [{ Field: 'Account.Phone', PermissionsRead: true, PermissionsEdit: false }]],
        [/SELECT PermissionsApiEnabled FROM PermissionSet/, [{ PermissionsApiEnabled: true }]],
        [/SetupEntityType = 'ApexClass'/, [{ SetupEntityId: '01p000000000001AAA' }]],
        [/FROM ApexClass WHERE Id IN/, [{ Id: '01p000000000001AAA', Name: 'AccountService' }]],
        [/SetupEntityType = 'ApexPage'/, new Error('Not allowed')],
        [/FROM PermissionSetTabSetting/, [{ Name: 'standard-Account', Visibility: 'DefaultOn' }]],
        [/SELECT FullName FROM Profile/, [{ FullName: 'Sales' }]],
        [/FROM ProfileLayout/, [{ Layout: { Name: 'Account Layout' }, RecordTypeId: null, TableEnumOrId: 'Account' }]],
      ],
      '<result><recordTypeVisibilities><default>true</default><recordType>Account.Customer</recordType><visible>true</visible></recordTypeVisibilities><recordTypeVisibilities><recordType>Account.Old</recordType><visible>false</visible></recordTypeVisibilities></result>'
    );
    const sections = await holderAccess(client, PS);
    const get = (t: string) => sections.find((s) => s.title === t);
    expect(get('Object access')?.rows).toEqual([{ key: 'Account', item: 'Account', value: 'Read, Edit' }]);
    expect(get('Field access')?.rows[0]).toMatchObject({ item: 'Account.Phone', value: 'Read' });
    expect(get('User & system permissions')?.rows).toEqual([
      { key: 'PermissionsApiEnabled', item: 'API Enabled', value: '✓' },
    ]);
    expect(get('Apex classes')?.rows[0]).toMatchObject({ item: 'AccountService' });
    expect(get('Visualforce pages')).toMatchObject({ rows: [], note: expect.stringContaining('Not allowed') });
    expect(get('Record types')?.rows).toEqual([
      { key: 'Account.Customer', item: 'Account.Customer', value: 'visible, default' },
    ]);
    expect(get('Page layouts')?.rows).toEqual([{ key: 'Account', item: 'Account', value: 'Account Layout' }]);
    expect(get('Tab settings')?.rows[0]).toMatchObject({ item: 'standard-Account', value: 'DefaultOn' });
  });

  it('lines two holders up, also when only one has it', () => {
    const merged = mergeAccess(
      [{ title: 'Object access', rows: [{ key: 'Account', item: 'Account', value: 'Read' }] }],
      [
        {
          title: 'Object access',
          rows: [
            { key: 'account', item: 'Account', value: 'Read, Edit' },
            { key: 'Lead', item: 'Lead', value: 'Read' },
          ],
        },
      ]
    );
    expect(merged[0].rows).toEqual([
      { key: 'Account', item: 'Account', a: 'Read', b: 'Read, Edit', differs: true },
      { key: 'Lead', item: 'Lead', a: '', b: 'Read', differs: true },
    ]);
    expect(mergeAccess(undefined, [{ title: 'Apps', rows: [] }])).toEqual([
      { title: 'Apps', rows: [], noteA: undefined, noteB: undefined },
    ]);
  });
});

describe('what is shared with a user', () => {
  it('counts records shared with the user, their groups and their role, with the role hierarchy and queue objects', async () => {
    const { client } = fakeOrg([
      [/SELECT UserRoleId FROM User/, [{ UserRoleId: '00E000000000002AAA' }]],
      [/FROM GroupMember/, [{ GroupId: '00G000000000001AAA', Group: { Name: 'Support', Type: 'Queue' } }]],
      [
        /FROM UserRole WHERE Id = '00E000000000002AAA'/,
        [{ Name: 'Support Lead', ParentRoleId: '00E000000000001AAA', CaseAccessForAccountOwner: 'Edit' }],
      ],
      [/FROM UserRole WHERE Id = '00E000000000001AAA'/, [{ Name: 'CEO', ParentRoleId: null }]],
      [/FROM Group WHERE RelatedId/, [{ Id: '00G000000000009AAA' }]],
      [/FROM CaseShare WHERE UserOrGroupId IN \('005/, [{ RowCause: 'Owner', records: 4 }]],
      [/FROM CaseShare WHERE UserOrGroupId IN \('00G000000000001AAA/, [{ RowCause: 'Rule', records: 12 }]],
      [/FROM AccountShare WHERE UserOrGroupId IN \('00G000000000009AAA/, [{ RowCause: 'Rule', records: 30 }]],
      [/FROM QueueSobject/, [{ QueueId: '00G000000000001AAA', SobjectType: 'Case' }]],
    ]);
    const s = await userSharing(client, '005000000000001AAA');
    expect(s.role).toMatchObject({ name: 'Support Lead', path: 'CEO › Support Lead' });
    expect(s.role?.settings['Case access (accounts they own)']).toBe('Edit');
    expect(s.userShares).toEqual([{ object: 'Case', reason: 'Owner', records: 4 }]);
    expect(s.groupShares).toEqual([{ object: 'Case', reason: 'Rule', records: 12 }]);
    expect(s.roleShares).toEqual([{ object: 'Account', reason: 'Rule', records: 30 }]);
    expect(s.queues).toEqual([{ queue: 'Support', objects: 'Case' }]);
    expect(mergeShares(s.userShares, [{ object: 'Case', reason: 'Owner', records: 2 }])).toEqual([
      { object: 'Case', reason: 'Owner', a: 4, b: 2 },
    ]);
  });
});
