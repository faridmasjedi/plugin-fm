import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { Org, type Connection } from '@salesforce/core';

/**
 * Server-side org helpers of the local NomadSF app. Org tools themselves (query, bulk data,
 * access, metadata) live in NomadSF Studio; the server adds what needs the machine:
 * the CLI's org login, retrieve into the project, and the project's activity log.
 */

const ACTIVITY_LOG = '.fm/org-activity.log';

type Row = Record<string, unknown>;
type CachedConnection = { conn: Connection; at: number };
const connections = new Map<string, CachedConnection>();

/** Connection with the Salesforce CLI's login for an alias or username (cached 10 minutes). */
export async function connect(org: string): Promise<Connection> {
  const hit = connections.get(org);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.conn;
  const conn = (await Org.create({ aliasOrUsername: org })).getConnection();
  connections.set(org, { conn, at: Date.now() });
  return conn;
}

/** Appends a change to the project's activity log (.fm/org-activity.log). */
export function logActivity(cwd: string, org: string, action: string, details: Row): void {
  mkdirSync(resolve(cwd, '.fm'), { recursive: true });
  appendFileSync(
    resolve(cwd, ACTIVITY_LOG),
    `${JSON.stringify({ at: new Date().toISOString(), user: userInfo().username, org, action, ...details })}\n`
  );
}

export function readActivity(cwd: string, limit = 300): Row[] {
  const path = resolve(cwd, ACTIVITY_LOG);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .reverse()
    .map((line) => JSON.parse(line) as Row);
}

/** Retrieves metadata into the current project with `sf project retrieve start`. */
export function retrieveMetadata(
  cwd: string,
  request: { org: string; members: string[] }
): { files: Row[]; error?: string } {
  const members = request.members.filter((m) => /^\w+:[^\s;&|`$]+$/.test(m));
  if (members.length === 0) throw new Error('Choose metadata to retrieve.');
  const args = ['project', 'retrieve', 'start', '--target-org', request.org, '--json'];
  for (const member of members) args.push('--metadata', member);
  const res = spawnSync('sf', args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 20 * 60_000 });
  let parsed: { status?: number; result?: { files?: Row[] }; message?: string } = {};
  try {
    parsed = JSON.parse(res.stdout || '{}') as typeof parsed;
  } catch {
    parsed = { message: res.stderr };
  }
  logActivity(cwd, request.org, 'retrieve', { members, files: parsed.result?.files?.length ?? 0 });
  return {
    files: (parsed.result?.files ?? []).map((f) => ({
      fullName: f.fullName,
      type: f.type,
      state: f.state,
      filePath: f.filePath,
    })),
    error: parsed.status && parsed.status !== 0 ? parsed.message ?? 'Retrieve failed.' : undefined,
  };
}

export type ProjectDeployRequest = {
  org: string;
  members: string[];
  testLevel?: string;
  tests?: string[];
  checkOnly?: boolean;
};

export type ProjectDeployOutcome = {
  id: string;
  status: string;
  success: boolean;
  checkOnly: boolean;
  componentsDeployed: number;
  componentsTotal: number;
  testsRun: number;
  componentFailures: Array<{ type: string; name: string; problem: string; line?: number }>;
  testFailures: Array<{ name: string; method: string; message: string }>;
  errorMessage?: string;
};

const TEST_LEVELS = new Set(['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg']);
const asList = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

/** Runs the Salesforce CLI without blocking the app (deploys can take many minutes). */
function sfJson(args: string[], cwd: string): Promise<{ status?: number; result?: Row; data?: Row; message?: string }> {
  return new Promise((resolveRun) => {
    const child = spawn('sf', [...args, '--json'], { cwd, env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('close', (code) => {
      try {
        resolveRun(JSON.parse(out || '{}') as { status?: number; result?: Row; data?: Row; message?: string });
      } catch {
        resolveRun({ status: code ?? 1, message: err.trim() || 'The Salesforce CLI failed.' });
      }
    });
  });
}

/** Reads `sf project deploy start|quick --json` into the same shape as the Studio's own deploys. */
export function parseCliDeploy(
  json: { result?: Row; data?: Row; message?: string },
  checkOnly: boolean
): ProjectDeployOutcome {
  const r = json.result ?? json.data ?? {};
  const details = (r.details ?? {}) as Row;
  const runTests = (details.runTestResult ?? {}) as Row;
  return {
    id: String(r.id ?? ''),
    status: String(r.status ?? (json.message ? 'Failed' : 'Unknown')),
    success: r.success === true || r.success === 'true',
    checkOnly,
    componentsDeployed: Number(r.numberComponentsDeployed ?? 0),
    componentsTotal: Number(r.numberComponentsTotal ?? 0),
    testsRun: Number(r.numberTestsCompleted ?? 0) + Number(r.numberTestErrors ?? 0),
    componentFailures: asList(details.componentFailures as Row | Row[] | undefined).map((f) => ({
      type: String(f.componentType ?? ''),
      name: String(f.fullName ?? ''),
      problem: String(f.problem ?? ''),
      line: f.lineNumber === undefined ? undefined : Number(f.lineNumber),
    })),
    testFailures: asList(runTests.failures as Row | Row[] | undefined).map((f) => ({
      name: String(f.name ?? ''),
      method: String(f.methodName ?? ''),
      message: String(f.message ?? ''),
    })),
    errorMessage: r.errorMessage ? String(r.errorMessage) : json.message && !r.id ? json.message : undefined,
  };
}

/** Deploys (or validates) components of the current project with `sf project deploy start`. */
export async function deployFromProject(cwd: string, request: ProjectDeployRequest): Promise<ProjectDeployOutcome> {
  if (!/^[\w.@+-]{1,80}$/.test(request.org)) throw new Error('Choose a connected org.');
  const members = request.members.filter((m) => /^\w+:[^\s;&|`$]+$/.test(m));
  if (members.length === 0) throw new Error('Choose components to deploy.');
  const level = request.testLevel ?? 'RunLocalTests';
  if (!TEST_LEVELS.has(level)) throw new Error('Unknown test level.');
  const tests = (request.tests ?? []).filter((t) => /^\w+$/.test(t));
  if (level === 'RunSpecifiedTests' && tests.length === 0) throw new Error('Name the test classes to run.');
  const args = ['project', 'deploy', 'start', '--target-org', request.org, '--test-level', level, '--wait', '120'];
  for (const member of members) args.push('--metadata', member);
  if (level === 'RunSpecifiedTests') for (const test of tests) args.push('--tests', test);
  if (request.checkOnly) args.push('--dry-run');
  const outcome = parseCliDeploy(await sfJson(args, cwd), Boolean(request.checkOnly));
  logActivity(cwd, request.org, request.checkOnly ? 'validate' : 'deploy', {
    members,
    testLevel: level,
    success: outcome.success,
    id: outcome.id,
  });
  return outcome;
}

/** Quick deploy of a validation that succeeded (`sf project deploy quick`). */
export async function quickDeployFromProject(cwd: string, org: string, jobId: string): Promise<ProjectDeployOutcome> {
  if (!/^[\w.@+-]{1,80}$/.test(org) || !/^\w{15,18}$/.test(jobId)) throw new Error('Invalid org or validation.');
  const outcome = parseCliDeploy(
    await sfJson(['project', 'deploy', 'quick', '--job-id', jobId, '--target-org', org, '--wait', '120'], cwd),
    false
  );
  logActivity(cwd, org, 'quick deploy', { validation: jobId, success: outcome.success });
  return outcome;
}
