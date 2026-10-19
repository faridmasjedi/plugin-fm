import { describeData, type DataField } from './backup.js';
import { bulkQuery } from './bulk.js';
import { SESSION_PLACEHOLDER, SalesforceClient } from './client.js';
import { parseCsv } from './csv.js';
import { query } from './query.js';
import { xmlBlocks, xmlValue } from './soap.js';

/**
 * Loading records into an org when their Ids cannot be kept: migrating between orgs, and
 * bringing deleted records back. Objects load parents first; every new record's Id is kept
 * (source Id -> target Id) so the lookups of the next objects point to the right records.
 * Self and circular lookups are set in a second pass. Owners map by username, record types and
 * queues by API name. Records go in through the REST sObject Collections API (200 per call,
 * results in order), so every source row knows its new Id.
 */

export type SourceRow = Record<string, string>;

// ---------- order ----------

/** Lookups that are not data to copy: who created or changed it, and system links. */
const SYSTEM_FIELDS = new Set([
  'Id',
  'IsDeleted',
  'CreatedById',
  'CreatedDate',
  'LastModifiedById',
  'LastModifiedDate',
  'SystemModstamp',
  'LastActivityDate',
  'LastViewedDate',
  'LastReferencedDate',
  'MasterRecordId',
]);

export type LoadOrder = {
  /** Parents before children. */
  order: string[];
  /** Lookups set in a second pass (to the same object, or breaking a circle). */
  deferred: Record<string, string[]>;
};

/** Load order of the objects from their lookups; circles are broken at a lookup that may be empty. */
export function loadOrder(objects: string[], schemas: Record<string, DataField[]>): LoadOrder {
  const set = new Set(objects);
  const deferred: Record<string, string[]> = {};
  // object -> objects it needs first, with the fields that make the link
  const needs = new Map<string, Map<string, string[]>>();
  for (const o of objects) {
    const links = new Map<string, string[]>();
    for (const f of schemas[o] ?? []) {
      if (f.type !== 'reference' || SYSTEM_FIELDS.has(f.name) || !f.createable) continue;
      for (const parent of f.referenceTo) {
        if (!set.has(parent)) continue;
        if (parent === o) (deferred[o] ??= []).push(f.name);
        else links.set(parent, [...(links.get(parent) ?? []), f.name]);
      }
    }
    needs.set(o, links);
  }
  const order: string[] = [];
  const done = new Set<string>();
  while (order.length < objects.length) {
    const ready = objects.filter((o) => !done.has(o) && [...needs.get(o)!.keys()].every((p) => done.has(p)));
    if (ready.length) {
      for (const o of ready) {
        order.push(o);
        done.add(o);
      }
      continue;
    }
    // A circle: defer the optional links of one object in it (the one with the fewest required ones)
    const left = objects.filter((o) => !done.has(o));
    const required = (o: string): number =>
      [...needs.get(o)!].filter(
        ([p, fields]) => !done.has(p) && fields.some((name) => !schemas[o].find((f) => f.name === name)?.nillable)
      ).length;
    // Objects many others need (Account) load first; their own optional links wait
    const dependents = (o: string): number => left.filter((x) => x !== o && needs.get(x)!.has(o)).length;
    const pick = left.sort((a, b) => required(a) - required(b) || dependents(b) - dependents(a))[0];
    for (const [parent, fields] of needs.get(pick)!) {
      if (done.has(parent)) continue;
      deferred[pick] = [...(deferred[pick] ?? []), ...fields];
      needs.get(pick)!.delete(parent);
    }
  }
  return { order, deferred };
}

// ---------- mapping between orgs ----------

export type OrgMaps = {
  /** Source user Id -> target user Id (by username without the sandbox suffix). */
  users: Map<string, string>;
  /** Source record type Id -> target record type Id (by object + API name). */
  recordTypes: Map<string, string>;
  /** Source queue Id -> target queue Id (by API name). */
  queues: Map<string, string>;
  /** Owner for records whose owner has no match in the target. */
  defaultOwner?: string;
};

/** "ann@acme.com.uat" -> "ann@acme.com" in a sandbox; usernames of production stay as they are. */
export const baseUsername = (username: string, sandbox: boolean): string =>
  (sandbox ? username.replace(/\.[^.@]+$/, '') : username).toLowerCase();

type Named = { Id: string; [key: string]: unknown };

/** Users, record types and queues of both orgs, matched. Same org: every Id maps to itself. */
export async function orgMaps(
  source: SalesforceClient,
  target: SalesforceClient,
  options: { sourceSandbox: boolean; targetSandbox: boolean; defaultOwner?: string }
): Promise<OrgMaps> {
  const rows = async (client: SalesforceClient, soql: string): Promise<Named[]> =>
    (await query(client, soql, { maxRows: 50_000 })).rows as Named[];
  const pair = async (
    soql: string,
    key: (r: Named, sandbox: boolean) => string,
    onlyTarget?: (r: Named) => boolean
  ) => {
    const [a, b] = await Promise.all([rows(source, soql), rows(target, soql)]);
    const byKey = new Map(
      b.filter((r) => !onlyTarget || onlyTarget(r)).map((r) => [key(r, options.targetSandbox), r.Id])
    );
    const out = new Map<string, string>();
    for (const r of a) {
      const match = byKey.get(key(r, options.sourceSandbox));
      if (match) out.set(r.Id, match);
    }
    return out;
  };
  const [users, recordTypes, queues] = await Promise.all([
    pair(
      'SELECT Id, Username, IsActive FROM User',
      (r, sandbox) => baseUsername(String(r.Username), sandbox),
      (r) => Boolean(r.IsActive)
    ),
    pair(
      'SELECT Id, DeveloperName, SobjectType FROM RecordType',
      (r) => `${String(r.SobjectType)}.${String(r.DeveloperName)}`
    ),
    pair("SELECT Id, DeveloperName FROM Group WHERE Type = 'Queue'", (r) => String(r.DeveloperName)),
  ]);
  return { users, recordTypes, queues, defaultOwner: options.defaultOwner };
}

/** Same org (bringing records back): users, record types and queues keep their Ids. */
export const sameOrgMaps = (): OrgMaps => ({ users: new Map(), recordTypes: new Map(), queues: new Map() });

// ---------- masking ----------

export type MaskRule = 'email' | 'phone' | 'name' | 'text' | 'blank';

/** Fields masked by default: e-mails and phones, people's names, street addresses. */
export function defaultMasking(fields: DataField[]): Record<string, MaskRule> {
  const out: Record<string, MaskRule> = {};
  for (const f of fields) {
    if (!f.createable || f.type === 'reference' || f.type === 'id') continue;
    if (f.type === 'email') out[f.name] = 'email';
    else if (f.type === 'phone') out[f.name] = 'phone';
    else if (/^(FirstName|LastName|MiddleName|Suffix)$/.test(f.name)) out[f.name] = 'name';
    else if (/(Street|Birthdate|SSN|TaxId|IBAN)/i.test(f.name) && f.type !== 'boolean')
      out[f.name] = f.nillable ? 'blank' : 'text';
  }
  return out;
}

/** A small stable hash, so the same value always gets the same fake value (relations stay readable). */
function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

const NAMES = [
  'Alex',
  'Sam',
  'Robin',
  'Jamie',
  'Taylor',
  'Morgan',
  'Casey',
  'Jordan',
  'Riley',
  'Avery',
  'Quinn',
  'Drew',
];

export function maskValue(rule: MaskRule, value: string): string {
  if (!value) return value;
  const n = hash(value);
  switch (rule) {
    case 'email':
      return `user${n % 1_000_000}@example.invalid`;
    case 'phone':
      return `+1 555 01${String(n % 100).padStart(2, '0')} ${String(n % 10_000).padStart(4, '0')}`;
    case 'name':
      return `${NAMES[n % NAMES.length]}${n % 1000}`;
    case 'text':
      return `masked-${n % 1_000_000}`;
    case 'blank':
      return '';
  }
}

// ---------- turning a source row into a target record ----------

export type ObjectLoad = {
  name: string;
  /** Field definitions in the source (for which fields are lookups) and the target (what can be written). */
  source: DataField[];
  target: DataField[];
  /** Masking per field. */
  mask?: Record<string, MaskRule>;
};

export type FieldPlan = { write: string[]; missing: string[]; readOnly: string[] };

/** Fields copied: in both orgs and writable on insert in the target (system fields aside). */
export function fieldPlan(load: Pick<ObjectLoad, 'source' | 'target'>, columns?: string[]): FieldPlan {
  const target = new Map(load.target.map((f) => [f.name, f]));
  const names = columns ?? load.source.map((f) => f.name);
  const write: string[] = [];
  const missing: string[] = [];
  const readOnly: string[] = [];
  for (const name of names) {
    if (SYSTEM_FIELDS.has(name)) continue;
    const t = target.get(name);
    if (!t) missing.push(name);
    else if (!t.createable || t.calculated) readOnly.push(name);
    else write.push(name);
  }
  return { write, missing, readOnly };
}

export type Resolver = {
  ids: Map<string, string>;
  maps: OrgMaps;
  /** Lookups to records outside the load keep their Id (same org, or a sandbox copied from the same production). */
  keepUnmapped: boolean;
};

export type Transformed = { record: Record<string, unknown>; deferred: Record<string, string>; dropped: string[] };

/** One source row as a target record: lookups translated, masked fields replaced, empty values left out. */
export function transformRow(
  row: SourceRow,
  load: ObjectLoad,
  write: string[],
  deferredFields: string[],
  resolver: Resolver
): Transformed {
  const record: Record<string, unknown> = {};
  const deferred: Record<string, string> = {};
  const dropped: string[] = [];
  const fields = new Map(load.target.map((f) => [f.name, f]));
  for (const name of write) {
    const value = row[name];
    if (value === undefined || value === '') continue;
    const field = fields.get(name)!;
    if (field.type === 'reference') {
      if (deferredFields.includes(name)) {
        deferred[name] = value;
        continue;
      }
      const mapped = resolveReference(name, field, value, resolver);
      if (mapped) record[name] = mapped;
      else dropped.push(name);
      continue;
    }
    const rule = load.mask?.[name];
    const out = rule ? maskValue(rule, value) : value;
    if (out !== '') record[name] = field.type === 'boolean' ? out === 'true' : out;
  }
  return { record, deferred, dropped };
}

function resolveReference(name: string, field: DataField, value: string, resolver: Resolver): string | undefined {
  const { ids, maps, keepUnmapped } = resolver;
  const loaded = ids.get(value);
  if (loaded) return loaded;
  if (name === 'RecordTypeId') return maps.recordTypes.get(value) ?? (keepUnmapped ? value : undefined);
  if (field.referenceTo.includes('User') || field.referenceTo.includes('Group')) {
    const person = maps.users.get(value) ?? maps.queues.get(value);
    if (person) return person;
    if (keepUnmapped) return value;
    return name === 'OwnerId' ? maps.defaultOwner : undefined;
  }
  return keepUnmapped ? value : undefined;
}

// ---------- writing (sObject Collections: 200 per call, results in order) ----------

type SaveResult = {
  id?: string;
  success: boolean;
  errors?: Array<{ statusCode: string; message: string; fields?: string[] }>;
};

const CHUNK = 200;
const errorText = (r: SaveResult): string =>
  (r.errors ?? [])
    .map((e) => `${e.statusCode}: ${e.message}${e.fields?.length ? ` (${e.fields.join(', ')})` : ''}`)
    .join('; ') || 'Failed';

export async function createRecords(
  client: SalesforceClient,
  object: string,
  records: Array<Record<string, unknown>>
): Promise<SaveResult[]> {
  const out: SaveResult[] = [];
  for (let i = 0; i < records.length; i += CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    const results = await client.rest<SaveResult[]>('POST', '/composite/sobjects', {
      allOrNone: false,
      records: records.slice(i, i + CHUNK).map((r) => ({ attributes: { type: object }, ...r })),
    });
    out.push(...results);
  }
  return out;
}

export async function updateRecords(
  client: SalesforceClient,
  object: string,
  records: Array<Record<string, unknown> & { Id: string }>
): Promise<SaveResult[]> {
  const out: SaveResult[] = [];
  for (let i = 0; i < records.length; i += CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    const results = await client.rest<SaveResult[]>('PATCH', '/composite/sobjects', {
      allOrNone: false,
      records: records.slice(i, i + CHUNK).map((r) => ({ attributes: { type: object }, ...r })),
    });
    out.push(...results);
  }
  return out;
}

export async function deleteRecords(client: SalesforceClient, ids: string[]): Promise<SaveResult[]> {
  const out: SaveResult[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    if (chunk.some((id) => !/^\w{15,18}$/.test(id))) throw new Error('Invalid Id.');
    // eslint-disable-next-line no-await-in-loop
    out.push(
      ...(await client.rest<SaveResult[]>('DELETE', `/composite/sobjects?allOrNone=false&ids=${chunk.join(',')}`))
    );
  }
  return out;
}

/** Brings records back from the recycle bin (they keep their Ids). */
export async function undeleteRecords(
  client: SalesforceClient,
  ids: string[]
): Promise<Array<{ id: string; success: boolean; error?: string }>> {
  const out: Array<{ id: string; success: boolean; error?: string }> = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    if (chunk.some((id) => !/^\w{15,18}$/.test(id))) throw new Error('Invalid Id.');
    // eslint-disable-next-line no-await-in-loop
    const xml = await client.soap(
      'partner',
      `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">
<soapenv:Header><urn:SessionHeader><urn:sessionId>${SESSION_PLACEHOLDER}</urn:sessionId></urn:SessionHeader></soapenv:Header>
<soapenv:Body><urn:undelete>${chunk.map((id) => `<urn:ids>${id}</urn:ids>`).join('')}</urn:undelete></soapenv:Body>
</soapenv:Envelope>`
    );
    xmlBlocks(xml, 'result').forEach((r, k) =>
      out.push({
        id: xmlValue(r, 'id') || chunk[k],
        success: xmlValue(r, 'success') === 'true',
        error: xmlValue(r, 'message') || undefined,
      })
    );
  }
  return out;
}

// ---------- the load ----------

export type LoadFailure = { object: string; sourceId: string; error: string };
export type ObjectLoadResult = {
  name: string;
  rows: number;
  created: number;
  updated: number;
  failed: number;
  /** Lookups left empty because their record is not in the target (field -> rows). */
  dropped: Record<string, number>;
};
export type LoadResult = {
  objects: ObjectLoadResult[];
  failures: LoadFailure[];
  /** Source Id -> target Id of every record created or matched, for the next run and for undo. */
  ids: Record<string, string>;
  /** Created records per object, newest object first (undo deletes in this order). */
  created: Array<{ object: string; ids: string[] }>;
};

export type LoadProgress = (step: {
  object: string;
  index: number;
  total: number;
  done: number;
  rows: number;
  phase: string;
}) => void;

/**
 * Loads rows (per object, with their source Ids) into the target. Rows whose source Id is
 * already in `known` (an earlier run) update that record instead of creating a new one.
 */
export async function loadRecords(
  target: SalesforceClient,
  loads: ObjectLoad[],
  rows: Record<string, SourceRow[]>,
  options: {
    maps: OrgMaps;
    keepUnmapped?: boolean;
    known?: Record<string, string>;
    onProgress?: LoadProgress;
    signal?: AbortSignal;
  }
): Promise<LoadResult> {
  const schemas = Object.fromEntries(loads.map((l) => [l.name, l.source]));
  const { order, deferred } = loadOrder(
    loads.map((l) => l.name),
    schemas
  );
  const ids = new Map(Object.entries(options.known ?? {}));
  const resolver: Resolver = { ids, maps: options.maps, keepUnmapped: Boolean(options.keepUnmapped) };
  const results: ObjectLoadResult[] = [];
  const failures: LoadFailure[] = [];
  const created: LoadResult['created'] = [];
  const later: Array<{ object: string; targetId: string; fields: Record<string, string> }> = [];

  for (const [index, name] of order.entries()) {
    if (options.signal?.aborted) throw new Error('Stopped.');
    const load = loads.find((l) => l.name === name)!;
    const list = rows[name] ?? [];
    const plan = fieldPlan(load, list.length ? Object.keys(list[0]) : undefined);
    const result: ObjectLoadResult = { name, rows: list.length, created: 0, updated: 0, failed: 0, dropped: {} };
    results.push(result);
    const step = (done: number, phase: string): void =>
      options.onProgress?.({ object: name, index, total: order.length, done, rows: list.length, phase });
    const fresh: Array<{ row: SourceRow; t: Transformed }> = [];
    const existing: Array<{ row: SourceRow; t: Transformed; id: string }> = [];
    for (const row of list) {
      const t = transformRow(row, load, plan.write, deferred[name] ?? [], resolver);
      for (const d of t.dropped) result.dropped[d] = (result.dropped[d] ?? 0) + 1;
      const known = ids.get(row.Id);
      if (known) existing.push({ row, t, id: known });
      else fresh.push({ row, t });
    }
    step(0, 'creating');
    /* eslint-disable no-await-in-loop */
    const made = await createRecords(
      target,
      name,
      fresh.map((f) => f.t.record)
    );
    const newIds: string[] = [];
    made.forEach((r, k) => {
      const { row, t } = fresh[k];
      if (r.success && r.id) {
        ids.set(row.Id, r.id);
        newIds.push(r.id);
        result.created++;
        if (Object.keys(t.deferred).length) later.push({ object: name, targetId: r.id, fields: t.deferred });
      } else {
        result.failed++;
        failures.push({ object: name, sourceId: row.Id, error: errorText(r) });
      }
    });
    if (newIds.length) created.unshift({ object: name, ids: newIds });
    if (existing.length) {
      step(made.length, 'updating');
      const updated = await updateRecords(
        target,
        name,
        existing.map((e) => ({ ...e.t.record, Id: e.id }))
      );
      updated.forEach((r, k) => {
        const e = existing[k];
        if (r.success) {
          result.updated++;
          if (Object.keys(e.t.deferred).length) later.push({ object: name, targetId: e.id, fields: e.t.deferred });
        } else {
          result.failed++;
          failures.push({ object: name, sourceId: e.row.Id, error: errorText(r) });
        }
      });
    }
    step(list.length, 'done');
  }

  // Second pass: lookups to the same object or across a circle, now that every record exists
  for (const name of order) {
    const updates = later
      .filter((l) => l.object === name)
      .map((l) => {
        const record: Record<string, unknown> & { Id: string } = { Id: l.targetId };
        for (const [field, value] of Object.entries(l.fields)) {
          const mapped = ids.get(value) ?? (resolver.keepUnmapped ? value : undefined);
          if (mapped) record[field] = mapped;
        }
        return record;
      })
      .filter((r) => Object.keys(r).length > 1);
    if (!updates.length) continue;
    options.onProgress?.({
      object: name,
      index: order.indexOf(name),
      total: order.length,
      done: 0,
      rows: updates.length,
      phase: 'linking',
    });
    const done = await updateRecords(target, name, updates);
    done.forEach((r, k) => {
      if (!r.success) failures.push({ object: name, sourceId: updates[k].Id, error: `Linking: ${errorText(r)}` });
    });
  }
  /* eslint-enable no-await-in-loop */
  return { objects: results, failures, ids: Object.fromEntries(ids), created };
}

/** Deletes what a load created, children first. */
export async function undoLoad(
  target: SalesforceClient,
  created: LoadResult['created'],
  onProgress?: (object: string) => void
): Promise<{ deleted: number; failed: LoadFailure[] }> {
  let deleted = 0;
  const failed: LoadFailure[] = [];
  for (const group of created) {
    onProgress?.(group.object);
    // eslint-disable-next-line no-await-in-loop
    const results = await deleteRecords(target, group.ids);
    results.forEach((r, k) => {
      if (r.success) deleted++;
      else failed.push({ object: group.object, sourceId: group.ids[k], error: errorText(r) });
    });
  }
  return { deleted, failed };
}

// ---------- reading rows from an org ----------

const ISO_ID = /^\w{15,18}$/;

/** Rows of an object (Bulk API 2.0), with a condition. */
export async function fetchRows(
  client: SalesforceClient,
  object: string,
  fields: string[],
  where?: string
): Promise<SourceRow[]> {
  if (!/^\w+$/.test(object) || fields.some((f) => !/^\w+$/.test(f))) throw new Error('Invalid object or field name.');
  const condition = (where ?? '').trim().replace(/^where\s+/i, '');
  const soql = `SELECT ${fields.join(', ')} FROM ${object}${condition ? ` WHERE ${condition}` : ''}`;
  const result = await bulkQuery(client, soql);
  return parseCsv(result.csv).rows;
}

/** Rows of an object whose lookups point to records already chosen (seeding a sandbox with related records). */
export async function fetchRelated(
  client: SalesforceClient,
  object: string,
  fields: string[],
  links: Array<{ field: string; ids: string[] }>,
  where?: string
): Promise<SourceRow[]> {
  const seen = new Map<string, SourceRow>();
  const extra = (where ?? '').trim().replace(/^where\s+/i, '');
  for (const link of links) {
    if (!/^\w+$/.test(link.field)) throw new Error('Invalid field name.');
    const valid = link.ids.filter((id) => ISO_ID.test(id));
    for (let i = 0; i < valid.length; i += 300) {
      const list = valid
        .slice(i, i + 300)
        .map((id) => `'${id}'`)
        .join(',');
      // eslint-disable-next-line no-await-in-loop
      const rows = await fetchRows(
        client,
        object,
        fields,
        `${link.field} IN (${list})${extra ? ` AND (${extra})` : ''}`
      );
      for (const r of rows) seen.set(r.Id, r);
    }
  }
  return [...seen.values()];
}

/** Field definitions of the objects in both orgs. */
export async function describeBoth(
  source: SalesforceClient | Record<string, DataField[]>,
  target: SalesforceClient,
  objects: string[]
): Promise<Record<string, { source: DataField[]; target: DataField[] }>> {
  const out: Record<string, { source: DataField[]; target: DataField[] }> = {};
  for (const o of objects) {
    /* eslint-disable no-await-in-loop */
    const [s, t] = await Promise.all([
      source instanceof SalesforceClient ? describeData(source, o) : Promise.resolve(source[o] ?? []),
      describeData(target, o).catch(() => [] as DataField[]),
    ]);
    /* eslint-enable no-await-in-loop */
    out[o] = { source: s, target: t };
  }
  return out;
}
