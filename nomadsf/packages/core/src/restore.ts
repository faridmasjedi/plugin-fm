import {
  describeData,
  jobFolder,
  readIndex,
  readManifest,
  type BackupJob,
  type BackupManifest,
  type BackupSink,
  type DataField,
} from './backup.js';
import type { SalesforceClient } from './client.js';
import { parseCsv } from './csv.js';
import {
  SYSTEM_FIELDS,
  loadRecords,
  sameOrgMaps,
  undeleteRecords,
  updateRecords,
  type LoadResult,
  type SourceRow,
} from './dataLoad.js';
import { loadWithOldIds } from './oldIds.js';
import { query } from './query.js';

/**
 * Restoring from a backup: the records as they were at a run (its last full run plus the
 * incremental runs up to it), compared with the org now, then changed values put back,
 * deleted records undeleted (recycle bin, same Ids) or created again with their lookups.
 */

export type BackupState = {
  manifest: BackupManifest;
  /** Field definitions at that run. */
  schema: Record<string, DataField[]>;
  /** Object -> Id -> row. */
  rows: Record<string, Map<string, SourceRow>>;
  /** Runs applied, oldest first. */
  runs: string[];
};

/** The records as they were at `folder` (a run of the job). */
export async function backupStateAt(
  sink: BackupSink,
  job: Pick<BackupJob, 'name' | 'id'>,
  folder: string,
  objects?: string[]
): Promise<BackupState> {
  const index = await readIndex(sink, job);
  if (!index) throw new Error('No backups of this job in the folder.');
  const at = index.runs.findIndex((r) => r.folder === folder);
  if (at < 0) throw new Error(`Run ${folder} is not in the folder.`);
  let start = at;
  while (start >= 0 && index.runs[start].kind !== 'full') start--;
  if (start < 0) throw new Error('No full backup before this run; its records cannot be rebuilt.');
  const root = jobFolder(job);
  const rows: Record<string, Map<string, SourceRow>> = {};
  const runs: string[] = [];
  let manifest: BackupManifest | undefined;
  for (const run of index.runs.slice(start, at + 1)) {
    /* eslint-disable no-await-in-loop */
    const m = await readManifest(sink, `${root}/${run.folder}`);
    if (!m) throw new Error(`The manifest of ${run.folder} is missing.`);
    manifest = m;
    runs.push(run.folder);
    for (const o of m.objects) {
      if (objects && !objects.includes(o.name)) continue;
      const map = (rows[o.name] ??= new Map());
      for (const file of o.files) {
        const text = await sink.read(`${root}/${run.folder}/${file}`);
        if (text === undefined) throw new Error(`${run.folder}/${file} is missing.`);
        const table = parseCsv(text);
        if (file.endsWith('/deleted.csv')) for (const r of table.rows) map.delete(r.Id);
        else for (const r of table.rows) map.set(r.Id, { ...(map.get(r.Id) ?? {}), ...r });
      }
    }
    /* eslint-enable no-await-in-loop */
  }
  return { manifest: manifest!, schema: manifest!.schema, rows, runs };
}

// ---------- comparing with the org ----------

export type FieldChange = { field: string; backup: string; now: string };
export type RecordChange = { id: string; changes: FieldChange[] };
export type RestorePreview = {
  object: string;
  /** Fields compared: in the backup and updatable in the org now. */
  fields: string[];
  changed: RecordChange[];
  /** In the backup, gone from the org: in the recycle bin (can be undeleted) or gone for good. */
  deleted: Array<{ id: string; inRecycleBin: boolean }>;
  same: number;
};

const NOT_RESTORED = new Set([
  'Id',
  'IsDeleted',
  'SystemModstamp',
  'CreatedDate',
  'CreatedById',
  'LastModifiedDate',
  'LastModifiedById',
]);

/** Backup Id -> new Id (15- or 18-character Ids), anything else unchanged. */
export function translator(restoredIds: Record<string, string>): (value: string) => string {
  const by15 = new Map(Object.entries(restoredIds).map(([k, v]) => [k.slice(0, 15), v]));
  return (value) =>
    /^[a-zA-Z0-9]{15,18}$/.test(value) ? restoredIds[value] ?? by15.get(value.slice(0, 15)) ?? value : value;
}

const asText = (value: unknown): string => (value === null || value === undefined ? '' : String(value));

/** Same value, whatever way the bulk CSV and the REST API write it (numbers, dates, booleans). */
export function sameValue(backup: string, now: string): boolean {
  if (backup === now) return true;
  if (backup === '' || now === '') return false;
  const a = Number(backup);
  const b = Number(now);
  if (
    !Number.isNaN(a) &&
    !Number.isNaN(b) &&
    /^-?[\d.]+(e[+-]?\d+)?$/i.test(backup) &&
    /^-?[\d.]+(e[+-]?\d+)?$/i.test(now)
  )
    return a === b;
  if (/^\d{4}-\d{2}-\d{2}T/.test(backup) && /^\d{4}-\d{2}-\d{2}T/.test(now)) {
    const iso = (t: string): number => Date.parse(t.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    return iso(backup) === iso(now);
  }
  return false;
}

/** Compares the backup's records of an object with the org now (300 Ids per query). */
export async function previewRestore(
  client: SalesforceClient,
  state: BackupState,
  object: string,
  orgFields: DataField[],
  onProgress?: (done: number, total: number) => void,
  /** Backup Id -> new Id of records created again by earlier restores. */
  restoredIds: Record<string, string> = {}
): Promise<RestorePreview> {
  const moved = translator(restoredIds);
  const backup = state.rows[object] ?? new Map<string, SourceRow>();
  const updatable = new Set(orgFields.filter((f) => f.updateable && !f.calculated).map((f) => f.name));
  const columns = backup.size ? Object.keys(backup.values().next().value as SourceRow) : [];
  const fields = columns.filter((c) => updatable.has(c) && !NOT_RESTORED.has(c) && /^\w+$/.test(c));
  const ids = [...backup.keys()].filter((id) => /^\w{15,18}$/.test(id));
  const changed: RecordChange[] = [];
  const missing: string[] = [];
  let same = 0;
  for (let i = 0; i < ids.length; i += 300) {
    onProgress?.(i, ids.length);
    const chunk = ids.slice(i, i + 300);
    const list = chunk.map((id) => `'${moved(id)}'`).join(',');
    /* eslint-disable no-await-in-loop */
    const result = await query(
      client,
      `SELECT Id${fields.length ? `, ${fields.join(', ')}` : ''} FROM ${object} WHERE Id IN (${list})`,
      {
        maxRows: 300,
      }
    );
    /* eslint-enable no-await-in-loop */
    const now = new Map(result.rows.map((r) => [String(r.Id).slice(0, 15), r]));
    for (const id of chunk) {
      const current = now.get(moved(id).slice(0, 15));
      if (!current) {
        missing.push(id);
        continue;
      }
      const row = backup.get(id)!;
      const changes = fields
        .filter((f) => !sameValue(moved(row[f] ?? ''), asText(current[f])))
        .map((f) => ({ field: f, backup: moved(row[f] ?? ''), now: asText(current[f]) }));
      if (changes.length) changed.push({ id: moved(id), changes });
      else same++;
    }
  }
  // Which of the missing ones are still in the recycle bin
  const inBin = new Set<string>();
  for (let i = 0; i < missing.length; i += 300) {
    const list = missing
      .slice(i, i + 300)
      .map((id) => `'${id}'`)
      .join(',');
    // eslint-disable-next-line no-await-in-loop
    const result = await query(client, `SELECT Id FROM ${object} WHERE IsDeleted = true AND Id IN (${list})`, {
      includeDeleted: true,
      maxRows: 300,
    }).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
    for (const r of result.rows) inBin.add(String(r.Id).slice(0, 15));
  }
  onProgress?.(ids.length, ids.length);
  return {
    object,
    fields,
    changed,
    deleted: missing.map((id) => ({ id, inRecycleBin: inBin.has(id.slice(0, 15)) })),
    same,
  };
}

// ---------- putting back ----------

/** Puts back the backup's values of the chosen records and fields (empty in the backup = cleared). */
export async function restoreValues(
  client: SalesforceClient,
  object: string,
  changes: Array<{ id: string; fields: Record<string, string> }>,
  orgFields: DataField[],
  restoredIds: Record<string, string> = {}
): Promise<{ updated: number; failures: Array<{ id: string; error: string }> }> {
  const types = new Map(orgFields.map((f) => [f.name, f.type]));
  const moved = translator(restoredIds);
  const records = changes.map((c) => {
    const record: Record<string, unknown> & { Id: string } = { Id: c.id };
    for (const [field, value] of Object.entries(c.fields)) {
      if (NOT_RESTORED.has(field)) continue;
      // A lookup to a record created again since points to its new Id
      record[field] = value === '' ? null : types.get(field) === 'boolean' ? value === 'true' : moved(value);
    }
    return record;
  });
  const results = await updateRecords(client, object, records);
  const failures: Array<{ id: string; error: string }> = [];
  let updated = 0;
  results.forEach((r, k) => {
    if (r.success) updated++;
    else failures.push({ id: records[k].Id, error: (r.errors ?? []).map((e) => e.message).join('; ') || 'Failed' });
  });
  return { updated, failures };
}

export type DeletedRestore = {
  undeleted: number;
  undeleteFailures: Array<{ id: string; error: string }>;
  /** Records created again (not in the recycle bin any more): new Ids, lookups between them rebuilt. */
  load?: LoadResult;
};

/**
 * Brings deleted records back: undelete from the recycle bin where possible (same Id), create
 * the others again. Lookups to records that still exist keep their Ids; lookups between
 * records created again are rebuilt.
 */
export async function restoreDeleted(
  client: SalesforceClient,
  state: BackupState,
  picked: Record<string, Array<{ id: string; inRecycleBin: boolean }>>,
  orgFields: Record<string, DataField[]>,
  onProgress?: (text: string) => void
): Promise<DeletedRestore> {
  const bin = Object.values(picked)
    .flat()
    .filter((d) => d.inRecycleBin)
    .map((d) => d.id);
  let undeleted = 0;
  const undeleteFailures: Array<{ id: string; error: string }> = [];
  const failedUndelete = new Set<string>();
  if (bin.length) {
    onProgress?.(`Undeleting ${bin.length} record(s)…`);
    for (const r of await undeleteRecords(client, bin)) {
      if (r.success) undeleted++;
      else {
        undeleteFailures.push({ id: r.id, error: r.error ?? 'Failed' });
        failedUndelete.add(r.id);
      }
    }
  }
  const rows: Record<string, SourceRow[]> = {};
  for (const [object, list] of Object.entries(picked)) {
    const again = list.filter((d) => !d.inRecycleBin || failedUndelete.has(d.id));
    if (again.length) rows[object] = again.map((d) => state.rows[object].get(d.id)!).filter(Boolean);
  }
  if (!Object.keys(rows).length) return { undeleted, undeleteFailures };
  onProgress?.('Creating the records again…');
  const load = await loadRecords(
    client,
    Object.keys(rows).map((name) => ({ name, source: state.schema[name] ?? orgFields[name], target: orgFields[name] })),
    rows,
    {
      maps: sameOrgMaps(),
      keepUnmapped: true,
      onProgress: (s) => onProgress?.(`${s.object}: ${s.phase} ${s.done}/${s.rows}`),
    }
  );
  return { undeleted, undeleteFailures, load };
}

// ---------- bringing records back with all their links ----------

const NOT_RECORD_LINKS = new Set(['User', 'Group', 'RecordType']);
const RECORD_ID = /^[a-zA-Z0-9]{15,18}$/;
const id15 = (id: string): string => id.slice(0, 15);

/** Lookups to other records in the backup's field definitions (users, queues, record types aside). */
function recordLookups(schema: DataField[] | undefined): DataField[] {
  return (schema ?? []).filter(
    (f) => f.type === 'reference' && !SYSTEM_FIELDS.has(f.name) && f.referenceTo.some((t) => !NOT_RECORD_LINKS.has(t))
  );
}

/** Which of these Ids exist in the org now (not deleted), per object. */
async function existing(client: SalesforceClient, object: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const valid = ids.filter((id) => RECORD_ID.test(id));
  for (let i = 0; i < valid.length; i += 300) {
    const list = valid
      .slice(i, i + 300)
      .map((id) => `'${id}'`)
      .join(',');
    // eslint-disable-next-line no-await-in-loop
    const result = await query(client, `SELECT Id FROM ${object} WHERE Id IN (${list})`, { maxRows: 300 });
    for (const r of result.rows) out.add(id15(String(r.Id)));
  }
  return out;
}

async function inRecycleBin(client: SalesforceClient, object: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 300) {
    const list = ids
      .slice(i, i + 300)
      .map((id) => `'${id}'`)
      .join(',');
    // eslint-disable-next-line no-await-in-loop
    const result = await query(client, `SELECT Id FROM ${object} WHERE IsDeleted = true AND Id IN (${list})`, {
      includeDeleted: true,
      maxRows: 300,
    }).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
    for (const r of result.rows) out.add(id15(String(r.Id)));
  }
  return out;
}

export type RestoreRecordsResult = {
  undeleted: number;
  created: number;
  /** Deleted parents brought back with the chosen records, per object. */
  parentsAdded: Record<string, number>;
  /** Records in the org whose lookup was set again to a record brought back with a new Id. */
  repointed: number;
  failures: Array<{ object: string; id: string; error: string }>;
  /** Backup Id -> new Id of the records created again (keep it for later restores). */
  ids: Record<string, string>;
  /** Created records per object (for undo), children first. */
  createdIds: LoadResult['created'];
};

/**
 * Brings deleted records back with their relationships: the records they point to that are
 * deleted too are brought back first (from the backup), recycle-bin records are undeleted
 * (same Id), the others created again (lookups between them rebuilt; with `oldIdField` through
 * NomadSF_Old_Id__c and the Bulk API), and the records still in the org that pointed to a
 * record created again are pointed to its new Id.
 */
export async function restoreRecords(
  client: SalesforceClient,
  state: BackupState,
  picked: Record<string, string[]>,
  options: {
    withParents?: boolean;
    restoredIds?: Record<string, string>;
    oldIdField?: boolean;
    /** With oldIdField: objects that cannot have the field. */
    withoutField?: string[];
    /** With oldIdField: called with the objects to create again (parents included) to set up the field; returns those that cannot have it. */
    prepareOldIds?: (objects: string[]) => Promise<string[]>;
    onProgress?: (text: string) => void;
  } = {}
): Promise<RestoreRecordsResult> {
  const progress = options.onProgress ?? (() => undefined);
  const moved = translator(options.restoredIds ?? {});
  // Which object of the backup each Id belongs to
  const objectOf = new Map<string, string>();
  for (const [object, rows] of Object.entries(state.rows)) for (const id of rows.keys()) objectOf.set(id15(id), object);
  const want = new Map<string, Set<string>>(Object.entries(picked).map(([o, ids]) => [o, new Set(ids)]));
  const parentsAdded: Record<string, number> = {};

  // 1. Parents that are deleted too, up the chain
  if (options.withParents !== false) {
    for (let round = 0; round < 10; round++) {
      const candidates = new Map<string, Set<string>>();
      for (const [object, ids] of want) {
        const lookups = recordLookups(state.schema[object]);
        for (const id of ids) {
          const row = state.rows[object]?.get(id);
          if (!row) continue;
          for (const f of lookups) {
            const value = row[f.name];
            if (!value || !RECORD_ID.test(value)) continue;
            const parent = objectOf.get(id15(value));
            if (!parent || [...(want.get(parent) ?? [])].some((x) => id15(x) === id15(value))) continue;
            if (moved(value) !== value) continue; // created again earlier
            if (!candidates.has(parent)) candidates.set(parent, new Set());
            candidates
              .get(parent)!
              .add(
                state.rows[parent].has(value)
                  ? value
                  : [...state.rows[parent].keys()].find((k) => id15(k) === id15(value))!
              );
          }
        }
      }
      let added = 0;
      for (const [object, ids] of candidates) {
        progress(`Checking ${ids.size} ${object} record(s) the chosen ones point to…`);
        // eslint-disable-next-line no-await-in-loop
        const there = await existing(client, object, [...ids]);
        const gone = [...ids].filter((id) => !there.has(id15(id)));
        if (!gone.length) continue;
        if (!want.has(object)) want.set(object, new Set());
        for (const id of gone) want.get(object)!.add(id);
        parentsAdded[object] = (parentsAdded[object] ?? 0) + gone.length;
        added += gone.length;
      }
      if (!added) break;
    }
  }

  // 2. Undelete what is still in the recycle bin (same Ids, so every link stays)
  const failures: RestoreRecordsResult['failures'] = [];
  let undeleted = 0;
  const again: Record<string, SourceRow[]> = {};
  for (const [object, ids] of want) {
    // eslint-disable-next-line no-await-in-loop
    const bin = await inRecycleBin(client, object, [...ids]);
    const fromBin = [...ids].filter((id) => bin.has(id15(id)));
    const failed = new Set<string>();
    if (fromBin.length) {
      progress(`Undeleting ${fromBin.length} ${object} record(s)…`);
      // eslint-disable-next-line no-await-in-loop
      for (const r of await undeleteRecords(client, fromBin)) {
        if (r.success) undeleted++;
        else failed.add(id15(r.id));
      }
    }
    const rows = [...ids]
      .filter((id) => !bin.has(id15(id)) || failed.has(id15(id)))
      .map((id) => state.rows[object]?.get(id))
      .filter((r): r is SourceRow => Boolean(r));
    if (rows.length) again[object] = rows;
  }

  // 3. Create the others again, parents first, lookups between them rebuilt
  let created = 0;
  let load: LoadResult | undefined;
  if (Object.keys(again).length) {
    const objects = Object.keys(again);
    const orgFields: Record<string, DataField[]> = {};
    for (const o of objects) orgFields[o] = await describeData(client, o); // eslint-disable-line no-await-in-loop
    const loads = objects.map((name) => ({
      name,
      source: state.schema[name] ?? orgFields[name],
      target: orgFields[name],
    }));
    const loadOptions = {
      maps: sameOrgMaps(),
      keepUnmapped: true,
      known: options.restoredIds,
      onProgress: (s: { object: string; phase: string; done: number; rows: number }) =>
        progress(`${s.object}: ${s.phase} ${s.done}/${s.rows}`),
    };
    const withoutField =
      options.oldIdField && options.prepareOldIds ? await options.prepareOldIds(objects) : options.withoutField;
    load = options.oldIdField
      ? await loadWithOldIds(client, loads, again, { ...loadOptions, withoutField })
      : await loadRecords(client, loads, again, loadOptions);
    created = load.objects.reduce((n, o) => n + o.created, 0);
    for (const f of load.failures) failures.push({ object: f.object, id: f.sourceId, error: f.error });
  }
  const recreated = new Set(Object.values(again).flatMap((rows) => rows.map((r) => r.Id)));
  const ids = Object.fromEntries(
    Object.entries(load?.ids ?? {}).filter(([oldId, newId]) => recreated.has(oldId) && oldId !== newId)
  );

  // 4. Records still in the org that pointed to a record created again: point them to its new Id
  const repointed = Object.keys(ids).length
    ? await repointChildren(client, state, ids, recreated, options.restoredIds ?? {}, progress, failures)
    : 0;
  return { undeleted, created, parentsAdded, repointed, failures, ids, createdIds: load?.created ?? [] };
}

/** Sets lookups that pointed (in the backup) to records now created again, where the org left them empty. */
async function repointChildren(
  client: SalesforceClient,
  state: BackupState,
  ids: Record<string, string>,
  recreated: Set<string>,
  restoredIds: Record<string, string>,
  progress: (text: string) => void,
  failures: RestoreRecordsResult['failures']
): Promise<number> {
  const moved = translator(ids);
  const earlier = translator(restoredIds);
  let count = 0;
  for (const [object, rows] of Object.entries(state.rows)) {
    const lookups = recordLookups(state.schema[object]);
    if (!lookups.length) continue;
    // record (its Id in the org now) -> field -> new value
    const wanted = new Map<string, Record<string, { from: string; to: string }>>();
    for (const row of rows.values()) {
      if (recreated.has(row.Id)) continue;
      for (const f of lookups) {
        const value = row[f.name];
        if (!value || moved(value) === value) continue;
        const orgId = earlier(row.Id);
        wanted.set(orgId, { ...(wanted.get(orgId) ?? {}), [f.name]: { from: value, to: moved(value) } });
      }
    }
    if (!wanted.size) continue;
    progress(`Pointing ${wanted.size} ${object} record(s) to the records brought back…`);
    const fields = [...new Set([...wanted.values()].flatMap((w) => Object.keys(w)))];
    const list = [...wanted.keys()];
    const updates: Array<Record<string, unknown> & { Id: string }> = [];
    for (let i = 0; i < list.length; i += 300) {
      // eslint-disable-next-line no-await-in-loop
      const current = await query(
        client,
        `SELECT Id, ${fields.join(', ')} FROM ${object} WHERE Id IN (${list
          .slice(i, i + 300)
          .map((id) => `'${id}'`)
          .join(',')})`,
        { maxRows: 300 }
      );
      for (const r of current.rows) {
        const want = [...wanted].find(([id]) => id15(id) === id15(String(r.Id)))?.[1];
        if (!want) continue;
        const update: Record<string, unknown> & { Id: string } = { Id: String(r.Id) };
        for (const [field, { from, to }] of Object.entries(want)) {
          const now = r[field] === null || r[field] === undefined ? '' : String(r[field]);
          // Only where the org lost the link (empty) or still holds the old Id; a link changed since is left alone
          if (!now || id15(now) === id15(from)) update[field] = to;
        }
        if (Object.keys(update).length > 1) updates.push(update);
      }
    }
    if (!updates.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const results = await updateRecords(client, object, updates);
    results.forEach((r, k) => {
      if (r.success) count++;
      else
        failures.push({
          object,
          id: updates[k].Id,
          error: `Pointing to the record brought back: ${(r.errors ?? []).map((e) => e.message).join('; ')}`,
        });
    });
  }
  return count;
}
