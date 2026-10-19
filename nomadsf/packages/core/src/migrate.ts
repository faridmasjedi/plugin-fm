import { chooseFields, type DataField, type FieldChoice } from './backup.js';
import type { SalesforceClient } from './client.js';
import {
  defaultMasking,
  fetchRelated,
  fetchRows,
  fieldPlan,
  loadOrder,
  loadRecords,
  type FieldPlan,
  type LoadProgress,
  type LoadResult,
  type MaskRule,
  type OrgMaps,
  type SourceRow,
  SYSTEM_FIELDS,
} from './dataLoad.js';
import { query } from './query.js';

/**
 * Moving data between orgs (or from a backup into an org): which objects and records, which
 * fields, masking, then the rows are gathered parents first and loaded with the Id mapping of
 * dataLoad. "Related only" takes just the records that point to records already chosen, so a
 * sandbox can be seeded with e.g. 100 Accounts and their Contacts and Opportunities.
 */

export type MigrateObject = {
  name: string;
  /** SOQL condition (source org only; a backup has no SOQL). */
  where?: string;
  fields?: FieldChoice;
  /** Only records whose lookups point to records of the objects loaded before it. */
  relatedOnly?: boolean;
  /** Only the records other copied records point to (brought by completeParents). */
  onlyReferenced?: boolean;
};

export type MigrateObjectPlan = {
  name: string;
  fields: FieldPlan;
  /** Fields read from the source (the field choice, with Id). */
  read: string[];
  mask: Record<string, MaskRule>;
  /** Lookups to objects of the plan (for "related only" and the order). */
  links: Array<{ field: string; to: string }>;
  relatedOnly: boolean;
  onlyReferenced: boolean;
  where?: string;
};

export type MigratePlan = {
  order: string[];
  deferred: Record<string, string[]>;
  objects: MigrateObjectPlan[];
  schemas: Record<string, { source: DataField[]; target: DataField[] }>;
  /** Objects that do not exist in the target. */
  missingObjects: string[];
};

export function planMigration(
  input: MigrateObject[],
  schemas: Record<string, { source: DataField[]; target: DataField[] }>,
  options: { mask: boolean; maskOverrides?: Record<string, Record<string, MaskRule | 'none'>> }
): MigratePlan {
  const missingObjects = input.filter((o) => !schemas[o.name]?.target.length).map((o) => o.name);
  const usable = input.filter((o) => !missingObjects.includes(o.name));
  const names = usable.map((o) => o.name);
  const { order, deferred } = loadOrder(names, Object.fromEntries(names.map((n) => [n, schemas[n].source])));
  const objects = order.map((name) => {
    const o = usable.find((x) => x.name === name)!;
    const { source, target } = schemas[name];
    const read = chooseFields(source, o.fields);
    const fields = fieldPlan({ source, target }, read);
    const mask: Record<string, MaskRule> = options.mask
      ? defaultMasking(target.filter((f) => fields.write.includes(f.name)))
      : {};
    for (const [field, rule] of Object.entries(options.maskOverrides?.[name] ?? {})) {
      if (rule === 'none') delete mask[field];
      else if (fields.write.includes(field)) mask[field] = rule;
    }
    const links = source
      .filter((f) => f.type === 'reference' && read.includes(f.name))
      .flatMap((f) =>
        f.referenceTo.filter((to) => names.includes(to) && to !== name).map((to) => ({ field: f.name, to }))
      );
    return {
      name,
      fields,
      read,
      mask,
      links,
      relatedOnly: Boolean(o.relatedOnly),
      onlyReferenced: Boolean(o.onlyReferenced),
      where: o.where,
    };
  });
  return { order, deferred, objects, schemas, missingObjects };
}

export type RowSource =
  | { kind: 'org'; client: SalesforceClient }
  | { kind: 'backup'; rows: Record<string, Map<string, SourceRow>> };

/** The rows to load, parents first; "related only" objects keep the rows linked to rows gathered before. */
export async function gatherRows(
  source: RowSource,
  plan: MigratePlan,
  onProgress?: (object: string, rows: number) => void
): Promise<Record<string, SourceRow[]>> {
  const out: Record<string, SourceRow[]> = {};
  for (const o of plan.objects) {
    const links = o.links.filter((l) => out[l.to]).map((l) => ({ field: l.field, ids: out[l.to].map((r) => r.Id) }));
    let rows: SourceRow[];
    if (o.onlyReferenced) {
      rows = [];
    } else if (source.kind === 'org') {
      /* eslint-disable no-await-in-loop */
      rows =
        o.relatedOnly && links.length
          ? await fetchRelated(source.client, o.name, o.read, links, o.where)
          : await fetchRows(source.client, o.name, o.read, o.where);
      /* eslint-enable no-await-in-loop */
    } else {
      const all = [...(source.rows[o.name]?.values() ?? [])];
      const linked = links.map((l) => ({ field: l.field, ids: new Set(l.ids) }));
      rows = o.relatedOnly && links.length ? all.filter((r) => linked.some((l) => l.ids.has(r[l.field]))) : all;
    }
    out[o.name] = rows;
    onProgress?.(o.name, rows.length);
  }
  return out;
}

export async function runMigration(
  target: SalesforceClient,
  plan: MigratePlan,
  rows: Record<string, SourceRow[]>,
  options: {
    maps: OrgMaps;
    known?: Record<string, string>;
    keepUnmapped?: boolean;
    onProgress?: LoadProgress;
    signal?: AbortSignal;
    onIds?: (ids: Record<string, string>) => void | Promise<void>;
  }
): Promise<LoadResult> {
  return loadRecords(
    target,
    plan.objects.map((o) => ({
      name: o.name,
      source: plan.schemas[o.name].source,
      target: plan.schemas[o.name].target,
      mask: o.mask,
    })),
    rows,
    options
  );
}

// ---------- keeping every link ----------

/** Users, queues and record types are matched by name, not copied. */
const MAPPED_BY_NAME = new Set(['User', 'Group', 'RecordType']);
const ID = /^[a-zA-Z0-9]{15,18}$/;
const k15 = (id: string): string => id.slice(0, 15);

export type LookupLink = { object: string; field: string; to: string[] };

/** The lookups copied with the records (to other records; users, queues and record types aside). */
export function lookupsOf(plan: MigratePlan): LookupLink[] {
  const out: LookupLink[] = [];
  for (const o of plan.objects) {
    for (const f of plan.schemas[o.name].source) {
      if (f.type !== 'reference' || SYSTEM_FIELDS.has(f.name) || !o.fields.write.includes(f.name)) continue;
      const to = f.referenceTo.filter((t) => !MAPPED_BY_NAME.has(t));
      if (to.length) out.push({ object: o.name, field: f.name, to });
    }
  }
  return out;
}

/** Which object an Id belongs to: the only target of the lookup, else by its key prefix. */
function objectOf(id: string, to: string[], prefixes: Map<string, string>): string | undefined {
  if (to.length === 1) return to[0];
  const byPrefix = prefixes.get(id.slice(0, 3));
  return byPrefix && to.includes(byPrefix) ? byPrefix : undefined;
}

function prefixMap(
  plan: MigratePlan,
  rows: Record<string, SourceRow[]>,
  known?: Record<string, string>
): Map<string, string> {
  const map = new Map(Object.entries(known ?? {}));
  for (const o of plan.order) {
    const first = rows[o]?.[0]?.Id;
    if (first && !map.has(first.slice(0, 3))) map.set(first.slice(0, 3), o);
  }
  return map;
}

const asRow = (r: Record<string, unknown>): SourceRow =>
  Object.fromEntries(
    Object.entries(r)
      .filter(([k]) => k !== 'attributes')
      .map(([k, v]) => [k, v === null || v === undefined ? '' : String(v)])
  );

/** Records of an object by Id: from the backup, or the org (200 Ids per query). */
async function rowsById(source: RowSource, object: string, fields: string[], ids: string[]): Promise<SourceRow[]> {
  if (source.kind === 'backup') {
    const all = source.rows[object];
    if (!all) return [];
    const by15 = new Map([...all.values()].map((r) => [k15(r.Id), r]));
    return ids.map((id) => all.get(id) ?? by15.get(k15(id))).filter((r): r is SourceRow => Boolean(r));
  }
  const out: SourceRow[] = [];
  const valid = ids.filter((id) => ID.test(id));
  for (let i = 0; i < valid.length; i += 200) {
    const list = valid
      .slice(i, i + 200)
      .map((id) => `'${id}'`)
      .join(',');
    // eslint-disable-next-line no-await-in-loop
    const result = await query(source.client, `SELECT ${fields.join(', ')} FROM ${object} WHERE Id IN (${list})`, {
      maxRows: 200,
    });
    out.push(...result.rows.map(asRow));
  }
  return out;
}

/**
 * Adds the records the chosen ones point to (Case -> its Account, Account -> its parent
 * Account…), up the whole chain, so no lookup between copied objects ends up empty.
 */
export async function completeParents(
  source: RowSource,
  plan: MigratePlan,
  rows: Record<string, SourceRow[]>,
  options: { prefixes?: Record<string, string>; onProgress?: (object: string, added: number) => void } = {}
): Promise<Record<string, number>> {
  const inPlan = new Set(plan.order);
  const links = lookupsOf(plan);
  const prefixes = prefixMap(plan, rows, options.prefixes);
  const added: Record<string, number> = {};
  for (let round = 0; round < 10; round++) {
    const have = new Map(plan.order.map((o) => [o, new Set((rows[o] ?? []).map((r) => k15(r.Id)))]));
    const want = new Map<string, Set<string>>();
    for (const link of links) {
      for (const r of rows[link.object] ?? []) {
        const value = r[link.field];
        if (!value || !ID.test(value)) continue;
        const object = objectOf(
          value,
          link.to.filter((t) => inPlan.has(t)),
          prefixes
        );
        if (!object || have.get(object)!.has(k15(value))) continue;
        if (!want.has(object)) want.set(object, new Set());
        want.get(object)!.add(value);
      }
    }
    if (!want.size) break;
    let fetched = 0;
    for (const [object, ids] of want) {
      const read = plan.objects.find((o) => o.name === object)!.read;
      /* eslint-disable no-await-in-loop */
      const more = await rowsById(source, object, read, [...ids]);
      /* eslint-enable no-await-in-loop */
      rows[object] = [...(rows[object] ?? []), ...more];
      added[object] = (added[object] ?? 0) + more.length;
      fetched += more.length;
      options.onProgress?.(object, added[object]);
    }
    // Ids that are not in the source any more (deleted) cannot be brought
    if (!fetched) break;
  }
  return added;
}

export type LinkStatus = {
  object: string;
  field: string;
  /** The object the lookup points to. */
  to: string;
  /** Records with a value in this lookup. */
  withValue: number;
  /** Will point to a record of the copy. */
  linked: number;
  /** Will point to a record already in the target (an earlier copy, or matched). */
  matched: number;
  /** Will be empty: the record is not in the copy (its object is), or its object is not copied. */
  empty: number;
  /** The object pointed to is part of the copy. */
  inCopy: boolean;
};

/** For every lookup: how many records keep their link, before anything is copied. */
export function linkReport(
  plan: MigratePlan,
  rows: Record<string, SourceRow[]>,
  known: Record<string, string> = {},
  prefixes?: Record<string, string>
): LinkStatus[] {
  const inPlan = new Set(plan.order);
  const map = prefixMap(plan, rows, prefixes);
  const have = new Map(plan.order.map((o) => [o, new Set((rows[o] ?? []).map((r) => k15(r.Id)))]));
  const knownBy15 = new Set(Object.keys(known).map(k15));
  const out = new Map<string, LinkStatus>();
  for (const link of lookupsOf(plan)) {
    for (const r of rows[link.object] ?? []) {
      const value = r[link.field];
      if (!value || !ID.test(value)) continue;
      const to = objectOf(value, link.to, map) ?? link.to.join(' / ');
      const key = `${link.object}.${link.field}.${to}`;
      const status = out.get(key) ?? {
        object: link.object,
        field: link.field,
        to,
        withValue: 0,
        linked: 0,
        matched: 0,
        empty: 0,
        inCopy: inPlan.has(to),
      };
      out.set(key, status);
      status.withValue++;
      if (have.get(to)?.has(k15(value))) status.linked++;
      else if (knownBy15.has(k15(value))) status.matched++;
      else status.empty++;
    }
  }
  return [...out.values()];
}

export type MatchRule = { object: string; by: 'id' | string };
export type MatchResult = {
  ids: Record<string, string>;
  stats: Record<string, { looked: number; matched: number; ambiguous: number }>;
};

const soqlText = (v: string): string => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/**
 * Links to records that are not copied but already exist in the target: the same Id (a sandbox
 * refreshed from the same production keeps the Ids of records that existed then), or the same
 * value of a field (Name, an external Id…). Returns source Id -> target Id.
 */
export async function matchInTarget(
  source: RowSource,
  target: SalesforceClient,
  plan: MigratePlan,
  rows: Record<string, SourceRow[]>,
  rules: MatchRule[],
  prefixes?: Record<string, string>
): Promise<MatchResult> {
  const map = prefixMap(plan, rows, prefixes);
  const inPlan = new Set(plan.order);
  const ids: Record<string, string> = {};
  const stats: MatchResult['stats'] = {};
  for (const rule of rules) {
    if (!/^\w+$/.test(rule.object) || (rule.by !== 'id' && !/^\w+$/.test(rule.by)))
      throw new Error('Invalid match rule.');
    const have = new Set((rows[rule.object] ?? []).map((r) => k15(r.Id)));
    const wanted = new Set<string>();
    for (const link of lookupsOf(plan)) {
      if (!link.to.includes(rule.object)) continue;
      for (const r of rows[link.object] ?? []) {
        const value = r[link.field];
        if (
          value &&
          ID.test(value) &&
          objectOf(value, link.to, map) === rule.object &&
          !(inPlan.has(rule.object) && have.has(k15(value)))
        )
          wanted.add(value);
      }
    }
    const list = [...wanted];
    const stat = { looked: list.length, matched: 0, ambiguous: 0 };
    stats[rule.object] = stat;
    for (let i = 0; i < list.length; i += 200) {
      const chunk = list.slice(i, i + 200);
      /* eslint-disable no-await-in-loop */
      if (rule.by === 'id') {
        const found = await query(
          target,
          `SELECT Id FROM ${rule.object} WHERE Id IN (${chunk.map((id) => `'${id}'`).join(',')})`,
          { maxRows: 200 }
        );
        const exists = new Map(found.rows.map((r) => [k15(String(r.Id)), String(r.Id)]));
        for (const id of chunk) {
          const t = exists.get(k15(id));
          if (t) {
            ids[id] = t;
            stat.matched++;
          }
        }
      } else {
        // The field's value in the source, then the record with that value in the target
        const sourceRows = await rowsById(source, rule.object, ['Id', rule.by], chunk);
        const values = new Map(sourceRows.filter((r) => r[rule.by]).map((r) => [k15(r.Id), r[rule.by]]));
        const distinct = [...new Set(values.values())];
        if (!distinct.length) continue;
        const found = await query(
          target,
          `SELECT Id, ${rule.by} FROM ${rule.object} WHERE ${rule.by} IN (${distinct.map(soqlText).join(',')})`,
          { maxRows: 50_000 }
        );
        const byValue = new Map<string, string[]>();
        for (const r of found.rows) {
          const v = String(r[rule.by] ?? '');
          byValue.set(v, [...(byValue.get(v) ?? []), String(r.Id)]);
        }
        for (const id of chunk) {
          const v = values.get(k15(id));
          const hits = v === undefined ? [] : byValue.get(v) ?? [];
          if (hits.length === 1) {
            ids[id] = hits[0];
            stat.matched++;
          } else if (hits.length > 1) stat.ambiguous++;
        }
      }
      /* eslint-enable no-await-in-loop */
    }
  }
  return { ids, stats };
}

// ---------- child objects of a parent ----------

export type ChildObject = {
  object: string;
  /** Lookups of the child that point to the parent (Case.AccountId; a child can have several). */
  fields: string[];
};

type ChildRelationship = { childSObject: string; field: string; deprecatedAndHidden?: boolean };

/** Objects that point to `parent` (from the org's describe), limited to the objects offered for copying. */
export async function childObjectsOf(
  client: SalesforceClient,
  parent: string,
  allowed: Set<string>
): Promise<ChildObject[]> {
  if (!/^\w+$/.test(parent)) throw new Error('Invalid object name.');
  const describe = await client.rest<{ childRelationships?: ChildRelationship[] }>(
    'GET',
    `/sobjects/${parent}/describe`
  );
  const byObject = new Map<string, string[]>();
  for (const r of describe.childRelationships ?? []) {
    if (
      r.deprecatedAndHidden ||
      r.childSObject === parent ||
      !allowed.has(r.childSObject) ||
      SYSTEM_FIELDS.has(r.field)
    )
      continue;
    byObject.set(r.childSObject, [...new Set([...(byObject.get(r.childSObject) ?? []), r.field])]);
  }
  return [...byObject].map(([object, fields]) => ({ object, fields })).sort((a, b) => a.object.localeCompare(b.object));
}

/** The same from a backup's field definitions (objects of the backup whose lookups point to `parent`). */
export function childObjectsInSchema(schema: Record<string, DataField[]>, parent: string): ChildObject[] {
  return Object.entries(schema)
    .filter(([object]) => object !== parent)
    .map(([object, fields]) => ({
      object,
      fields: fields
        .filter((f) => f.type === 'reference' && f.referenceTo.includes(parent) && !SYSTEM_FIELDS.has(f.name))
        .map((f) => f.name),
    }))
    .filter((c) => c.fields.length)
    .sort((a, b) => a.object.localeCompare(b.object));
}

/**
 * Records of a child object linked to the parent's records (those matching the parent's
 * condition), per lookup field. SOQL does not allow semi-joins with OR, so each lookup is
 * counted on its own.
 */
export async function countChildren(
  source: RowSource,
  parent: string,
  child: ChildObject,
  parentWhere?: string
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (source.kind === 'backup') {
    const parents = new Set([...(source.rows[parent]?.keys() ?? [])].map((id) => id.slice(0, 15)));
    for (const field of child.fields)
      out[field] = [...(source.rows[child.object]?.values() ?? [])].filter(
        (r) => r[field] && parents.has(r[field].slice(0, 15))
      ).length;
    return out;
  }
  const condition = (parentWhere ?? '').trim().replace(/^where\s+/i, '');
  for (const field of child.fields) {
    if (!/^\w+$/.test(field) || !/^\w+$/.test(child.object)) continue;
    const soql = `SELECT COUNT() FROM ${child.object} WHERE ${field} IN (SELECT Id FROM ${parent}${
      condition ? ` WHERE ${condition}` : ''
    })`;
    // eslint-disable-next-line no-await-in-loop
    out[field] = (await query(source.client, soql)).totalSize;
  }
  return out;
}

// ---------- will it fit? ----------

export type OrgCapacity = {
  api?: { max: number; remaining: number };
  dataMB?: { max: number; remaining: number };
  fileMB?: { max: number; remaining: number };
};

export async function orgCapacity(client: SalesforceClient): Promise<OrgCapacity> {
  const limits = await client.rest<Record<string, { Max: number; Remaining: number }>>('GET', '/limits');
  const pick = (key: string): { max: number; remaining: number } | undefined =>
    limits[key] ? { max: limits[key].Max, remaining: limits[key].Remaining } : undefined;
  return { api: pick('DailyApiRequests'), dataMB: pick('DataStorageMB'), fileMB: pick('FileStorageMB') };
}

/** Salesforce counts most records as 2 KB of data storage. */
const RECORD_KB = 2;

/**
 * Warnings before a copy: data and file storage left in the target, daily API calls, and a
 * hint to use the Bulk API (old-Id field) for large copies.
 */
export function capacityWarnings(
  capacity: OrgCapacity,
  need: { records: number; fileBytes: number; bulk: boolean; files?: number }
): string[] {
  const out: string[] = [];
  const dataMB = (need.records * RECORD_KB) / 1024;
  if (capacity.dataMB && dataMB > capacity.dataMB.remaining)
    out.push(
      `Data storage: the copy needs about ${Math.ceil(dataMB)} MB, the target has ${
        capacity.dataMB.remaining
      } MB left of ${capacity.dataMB.max} MB. It will stop when the storage is full.`
    );
  else if (capacity.dataMB && dataMB > capacity.dataMB.remaining * 0.8)
    out.push(
      `Data storage: the copy uses most of what is left (${Math.ceil(dataMB)} of ${capacity.dataMB.remaining} MB).`
    );
  const fileMB = need.fileBytes / (1024 * 1024);
  if (capacity.fileMB && fileMB > capacity.fileMB.remaining)
    out.push(
      `File storage: the files need about ${Math.ceil(fileMB)} MB, the target has ${capacity.fileMB.remaining} MB left.`
    );
  // REST collections: one call per 200 records (plus linking); Bulk: a few calls per 10,000; files: two calls each
  const calls = Math.ceil(need.bulk ? (need.records / 10_000) * 8 : (need.records / 200) * 1.3) + (need.files ?? 0) * 2;
  if (capacity.api && calls > capacity.api.remaining * 0.8)
    out.push(
      `API calls: about ${calls.toLocaleString()} needed, ${capacity.api.remaining.toLocaleString()} left today in the target.`
    );
  if (!need.bulk && need.records > 50_000)
    out.push(
      `Large copy (${need.records.toLocaleString()} records): "Keep the old Ids in the target org" loads with the Bulk API, uses far fewer API calls and can be run again safely if it stops.`
    );
  return out;
}
