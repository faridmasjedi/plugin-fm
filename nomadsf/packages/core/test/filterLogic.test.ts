import { describe, expect, it } from 'vitest';
import { parseFilterLogic } from '../src/index.js';

describe('filter logic', () => {
  const run = (logic: string, r: boolean[]) => parseFilterLogic(logic, r.length)(r);

  it('is AND of every filter when empty', () => {
    expect(run('', [true, true])).toBe(true);
    expect(run('  ', [true, false])).toBe(false);
  });

  it('reads OR, AND, NOT and brackets, in any case', () => {
    expect(run('1 OR 2 OR (3 AND 4)', [false, false, true, true])).toBe(true);
    expect(run('1 OR 2 OR (3 AND 4)', [false, false, true, false])).toBe(false);
    expect(run('1 and not 2', [true, false])).toBe(true);
    expect(run('(1 || 2) && !3', [false, true, true])).toBe(false);
  });

  it('says what is wrong', () => {
    expect(() => parseFilterLogic('1 OR 3', 2)).toThrow(/no filter 3/);
    expect(() => parseFilterLogic('1 OR 2 AND 3', 3)).toThrow(/brackets/);
    expect(() => parseFilterLogic('(1 OR 2', 2)).toThrow(/not closed/);
    expect(() => parseFilterLogic('1 2', 2)).toThrow(/AND or OR/);
    expect(() => parseFilterLogic('1 XOR 2', 2)).toThrow(/Not understood/);
  });
});
