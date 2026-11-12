import { describe, expect, it } from 'vitest';
import { missingSchema, schemaPlan, type SalesforceClient } from '../src/index.js';

const client = {
  rest: async (_m: string, path: string) =>
    path === '/sobjects'
      ? { sobjects: [{ name: 'Account' }, { name: 'Invoice__c' }] }
      : { fields: [{ name: 'Name' }, { name: 'Status__c' }] },
  version: async () => '62.0',
} as unknown as SalesforceClient;

describe('what a permission set mentions that the target lacks', () => {
  it('lists missing objects and fields, not the ones that are there', async () => {
    const xml =
      '<objectPermissions><object>Bulk_Item_01__c</object></objectPermissions>' +
      '<fieldPermissions><field>Invoice__c.Status__c</field></fieldPermissions>' +
      '<fieldPermissions><field>Invoice__c.Code__c</field></fieldPermissions>' +
      '<fieldPermissions><field>Gone__c.X__c</field></fieldPermissions>';
    const r = await missingSchema(client, [{ type: 'PermissionSet', name: 'A', xml }]);
    expect(r.objects).toEqual(['Bulk_Item_01__c', 'Gone__c']);
    expect(r.fields).toEqual(['Invoice__c.Code__c']);
  });
  it('says what each permission set needs, and what to deploy first', async () => {
    const a =
      '<objectPermissions><object>Gone__c</object></objectPermissions><fieldPermissions><field>Gone__c.X__c</field></fieldPermissions>';
    const b =
      '<fieldPermissions><field>Invoice__c.Code__c</field></fieldPermissions><classAccesses><apexClass>Nope</apexClass></classAccesses>';
    const plan = await schemaPlan(client, [
      { type: 'PermissionSet', name: 'A', xml: a },
      { type: 'PermissionSet', name: 'B', xml: b },
      { type: 'PermissionSet', name: 'C', xml: '<objectPermissions><object>Account</object></objectPermissions>' },
    ]);
    expect(plan.needs.map((n) => [n.name, n.objects, n.fields])).toEqual([
      ['A', ['Gone__c'], []],
      ['B', [], ['Invoice__c.Code__c']],
    ]);
    expect(plan.components.map((c) => `${c.type}:${c.name}`)).toEqual([
      'CustomObject:Gone__c',
      'CustomField:Invoice__c.Code__c',
      'ApexClass:Nope',
    ]);
  });
});
