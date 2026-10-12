import { expect } from 'chai';
import { flattenRecord } from '../../src/utils/dashboard/orgExplorer.js';
import { parsePlaywrightReport } from '../../src/utils/e2e.js';

describe('org explorer', () => {
  it('flattens lookups into dotted columns and summarizes subqueries', () => {
    const row = flattenRecord({
      attributes: { type: 'Account' },
      Id: '001',
      Owner: { attributes: { type: 'User' }, Name: 'Ada', Manager: { attributes: { type: 'User' }, Name: 'Bob' } },
      Contacts: {
        totalSize: 2,
        done: true,
        records: [
          { attributes: {}, Id: '003a' },
          { attributes: {}, Id: '003b' },
        ],
      },
      Parent: null,
    });
    expect(row).to.deep.include({
      Id: '001',
      'Owner.Name': 'Ada',
      'Owner.Manager.Name': 'Bob',
      Contacts: '2 record(s)',
      Parent: null,
    });
    expect(JSON.parse(row['Contacts.__json'] as string)).to.deep.equal([{ Id: '003a' }, { Id: '003b' }]);
    expect(row).to.not.have.property('attributes');
  });
});

describe('playwright report', () => {
  it('flattens suites into one row per test with stats', () => {
    const parsed = parsePlaywrightReport({
      stats: { expected: 1, unexpected: 1, flaky: 0, skipped: 0, duration: 1234.5 },
      suites: [
        {
          title: 'smoke.spec.ts',
          file: 'smoke.spec.ts',
          suites: [
            {
              title: 'Smoke',
              specs: [
                {
                  title: 'home loads',
                  tests: [{ status: 'expected', results: [{ status: 'passed', duration: 500 }] }],
                },
                {
                  title: 'cases',
                  tests: [
                    {
                      status: 'unexpected',
                      results: [
                        { status: 'failed', duration: 300, error: { message: '\u001b[31mboom\u001b[39m' } },
                        { status: 'failed', duration: 400 },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(parsed.stats).to.deep.equal({ passed: 1, failed: 1, flaky: 0, skipped: 0, durationMs: 1235 });
    expect(parsed.tests.map((t) => [t.title, t.status, t.durationMs, t.retries])).to.deep.equal([
      ['Smoke › home loads', 'passed', 500, 0],
      ['Smoke › cases', 'failed', 700, 1],
    ]);
    expect(parsed.tests[1].error).to.equal('boom');
  });
});
