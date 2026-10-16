import type { SalesforceClient } from './client.js';
import { query } from './query.js';

/**
 * Apex tests and code coverage (the Developer Console's Tests tab): find test classes,
 * run them asynchronously, read results, and coverage per class and org-wide.
 */

export type TestClass = { id: string; name: string; methods: number };

const TEST_METHOD = /(@isTest[\s\S]{0,200}?\b(?:static\s+)?void\s+\w+\s*\(|\btestMethod\b)/gi;

/** Local (unmanaged) test classes; Apex has no isTest field, so bodies are scanned. */
export async function listTestClasses(client: SalesforceClient): Promise<TestClass[]> {
  const result = await query(
    client,
    "SELECT Id, Name, Body FROM ApexClass WHERE NamespacePrefix = null AND Status = 'Active' ORDER BY Name",
    { tooling: true, maxRows: 5000 }
  );
  return result.rows
    .map((row) => {
      const body = String(row.Body ?? '');
      return {
        id: String(row.Id),
        name: String(row.Name),
        isTest: /@isTest/i.test(body),
        methods: (body.match(TEST_METHOD) ?? []).length,
      };
    })
    .filter((c) => c.isTest)
    .map(({ id, name, methods }) => ({ id, name, methods }));
}

export type TestRun =
  | { kind: 'classes'; classIds: string[] }
  | { kind: 'methods'; tests: Array<{ classId: string; testMethods: string[] }> }
  | { kind: 'level'; testLevel: 'RunLocalTests' | 'RunAllTestsInOrg' };

/** Starts tests asynchronously; returns the AsyncApexJob Id. */
export async function runTests(client: SalesforceClient, run: TestRun): Promise<string> {
  let body: Record<string, unknown>;
  if (run.kind === 'classes') {
    if (!run.classIds.length) throw new Error('Choose test classes.');
    body = { classids: run.classIds.join(',') };
  } else if (run.kind === 'methods') {
    body = { tests: run.tests };
  } else {
    body = { testLevel: run.testLevel };
  }
  const jobId = await client.tooling<string>('POST', '/runTestsAsynchronous', body);
  return String(jobId).replace(/"/g, '');
}

export type TestJob = { status: string; processed: number; total: number; errors: number; done: boolean };

export async function testJobStatus(client: SalesforceClient, jobId: string): Promise<TestJob> {
  if (!/^\w{15,18}$/.test(jobId)) throw new Error('Invalid job Id.');
  const rows = (
    await query(
      client,
      `SELECT Status, JobItemsProcessed, TotalJobItems, NumberOfErrors FROM AsyncApexJob WHERE Id = '${jobId}'`
    )
  ).rows;
  const row = rows[0] ?? {};
  const status = String(row.Status ?? 'Queued');
  return {
    status,
    processed: Number(row.JobItemsProcessed ?? 0),
    total: Number(row.TotalJobItems ?? 0),
    errors: Number(row.NumberOfErrors ?? 0),
    done: ['Completed', 'Failed', 'Aborted'].includes(status),
  };
}

export type TestResult = {
  className: string;
  method: string;
  outcome: string;
  message?: string;
  stackTrace?: string;
  runTimeMs: number;
};

export async function testResults(client: SalesforceClient, jobId: string): Promise<TestResult[]> {
  if (!/^\w{15,18}$/.test(jobId)) throw new Error('Invalid job Id.');
  const rows = (
    await query(
      client,
      `SELECT ApexClass.Name, MethodName, Outcome, Message, StackTrace, RunTime FROM ApexTestResult WHERE AsyncApexJobId = '${jobId}' ORDER BY Outcome, ApexClass.Name, MethodName`
    )
  ).rows;
  return rows.map((r) => ({
    className: String(r['ApexClass.Name'] ?? ''),
    method: String(r.MethodName ?? ''),
    outcome: String(r.Outcome ?? ''),
    message: r.Message ? String(r.Message) : undefined,
    stackTrace: r.StackTrace ? String(r.StackTrace) : undefined,
    runTimeMs: Number(r.RunTime ?? 0),
  }));
}

/** Polls until the job finishes (or `signal` aborts). */
export async function waitForTests(
  client: SalesforceClient,
  jobId: string,
  onProgress: (job: TestJob) => void,
  signal?: AbortSignal,
  intervalMs = 3000
): Promise<TestResult[]> {
  for (;;) {
    if (signal?.aborted) throw new Error('Stopped waiting.');
    // eslint-disable-next-line no-await-in-loop
    const job = await testJobStatus(client, jobId);
    onProgress(job);
    // eslint-disable-next-line no-await-in-loop
    if (job.done) return testResults(client, jobId);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export type ClassCoverage = {
  id: string;
  name: string;
  covered: number;
  uncovered: number;
  percent: number;
  coveredLines: number[];
  uncoveredLines: number[];
};

/** Coverage per class and trigger (from the last test runs) and the org-wide percentage. */
export async function codeCoverage(client: SalesforceClient): Promise<{ orgWide?: number; classes: ClassCoverage[] }> {
  const [aggregate, orgWide] = await Promise.all([
    query(
      client,
      'SELECT ApexClassOrTriggerId, ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered, Coverage FROM ApexCodeCoverageAggregate',
      { tooling: true, maxRows: 10_000 }
    ),
    query(client, 'SELECT PercentCovered FROM ApexOrgWideCoverage', { tooling: true }).catch(() => undefined),
  ]);
  const classes = aggregate.rows
    .map((r) => {
      const covered = Number(r.NumLinesCovered ?? 0);
      const uncovered = Number(r.NumLinesUncovered ?? 0);
      // query() flattens the Coverage object into dotted columns
      const lines = (key: string): number[] =>
        Array.isArray(r[`Coverage.${key}`]) ? (r[`Coverage.${key}`] as number[]) : [];
      return {
        id: String(r.ApexClassOrTriggerId),
        name: String(r['ApexClassOrTrigger.Name'] ?? r.ApexClassOrTriggerId),
        covered,
        uncovered,
        percent: covered + uncovered ? Math.round((covered / (covered + uncovered)) * 1000) / 10 : 0,
        coveredLines: lines('coveredLines'),
        uncoveredLines: lines('uncoveredLines'),
      };
    })
    .sort((a, b) => a.percent - b.percent || a.name.localeCompare(b.name));
  const percent = orgWide?.rows[0]?.PercentCovered;
  return { orgWide: percent === undefined ? undefined : Number(percent), classes };
}
