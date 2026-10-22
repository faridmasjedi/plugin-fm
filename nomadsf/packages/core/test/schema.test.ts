import { describe, expect, it } from 'vitest';
import { SalesforceClient, objectSchema, recordHistory, type HttpRequest } from '../src/index.js';

function fakeOrg(describes: Record<string, unknown>, global: string[], historyRows: unknown[] = []) {
  const soql: string[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const json = (b: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(b) });
    if (r.path.endsWith('/sobjects'))
      return json({ sobjects: global.map((name) => ({ name, label: name, queryable: true })) });
    const d = /\/sobjects\/(\w+)\/describe$/.exec(r.path);
    if (d) return json(describes[d[1]]);
    soql.push(decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' '));
    return json({ totalSize: historyRows.length, done: true, records: historyRows });
  }, '62.0');
  return { client, soql };
}

describe('record history', () => {
  it('finds OpportunityFieldHistory and its parent field, newest first', async () => {
    const { client, soql } = fakeOrg(
      {
        OpportunityFieldHistory: {
          fields: [
            { name: 'CreatedById', type: 'reference', referenceTo: ['User'] },
            { name: 'OpportunityId', type: 'reference', referenceTo: ['Opportunity'] },
          ],
        },
      },
      ['Opportunity', 'OpportunityFieldHistory'],
      [
        {
          Field: 'StageName',
          OldValue: 'Proposal',
          NewValue: 'Closed Won',
          CreatedDate: '2026-10-20',
          CreatedBy: { Name: 'Priya' },
        },
      ]
    );
    const h = await recordHistory(client, 'Opportunity', '006000000000001AAA');
    expect(h.object).toBe('OpportunityFieldHistory');
    expect(h.entries).toEqual([
      { when: '2026-10-20', field: 'StageName', from: 'Proposal', to: 'Closed Won', by: 'Priya' },
    ]);
    expect(soql[0]).toContain(
      "FROM OpportunityFieldHistory WHERE OpportunityId = '006000000000001AAA' ORDER BY CreatedDate DESC"
    );
  });

  it('uses X__History with ParentId for custom objects, and says when there is no history object', async () => {
    const custom = fakeOrg(
      { Invoice__History: { fields: [{ name: 'ParentId', type: 'reference', referenceTo: ['Invoice__c'] }] } },
      ['Invoice__c', 'Invoice__History']
    );
    expect((await recordHistory(custom.client, 'Invoice__c', 'a01000000000001AAA')).object).toBe('Invoice__History');
    expect(custom.soql[0]).toContain('WHERE ParentId = ');
    const none = fakeOrg({}, ['Shipment__c']);
    expect(await recordHistory(none.client, 'Shipment__c', 'a02000000000001AAA')).toEqual({ entries: [] });
    await expect(recordHistory(none.client, 'Shipment__c', "x' OR Id != '")).rejects.toThrow('Invalid record Id');
  });
});

describe('object schema', () => {
  it('lists fields (required, formula, picklist), parents, children and record types', async () => {
    const { client } = fakeOrg(
      {
        Account: {
          name: 'Account',
          label: 'Account',
          labelPlural: 'Accounts',
          keyPrefix: '001',
          queryable: true,
          createable: true,
          fields: [
            { name: 'Name', label: 'Account Name', type: 'string', length: 255, nillable: false, createable: true },
            {
              name: 'Score__c',
              label: 'Score',
              type: 'double',
              precision: 5,
              scale: 1,
              calculated: true,
              calculatedFormula: 'AnnualRevenue / 1000',
              custom: true,
            },
            {
              name: 'Industry',
              label: 'Industry',
              type: 'picklist',
              picklistValues: [
                { value: 'Energy', active: true },
                { value: 'Old', active: false },
              ],
            },
            {
              name: 'ParentId',
              label: 'Parent',
              type: 'reference',
              referenceTo: ['Account'],
              relationshipName: 'Parent',
            },
          ],
          childRelationships: [
            { childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts', cascadeDelete: false },
            { childSObject: 'AccountHistory', field: 'AccountId', relationshipName: null },
          ],
          recordTypeInfos: [
            { name: 'Master', master: true },
            { name: 'Partner', developerName: 'Partner', active: true, defaultRecordTypeMapping: false },
          ],
        },
      },
      ['Account']
    );
    const s = await objectSchema(client, 'Account');
    expect(s.access).toBe('read, create');
    const byName = Object.fromEntries(s.fields.map((f) => [f.name, f]));
    expect(byName.Name).toMatchObject({ required: true, length: '255' });
    expect(byName.Score__c).toMatchObject({ formula: 'AnnualRevenue / 1000', length: '5,1', custom: true });
    expect(byName.Industry.picklist).toEqual(['Energy']);
    expect(s.parents).toEqual([{ field: 'ParentId', to: 'Account', relationship: 'Parent' }]);
    expect(s.children).toEqual([
      { object: 'Contact', field: 'AccountId', relationship: 'Contacts', cascadeDelete: false },
    ]);
    expect(s.recordTypes).toEqual([{ name: 'Partner', developerName: 'Partner', active: true, isDefault: false }]);
  });
});
