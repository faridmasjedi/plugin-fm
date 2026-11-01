import { describe, expect, it } from 'vitest';
import {
  buildGraph,
  declaredTests,
  dmlObjects,
  elementType,
  selectTests,
  sourcesFromRecords,
  stripCommentsAndStrings,
  type ApexSource,
} from '../src/index.js';

const sources: ApexSource[] = [
  {
    name: 'AccountService',
    kind: 'class',
    body: `public with sharing class AccountService {
  // calls Orphan only in a comment
  public static void touch(List<Account> accs) {
    String s = 'Orphan.run()';
    update accs;
  }
  public static void addContact() {
    Database.insert(new List<Contact>{ new Contact(LastName = 'x') }, false);
  }
}`,
  },
  {
    name: 'AccountTrigger',
    kind: 'trigger',
    body: `trigger AccountTrigger on Account (before insert, after update) {
  AccountTriggerHandler.run(Trigger.new);
}`,
  },
  {
    name: 'AccountTriggerHandler',
    kind: 'class',
    body: `public class AccountTriggerHandler {
  public static void run(List<Account> rows) { util.log('x'); }
}`,
  },
  { name: 'Util', kind: 'class', body: 'public class Util { public static void log(String s) { System.debug(s); } }' },
  { name: 'ContactTrigger', kind: 'trigger', body: 'trigger ContactTrigger on Contact (after insert) { }' },
  {
    name: 'Orphan',
    kind: 'class',
    body: '// @tests: OrphanManualTest\npublic class Orphan { public void run() { obj.Util = null; } }',
  },
  {
    name: 'AccountServiceTest',
    kind: 'class',
    body: `@IsTest
private class AccountServiceTest {
  @IsTest static void touches() { AccountService.touch(new List<Account>()); }
}`,
  },
  {
    name: 'OrderFlowTest',
    kind: 'class',
    body: `@isTest
private class OrderFlowTest {
  @isTest static void createsAccount() { Account a = new Account(Name = 'a'); insert a; }
}`,
  },
  { name: 'UtilTest', kind: 'class', body: '@isTest private class UtilTest { }' },
];

describe('apex graph', () => {
  const graph = buildGraph(sources);

  it('strips comments and strings', () => {
    expect(stripCommentsAndStrings("a // x\nb /* y\nz */ c 'it\\'s' d")).toBe("a \nb \n  c '' d");
  });

  it('finds the objects written, from variables, new and Database methods', () => {
    expect(dmlObjects(stripCommentsAndStrings(sources[0].body)).sort()).toEqual(['Account', 'Contact']);
    expect(dmlObjects('Map<Id, Lead> byId = x; upsert byId.values() Ext__c;')).toEqual(['Lead']);
    expect(dmlObjects('for (Case c : cases) { } delete [SELECT Id FROM Task WHERE x = 1];')).toEqual(['Task']);
    expect(dmlObjects('List<SObject> rows; insert rows;')).toEqual([]);
    expect(elementType('Map<Id, List<Foo__c>>')).toBe('Foo__c');
  });

  it('parses triggers, tests, references and @tests comments', () => {
    const trigger = graph.units.get('accounttrigger');
    expect(trigger?.sobject).toBe('Account');
    expect(trigger?.events).toEqual(['before insert', 'after update']);
    expect(graph.units.get('accountservicetest')?.isTest).toBe(true);
    expect(graph.units.get('accountservice')?.references).toEqual([]); // comment, string only
    expect(graph.units.get('accounttriggerhandler')?.references).toEqual(['util']); // case-insensitive
    expect(graph.units.get('orphan')?.references).toEqual([]); // obj.Util is a field
    expect(declaredTests(' * @tests A, B */\n// @tests: C')).toEqual(['A', 'B', 'C']);
  });

  it('selects tests, including the tests that fire a trigger', () => {
    const selection = selectTests(graph, ['AccountTrigger', 'Util', 'Orphan', 'Missing']);
    const byName = Object.fromEntries(selection.components.map((c) => [c.name, c.tests]));
    expect(byName.AccountTrigger).toEqual(['AccountServiceTest', 'OrderFlowTest']);
    expect(byName.Util).toEqual(['AccountServiceTest', 'OrderFlowTest', 'UtilTest']);
    expect(byName.Orphan).toEqual(['OrphanManualTest']);
    expect(selection.uncovered).toEqual(['Missing']);
    expect(selection.tests).toEqual(['AccountServiceTest', 'OrderFlowTest', 'OrphanManualTest', 'UtilTest']);
  });

  it('a changed test class runs itself', () => {
    expect(selectTests(graph, ['UtilTest']).tests).toEqual(['UtilTest']);
  });

  it('reads org records, skipping managed code', () => {
    const list = sourcesFromRecords(
      [
        { Name: 'A', Body: 'public class A {}' },
        { Name: 'M', Body: '(hidden)' },
      ],
      [{ Name: 'T', Body: 'trigger T on Account (after insert) {}' }]
    );
    expect(list.map((s) => `${s.kind}:${s.name}`)).toEqual(['class:A', 'trigger:T']);
  });
});
