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

export async function query(client: SalesforceClient, soql: string, options: QueryOptions = {}): Promise<QueryResult> {
  const start = Date.now();
  const max = options.maxRows ?? 10_000;
  const resource = options.includeDeleted && !options.tooling ? '/queryAll' : '/query';
  const q = encodeURIComponent(soql.trim().replace(/;$/, ''));
  const call = (path: string): Promise<QueryPage> =>
    options.tooling ? client.tooling<QueryPage>('GET', path) : client.rest<QueryPage>('GET', path);

  let page = await call(`${resource}?q=${q}`);
  const records = [...page.records];
  while (!page.done && page.nextRecordsUrl && records.length < max) {
    // nextRecordsUrl is absolute from the instance root; strip the version prefix
    const next = page.nextRecordsUrl.replace(/^\/services\/data\/v[\d.]+(\/tooling)?/, '');
    // eslint-disable-next-line no-await-in-loop
    page = await call(next);
    records.push(...page.records);
  }

  const rows = records.slice(0, max).map((r) => flattenRecord(r));
  const columns: string[] = [];
  for (const row of rows) for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
  return {
    columns,
    rows,
    totalSize: page.totalSize,
    truncated: records.length > max || !page.done,
    sobject: (records[0]?.attributes as { type?: string } | undefined)?.type ?? mainSObject(soql),
    durationMs: Date.now() - start,
  };
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
