import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { logInsights, parseLog } from '../src/index.js';

const log = readFileSync(new URL('./fixtures-loop.log', import.meta.url), 'utf8');

describe('log insights', () => {
  const r = logInsights(parseLog(log));
  it('puts errors, limits and loops first', () => {
    const texts = r.insights.map((i) => `${i.level}: ${i.text}`);
    expect(texts[0]).toMatch(/^bad: Exception at line 20: System.NullPointerException/);
    expect(texts).toContainEqual(expect.stringMatching(/^warn: Number of SOQL queries: 90 of 100 \(90%\)/));
    expect(texts).toContainEqual(expect.stringMatching(/^warn: The same query ran 6 times \(line 12\)/));
    expect(texts).toContainEqual(expect.stringMatching(/^warn: Insert Task ran 6 times \(line 14\)/));
  });
  it('shows what ran as a tree', () => {
    expect(r.ran).toHaveLength(1);
    expect(r.ran[0]).toMatchObject({ name: 'AccountTrigger on Account · BeforeUpdate', kind: 'Trigger' });
    expect(r.ran[0].children.map((c) => `${c.kind}:${c.name}`)).toEqual([
      'Validation:Amount_Required',
      'Flow:Invoice reminder',
    ]);
  });
  it('groups queries and finds the slowest method', () => {
    expect(r.queries[0]).toMatchObject({ count: 6, rows: 12, lines: [12] });
    expect(r.queries[0].text).toBe("SELECT Id FROM Contact WHERE AccountId = '…'");
    expect(r.slowest[0]).toMatchObject({ method: 'AccountService.setTier()', calls: 1 });
  });
});
