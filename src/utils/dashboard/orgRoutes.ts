import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import { E2E_DIR, listSpecs } from '../e2e.js';
import * as explorer from './orgExplorer.js';

type Body = Record<string, unknown>;

export type OrgRouteContext = {
  cwd: string;
  runsDir: string;
  pluginCommand: string[];
  readBody: (req: IncomingMessage) => Promise<Body>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webm': 'video/webm',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv; charset=utf-8',
};

function sendFile(res: ServerResponse, path: string, download = false): void {
  res.writeHead(200, {
    'content-type': MIME[extname(path)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
    ...(download ? { 'content-disposition': `attachment; filename="${basename(path)}"` } : {}),
  });
  createReadStream(path).pipe(res);
}

/** Starts a one-stage pipeline run so ad-hoc jobs show up on the Runs page with their log. */
function startAdhocRun(context: OrgRouteContext, name: string, stage: Body): void {
  const dir = resolve(context.cwd, context.runsDir, '.adhoc');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Date.now()}-${String(stage.id)}.yml`);
  writeFileSync(file, stringify({ name, stages: [stage] }));
  const [cmd, ...args] = context.pluginCommand;
  args.push(
    'fm',
    'pipeline',
    'run',
    '--file',
    file,
    '--runs-dir',
    context.runsDir,
    '--trigger',
    'dashboard',
    '--wait-for-approval'
  );
  spawn(cmd, args, { cwd: context.cwd, detached: true, stdio: 'ignore', env: process.env }).unref();
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

type RouteInput = { org: string; body: Body; q: (key: string) => string; context: OrgRouteContext };

const csvList = (value: unknown): string[] =>
  str(value)
    .split(/[\s,;]+/)
    .filter(Boolean);

/** JSON routes, keyed by "METHOD path" under /api. */
const ROUTES: Record<string, (input: RouteInput) => unknown> = {
  'GET org/sobjects': ({ org }) => explorer.listSObjects(org),
  'GET org/describe': ({ org, q }) => explorer.describeObject(org, q('sobject'), q('tooling') === '1'),
  'GET org/all-fields': async ({ org, q }) => ({
    soql: await explorer.allFieldsSoql(org, q('sobject'), q('tooling') === '1'),
  }),
  'POST org/query': ({ org, body }) =>
    explorer.runQuery({
      org,
      soql: str(body.soql),
      tooling: Boolean(body.tooling),
      includeDeleted: Boolean(body.includeDeleted),
      maxRows: Number(body.maxRows) || undefined,
    }),
  'POST org/bulk/export': ({ org, body, context }) =>
    explorer.bulkExport(context.cwd, { org, soql: str(body.soql), includeDeleted: Boolean(body.includeDeleted) }),
  'POST org/bulk/ingest': ({ org, body, context }) =>
    explorer.bulkIngest(context.cwd, {
      org,
      sobject: str(body.sobject),
      operation: str(body.operation) as explorer.IngestRequest['operation'],
      csv: str(body.csv),
      externalIdField: str(body.externalIdField) || undefined,
      confirm: str(body.confirm),
    }),
  'POST org/bulk/delete-query': ({ org, body, context }) =>
    explorer.deleteByQuery(context.cwd, {
      org,
      soql: str(body.soql),
      hardDelete: Boolean(body.hardDelete),
      confirm: str(body.confirm),
    }),
  'GET org/login-history': ({ org, q }) => explorer.loginHistory(org, Number(q('days')) || 7),
  'GET org/audit-trail': ({ org, q }) => explorer.auditTrail(org, Number(q('days')) || 30),
  'GET org/permsets': ({ org }) => explorer.listPermissionSets(org),
  'GET org/assignments': ({ org, q }) =>
    explorer.assignments(org, { kind: q('kind') === 'group' ? 'group' : 'permset', id: q('id') }),
  'POST org/users': ({ org, body }) =>
    explorer.findUsers(org, {
      usernames: csvList(body.usernames),
      profile: str(body.profile) || undefined,
      role: str(body.role) || undefined,
      publicGroup: str(body.publicGroup) || undefined,
    }),
  'POST org/assign': ({ org, body, context }) =>
    explorer.assignAccess(context.cwd, {
      org,
      target: body.target as explorer.AccessTarget,
      userIds: (body.userIds as string[] | undefined) ?? [],
      expirationDate: str(body.expirationDate) || undefined,
      confirm: str(body.confirm),
    }),
  'POST org/unassign': ({ org, body, context }) =>
    explorer.removeAccess(context.cwd, {
      org,
      assignmentIds: (body.assignmentIds as string[] | undefined) ?? [],
      confirm: str(body.confirm),
    }),
  'GET org/metadata-types': ({ org }) => explorer.metadataTypes(org),
  'GET org/metadata': ({ org, q }) => explorer.listMetadata(org, q('type')),
  'POST org/retrieve': ({ org, body, context }) =>
    explorer.retrieveMetadata(context.cwd, { org, members: (body.members as string[] | undefined) ?? [] }),
  'GET org/activity': ({ context }) => explorer.readActivity(context.cwd),
  'GET e2e/specs': ({ context }) => ({
    specs: listSpecs(context.cwd),
    hasConfig: ['playwright.config.ts', 'playwright.config.js'].some((f) => existsSync(resolve(context.cwd, f))),
  }),
  'POST e2e/run': ({ org, body, context }) => {
    if (!/^[\w.@+-]{1,80}$/.test(org)) throw new Error('Choose a connected org.');
    const grep = str(body.grep);
    startAdhocRun(context, `E2E tests on ${org}`, {
      id: 'e2e',
      name: grep ? `Playwright: ${grep}` : 'Playwright scenarios',
      uses: 'e2e',
      with: { 'target-org': org, ...(grep ? { grep } : {}) },
    });
    return { ok: true };
  },
};

/** Serves a file from the last Playwright HTML report (read-only, confined to the report folder). */
function sendReportFile(res: ServerResponse, parts: string[], context: OrgRouteContext): void {
  const root = resolve(context.cwd, E2E_DIR, 'report');
  const path = resolve(root, parts.slice(3).join('/') || 'index.html');
  const rel = relative(root, path);
  if (rel.startsWith('..') || rel.split(sep).includes('..') || !existsSync(path) || !statSync(path).isFile()) {
    context.sendJson(res, 404, { error: 'Report not found. Run the tests first.' });
    return;
  }
  sendFile(res, path);
}

/**
 * Routes under /api/org/* and /api/e2e/*. Returns false when the path is not handled.
 */
export async function handleOrgRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  context: OrgRouteContext
): Promise<boolean> {
  const method = req.method ?? 'GET';
  if (method === 'GET' && parts[1] === 'org' && parts[2] === 'exports' && parts[3]) {
    sendFile(res, explorer.exportFile(context.cwd, parts[3]), true);
    return true;
  }
  if (method === 'GET' && parts[1] === 'e2e' && parts[2] === 'report') {
    sendReportFile(res, parts, context);
    return true;
  }

  const handler = ROUTES[`${method} ${parts.slice(1).join('/')}`];
  if (!handler) return false;
  const url = new URL(req.url ?? '/', 'http://localhost');
  const q = (key: string): string => url.searchParams.get(key) ?? '';
  const body = method === 'POST' ? await context.readBody(req) : {};
  const org = method === 'POST' ? str(body.org) : q('org');
  context.sendJson(res, 200, await handler({ org, body, q, context }));
  return true;
}
