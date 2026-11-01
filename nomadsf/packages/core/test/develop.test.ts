import { describe, expect, it } from 'vitest';
import { SalesforceClient, dependenciesOf, deployComponent, explainQuery, type HttpRequest } from '../src/index.js';

const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });

describe('query plan', () => {
  it('lists the plans cheapest first', async () => {
    const asked: string[] = [];
    const client = new SalesforceClient(async (r: HttpRequest) => {
      asked.push(r.path);
      return json({
        plans: [
          {
            leadingOperationType: 'TableScan',
            relativeCost: 2.1,
            cardinality: 9000,
            sobjectCardinality: 9000,
            sobjectType: 'Case',
            fields: [],
            notes: [],
          },
          {
            leadingOperationType: 'Index',
            relativeCost: 0.2,
            cardinality: 40,
            sobjectCardinality: 9000,
            sobjectType: 'Case',
            fields: ['OwnerId'],
            notes: [],
          },
        ],
      });
    }, '62.0');
    const plans = await explainQuery(client, " SELECT Id FROM Case WHERE OwnerId = '005' ");
    expect(plans.map((p) => p.leadingOperationType)).toEqual(['Index', 'TableScan']);
    expect(decodeURIComponent(asked[0])).toContain("/query?explain=SELECT Id FROM Case WHERE OwnerId = '005'");
  });
});

describe('dependencies', () => {
  it('splits what a component uses from what uses it', async () => {
    const client = new SalesforceClient(async (r: HttpRequest) => {
      const soql = decodeURIComponent(r.path);
      const row = (prefix: string, id: string, name: string, type: string) => ({
        [`${prefix}MetadataComponentId`]: id,
        [`${prefix}MetadataComponentName`]: name,
        [`${prefix}MetadataComponentType`]: type,
        [`${prefix}MetadataComponentNamespace`]: null,
      });
      if (soql.includes("WHERE MetadataComponentId = '01p000000000001AAA'"))
        return json({
          records: [
            {
              ...row('', '01p000000000001AAA', 'AccountService', 'ApexClass'),
              ...row('Ref', '01I000000000001AAA', 'Invoice__c', 'CustomObject'),
            },
          ],
        });
      return json({
        records: [
          {
            ...row('', '0Ab000000000001AAA', 'Invoice_Flow', 'Flow'),
            ...row('Ref', '01p000000000001AAA', 'AccountService', 'ApexClass'),
          },
        ],
      });
    }, '62.0');
    const deps = await dependenciesOf(client, '01p000000000001AAA');
    expect(deps.uses.map((d) => `${d.type}:${d.name}`)).toEqual(['CustomObject:Invoice__c']);
    expect(deps.usedBy.map((d) => `${d.type}:${d.name}`)).toEqual(['Flow:Invoice_Flow']);
  });
});

describe('fields in dependencies', () => {
  it('are named with their object, standard or custom', async () => {
    const client = new SalesforceClient(async (r: HttpRequest) => {
      const soql = decodeURIComponent(r.path.split('q=')[1] ?? '');
      if (soql.includes('FROM MetadataComponentDependency'))
        return json({
          records: soql.includes("WHERE MetadataComponentId = '01p000000000001AAA'")
            ? [
                {
                  RefMetadataComponentId: '00N000000000001AAA',
                  RefMetadataComponentName: 'Customer_Tier',
                  RefMetadataComponentType: 'CustomField',
                },
                {
                  RefMetadataComponentId: '00N000000000002AAA',
                  RefMetadataComponentName: 'Total',
                  RefMetadataComponentType: 'CustomField',
                },
              ]
            : [],
        });
      if (soql.includes('FROM CustomField'))
        return json({
          records: [
            { Id: '00N000000000001AAA', DeveloperName: 'Customer_Tier', TableEnumOrId: 'Account' },
            { Id: '00N000000000002AAA', DeveloperName: 'Total', TableEnumOrId: '01I000000000001AAA' },
          ],
        });
      if (soql.includes('FROM CustomObject'))
        return json({ records: [{ Id: '01I000000000001AAA', DeveloperName: 'Invoice' }] });
      return json({ records: [] });
    }, '62.0');
    const deps = await dependenciesOf(client, '01p000000000001AAA');
    expect(deps.uses.map((d) => d.name)).toEqual(['Account.Customer_Tier__c', 'Invoice__c.Total__c']);
  });
});

describe('deploying a component', () => {
  const client = new SalesforceClient(async () => json({}), '62.0');
  it('refuses binary files and paths that leave the package', async () => {
    await expect(
      deployComponent(client, 'StaticResource', 'Logo', [
        { path: 'staticresources/Logo.resource', text: null, size: 10 },
      ])
    ).rejects.toThrow(/binary/);
    await expect(
      deployComponent(client, 'FlexiPage', 'Home', [{ path: '../evil.flexipage', text: '<x/>', size: 4 }])
    ).rejects.toThrow(/Invalid file path/);
  });
});
