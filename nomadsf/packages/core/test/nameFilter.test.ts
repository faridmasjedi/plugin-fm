import { describe, expect, it } from 'vitest';
import { nameMatcher } from '../src/index.js';

describe('nameMatcher', () => {
  const names = ['Billing', 'CaseBilling', 'CaseService', 'CaseServiceTest', 'Account_Flow', 'Flow'];
  const pick = (text: string) => names.filter(nameMatcher(text));
  it('matches everything when nothing is typed', () => expect(pick('  ')).toEqual(names));
  it('a word matches anywhere, any case', () => expect(pick('bill')).toEqual(['Billing', 'CaseBilling']));
  it('* is a pattern of the whole name', () => {
    expect(pick('Case*')).toEqual(['CaseBilling', 'CaseService', 'CaseServiceTest']);
    expect(pick('*test')).toEqual(['CaseServiceTest']);
    expect(pick('flow')).toEqual(['Account_Flow', 'Flow']);
  });
  it('several words: any of them', () =>
    expect(pick('Case*Test, flow')).toEqual(['CaseServiceTest', 'Account_Flow', 'Flow']));
});
