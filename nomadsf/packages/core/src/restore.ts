import {
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
  loadRecords,
  sameOrgMaps,
  undeleteRecords,
  updateRecords,
  type LoadResult,
  type SourceRow,
} from './dataLoad.js';
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
  onProgress?: (done: number, total: number) => void
): Promise<RestorePreview> {
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
    const list = chunk.map((id) => `'${id}'`).join(',');
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
      const current = now.get(id.slice(0, 15));
      if (!current) {
        missing.push(id);
        continue;
      }
      const row = backup.get(id)!;
      const changes = fields
        .filter((f) => !sameValue(row[f] ?? '', asText(current[f])))
        .map((f) => ({ field: f, backup: row[f] ?? '', now: asText(current[f]) }));
      if (changes.length) changed.push({ id, changes });
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
  orgFields: DataField[]
): Promise<{ updated: number; failures: Array<{ id: string; error: string }> }> {
  const types = new Map(orgFields.map((f) => [f.name, f.type]));
  const records = changes.map((c) => {
    const record: Record<string, unknown> & { Id: string } = { Id: c.id };
    for (const [field, value] of Object.entries(c.fields)) {
      if (NOT_RESTORED.has(field)) continue;
      record[field] = value === '' ? null : types.get(field) === 'boolean' ? value === 'true' : value;
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
