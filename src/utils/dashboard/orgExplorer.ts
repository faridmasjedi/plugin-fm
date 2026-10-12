import { spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Org, type Connection } from '@salesforce/core';

/**
 * Org explorer behind the dashboard's Org page (in the spirit of Salesforce Inspector):
 * queries, bulk data, login history / audit trail, permission set assignments and
 * metadata retrieve. Uses the Salesforce CLI's own org authentication.
 */

export const EXPORTS_DIR = '.fm/exports';
const ACTIVITY_LOG = '.fm/org-activity.log';
const MAX_QUERY_ROWS = 50_000;

type Row = Record<string, unknown>;
type CachedConnection = { conn: Connection; at: number };
const connections = new Map<string, CachedConnection>();
const describeCache = new Map<string, { at: number; value: unknown }>();

export async function connect(org: string): Promise<Connection> {
  const hit = connections.get(org);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.conn;
  const conn = (await Org.create({ aliasOrUsername: org })).getConnection();
  connections.set(org, { conn, at: Date.now() });
  return conn;
}

async function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = describeCache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60_000) return hit.value as T;
  const value = await load();
  describeCache.set(key, { at: Date.now(), value });
  return value;
}

/** Appends an entry to the activity log for every change made through the dashboard. */
function logActivity(cwd: string, org: string, action: string, details: Row): void {
  const path = resolve(cwd, ACTIVITY_LOG);
  mkdirSync(resolve(cwd, '.fm'), { recursive: true });
  appendFileSync(
    path,
    `${JSON.stringify({ at: new Date().toISOString(), user: userInfo().username, org, action, ...details })}\n`
  );
}

export function readActivity(cwd: string, limit = 200): Row[] {
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

/** Changes must name the org they run against; the UI asks the person to type it. */
function requireConfirmation(org: string, confirm: unknown): void {
  if (confirm !== org) throw new Error(`Type the org name "${org}" to confirm this change.`);
}

// ---------- query ----------

/** Flattens a record: drops `attributes`, turns lookups into dotted columns, summarizes subqueries. */
export function flattenRecord(record: Row, prefix = '', out: Row = {}): Row {
  for (const [key, value] of Object.entries(record)) {
    if (key === 'attributes') continue;
    const column = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Row;
      if (Array.isArray(nested.records)) {
        out[column] = `${nested.records.length} record(s)`;
        out[`${column}.__json`] = JSON.stringify((nested.records as Row[]).map((r) => flattenRecord(r)));
      } else {
        flattenRecord(nested, column, out);
      }
    } else {
      out[column] = value;
    }
  }
  return out;
}

export type QueryRequest = { org: string; soql: string; tooling?: boolean; includeDeleted?: boolean; maxRows?: number };

export type QueryResponse = {
  columns: string[];
  rows: Row[];
  totalSize: number;
  truncated: boolean;
  sobject?: string;
  instanceUrl: string;
  tookMs: number;
};

export async function runQuery(request: QueryRequest): Promise<QueryResponse> {
  const start = Date.now();
  const conn = await connect(request.org);
  const api = request.tooling ? conn.tooling : conn;
  const max = Math.min(request.maxRows ?? 10_000, MAX_QUERY_ROWS);
  const soql = request.soql.trim().replace(/;$/, '');

  let result = await api.query<Row>(soql, { autoFetch: false, scanAll: Boolean(request.includeDeleted) });
  const records: Row[] = [...result.records];
  while (!result.done && result.nextRecordsUrl && records.length < max) {
    // eslint-disable-next-line no-await-in-loop
    result = await api.queryMore<Row>(result.nextRecordsUrl);
    records.push(...result.records);
  }

  const rows = records.slice(0, max).map((r) => flattenRecord(r));
  const columns: string[] = [];
  for (const row of rows)
    for (const key of Object.keys(row)) if (!columns.includes(key) && !key.endsWith('.__json')) columns.push(key);
  const sobject = (records[0]?.attributes as { type?: string } | undefined)?.type ?? /\bfrom\s+(\w+)/i.exec(soql)?.[1];
  return {
    columns,
    rows,
    totalSize: result.totalSize,
    truncated: records.length > max || !result.done,
    sobject,
    instanceUrl: conn.instanceUrl,
    tookMs: Date.now() - start,
  };
}

export async function listSObjects(
  org: string
): Promise<Array<{ name: string; label: string; custom: boolean; queryable: boolean }>> {
  return cached(`global:${org}`, async () => {
    const result = await (await connect(org)).describeGlobal();
    return result.sobjects
      .filter((s) => s.queryable)
      .map((s) => ({ name: s.name, label: s.label, custom: s.custom, queryable: s.queryable }));
  });
}

export type FieldInfo = {
  name: string;
  label: string;
  type: string;
  referenceTo: string[];
  relationshipName?: string | null;
  filterable?: boolean;
};

export async function describeObject(
  org: string,
  sobject: string,
  tooling = false
): Promise<{ name: string; label: string; fields: FieldInfo[] }> {
  if (!/^\w+$/.test(sobject)) throw new Error('Invalid object name.');
  return cached(`describe:${org}:${tooling ? 'tooling:' : ''}${sobject}`, async () => {
    const conn = await connect(org);
    const result = tooling ? await conn.tooling.describe(sobject) : await conn.describe(sobject);
    return {
      name: result.name,
      label: result.label,
      fields: result.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        referenceTo: f.referenceTo ?? [],
        relationshipName: f.relationshipName,
        filterable: f.filterable,
      })),
    };
  });
}

/** SELECT with every field of an object (base64 bodies left out: they only work for single records). */
export async function allFieldsSoql(org: string, sobject: string, tooling = false): Promise<string> {
  const { fields } = await describeObject(org, sobject, tooling);
  const names = fields.filter((f) => f.type !== 'base64').map((f) => f.name);
  return `SELECT ${names.join(', ')}\nFROM ${sobject}\nLIMIT 200`;
}

// ---------- bulk data ----------

/** Creates a folder whose contents git ignores (exports and reports contain org data). */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, '# Org data: never commit\n*\n');
}

function exportPath(cwd: string, name: string): string {
  const dir = resolve(cwd, EXPORTS_DIR);
  ensurePrivateDir(dir);
  return join(
    dir,
    `${name.replace(/[^\w.-]/g, '_')}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}.csv`
  );
}

export function exportFile(cwd: string, file: string): string {
  const root = resolve(cwd, EXPORTS_DIR);
  const path = resolve(root, file);
  if (relative(root, path).startsWith('..') || relative(root, path).includes(sep) || !existsSync(path)) {
    throw new Error('Export not found.');
  }
  return path;
}

/** Bulk API 2.0 query to a CSV file in .fm/exports. */
export async function bulkExport(
  cwd: string,
  request: { org: string; soql: string; includeDeleted?: boolean }
): Promise<{ file: string; rows: number }> {
  const conn = await connect(request.org);
  const sobject = /\bfrom\s+(\w+)/i.exec(request.soql)?.[1] ?? 'export';
  const path = exportPath(cwd, `${request.org}-${sobject}`);
  const stream = await conn.bulk2.query(request.soql.trim().replace(/;$/, ''), {
    scanAll: Boolean(request.includeDeleted),
    pollTimeout: 30 * 60_000,
  });
  await pipeline(stream.stream('csv'), createWriteStream(path));
  const rows = Math.max(0, readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).length - 1);
  logActivity(cwd, request.org, 'bulk-export', { soql: request.soql, rows, file: relative(cwd, path) });
  return { file: relative(resolve(cwd, EXPORTS_DIR), path), rows };
}

export type IngestRequest = {
  org: string;
  sobject: string;
  operation: 'insert' | 'update' | 'upsert' | 'delete' | 'hardDelete';
  csv: string;
  externalIdField?: string;
  confirm?: string;
};

export type IngestResponse = {
  processed: number;
  succeeded: number;
  failed: number;
  unprocessed: number;
  failures: Row[];
  failuresFile?: string;
};

/** Bulk API 2.0 insert / update / upsert / delete from CSV. */
export async function bulkIngest(cwd: string, request: IngestRequest): Promise<IngestResponse> {
  requireConfirmation(request.org, request.confirm);
  if (!/^\w+$/.test(request.sobject)) throw new Error('Invalid object name.');
  if (request.operation === 'upsert' && !request.externalIdField) throw new Error('Upsert needs an external ID field.');
  const conn = await connect(request.org);
  const results = await conn.bulk2.loadAndWaitForResults({
    object: request.sobject,
    operation: request.operation,
    ...(request.externalIdField ? { externalIdFieldName: request.externalIdField } : {}),
    input: request.csv,
    pollTimeout: 30 * 60_000,
  });

  const failures = (results.failedResults as unknown as Row[]).map((r) => ({ ...r }));
  let failuresFile: string | undefined;
  if (failures.length > 0) {
    const path = exportPath(cwd, `${request.org}-${request.sobject}-${request.operation}-failures`);
    const columns = Object.keys(failures[0]);
    const quote = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [columns.join(','), ...failures.map((f) => columns.map((c) => quote(f[c])).join(','))];
    writeFileSync(path, `${lines.join('\n')}\n`);
    failuresFile = relative(resolve(cwd, EXPORTS_DIR), path);
  }
  const response: IngestResponse = {
    processed: results.successfulResults.length + failures.length,
    succeeded: results.successfulResults.length,
    failed: failures.length,
    unprocessed: results.unprocessedRecords.length,
    failures: failures.slice(0, 200),
    failuresFile,
  };
  logActivity(cwd, request.org, `bulk-${request.operation}`, {
    sobject: request.sobject,
    succeeded: response.succeeded,
    failed: response.failed,
  });
  return response;
}

/** Deletes every record a query returns (Bulk API 2.0). */
export async function deleteByQuery(
  cwd: string,
  request: { org: string; soql: string; hardDelete?: boolean; confirm?: string }
): Promise<IngestResponse> {
  requireConfirmation(request.org, request.confirm);
  const sobject = /\bfrom\s+(\w+)/i.exec(request.soql)?.[1];
  if (!sobject) throw new Error('The query needs a FROM clause.');
  const soql = request.soql.replace(/^\s*select\s+[\s\S]+?\s+from\s+/i, 'SELECT Id FROM ');
  const conn = await connect(request.org);
  const stream = await conn.bulk2.query(soql, { pollTimeout: 30 * 60_000 });
  const ids: string[] = [];
  for await (const record of stream.stream('json') as AsyncIterable<Row>) ids.push(String(record.Id));
  if (ids.length === 0) return { processed: 0, succeeded: 0, failed: 0, unprocessed: 0, failures: [] };
  return bulkIngest(cwd, {
    org: request.org,
    sobject,
    operation: request.hardDelete ? 'hardDelete' : 'delete',
    csv: `Id\n${ids.join('\n')}\n`,
    confirm: request.confirm,
  });
}

// ---------- users & access ----------

/** Login history for the last N days, with usernames. */
export async function loginHistory(org: string, days: number): Promise<QueryResponse> {
  const n = Math.max(1, Math.min(180, Math.floor(days)));
  const history = await runQuery({
    org,
    soql: `SELECT Id, LoginTime, UserId, LoginType, Status, SourceIp, CountryIso, Application, Browser, Platform, LoginUrl, AuthenticationServiceId FROM LoginHistory WHERE LoginTime = LAST_N_DAYS:${n} ORDER BY LoginTime DESC`,
    maxRows: MAX_QUERY_ROWS,
  });
  const userIds = [...new Set(history.rows.map((r) => String(r.UserId)))];
  const names = new Map<string, Row>();
  for (let i = 0; i < userIds.length; i += 500) {
    const ids = userIds
      .slice(i, i + 500)
      .map((id) => `'${id}'`)
      .join(',');
    // eslint-disable-next-line no-await-in-loop
    const users = await runQuery({
      org,
      soql: `SELECT Id, Username, Name FROM User WHERE Id IN (${ids})`,
      maxRows: 500,
    });
    for (const u of users.rows) names.set(String(u.Id), u);
  }
  const rows = history.rows.map((r) => {
    const user = names.get(String(r.UserId));
    return { LoginTime: r.LoginTime, Username: user?.Username ?? '', Name: user?.Name ?? '', ...r };
  });
  return {
    ...history,
    rows,
    columns: ['LoginTime', 'Username', 'Name', ...history.columns.filter((c) => c !== 'LoginTime')],
  };
}

export function auditTrail(org: string, days: number): Promise<QueryResponse> {
  const n = Math.max(1, Math.min(180, Math.floor(days)));
  return runQuery({
    org,
    soql: `SELECT CreatedDate, CreatedBy.Username, CreatedBy.Name, Action, Section, Display, DelegateUser FROM SetupAuditTrail WHERE CreatedDate = LAST_N_DAYS:${n} ORDER BY CreatedDate DESC`,
    maxRows: MAX_QUERY_ROWS,
  });
}

export type AccessTarget = { kind: 'permset' | 'group'; id: string };

export async function listPermissionSets(
  org: string
): Promise<Array<{ kind: 'permset' | 'group'; id: string; name: string; label: string }>> {
  const [sets, groups] = await Promise.all([
    runQuery({
      org,
      soql: "SELECT Id, Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false AND Type != 'Group' ORDER BY Label",
      maxRows: 5000,
    }),
    runQuery({
      org,
      soql: 'SELECT Id, DeveloperName, MasterLabel FROM PermissionSetGroup ORDER BY MasterLabel',
      maxRows: 2000,
    }),
  ]);
  return [
    ...groups.rows.map((g) => ({
      kind: 'group' as const,
      id: String(g.Id),
      name: String(g.DeveloperName),
      label: String(g.MasterLabel),
    })),
    ...sets.rows.map((p) => ({
      kind: 'permset' as const,
      id: String(p.Id),
      name: String(p.Name),
      label: String(p.Label),
    })),
  ];
}

function targetField(target: AccessTarget): string {
  if (!/^[a-zA-Z0-9]{15,18}$/.test(target.id)) throw new Error('Invalid permission set id.');
  return target.kind === 'group' ? 'PermissionSetGroupId' : 'PermissionSetId';
}

export function assignments(org: string, target: AccessTarget): Promise<QueryResponse> {
  return runQuery({
    org,
    soql: `SELECT Id, Assignee.Username, Assignee.Name, Assignee.Profile.Name, Assignee.IsActive, ExpirationDate, SystemModstamp FROM PermissionSetAssignment WHERE ${targetField(
      target
    )} = '${target.id}' ORDER BY Assignee.Name`,
    maxRows: MAX_QUERY_ROWS,
  });
}

const escapeSoql = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Finds active users by usernames, profile, role or public group (direct user members). */
export async function findUsers(
  org: string,
  by: { usernames?: string[]; profile?: string; role?: string; publicGroup?: string }
): Promise<Row[]> {
  let where: string;
  if (by.usernames?.length) where = `Username IN (${by.usernames.map((u) => `'${escapeSoql(u.trim())}'`).join(',')})`;
  else if (by.profile) where = `Profile.Name = '${escapeSoql(by.profile)}'`;
  else if (by.role) where = `UserRole.Name = '${escapeSoql(by.role)}'`;
  else if (by.publicGroup) {
    where = `Id IN (SELECT UserOrGroupId FROM GroupMember WHERE Group.DeveloperName = '${escapeSoql(
      by.publicGroup
    )}' OR Group.Name = '${escapeSoql(by.publicGroup)}')`;
  } else throw new Error('Choose users by username, profile, role or public group.');
  const users = await runQuery({
    org,
    soql: `SELECT Id, Username, Name, Profile.Name FROM User WHERE IsActive = true AND (${where}) ORDER BY Name`,
    maxRows: MAX_QUERY_ROWS,
  });
  return users.rows;
}

/** Assigns a permission set or permission set group; users who already have it are skipped. */
export async function assignAccess(
  cwd: string,
  request: { org: string; target: AccessTarget; userIds: string[]; expirationDate?: string; confirm?: string }
): Promise<{ assigned: number; skipped: number; errors: string[] }> {
  requireConfirmation(request.org, request.confirm);
  const field = targetField(request.target);
  const have = new Set(
    (
      await runQuery({
        org: request.org,
        soql: `SELECT AssigneeId FROM PermissionSetAssignment WHERE ${field} = '${request.target.id}'`,
        maxRows: MAX_QUERY_ROWS,
      })
    ).rows.map((r) => String(r.AssigneeId))
  );
  const todo = request.userIds.filter((id) => /^005\w{12,15}$/.test(id) && !have.has(id));
  const conn = await connect(request.org);
  const errors: string[] = [];
  let assigned = 0;
  for (let i = 0; i < todo.length; i += 200) {
    const batch = todo.slice(i, i + 200).map((AssigneeId) => ({
      AssigneeId,
      [field]: request.target.id,
      ...(request.expirationDate ? { ExpirationDate: request.expirationDate } : {}),
    }));
    // eslint-disable-next-line no-await-in-loop
    const results = await conn.sobject('PermissionSetAssignment').create(batch, { allOrNone: false });
    for (const r of results) {
      if (r.success) assigned++;
      else errors.push(r.errors.map((e) => (typeof e === 'string' ? e : e.message)).join('; '));
    }
  }
  logActivity(cwd, request.org, 'assign-access', {
    target: request.target,
    assigned,
    skipped: request.userIds.length - todo.length,
    errors: errors.length,
  });
  return { assigned, skipped: request.userIds.length - todo.length, errors };
}

/** Removes permission set (group) assignments by assignment id. */
export async function removeAccess(
  cwd: string,
  request: { org: string; assignmentIds: string[]; confirm?: string }
): Promise<{ removed: number; errors: string[] }> {
  requireConfirmation(request.org, request.confirm);
  const ids = request.assignmentIds.filter((id) => /^0Pa\w{12,15}$/.test(id));
  const conn = await connect(request.org);
  const errors: string[] = [];
  let removed = 0;
  for (let i = 0; i < ids.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    const results = await conn.sobject('PermissionSetAssignment').destroy(ids.slice(i, i + 200), { allOrNone: false });
    for (const r of results) {
      if (r.success) removed++;
      else errors.push(r.errors.map((e) => (typeof e === 'string' ? e : e.message)).join('; '));
    }
  }
  logActivity(cwd, request.org, 'remove-access', { removed, errors: errors.length });
  return { removed, errors };
}

// ---------- metadata ----------

export async function metadataTypes(org: string): Promise<string[]> {
  return cached(`mdtypes:${org}`, async () => {
    const result = await (await connect(org)).metadata.describe();
    return result.metadataObjects.map((m) => m.xmlName).sort();
  });
}

export async function listMetadata(org: string, type: string): Promise<Row[]> {
  if (!/^\w+$/.test(type)) throw new Error('Invalid metadata type.');
  const result = await (await connect(org)).metadata.list([{ type }]);
  return ([] as Array<Record<string, unknown>>)
    .concat(result as unknown as Array<Record<string, unknown>>)
    .filter(Boolean)
    .map((m) => ({
      fullName: m.fullName,
      type: m.type,
      lastModifiedDate: m.lastModifiedDate,
      lastModifiedByName: m.lastModifiedByName,
      manageableState: m.manageableState,
    }))
    .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));
}

/** Retrieves metadata into the local project with `sf project retrieve start`. */
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
