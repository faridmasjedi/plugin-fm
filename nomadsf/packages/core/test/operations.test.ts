import { describe, expect, it } from 'vitest';
import { SalesforceClient, abortJob, deployHistory, saveOrder, type HttpRequest } from '../src/index.js';

function fakeOrg(answers: Array<[RegExp, unknown[]]>) {
  const calls: string[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    calls.push(r.path.includes('/services/Soap/') ? `SOAP ${r.body ?? ''}` : q);
    if (r.path.includes('/services/Soap/s/'))
      return { status: 200, headers: {}, body: '<result><compiled>true</compiled><success>true</success></result>' };
    const rows = answers.find(([re]) => re.test(q))?.[1] ?? [];
    return { status: 200, headers: {}, body: JSON.stringify({ totalSize: rows.length, done: true, records: rows }) };
  }, '62.0');
  return { client, calls };
}

describe('what runs on save', () => {
  it('orders flows, triggers, rules in the order of execution', async () => {
    const { client } = fakeOrg([
      [/FROM EntityDefinition/, [{ DurableId: '01I000000000001' }]],
      [
        /FROM ApexTrigger/,
        [{ Name: 'InvoiceTrigger', Status: 'Active', UsageBeforeInsert: true, UsageAfterUpdate: true }],
      ],
      [
        /FROM FlowDefinitionView/,
        [
          {
            ApiName: 'Notify',
            Label: 'Notify owner',
            TriggerType: 'RecordAfterSave',
            RecordTriggerType: 'CreateAndUpdate',
            IsActive: true,
          },
          {
            ApiName: 'SetDefaults',
            Label: 'Set defaults',
            TriggerType: 'RecordBeforeSave',
            RecordTriggerType: 'Create',
            IsActive: true,
          },
        ],
      ],
      [
        /FROM ValidationRule/,
        [{ ValidationName: 'Amount_Positive', Active: true, ErrorMessage: 'Amount must be positive' }],
      ],
      [/FROM DuplicateRule/, [{ MasterLabel: 'Same number', IsActive: false }]],
    ]);
    const { steps } = await saveOrder(client, 'Invoice__c');
    expect(steps.map((s) => [s.order, s.kind, s.name, s.events])).toEqual([
      [1, 'Flow (fast field updates)', 'Set defaults', 'insert'],
      [2, 'Apex trigger (before)', 'InvoiceTrigger', 'insert'],
      [3, 'Validation rule', 'Amount_Positive', 'insert, update'],
      [4, 'Duplicate rule', 'Same number', 'insert, update'],
      [5, 'Apex trigger (after)', 'InvoiceTrigger', 'update'],
      [6, 'Flow (actions and related records)', 'Notify owner', 'insert, update'],
    ]);
    expect(steps[3].active).toBe(false);
    await expect(saveOrder(client, "Case' OR")).rejects.toThrow('Invalid object name');
  });
});

describe('jobs and deployments', () => {
  it('stops only job Ids, through System.abortJob', async () => {
    const { client, calls } = fakeOrg([]);
    await abortJob(client, '08e000000000001AAA');
    expect(calls.at(-1)).toContain('System.abortJob(&apos;08e000000000001AAA&apos;);');
    await expect(abortJob(client, '001000000000001AAA')).rejects.toThrow('Not a scheduled or background job Id');
  });

  it('marks recent validations with tests as quick-deployable', async () => {
    const recent = new Date(Date.now() - 2 * 24 * 3_600_000).toISOString();
    const { client } = fakeOrg([
      [
        /FROM DeployRequest/,
        [
          {
            Id: '0Af000000000001AAA',
            CheckOnly: true,
            Status: 'Succeeded',
            CompletedDate: recent,
            NumberTestsTotal: 4,
            NumberTestsCompleted: 4,
            NumberComponentsDeployed: 3,
            NumberComponentsTotal: 3,
          },
          {
            Id: '0Af000000000002AAA',
            CheckOnly: false,
            Status: 'Failed',
            CompletedDate: recent,
            NumberComponentsDeployed: 1,
            NumberComponentsTotal: 2,
            NumberComponentErrors: 1,
          },
        ],
      ],
    ]);
    const rows = await deployHistory(client);
    expect(rows.map((r) => [r.Kind, r.Components, r.Tests, r.QuickDeploy])).toEqual([
      ['Validation', '3/3', '4/4', 'yes'],
      ['Deploy', '1/2 · 1 failed', '', ''],
    ]);
  });
});
