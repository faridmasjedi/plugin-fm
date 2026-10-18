import type { SalesforceClient } from './client.js';
import { sobjectForId } from './inspector.js';
import { query, type Row } from './query.js';

/**
 * "VLOOKUP against Salesforce": values from a column of a file (Ids, usernames, emails,
 * external Ids…) are looked up in batches, and the records found are joined back onto the
 * file's rows. Read-only: only SELECT queries.
 */

const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const BATCH = 200;

export type LookupField = { name: string; label: string; type: string; filterable: boolean; nameField: boolean };

/** Fields of an object for the "match on" and "bring back" pickers. */
export async function lookupFields(client: SalesforceClient, sobject: string): Promise<LookupField[]> {
  if (!/^\w+$/.test(sobject)) throw new Error('Invalid object name.');
  const describe = await client.rest<{ fields: Array<LookupField & { filterable: boolean }> }>(
    'GET',
    `/sobjects/${sobject}/describe`
  );
  return describe.fields
    .map((f) => ({ name: f.name, label: f.label, type: f.type, filterable: f.filterable, nameField: f.nameField }))
    .sort((a, b) => Number(b.nameField) - Number(a.nameField) || a.label.localeCompare(b.label));
}

/** Distinct, non-empty values of a column. */
export function distinctValues(rows: Array<Record<string, unknown>>, column: string): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const value = String(row[column] ?? '').trim();
    if (value) seen.add(value);
  }
  return [...seen];
}

/** Objects the values are Ids of (by prefix), or undefined when they are not all Ids. */
export async function idObjects(client: SalesforceClient, values: string[]): Promise<string[] | undefined> {
  if (!values.length || values.some((v) => !ID.test(v))) return undefined;
  const prefixes = new Map<string, string>();
  for (const value of values) prefixes.set(value.slice(0, 3), value);
  const objects = new Set<string>();
  for (const sample of prefixes.values()) {
    // eslint-disable-next-line no-await-in-loop
    objects.add(await sobjectForId(client, sample));
  }
  return [...objects].sort();
}

/** Key used to match file values with records: Ids by their first 15 characters, text case-insensitively. */
export const matchKey = (value: unknown, byId: boolean): string => {
  const text = String(value ?? '').trim();
  return byId ? text.slice(0, 15) : text.toLowerCase();
};

const quote = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export type LookupRequest = {
  sobject: string;
  /** Field the values are matched on (Id, Username, Email, an External Id…). */
  matchField: string;
  values: string[];
  /** Fields to bring back (the match field is always read). */
  fields: string[];
};

export type LookupResult = {
  /** Match key -> records found (more than one when a non-unique field matches several). */
  found: Map<string, Row[]>;
  records: Row[];
  queries: number;
};

export const estimateQueries = (values: number): number => Math.ceil(values / BATCH);

/** Looks the values up in batches of 200. */
export async function lookupValues(
  client: SalesforceClient,
  request: LookupRequest,
  onProgress?: (done: number, total: number) => void
): Promise<LookupResult> {
  const { sobject, matchField } = request;
  if (!/^\w+$/.test(sobject) || !/^\w+$/.test(matchField)) throw new Error('Invalid object or field.');
  const byId = matchField === 'Id';
  const values = byId ? request.values.filter((v) => ID.test(v)) : request.values;
  const fields = [...new Set(['Id', matchField, ...request.fields.filter((f) => /^[\w.]+$/.test(f))])];
  const found = new Map<string, Row[]>();
  const records: Row[] = [];
  let queries = 0;
  for (let i = 0; i < values.length; i += BATCH) {
    const chunk = values.slice(i, i + BATCH);
    // eslint-disable-next-line no-await-in-loop
    const result = await query(
      client,
      `SELECT ${fields.join(', ')} FROM ${sobject} WHERE ${matchField} IN (${chunk.map(quote).join(',')})`,
      { maxRows: 50_000 }
    );
    queries++;
    for (const record of result.rows) {
      records.push(record);
      const key = matchKey(record[matchField], byId);
      if (!found.has(key)) found.set(key, []);
      found.get(key)!.push(record);
    }
    onProgress?.(Math.min(i + BATCH, values.length), values.length);
  }
  return { found, records, queries };
}

/**
 * The file's rows with the looked-up fields added ("ProfileId → Name") and a "Found" column
 * (yes / no / several when a value matched more than one record; the first is shown).
 */
export function joinBack(
  rows: Array<Record<string, unknown>>,
  columns: string[],
  column: string,
  byId: boolean,
  fields: string[],
  found: Map<string, Row[]>
): { columns: string[]; rows: Row[]; notFound: number } {
  const added = fields.map((f) => `${column} → ${f}`);
  const index = columns.indexOf(column);
  const outColumns = [...columns.slice(0, index + 1), `${column} → Found`, ...added, ...columns.slice(index + 1)];
  let notFound = 0;
  const outRows = rows.map((row) => {
    const value = String(row[column] ?? '').trim();
    const matches = value ? found.get(matchKey(value, byId)) ?? [] : [];
    if (value && !matches.length) notFound++;
    const first = matches[0];
    const next: Row = {
      ...row,
      [`${column} → Found`]: !value
        ? ''
        : matches.length > 1
        ? `several (${matches.length})`
        : matches.length
        ? 'yes'
        : 'no',
    };
    fields.forEach((f, i) => {
      next[added[i]] = first?.[f] ?? '';
    });
    return next;
  });
  return { columns: outColumns, rows: outRows, notFound };
}
