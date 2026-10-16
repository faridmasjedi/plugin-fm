import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  codeCoverage,
  listTestClasses,
  openCode,
  runTests,
  saveApex,
  waitForTests,
  type HttpRequest,
} from '../src/index.js';

function fake(handler: (r: HttpRequest) => { status?: number; json?: unknown }) {
  const calls: HttpRequest[] = [];
  const client = new SalesforceClient(async (r) => {
    calls.push(r);
    const out = handler(r);
    return { status: out.status ?? 200, headers: {}, body: out.json === undefined ? '' : JSON.stringify(out.json) };
  }, '62.0');
  return { calls, client };
}
const records = (rows: unknown[]) => ({ json: { totalSize: rows.length, done: true, records: rows } });
const q = (r: HttpRequest) => decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');

describe('apex tests', () => {
  it('finds test classes and counts methods', async () => {
    const { client } = fake(() =>
      records([
        {
          Id: '01p000000000001',
          Name: 'AccountTest',
          Body: '@isTest\nprivate class AccountTest {\n @isTest static void a() {}\n @IsTest\n static void b() {} }',
        },
        { Id: '01p000000000002', Name: 'Account', Body: 'public class Account {}' },
      ])
    );
    expect(await listTestClasses(client)).toEqual([{ id: '01p000000000001', name: 'AccountTest', methods: 2 }]);
  });

  it('runs tests and waits for results', async () => {
    let polls = 0;
    const { calls, client } = fake((r) => {
      if (r.path.endsWith('/runTestsAsynchronous')) return { json: '707000000000001' };
      if (q(r).includes('FROM AsyncApexJob'))
        return records([
          {
            Status: ++polls < 2 ? 'Processing' : 'Completed',
            JobItemsProcessed: 1,
            TotalJobItems: 1,
            NumberOfErrors: 0,
          },
        ]);
      return records([
        { ApexClass: { Name: 'AccountTest' }, MethodName: 'a', Outcome: 'Fail', Message: 'boom', RunTime: 12 },
      ]);
    });
    const job = await runTests(client, { kind: 'classes', classIds: ['01p000000000001'] });
    expect(job).toBe('707000000000001');
    expect(JSON.parse(calls[0].body!)).toEqual({ classids: '01p000000000001' });
    const seen: string[] = [];
    const results = await waitForTests(client, job, (j) => seen.push(j.status), undefined, 1);
    expect(seen).toEqual(['Processing', 'Completed']);
    expect(results[0]).toMatchObject({ className: 'AccountTest', method: 'a', outcome: 'Fail', message: 'boom' });
  });

  it('reads coverage with line details', async () => {
    const { client } = fake((r) =>
      q(r).includes('ApexOrgWideCoverage')
        ? records([{ PercentCovered: 81 }])
        : records([
            {
              ApexClassOrTriggerId: '01p1',
              ApexClassOrTrigger: { Name: 'A' },
              NumLinesCovered: 3,
              NumLinesUncovered: 1,
              Coverage: { coveredLines: [1, 2, 3], uncoveredLines: [4] },
            },
          ])
    );
    const coverage = await codeCoverage(client);
    expect(coverage.orgWide).toBe(81);
    expect(coverage.classes[0]).toMatchObject({ name: 'A', percent: 75, coveredLines: [1, 2, 3], uncoveredLines: [4] });
  });
});

describe('code editor', () => {
  it('opens LWC bundles file by file', async () => {
    const { client } = fake(() =>
      records([{ Id: '0Rd000000000001', FilePath: 'lwc/hello/hello.html', Source: '<template></template>' }])
    );
    expect(await openCode(client, { id: '0Rb000000000001', kind: 'LWC', name: 'hello' })).toEqual([
      { id: '0Rd000000000001', path: 'lwc/hello/hello.html', language: 'html', source: '<template></template>' },
    ]);
  });

  it('compiles through a metadata container, reports problems and cleans up', async () => {
    let polls = 0;
    const { calls, client } = fake((r) => {
      if (r.path.endsWith('/MetadataContainer') && r.method === 'POST') return { json: { id: '1dc1' } };
      if (r.path.endsWith('/ApexClassMember')) return { json: { id: 'm1' } };
      if (r.path.endsWith('/ContainerAsyncRequest')) return { json: { id: '1dr1' } };
      if (r.path.includes('/ContainerAsyncRequest/'))
        return {
          json:
            ++polls < 2
              ? { State: 'Queued' }
              : {
                  State: 'Failed',
                  DeployDetails: { componentFailures: [{ lineNumber: 3, columnNumber: 5, problem: 'Missing ;' }] },
                },
        };
      return { status: 204 };
    });
    const result = await saveApex(client, { id: '01p000000000001', kind: 'ApexClass' }, 'class A {}', {
      checkOnly: true,
      intervalMs: 1,
    });
    expect(result).toEqual({
      ok: false,
      state: 'Failed',
      problems: [{ line: 3, column: 5, problem: 'Missing ;', name: undefined }],
    });
    expect(JSON.parse(calls.find((c) => c.path.endsWith('/ContainerAsyncRequest'))!.body!)).toEqual({
      MetadataContainerId: '1dc1',
      IsCheckOnly: true,
    });
    expect(calls.at(-1)).toMatchObject({
      method: 'DELETE',
      path: '/services/data/v62.0/tooling/sobjects/MetadataContainer/1dc1',
    });
  });
});
