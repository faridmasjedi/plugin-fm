import type { SalesforceClient } from './client.js';
import { sobjectForId } from './inspector.js';
import { query, type Row } from './query.js';

/**
 * Names (and any other fields) for the Id columns of a result, also where SOQL cannot follow
 * the link (LoginHistory.UserId, polymorphic WhoId, Tooling Ids…): the object comes from each
 * Id's 3-character prefix and the records are read in batches, then shown in extra columns next
 * to the Id ("UserId → Name", "UserId → Username", "UserId → Profile.Name").
 */

const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
/** A field or a path through lookups (Profile.Name), as typed into SOQL. */
const FIELD_PATH = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*){0,4}$/;
const BATCH = 200;

/** Extra fields worth showing for some objects, besides the name field. */
const EXTRA: Record<string, string[]> = { User: ['Username'] };

export type IdNameLookup = {
  /** Id column -> the extra columns added after it (Name, Username, then chosen fields). */
  added: Record<string, string[]>;
  /** 15- and 18-character Id -> values of the extra columns (Name for the name field, then by field). */
  values: Map<string, Record<string, string>>;
  /** Id column -> the objects its Ids belong to (more than one for WhoId, WhatId…). */
  objects: Record<string, string[]>;
};

export type IdLookupOptions = {
  /** An earlier lookup with the same choice of fields: only Ids not seen yet are read. */
  known?: IdNameLookup;
  maxIds?: number;
  /** The name field (and Username for users); default true. */
  names?: boolean;
  /** More fields per object, e.g. { User: ['Email', 'Profile.Name'] }. */
  related?: Record<string, string[]>;
};

/** Columns whose values are all record Ids (the row's own Id excluded). */
export function idColumns(columns: string[], rows: Row[]): string[] {
  return columns.filter((column) => {
    if (column === 'Id' || column.endsWith('.Id')) return false;
    let seen = 0;
    for (const row of rows) {
      const value = row[column];
      if (value === null || value === undefined || value === '') continue;
      if (typeof value !== 'string' || !ID.test(value)) return false;
      if (++seen >= 50) break;
    }
    return seen > 0;
  });
}

type NameFields = { name: string; fields: string[] } | null;
const nameFieldCache = new WeakMap<SalesforceClient, Map<string, Promise<NameFields>>>();

/** Name field (+ extras) of an object, or null when it has none or cannot be queried. */
function nameFields(client: SalesforceClient, sobject: string): Promise<NameFields> {
  let cache = nameFieldCache.get(client);
  if (!cache) {
    cache = new Map();
    nameFieldCache.set(client, cache);
  }
  let found = cache.get(sobject);
  if (!found) {
    found = client
      .rest<{ queryable: boolean; fields: Array<{ name: string; nameField: boolean }> }>(
        'GET',
        `/sobjects/${sobject}/describe`
      )
      .then((d) => {
        const name = d.fields.find((f) => f.nameField)?.name;
        if (!d.queryable || !name) return null;
        const have = new Set(d.fields.map((f) => f.name));
        return { name, fields: [name, ...(EXTRA[sobject] ?? []).filter((f) => have.has(f))] };
      })
      .catch(() => null);
    cache.set(sobject, found);
  }
  return found;
}

/**
 * Looks up names for the Id columns of a result. `known` (an earlier lookup) is reused, so
 * loading more rows only asks for Ids not seen yet. At most `maxIds` new Ids are looked up.
 */
export async function lookupIdNames(
  client: SalesforceClient,
  columns: string[],
  rows: Row[],
  options: IdLookupOptions = {}
): Promise<IdNameLookup> {
  const values = new Map(options.known?.values);
  const added: Record<string, string[]> = { ...options.known?.added };
  const objects: Record<string, string[]> = { ...options.known?.objects };
  const names = options.names ?? true;
  const maxIds = options.maxIds ?? 20_000;
  const columnsWithIds = idColumns(columns, rows);

  // Ids still unknown, grouped by object (from their prefix)
  const byObject = new Map<string, Set<string>>();
  const objectOf = new Map<string, string>();
  let budget = maxIds;
  for (const column of columnsWithIds) {
    for (const row of rows) {
      const id = row[column];
      if (typeof id !== 'string' || !ID.test(id) || values.has(id) || budget <= 0) continue;
      const prefix = id.slice(0, 3);
      if (!objectOf.has(prefix)) {
        // eslint-disable-next-line no-await-in-loop
        objectOf.set(prefix, await sobjectForId(client, id).catch(() => ''));
      }
      const sobject = objectOf.get(prefix)!;
      if (!sobject) continue;
      objects[column] = [...new Set([...(objects[column] ?? []), sobject])];
      if (!byObject.has(sobject)) byObject.set(sobject, new Set());
      if (!byObject.get(sobject)!.has(id)) budget--;
      byObject.get(sobject)!.add(id);
    }
  }

  for (const [sobject, ids] of byObject) {
    // eslint-disable-next-line no-await-in-loop
    const named = await nameFields(client, sobject);
    const chosen = (options.related?.[sobject] ?? []).filter((f) => f !== 'Id' && FIELD_PATH.test(f));
    // Read as: the name field shows as "Name"; chosen fields by their own name
    const keys = new Map<string, string>();
    if (names && named) named.fields.forEach((f) => keys.set(f, f === named.name ? 'Name' : f));
    chosen.forEach((f) => keys.set(f, keys.get(f) ?? f));
    if (!keys.size) continue;
    const fields = [...keys.keys()];
    const list = [...ids];
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      // eslint-disable-next-line no-await-in-loop
      const result = await query(
        client,
        `SELECT Id, ${fields.join(', ')} FROM ${sobject} WHERE Id IN ('${chunk.join("','")}')`,
        { maxRows: BATCH }
      ).catch(() => undefined);
      for (const record of result?.rows ?? []) {
        const entry = Object.fromEntries(
          fields.map((f) => [keys.get(f)!, record[f] == null || typeof record[f] === 'object' ? '' : String(record[f])])
        );
        const id18 = String(record.Id);
        values.set(id18, entry);
        values.set(id18.slice(0, 15), entry);
      }
    }
  }

  // Columns to add: Name (and object extras such as Username) for each Id column with results
  for (const column of columnsWithIds) {
    const fields = new Set(added[column] ?? []);
    for (const row of rows) {
      const entry = typeof row[column] === 'string' ? values.get(row[column] as string) : undefined;
      if (entry) Object.keys(entry).forEach((f) => fields.add(f));
    }
    if (fields.size) {
      // Name first, then Username, then the chosen fields in their order
      const rank = (f: string): number => (f === 'Name' ? 0 : f === 'Username' ? 1 : 2);
      added[column] = [...fields].sort((a, b) => rank(a) - rank(b));
    }
  }
  return { added, values, objects };
}

export const idNameColumn = (column: string, field: string): string => `${column} → ${field}`;

/** The result with the looked-up columns placed right after each Id column. */
export function withIdNames(columns: string[], rows: Row[], lookup: IdNameLookup): { columns: string[]; rows: Row[] } {
  const extra = Object.entries(lookup.added);
  if (!extra.length) return { columns, rows };
  const out: string[] = [];
  for (const column of columns) {
    out.push(column);
    for (const field of lookup.added[column] ?? []) out.push(idNameColumn(column, field));
  }
  return {
    columns: out,
    rows: rows.map((row) => {
      const next: Row = { ...row };
      for (const [column, fields] of extra) {
        const entry = typeof row[column] === 'string' ? lookup.values.get(row[column] as string) : undefined;
        for (const field of fields) next[idNameColumn(column, field)] = entry?.[field] ?? '';
      }
      return next;
    }),
  };
}
