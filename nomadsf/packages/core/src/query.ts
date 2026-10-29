import type { SalesforceClient } from './client.js';

export type Row = Record<string, unknown>;

type QueryPage = { totalSize: number; done: boolean; nextRecordsUrl?: string; records: Row[] };

export type QueryOptions = {
  tooling?: boolean;
  /** Include deleted and archived records (queryAll). */
  includeDeleted?: boolean;
  maxRows?: number;
};

export type QueryResult = {
  columns: string[];
  rows: Row[];
  totalSize: number;
  truncated: boolean;
  sobject?: string;
  durationMs: number;
};

/** Drops `attributes`, turns lookups into dotted columns and summarizes subqueries. */
export function flattenRecord(record: Row, prefix = '', out: Row = {}): Row {
  for (const [key, value] of Object.entries(record)) {
    if (key === 'attributes') continue;
    const column = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Row;
      if (Array.isArray(nested.records)) out[column] = `${nested.records.length} record(s)`;
      else flattenRecord(nested, column, out);
    } else {
      out[column] = value;
    }
  }
  return out;
}

/** Object of the top-level FROM, ignoring subqueries: SELECT Id, (SELECT Id FROM Contacts) FROM Account -> Account. */
export function mainSObject(soql: string): string | undefined {
  let text = soql;
  for (let previous = ''; previous !== text; ) {
    previous = text;
    text = text.replace(/\([^()]*\)/g, '');
  }
  return /\bfrom\s+(\w+)/i.exec(text)?.[1];
}

/**
 * Adds fields to the top-level SELECT (before its FROM, outside subqueries and strings);
 * fields already selected are skipped. `SELECT Id FROM Case` + Account.Name ->
 * `SELECT Id, Account.Name FROM Case`.
 */
export function addToSelect(soql: string, fields: string[]): string {
  let depth = 0;
  let quoted = false;
  let from = -1;
  for (let i = 0; i < soql.length; i++) {
    const c = soql[i];
    if (quoted) {
      if (c === '\\') i++;
      else if (c === "'") quoted = false;
    } else if (c === "'") quoted = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && /\s/.test(c) && /^\s+from\s/i.test(soql.slice(i))) {
      from = i;
      break;
    }
  }
  if (from < 0) throw new Error('The query needs a FROM clause.');
  const select = soql.slice(0, from);
  const have = new Set(
    select
      .replace(/^\s*select\s+/i, '')
      .replace(/\([^()]*\)/g, '')
      .split(',')
      .map((f) => f.trim().toLowerCase())
  );
  const missing = [...new Set(fields)].filter((f) => !have.has(f.toLowerCase()));
  if (!missing.length) return soql;
  return `${select.replace(/\s+$/, '')}, ${missing.join(', ')}${soql.slice(from)}`;
}

/** A query being read page by page (Salesforce returns up to 2,000 rows per page). */
export type QueryCursor = QueryResult & {
  /** Next page to read; undefined when every row is loaded. */
  next?: string;
  tooling: boolean;
};

function addColumns(columns: string[], rows: Row[]): string[] {
  const out = [...columns];
  for (const row of rows) for (const key of Object.keys(row)) if (!out.includes(key)) out.push(key);
  return out;
}

const pathOf = (nextRecordsUrl?: string): string | undefined =>
  // nextRecordsUrl is absolute from the instance root; strip the version prefix
  nextRecordsUrl?.replace(/^\/services\/data\/v[\d.]+(\/tooling)?/, '');

/** Runs a query and reads its first page. */
export async function openQuery(
  client: SalesforceClient,
  soql: string,
  options: Omit<QueryOptions, 'maxRows'> = {}
): Promise<QueryCursor> {
  const start = Date.now();
  const tooling = Boolean(options.tooling);
  const resource = options.includeDeleted && !tooling ? '/queryAll' : '/query';
  const q = encodeURIComponent(soql.trim().replace(/;$/, ''));
  const page = tooling
    ? await client.tooling<QueryPage>('GET', `${resource}?q=${q}`)
    : await client.rest<QueryPage>('GET', `${resource}?q=${q}`);
  const rows = page.records.map((r) => flattenRecord(r));
  return {
    columns: addColumns([], rows),
    rows,
    totalSize: page.totalSize,
    truncated: !page.done,
    sobject: (page.records[0]?.attributes as { type?: string } | undefined)?.type ?? mainSObject(soql),
    durationMs: Date.now() - start,
    next: page.done ? undefined : pathOf(page.nextRecordsUrl),
    tooling,
  };
}

/** Reads the next page of a cursor; returns a new cursor with the rows appended. */
export async function queryMore(client: SalesforceClient, cursor: QueryCursor): Promise<QueryCursor> {
  if (!cursor.next) return cursor;
  const start = Date.now();
  const page = cursor.tooling
    ? await client.tooling<QueryPage>('GET', cursor.next)
    : await client.rest<QueryPage>('GET', cursor.next);
  const added = page.records.map((r) => flattenRecord(r));
  return {
    ...cursor,
    columns: addColumns(cursor.columns, added),
    rows: [...cursor.rows, ...added],
    truncated: !page.done,
    durationMs: cursor.durationMs + Date.now() - start,
    next: page.done ? undefined : pathOf(page.nextRecordsUrl),
  };
}

/** Reads up to `maxRows` rows (default 10,000) in one call. */
export async function query(client: SalesforceClient, soql: string, options: QueryOptions = {}): Promise<QueryResult> {
  const max = options.maxRows ?? 10_000;
  let cursor = await openQuery(client, soql, options);
  while (cursor.next && cursor.rows.length < max) {
    // eslint-disable-next-line no-await-in-loop
    cursor = await queryMore(client, cursor);
  }
  const rows = cursor.rows.slice(0, max);
  return {
    columns: cursor.columns,
    rows,
    totalSize: cursor.totalSize,
    truncated: cursor.rows.length > max || Boolean(cursor.next),
    sobject: cursor.sobject,
    durationMs: cursor.durationMs,
  };
}

/** A value inside a SOQL string literal: backslashes and quotes escaped. */
export const soqlText = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Parent-to-child subqueries ("(SELECT … FROM Contacts)") are not supported by Bulk API 2.0. */
export function bulkCompatible(soql: string, tooling: boolean): boolean {
  return !tooling && !/\(\s*select\b/i.test(soql);
}

export type SObjectSummary = { name: string; label: string; custom: boolean; queryable: boolean; keyPrefix?: string };
export type FieldSummary = {
  name: string;
  label: string;
  type: string;
  referenceTo: string[];
  relationshipName?: string | null;
};

export async function describeGlobal(client: SalesforceClient, tooling = false): Promise<SObjectSummary[]> {
  const path = '/sobjects';
  const result = tooling
    ? await client.tooling<{ sobjects: SObjectSummary[] }>('GET', path)
    : await client.rest<{ sobjects: SObjectSummary[] }>('GET', path);
  return result.sobjects.filter((s) => s.queryable);
}

export async function describeSObject(
  client: SalesforceClient,
  name: string,
  tooling = false
): Promise<{ name: string; label: string; fields: FieldSummary[] }> {
  if (!/^\w+$/.test(name)) throw new Error('Invalid object name.');
  const path = `/sobjects/${name}/describe`;
  type Describe = { name: string; label: string; fields: FieldSummary[] };
  const result = tooling ? await client.tooling<Describe>('GET', path) : await client.rest<Describe>('GET', path);
  return {
    name: result.name,
    label: result.label,
    fields: result.fields.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      referenceTo: f.referenceTo ?? [],
      relationshipName: f.relationshipName,
    })),
  };
}
