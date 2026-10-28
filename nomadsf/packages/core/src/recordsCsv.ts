import type { SalesforceClient } from './client.js';
import type { CsvTable } from './csv.js';
import { query, type Row } from './query.js';

/**
 * A CSV of records next to an org: each CSV row matched to a record by a key field, compared field
 * by field, and applied (update what differs, insert what is missing). Lookups are compared and set
 * by the name of what they point to, when the CSV has it (Account.Name for AccountId): Ids from
 * another org mean nothing here.
 */

type Field = {
  name: string;
  label: string;
  type: string;
  createable: boolean;
  updateable: boolean;
  referenceTo: string[];
  relationshipName: string | null;
  idLookup: boolean;
};

export type CsvColumn = {
  column: string;
  /** The field it sets; for "Account.Name" that is AccountId. */
  field: string;
  /** For a lookup by name: the object and its name field. */
  lookup?: { sobject: string; nameField: string };
  updateable: boolean;
  createable: boolean;
};

export type CsvPlan = { sobject: string; key: string; columns: CsvColumn[]; ignored: string[]; keyFields: string[] };

const soqlText = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Which CSV columns can be compared and set: fields of the object, and Relationship.Name for its lookups. */
export async function planCsv(
  client: SalesforceClient,
  sobject: string,
  columns: string[],
  key: string
): Promise<CsvPlan> {
  if (!/^\w+$/.test(sobject)) throw new Error('Invalid object.');
  const d = await client.rest<{ fields: Field[] }>('GET', `/sobjects/${sobject}/describe`);
  const byName = new Map(d.fields.map((f) => [f.name.toLowerCase(), f]));
  const byRelationship = new Map(
    d.fields
      .filter((f) => f.relationshipName && f.referenceTo.length)
      .map((f) => [f.relationshipName!.toLowerCase(), f])
  );
  const out: CsvColumn[] = [];
  const ignored: string[] = [];
  for (const column of columns) {
    const direct = byName.get(column.toLowerCase());
    const [rel, nameField] = column.split('.');
    const via = nameField ? byRelationship.get(rel.toLowerCase()) : undefined;
    if (direct && !direct.referenceTo.length && column !== 'Id') {
      out.push({ column, field: direct.name, updateable: direct.updateable, createable: direct.createable });
    } else if (via && nameField && /^(Name|Username|DeveloperName)$/i.test(nameField)) {
      out.push({
        column,
        field: via.name,
        lookup: { sobject: via.referenceTo[0], nameField },
        updateable: via.updateable,
        createable: via.createable,
      });
    } else if (column !== 'Id') ignored.push(column);
  }
  const keyFields = d.fields.filter((f) => f.idLookup || f.name === 'Name').map((f) => f.name);
  if (key !== 'Id' && !out.some((c) => c.column === key))
    throw new Error(`The key ${key} is not a field of ${sobject} in the CSV.`);
  return { sobject, key, columns: out, ignored, keyFields };
}

export type RecordDifference = { field: string; column: string; csv: string; org: string };
export type CsvRowResult = {
  row: number;
  key: string;
  status: 'same' | 'different' | 'only in CSV' | 'no key';
  id?: string;
  differences: RecordDifference[];
};

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
/** 2026-01-05 is 2026-01-05T00:00:00.000+0000; the same instant written two ways is the same. */
const sameDate = (a: string, b: string): boolean => {
  const day = /^\d{4}-\d{2}-\d{2}/;
  if (!day.test(a) || !day.test(b)) return false;
  if (a.length === 10 || b.length === 10) return a.slice(0, 10) === b.slice(0, 10);
  return Date.parse(a) === Date.parse(b);
};

/** Equal as Salesforce means it: true / TRUE, 5 / 5.0, a date with or without its time. */
const same = (a: string, b: string): boolean =>
  a === b ||
  (/^(true|false)$/i.test(a) && a.toLowerCase() === b.toLowerCase()) ||
  (a !== '' && b !== '' && !Number.isNaN(Number(a)) && !Number.isNaN(Number(b)) && Number(a) === Number(b)) ||
  sameDate(a, b);

/** Each CSV row next to its record in the org. */
export async function compareCsv(client: SalesforceClient, plan: CsvPlan, table: CsvTable): Promise<CsvRowResult[]> {
  const keyColumn = plan.key;
  const keys = [...new Set(table.rows.map((r) => (r[keyColumn] ?? '').trim()).filter(Boolean))];
  const select = [
    'Id',
    ...new Set([
      ...(plan.key === 'Id' ? [] : [plan.key]),
      ...plan.columns.map((c) => (c.lookup ? `${c.column.split('.')[0]}.${c.lookup.nameField}` : c.field)),
    ]),
  ];
  const found = new Map<string, Row>();
  for (let i = 0; i < keys.length; i += 200) {
    const batch = keys
      .slice(i, i + 200)
      .map((k) => `'${soqlText(k)}'`)
      .join(',');
    // eslint-disable-next-line no-await-in-loop
    const rows = (
      await query(client, `SELECT ${select.join(', ')} FROM ${plan.sobject} WHERE ${plan.key} IN (${batch})`, {
        maxRows: 50_000,
      })
    ).rows;
    for (const r of rows) found.set(text(r[plan.key]).toLowerCase(), r);
  }
  return table.rows.map((r, row) => {
    const key = (r[keyColumn] ?? '').trim();
    if (!key) return { row, key, status: 'no key' as const, differences: [] };
    const record = found.get(key.toLowerCase());
    if (!record) return { row, key, status: 'only in CSV' as const, differences: [] };
    const differences = plan.columns
      .filter((c) => c.column !== plan.key)
      .map((c) => {
        const org = text(c.lookup ? record[`${c.column.split('.')[0]}.${c.lookup.nameField}`] : record[c.field]);
        return { field: c.field, column: c.column, csv: r[c.column] ?? '', org };
      })
      .filter((d) => !same(d.csv, d.org));
    return {
      row,
      key,
      status: differences.length ? ('different' as const) : ('same' as const),
      id: text(record.Id),
      differences,
    };
  });
}

type CollectionResult = { id?: string; success: boolean; errors: Array<{ message: string }> };
export type CsvApplyResult = { updated: number; inserted: number; failed: Array<{ key: string; error: string }> };

/**
 * Makes the org match the CSV for the rows given: updates the fields that differ (only updateable
 * ones) and inserts the rows that are only in the CSV (createable fields). Lookups by name are found
 * in this org first; a name it does not have fails that row.
 */
export async function applyCsv(
  client: SalesforceClient,
  plan: CsvPlan,
  table: CsvTable,
  results: CsvRowResult[]
): Promise<CsvApplyResult> {
  const describe = await client.rest<{ fields: Field[] }>('GET', `/sobjects/${plan.sobject}/describe`);
  const typeOf = new Map(describe.fields.map((f) => [f.name, f.type]));
  // Every name the chosen rows point to, looked up once per object
  const names = new Map<string, Map<string, string>>();
  for (const c of plan.columns.filter((x) => x.lookup)) {
    const wanted = [...new Set(results.map((r) => (table.rows[r.row][c.column] ?? '').trim()).filter(Boolean))];
    const map = names.get(c.column) ?? new Map<string, string>();
    for (let i = 0; i < wanted.length; i += 200) {
      const list = wanted
        .slice(i, i + 200)
        .map((w) => `'${soqlText(w)}'`)
        .join(',');
      // eslint-disable-next-line no-await-in-loop
      const rows = (
        await query(
          client,
          `SELECT Id, ${c.lookup!.nameField} FROM ${c.lookup!.sobject} WHERE ${c.lookup!.nameField} IN (${list})`,
          { maxRows: 50_000 }
        )
      ).rows;
      for (const r of rows) map.set(text(r[c.lookup!.nameField]).toLowerCase(), text(r.Id));
    }
    names.set(c.column, map);
  }
  const value = (c: CsvColumn, raw: string): unknown => {
    const v = raw.trim();
    if (v === '') return null;
    if (c.lookup) {
      const id = names.get(c.column)?.get(v.toLowerCase());
      if (!id) throw new Error(`${c.lookup.sobject} "${v}" is not in this org`);
      return id;
    }
    const type = typeOf.get(c.field);
    if (type === 'boolean') return /^(true|1|yes)$/i.test(v);
    if (['double', 'int', 'currency', 'percent', 'long'].includes(type ?? '')) return Number(v);
    return v;
  };

  const out: CsvApplyResult = { updated: 0, inserted: 0, failed: [] };
  const updates: Array<{ key: string; record: Row }> = [];
  const inserts: Array<{ key: string; record: Row }> = [];
  for (const r of results) {
    const source = table.rows[r.row];
    try {
      if (r.status === 'different' && r.id) {
        const record: Row = { attributes: { type: plan.sobject }, Id: r.id };
        for (const d of r.differences) {
          const c = plan.columns.find((x) => x.column === d.column)!;
          if (c.updateable) record[c.field] = value(c, source[c.column] ?? '');
        }
        if (Object.keys(record).length > 2) updates.push({ key: r.key, record });
      } else if (r.status === 'only in CSV') {
        const record: Row = { attributes: { type: plan.sobject } };
        for (const c of plan.columns.filter((x) => x.createable)) {
          const v = value(c, source[c.column] ?? '');
          if (v !== null) record[c.field] = v;
        }
        inserts.push({ key: r.key, record });
      }
    } catch (e) {
      out.failed.push({ key: r.key, error: (e as Error).message });
    }
  }
  const send = async (method: 'PATCH' | 'POST', list: Array<{ key: string; record: Row }>): Promise<number> => {
    let ok = 0;
    for (let i = 0; i < list.length; i += 200) {
      const batch = list.slice(i, i + 200);
      // eslint-disable-next-line no-await-in-loop
      const results2 = await client.rest<CollectionResult[]>(method, '/composite/sobjects', {
        allOrNone: false,
        records: batch.map((b) => b.record),
      });
      results2.forEach((res, j) => {
        if (res.success) ok++;
        else out.failed.push({ key: batch[j].key, error: res.errors.map((e) => e.message).join('; ') });
      });
    }
    return ok;
  };
  out.updated = await send('PATCH', updates);
  out.inserted = await send('POST', inserts);
  return out;
}
