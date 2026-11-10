import { describe, expect, it } from 'vitest';
import { AutomationTree, SalesforceClient, apexMethods, type AutoNode, type HttpRequest } from '../src/index.js';

const sources = [
  {
    name: 'CaseTrigger',
    kind: 'trigger' as const,
    body: 'trigger CaseTrigger on Case (before insert, after insert) { CaseHandler h = new CaseHandler(); h.afterInsert(Trigger.new); }',
  },
  {
    name: 'CaseHandler',
    kind: 'class' as const,
    body: `public with sharing class CaseHandler {
      private CaseService service = new CaseService();
      public CaseHandler() { }
      public void afterInsert(List<Case> cases) {
        service.createTasks(cases);
        SlaUtil.calc(cases); // CaseService.never()
        log('done');
      }
      private void log(String s) { System.debug(s); }
    }`,
  },
  {
    name: 'CaseService',
    kind: 'class' as const,
    body: `public class CaseService {
      public void createTasks(List<Case> cases) {
        List<Task> tasks = new List<Task>();
        insert tasks;
      }
      public void never() {}
    }`,
  },
  {
    name: 'SlaUtil',
    kind: 'class' as const,
    body: `global class SlaUtil {
      public static void calc(List<Case> cases) { }
      @InvocableMethod(label='SLA')
      public static void fromFlow(List<Id> ids) { calc(null); }
    }`,
  },
];

function org() {
  return new SalesforceClient(async (r: HttpRequest) => {
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    let records: unknown[] = [];
    if (/FROM ApexTrigger WHERE TableEnumOrId = 'Task'/.test(q))
      records = [
        { Id: '01q1', Name: 'TaskTrigger', Status: 'Active', UsageBeforeInsert: true, UsageAfterInsert: true },
      ];
    if (/FROM Flow WHERE Definition.DeveloperName = 'Case_After'/.test(q))
      records = [
        {
          Metadata: {
            start: { object: 'Case' },
            actionCalls: [
              { actionName: 'SlaUtil', actionType: 'apex', label: 'Set SLA' },
              { actionName: 'Case_Alert', actionType: 'emailAlert', label: 'Mail' },
            ],
            subflows: { flowName: 'Notify_Team', label: 'Notify' },
            recordUpdates: [
              { inputReference: '$Record', label: 'Close' },
              { object: 'Account', label: 'Touch account' },
            ],
          },
        },
      ];
    return { status: 200, headers: {}, body: JSON.stringify({ totalSize: records.length, done: true, records }) };
  }, '62.0');
}

const labels = (nodes: AutoNode[]) => nodes.map((n) => n.label);

describe('what a step of a save runs', () => {
  it('finds methods with their bodies and the invocable one', () => {
    const methods = apexMethods(sources[3].body);
    expect([...methods.keys()]).toEqual(['calc', 'fromflow']);
    expect(methods.get('fromflow')?.[0].invocable).toBe(true);
  });

  it('trigger → methods → what they call and write → the triggers of that object', async () => {
    const tree = new AutomationTree(org(), sources);
    const root = AutomationTree.rootOf({
      order: 1,
      when: 'After save',
      kind: 'Apex trigger (after)',
      name: 'CaseTrigger',
      active: true,
      events: 'insert',
      detail: '',
      ref: 'CaseTrigger',
    })!;
    const top = await tree.children(root);
    expect(labels(top)).toEqual(['CaseHandler.afterInsert()', 'CaseHandler.CaseHandler()']);
    const handler = await tree.children(top[0]);
    // A call inside a comment is not a call
    expect(labels(handler)).toEqual(['CaseService.createTasks()', 'SlaUtil.calc()', 'CaseHandler.log()']);
    const service = await tree.children(handler[0]);
    expect(labels(service)).toEqual(['writes Task']);
    const task = await tree.children(service[0]);
    expect(task.map((n) => [n.label, n.detail])).toEqual([
      ['TaskTrigger', 'Before save · insert | After save · insert'],
    ]);
  });

  it('flow → its Apex action (the invocable method), subflows, other actions and the records it writes', async () => {
    const tree = new AutomationTree(org(), sources);
    const nodes = await tree.children({
      id: 'flow:case_after',
      kind: 'flow',
      label: 'Case after',
      ref: 'Case_After',
      opens: true,
    });
    expect(nodes.map((n) => [n.kind, n.label])).toEqual([
      ['method', 'SlaUtil.fromFlow()'],
      ['action', 'Case_Alert'],
      ['flow', 'Notify_Team'],
      ['writes', 'writes Case'],
      ['writes', 'writes Account'],
    ]);
    expect(labels(await tree.children(nodes[0]))).toEqual(['SlaUtil.calc()']);
  });
});
