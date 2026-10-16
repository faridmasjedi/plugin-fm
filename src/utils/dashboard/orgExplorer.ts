import { spawnSync } from 'node:child_process';
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
