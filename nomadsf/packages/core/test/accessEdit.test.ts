import { describe, expect, it } from 'vitest';
import {
  NO_ACCESS,
  SalesforceClient,
  accessFromText,
  addToGroup,
  applyAccessChanges,
  groupPermissionSets,
  normalizeObjectAccess,
  permissionSetInfo,
  type HttpRequest,
} from '../src/index.js';

/** Answers SOQL by matcher and records every write (method, path, body). */
function fakeOrg(answers: Array<[RegExp, unknown[]]>, failOn?: RegExp) {
  const writes: Array<[string, string, unknown]> = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    if (r.method !== 'GET') {
      const path = r.path.replace(/^\/services\/data\/v[\d.]+/, '');
      writes.push([r.method, path, r.body ? JSON.parse(String(r.body)) : undefined]);
      if (failOn?.test(path))
        return { status: 400, headers: {}, body: JSON.stringify([{ message: 'Field does not exist' }]) };
      return {
        status: r.method === 'POST' ? 201 : 204,
        headers: {},
        body: r.method === 'POST' ? '{"id":"x","success":true}' : '',
      };
    }
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    const rows = answers.find(([re]) => re.test(q))?.[1] ?? [];
    return { status: 200, headers: {}, body: JSON.stringify({ totalSize: rows.length, done: true, records: rows }) };
  }, '62.0');
  return { client, writes };
}

const PS = '0PS000000000001AAA';

describe('object access rules', () => {
  it('adds what Salesforce requires', () => {
    expect(normalizeObjectAccess({ ...NO_ACCESS, delete: true })).toMatchObject({
      read: true,
      edit: true,
      delete: true,
    });
    expect(normalizeObjectAccess({ ...NO_ACCESS, modifyAll: true })).toEqual({
      read: true,
      create: true,
      edit: true,
      delete: true,
      viewAll: true,
      modifyAll: true,
    });
    expect(accessFromText('Read, View all')).toEqual({ ...NO_ACCESS, read: true, viewAll: true });
  });
});

describe('applying access changes', () => {
  it('changes a permission set: system permissions, object rows created / updated / removed, field access', async () => {
    const { client, writes } = fakeOrg([
      [/FROM PermissionSet WHERE Id/, [{ Id: PS, IsCustom: true, IsOwnedByProfile: false, Type: 'Regular' }]],
      [
        /FROM ObjectPermissions/,
        [
          { Id: '110000000000001AAA', SobjectType: 'Account' },
          { Id: '110000000000002AAA', SobjectType: 'Case' },
        ],
      ],
      [/FROM FieldPermissions/, []],
    ]);
    const result = await applyAccessChanges(client, PS, [
      { kind: 'system', api: 'ApiEnabled', enabled: true },
      { kind: 'object', object: 'Account', access: { ...NO_ACCESS, edit: true } },
      { kind: 'object', object: 'Case', access: NO_ACCESS },
      { kind: 'object', object: 'Lead', access: { ...NO_ACCESS, read: true } },
      { kind: 'field', field: 'Account.Phone', read: false, edit: true },
    ]);
    expect(result).toEqual({ applied: 5, failures: [] });
    expect(writes).toEqual([
      ['PATCH', `/sobjects/PermissionSet/${PS}`, { PermissionsApiEnabled: true }],
      [
        'PATCH',
        '/sobjects/ObjectPermissions/110000000000001AAA',
        expect.objectContaining({ PermissionsRead: true, PermissionsEdit: true }),
      ],
      ['DELETE', '/sobjects/ObjectPermissions/110000000000002AAA', undefined],
      [
        'POST',
        '/sobjects/ObjectPermissions',
        expect.objectContaining({ ParentId: PS, SobjectType: 'Lead', PermissionsRead: true }),
      ],
      [
        'POST',
        '/sobjects/FieldPermissions',
        { ParentId: PS, SobjectType: 'Account', Field: 'Account.Phone', PermissionsRead: true, PermissionsEdit: true },
      ],
    ]);
  });

  it("sets a custom profile's permissions on the Profile, and reports failures without stopping", async () => {
    const { client, writes } = fakeOrg(
      [
        [
          /FROM PermissionSet WHERE Id/,
          [{ Id: PS, IsCustom: true, IsOwnedByProfile: true, ProfileId: '00e000000000001AAA' }],
        ],
        [/FROM FieldPermissions/, []],
      ],
      /FieldPermissions/
    );
    const result = await applyAccessChanges(client, PS, [
      { kind: 'system', api: 'ExportReport', enabled: false },
      { kind: 'field', field: 'Account.Region__c', read: true, edit: false },
    ]);
    expect(writes[0]).toEqual(['PATCH', '/sobjects/Profile/00e000000000001AAA', { PermissionsExportReport: false }]);
    expect(result.applied).toBe(1);
    expect(result.failures).toEqual([
      { change: 'Account.Region__c: Read', error: expect.stringContaining('does not exist') },
    ]);
  });

  it('refuses standard profiles and groups, and bad names', async () => {
    const standard = fakeOrg([[/FROM PermissionSet WHERE Id/, [{ Id: PS, IsCustom: false, IsOwnedByProfile: true }]]]);
    await expect(applyAccessChanges(standard.client, PS, [])).rejects.toThrow('standard profile');
    const group = fakeOrg([
      [/FROM PermissionSet WHERE Id/, [{ Id: PS, Type: 'Group', PermissionSetGroupId: '0PG000000000001AAA' }]],
    ]);
    expect(await permissionSetInfo(group.client, PS)).toMatchObject({ editable: false, groupId: '0PG000000000001AAA' });
    const custom = fakeOrg([[/FROM PermissionSet WHERE Id/, [{ Id: PS, IsCustom: true, Type: 'Regular' }]]]);
    await expect(
      applyAccessChanges(custom.client, PS, [{ kind: 'object', object: "Account' OR", access: NO_ACCESS }])
    ).rejects.toThrow('Invalid object');
  });
});

describe('permission set groups', () => {
  it('lists the sets in a group and adds one', async () => {
    const { client, writes } = fakeOrg([
      [
        /FROM PermissionSetGroupComponent/,
        [{ Id: '0PH000000000001AAA', PermissionSetId: PS, PermissionSet: { Label: 'Sales Ops', Name: 'Sales_Ops' } }],
      ],
      [/FROM PermissionSetGroup WHERE/, [{ Status: 'Updated' }]],
    ]);
    expect(await groupPermissionSets(client, '0PG000000000001AAA')).toEqual({
      members: [{ componentId: '0PH000000000001AAA', permissionSetId: PS, label: 'Sales Ops', name: 'Sales_Ops' }],
      status: 'Updated',
    });
    await addToGroup(client, '0PG000000000001AAA', '0PS000000000002AAA');
    expect(writes).toEqual([
      [
        'POST',
        '/sobjects/PermissionSetGroupComponent',
        { PermissionSetGroupId: '0PG000000000001AAA', PermissionSetId: '0PS000000000002AAA' },
      ],
    ]);
  });
});
