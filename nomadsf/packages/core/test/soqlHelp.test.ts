import { describe, expect, it } from 'vitest';
import { SOQL_HELP, valueContext } from '../src/index.js';

describe('soql help', () => {
  it('knows when the cursor is after a field and an operator', () => {
    expect(valueContext('SELECT Id FROM Case WHERE CreatedDate = ')).toEqual({ path: 'CreatedDate', operator: '=' });
    expect(valueContext('WHERE CreatedDate >= LAST_N')).toEqual({ path: 'CreatedDate', operator: '>=' });
    expect(valueContext("WHERE Status = 'Ne")).toEqual({ path: 'Status', operator: '=' });
    expect(valueContext("WHERE Account.Type IN ('Customer', 'Pa")).toEqual({ path: 'Account.Type', operator: 'IN' });
    expect(valueContext('WHERE Stage__c not in (')).toEqual({ path: 'Stage__c', operator: 'NOT IN' });
    expect(valueContext('SELECT Id, Na')).toBeUndefined();
    expect(valueContext("WHERE Name = 'Acme' AND ")).toBeUndefined();
  });
  it('has pieces with a hint each', () => {
    for (const g of SOQL_HELP) for (const p of g.pieces) expect(p.hint.length, p.label).toBeGreaterThan(3);
  });
});
