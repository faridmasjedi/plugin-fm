import { describe, expect, it } from 'vitest';
import { missingSchema, schemaPlan, type SalesforceClient } from '../src/index.js';

/** A target org with Account, Contact and Invoice__c (Name, Status__c), no classes, the group Sales and role CEO. */
const rows = (soql: string): Array<Record<string, string>> => {
  if (/FROM EntityDefinition/.test(soql))
    return ['Account', 'Contact', 'Invoice__c']
      .filter((o) => soql.includes(`'${o}'`))
      .map((o) => ({ QualifiedApiName: o }));
  if (/FROM FieldDefinition/.test(soql))
    return /'Invoice__c'/.test(soql) ? [{ QualifiedApiName: 'Name' }, { QualifiedApiName: 'Status__c' }] : [];
  if (/FROM Group/.test(soql)) return soql.includes("'Sales'") ? [{ DeveloperName: 'Sales' }] : [];
  if (/FROM UserRole/.test(soql)) return soql.includes("'CEO'") ? [{ DeveloperName: 'CEO' }] : [];
  return [];
};
const client = {
  rest: async (_m: string, path: string) => {
    const soql = decodeURIComponent(path.replace(/^\/query\/?\?q=/, '').replace(/\+/g, ' '));
    const records = rows(soql).map((r) => ({ attributes: {}, ...r }));
    return { done: true, totalSize: records.length, records };
  },
  version: async () => '62.0',
} as unknown as SalesforceClient;

describe('what the target org lacks', () => {
  it('lists missing objects, fields, classes, groups and roles — not the ones that are there', async () => {
    const xml =
      '<objectPermissions><object>Bulk_Item_01__c</object></objectPermissions>' +
      '<fieldPermissions><field>Invoice__c.Status__c</field></fieldPermissions>' +
      '<fieldPermissions><field>Invoice__c.Code__c</field></fieldPermissions>' +
      '<fieldPermissions><field>Gone__c.X__c</field></fieldPermissions>';
    const r = await missingSchema(client, [{ type: 'PermissionSet', name: 'A', xml }], {
      groups: ['Sales', 'Leads'],
      roles: ['CEO', 'Support_Manager'],
    });
    expect(r.objects).toEqual(['Bulk_Item_01__c', 'Gone__c']);
    expect(r.fields).toEqual(['Invoice__c.Code__c']);
    expect(r.groups).toEqual(['Leads']);
    expect(r.roles).toEqual(['Support_Manager']);
  });

  it('says what each permission set or setting needs, roles and groups first', async () => {
    const a = '<objectPermissions><object>Gone__c</object></objectPermissions>';
    const b =
      '<fieldPermissions><field>Invoice__c.Code__c</field></fieldPermissions><classAccesses><apexClass>Nope</apexClass></classAccesses>';
    const plan = await schemaPlan(
      client,
      [
        { type: 'PermissionSet', name: 'A', xml: a },
        { type: 'PermissionSet', name: 'B', xml: b },
        { type: 'PermissionSet', name: 'C', xml: '<objectPermissions><object>Account</object></objectPermissions>' },
      ],
      [{ name: 'Sharing rules', groups: ['Leads'], roles: ['Support_Manager'] }]
    );
    expect(plan.needs.map((n) => n.name)).toEqual(['A', 'B', 'Sharing rules']);
    expect(plan.components.map((c) => `${c.type}:${c.name}`)).toEqual([
      'Role:Support_Manager',
      'Group:Leads',
      'CustomObject:Gone__c',
      'CustomField:Invoice__c.Code__c',
      'ApexClass:Nope',
    ]);
  });
});
