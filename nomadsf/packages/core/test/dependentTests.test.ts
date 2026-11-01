import { describe, expect, it } from 'vitest';
import { apexSourcesFromFiles, testsForPackage } from '../src/index.js';

const files: Record<string, string> = {
  'force-app/main/default/classes/ScoreService.cls':
    'public class ScoreService { public static void run(List<Account> a) { update a; } }',
  'force-app/main/default/classes/ScoreService.cls-meta.xml': '<ApexClass/>',
  'force-app/main/default/classes/Handler.cls': 'public class Handler { public static void go() {} }',
  'force-app/main/default/triggers/AccountTrigger.trigger':
    'trigger AccountTrigger on Account (before update) { Handler.go(); }',
  'force-app/main/default/classes/ScoreServiceTest.cls':
    '@isTest private class ScoreServiceTest { @isTest static void t() { ScoreService.run(new List<Account>()); } }',
  'force-app/main/default/classes/OtherTest.cls': '@isTest private class OtherTest { @isTest static void t() {} }',
};

describe('dependent tests', () => {
  it('finds the tests that reach the classes and triggers of a package, through DML too', async () => {
    const sources = await apexSourcesFromFiles(Object.keys(files), async (p) => files[p]);
    expect(sources.map((s) => `${s.kind}:${s.name}`).sort()).toEqual([
      'class:Handler',
      'class:OtherTest',
      'class:ScoreService',
      'class:ScoreServiceTest',
      'trigger:AccountTrigger',
    ]);
    const selection = testsForPackage(sources, [
      { type: 'ApexTrigger', name: 'AccountTrigger' },
      { type: 'ApexClass', name: 'Handler' },
      { type: 'CustomField', name: 'Account.Score__c' },
    ]);
    // ScoreServiceTest updates Accounts through ScoreService, which fires AccountTrigger, which calls Handler
    expect(selection.tests).toEqual(['ScoreServiceTest']);
    expect(selection.uncovered).toEqual([]);
  });
});
