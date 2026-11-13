import { describe, expect, it } from 'vitest';
import { checkCode, checkKindOf, type CheckFile } from '../src/index.js';

const apex = `public without sharing class AccountApi {
  private static final String API_KEY = 'sk_live_1234567890';
  @AuraEnabled
  public static List<Account> find(String name) {
    List<Account> a = Database.query('SELECT Id FROM Account WHERE Name = \\'' + name + '\\'');
    List<Contact> c = [SELECT Id, Email FROM Contact];
    for (Account acc : a) {
      List<Case> cases = [SELECT Id FROM Case WHERE AccountId = :acc.Id];
      update acc;
    }
    Id owner = '005000000000001AAA';
    try { insert c; } catch (Exception e) {}
    HttpRequest r = new HttpRequest();
    r.setEndpoint('https://erp.example.com/api');
    return a;
  }
}`;
const safeApex = `public with sharing class Safe {
  @AuraEnabled
  public static List<Account> find(String name) {
    Map<Id, List<Case>> byAccount = new Map<Id, List<Case>>();
    for (Case c : [SELECT Id, AccountId FROM Case WITH USER_MODE]) byAccount.put(c.AccountId, null);
    return [SELECT Id FROM Account WHERE Name = :name WITH USER_MODE];
  }
}`;
const files: CheckFile[] = [
  { kind: 'Apex class', name: 'AccountApi', text: apex },
  { kind: 'Apex class', name: 'Safe', text: safeApex },
  {
    kind: 'Apex class',
    name: 'InvoiceController',
    text: 'public with sharing class InvoiceController {\n  @AuraEnabled(cacheable=true)\n  public static List<Invoice__c> get(Id a) {\n    return [\n      SELECT Id FROM Invoice__c\n      WHERE Account__c = :a\n    ];\n  }\n}',
  },
  {
    kind: 'Apex class',
    name: 'AccountApiTest',
    text: "@isTest private class AccountApiTest { static void t() { Id x = '005000000000001AAA'; } }",
  },
  {
    kind: 'Visualforce',
    name: 'Search.page',
    text: '<apex:outputText value="{!q}" escape="false"/>\n<p>{!$CurrentPage.parameters.q}</p>',
  },
  { kind: 'LWC', name: 'banner/banner.js', text: 'this.template.querySelector("div").innerHTML = this.message;' },
  { kind: 'Aura', name: 'note · component', text: '<aura:unescapedHtml value="{!v.body}"/>' },
];

describe('code checks', () => {
  const found = checkCode(files);
  const rules = (name: string) => found.filter((f) => f.name === name).map((f) => `${f.rule}@${f.line}`);
  it('finds the well-known mistakes, with the line', () => {
    expect(rules('AccountApi')).toEqual(
      expect.arrayContaining([
        'SOQL injection@5',
        'Secret in the code@2',
        'Without sharing@1',
        'No access check@6',
        'Query in a loop@8',
        'DML in a loop@9',
        'Hard-coded Id@11',
        'Empty catch@12',
        'Hard-coded endpoint@14',
      ])
    );
    expect(rules('Search.page')).toEqual(['Unescaped output@1', 'Page parameter not encoded@2']);
    expect(rules('banner/banner.js')).toEqual(['HTML from a string@1']);
    expect(rules('note · component')).toEqual(['Unescaped HTML@1']);
  });
  it('reads a query spread over several lines', () => {
    expect(rules('InvoiceController')).toEqual(['No access check@4']);
  });
  it('leaves safe code and test classes alone', () => {
    expect(rules('Safe')).toEqual([]);
    expect(rules('AccountApiTest')).toEqual([]);
  });
  it('puts the most serious first', () => {
    expect(found[0].severity).toBe('High');
    expect(found[found.length - 1].severity).toBe('Low');
  });
  it('knows code files by their path', () => {
    expect(checkKindOf('force-app/main/default/classes/A.cls')).toBe('Apex class');
    expect(checkKindOf('force-app/main/default/lwc/x/x.js')).toBe('LWC');
    expect(checkKindOf('force-app/main/default/lwc/x/__tests__/x.test.js')).toBeUndefined();
    expect(checkKindOf('force-app/main/default/classes/A.cls-meta.xml')).toBeUndefined();
  });
});
