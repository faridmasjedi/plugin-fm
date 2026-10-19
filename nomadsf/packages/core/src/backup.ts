import { bulkQuery } from './bulk.js';
import type { SalesforceClient } from './client.js';
import type { EncryptionInfo } from './crypto.js';
import { parseCsv } from './csv.js';
import { backupFiles, type FilesChoice, type FilesResult } from './files.js';
import { query } from './query.js';

/**
 * Data backups: a saved job says which objects (picked, or all custom / standard ones), which
 * records (a condition per object) and which fields (all, only some, all except some); a run
 * writes one folder of CSV files plus a manifest with the field definitions of that moment.
 * After the first full run, runs can be incremental (changed since the last run, and deleted
 * Ids). Where the files go is a BackupSink: a folder picked in the browser, a zip, memory…
 */

export type FieldChoice = { mode: 'all' } | { mode: 'only'; fields: string[] } | { mode: 'except'; fields: string[] };

/** Settings of one object: a SOQL condition (without WHERE) and the fields. */
export type BackupObject = { name: string; where?: string; fields?: FieldChoice };

export type BackupScope = 'picked' | 'custom' | 'standard' | 'all';

export type BackupSchedule =
  | { every: 'off' }
  | { every: 'daily'; time: string }
  | { every: 'weekly'; time: string; weekday: number };

export type BackupJob = {
  id: string;
  name: string;
  /** The org (its API host in the extension, its alias in the app). */
  org: string;
  scope: BackupScope;
  /** With 'picked' these are the objects; with the other scopes, settings for some of them. */
  objects: BackupObject[];
  /** Left out of custom / standard / all. */
  exclude: string[];
  /** After a full run: only records changed since the last run (and deleted Ids). */
  incremental: boolean;
  /** A full run again after this many days of incremental runs (0 = never). */
  fullEveryDays: number;
  schedule: BackupSchedule;
  /** Salesforce Files and attachments of the records backed up. */
  files?: FilesChoice;
  /** Set when the backup is encrypted (salt and check value; never the key). */
  encryption?: EncryptionInfo;
};

export const newBackupJob = (org: string, name = 'Backup'): BackupJob => ({
  id: `b${Date.now().toString(36)}`,
  name,
  org,
  scope: 'picked',
  objects: [],
  exclude: [],
  incremental: true,
  fullEveryDays: 7,
  schedule: { every: 'off' },
});

// ---------- which objects ----------

export type DataObject = {
  name: string;
  label: string;
  custom: boolean;
  keyPrefix?: string | null;
  queryable: boolean;
  createable?: boolean;
  replicateable?: boolean;
  retrieveable?: boolean;
};

/** Suffixes of objects that are not business data of their own (sharing, history, feeds, events…). */
const NOT_DATA =
  /(__Share|__History|__Feed|__ChangeEvent|ChangeEvent|__e|__mdt|__x|__b|__Tag|__hd|__chn|__dlm|__dll|__kav|__ka|__ViewStat|__VoteStat|__DataCategorySelection)$/;
const NOT_DATA_STANDARD = /(Share|History|Feed|Tag|ChangeEvent|EventStore|EventRelay)$/;

/** Objects worth backing up: your records, not sharing rows, history, feeds, events or setup data. */
export function backupCandidates(objects: DataObject[]): DataObject[] {
  return objects
    .filter(
      (o) =>
        o.queryable &&
        o.retrieveable !== false &&
        o.createable !== false &&
        o.replicateable !== false &&
        !NOT_DATA.test(o.name) &&
        (o.custom || !NOT_DATA_STANDARD.test(o.name))
    )
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The objects a job backs up, from the org's object list. */
export function resolveObjects(job: BackupJob, candidates: DataObject[]): BackupObject[] {
  const settings = new Map(job.objects.map((o) => [o.name, o]));
  if (job.scope === 'picked') return job.objects.filter((o) => candidates.some((c) => c.name === o.name));
  const excluded = new Set(job.exclude);
  return candidates
    .filter((c) => (job.scope === 'all' ? true : job.scope === 'custom' ? c.custom : !c.custom))
    .filter((c) => !excluded.has(c.name))
    .map((c) => settings.get(c.name) ?? { name: c.name });
}

// ---------- which fields ----------

export type DataField = {
  name: string;
  label: string;
  type: string;
  referenceTo: string[];
  relationshipName?: string | null;
  createable: boolean;
  updateable: boolean;
  calculated: boolean;
  externalId: boolean;
  nillable: boolean;
  defaultedOnCreate: boolean;
  unique: boolean;
};

type RawField = Partial<DataField> & { name: string; label: string; type: string; referenceTo?: string[] };

/** Field definitions with what a backup and a restore need to know. */
export async function describeData(client: SalesforceClient, object: string): Promise<DataField[]> {
  if (!/^\w+$/.test(object)) throw new Error('Invalid object name.');
  const result = await client.rest<{ fields: RawField[] }>('GET', `/sobjects/${object}/describe`);
  return result.fields.map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    referenceTo: f.referenceTo ?? [],
    relationshipName: f.relationshipName ?? null,
    createable: Boolean(f.createable),
    updateable: Boolean(f.updateable),
    calculated: Boolean(f.calculated),
    externalId: Boolean(f.externalId),
    nillable: Boolean(f.nillable),
    defaultedOnCreate: Boolean(f.defaultedOnCreate),
    unique: Boolean(f.unique),
  }));
}

/** Bulk API 2.0 cannot return compound fields (address, location) or file bodies (base64). */
const NOT_IN_BULK = new Set(['address', 'location', 'base64']);
/** Always kept: the record's identity and what incremental runs filter on. */
const ALWAYS = ['Id', 'SystemModstamp'];

/** The fields of an object a backup queries, following the choice. */
export function chooseFields(fields: DataField[], choice: FieldChoice = { mode: 'all' }): string[] {
  const usable = fields.filter((f) => !NOT_IN_BULK.has(f.type)).map((f) => f.name);
  const has = new Set(usable);
  let picked: string[];
  if (choice.mode === 'only') picked = choice.fields.filter((f) => has.has(f));
  else if (choice.mode === 'except') {
    const out = new Set(choice.fields);
    picked = usable.filter((f) => !out.has(f) || ALWAYS.includes(f));
  } else picked = usable;
  return [...new Set([...ALWAYS.filter((f) => has.has(f)), ...picked])];
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** The SOQL of one object: chosen fields, its condition, and the incremental filter. */
export function backupSoql(object: string, fields: string[], where?: string, since?: string, deleted = false): string {
  if (!/^\w+$/.test(object) || fields.some((f) => !/^\w+$/.test(f))) throw new Error('Invalid object or field name.');
  const condition = (where ?? '').trim().replace(/^where\s+/i, '');
  if (/;|\blimit\b|\border\s+by\b/i.test(condition))
    throw new Error(`${object}: the condition cannot hold ;, LIMIT or ORDER BY.`);
  if (since && !ISO.test(since)) throw new Error('Invalid date.');
  const parts = [
    condition ? `(${condition})` : '',
    since ? `SystemModstamp > ${since}` : '',
    deleted ? 'IsDeleted = true' : '',
  ].filter(Boolean);
  const select = deleted ? 'Id, SystemModstamp' : fields.join(', ');
  return `SELECT ${select} FROM ${object}${parts.length ? ` WHERE ${parts.join(' AND ')}` : ''}`;
}

// ---------- running ----------

/** Where a backup goes. Paths use "/"; `list` gives the names in a folder (for reading backups back). */
export type BackupSink = {
  write(path: string, content: string): Promise<void>;
  read(path: string): Promise<string | undefined>;
  list(dir: string): Promise<string[]>;
  /** Binary files (Salesforce Files, attachment bodies). */
  writeBytes(path: string, content: Uint8Array): Promise<void>;
  readBytes(path: string): Promise<Uint8Array | undefined>;
};

export type BackupObjectResult = {
  name: string;
  where?: string;
  fields: string[];
  rows: number;
  deleted: number;
  files: string[];
  error?: string;
};

export type BackupManifest = {
  format: 1;
  job: { id: string; name: string };
  org: { id: string; name: string; instanceUrl?: string; isSandbox: boolean };
  kind: 'full' | 'incremental';
  /** Incremental: records changed after this moment. */
  since?: string;
  /** The moment the next incremental run starts from (a few minutes before the run began). */
  checkpoint: string;
  startedAt: string;
  finishedAt: string;
  apiVersion: string;
  objects: BackupObjectResult[];
  /** Field definitions at backup time, for restoring into a changed org later. */
  schema: Record<string, DataField[]>;
  /** Files and attachments of the records (when the job includes them). */
  files?: FilesResult;
  filesError?: string;
  /** The data files are encrypted (".enc"). */
  encrypted?: boolean;
};

/** The last run of a job (written next to the runs), for incremental runs and the list of backups. */
export type BackupIndex = {
  job: BackupJob;
  runs: Array<{ folder: string; kind: 'full' | 'incremental'; finishedAt: string; rows: number; failed: number }>;
};

const runFolder = (date: Date): string =>
  date
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace(/-\d{3}Z$/, 'Z');

/** Full or incremental, from the job and the runs so far. */
export function nextKind(job: BackupJob, index: BackupIndex | undefined, now = new Date()): 'full' | 'incremental' {
  if (!job.incremental) return 'full';
  const lastFull = [...(index?.runs ?? [])].reverse().find((r) => r.kind === 'full' && r.failed === 0);
  if (!lastFull) return 'full';
  if (job.fullEveryDays > 0 && now.getTime() - Date.parse(lastFull.finishedAt) >= job.fullEveryDays * 86_400_000)
    return 'full';
  return 'incremental';
}

export type BackupProgress = (step: {
  object: string;
  index: number;
  total: number;
  rows: number;
  state: string;
}) => void;

/**
 * Runs a backup job into `sink` under `<job name>/<run time>/`: one folder per object with CSV
 * files (50,000 rows each), `deleted.csv` for incremental runs, and `manifest.json`. One object
 * failing does not stop the others; it is recorded in the manifest.
 */
export async function runBackup(
  client: SalesforceClient,
  job: BackupJob,
  sink: BackupSink,
  options: { onProgress?: BackupProgress; now?: Date; rowsPerFile?: number; signal?: AbortSignal } = {}
): Promise<BackupManifest> {
  const started = options.now ?? new Date();
  const root = jobFolder(job);
  const index = await readIndex(sink, job);
  const kind = nextKind(job, index, started);
  const last = kind === 'incremental' ? await readManifest(sink, `${root}/${index!.runs.at(-1)!.folder}`) : undefined;
  const since = last?.checkpoint;
  const folder = runFolder(started);
  const apiVersion = await client.version();
  const org = (await query(client, 'SELECT Id, Name, IsSandbox FROM Organization LIMIT 1')).rows[0] as {
    Id: string;
    Name: string;
    IsSandbox: boolean;
  };

  const candidates = backupCandidates((await client.rest<{ sobjects: DataObject[] }>('GET', '/sobjects')).sobjects);
  const objects = resolveObjects(job, candidates);
  if (!objects.length) throw new Error('This backup has no objects to back up.');

  const results: BackupObjectResult[] = [];
  // Ids of the records backed up, for their files and attachments
  const withFiles = Boolean(job.files && (job.files.files || job.files.attachments));
  const recordIds: string[] = [];
  const schema: Record<string, DataField[]> = {};
  for (const [i, o] of objects.entries()) {
    if (options.signal?.aborted) throw new Error('Backup stopped.');
    const result: BackupObjectResult = { name: o.name, where: o.where, fields: [], rows: 0, deleted: 0, files: [] };
    results.push(result);
    const step = (state: string): void =>
      options.onProgress?.({ object: o.name, index: i, total: objects.length, rows: result.rows, state });
    try {
      step('describe');
      /* eslint-disable no-await-in-loop */
      const fields = await describeData(client, o.name);
      schema[o.name] = fields;
      result.fields = chooseFields(fields, o.fields);
      step('query');
      await bulkQuery(client, backupSoql(o.name, result.fields, o.where, since), {
        rowsPerFile: options.rowsPerFile ?? 50_000,
        onProgress: (state) => step(state),
        onFile: async (csv, n, rows) => {
          const file = `${o.name}/part-${String(n + 1).padStart(4, '0')}.csv`;
          await sink.write(`${root}/${folder}/${file}`, csv);
          if (withFiles) for (const r of parseCsv(csv).rows) recordIds.push(r.Id);
          result.files.push(file);
          result.rows += rows;
          step('saving');
        },
      });
      // Deleted since the last run (the recycle bin keeps them about 15 days)
      if (since && fields.some((f) => f.name === 'IsDeleted')) {
        step('deleted');
        const deleted = await bulkQuery(client, backupSoql(o.name, [], o.where, since, true), { includeDeleted: true });
        if (deleted.rows) {
          await sink.write(`${root}/${folder}/${o.name}/deleted.csv`, deleted.csv);
          result.files.push(`${o.name}/deleted.csv`);
          result.deleted = deleted.rows;
        }
      }
      /* eslint-enable no-await-in-loop */
    } catch (e) {
      result.error = (e as Error).message;
    }
  }

  let files: FilesResult | undefined;
  let filesError: string | undefined;
  if (withFiles) {
    const prefixes = new Set(
      candidates.filter((c) => objects.some((o) => o.name === c.name) && c.keyPrefix).map((c) => String(c.keyPrefix))
    );
    try {
      files = await backupFiles(client, sink, `${root}/${folder}`, recordIds, {
        choice: job.files!,
        since,
        prefixes,
        onProgress: (state) =>
          options.onProgress?.({ object: 'Files', index: objects.length - 1, total: objects.length, rows: 0, state }),
      });
    } catch (e) {
      filesError = (e as Error).message;
    }
  }

  const manifest: BackupManifest = {
    format: 1,
    job: { id: job.id, name: job.name },
    org: { id: org.Id, name: org.Name, isSandbox: Boolean(org.IsSandbox) },
    kind,
    since,
    // Records changed while this run was going are picked up again by the next one
    checkpoint: new Date(started.getTime() - 5 * 60_000).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    apiVersion,
    objects: results,
    schema,
    ...(files ? { files } : {}),
    ...(filesError ? { filesError } : {}),
    ...(job.encryption ? { encrypted: true } : {}),
  };
  await sink.write(`${root}/${folder}/manifest.json`, JSON.stringify(manifest, null, 2));
  const runs = [
    ...(index?.runs ?? []),
    {
      folder,
      kind,
      finishedAt: manifest.finishedAt,
      rows: results.reduce((n, r) => n + r.rows, 0),
      failed: results.filter((r) => r.error).length,
    },
  ];
  await sink.write(`${root}/backups.json`, JSON.stringify({ job, runs } satisfies BackupIndex, null, 2));
  return manifest;
}

/** Folder of a job's runs: its name made safe for file systems. */
export const jobFolder = (job: Pick<BackupJob, 'name' | 'id'>): string =>
  `${job.name.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'backup'}-${job.id}`;

export async function readIndex(
  sink: BackupSink,
  job: Pick<BackupJob, 'name' | 'id'>
): Promise<BackupIndex | undefined> {
  const text = await sink.read(`${jobFolder(job)}/backups.json`);
  return text ? (JSON.parse(text) as BackupIndex) : undefined;
}

export async function readManifest(sink: BackupSink, folder: string): Promise<BackupManifest | undefined> {
  const text = await sink.read(`${folder}/manifest.json`);
  return text ? (JSON.parse(text) as BackupManifest) : undefined;
}

/** Records per object for a job (one COUNT() each), to see the size before running it. */
export async function estimateBackup(
  client: SalesforceClient,
  objects: BackupObject[],
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, number | string>> {
  const out = new Map<string, number | string>();
  for (const [i, o] of objects.entries()) {
    onProgress?.(i, objects.length);
    try {
      const soql = backupSoql(o.name, ['Id'], o.where).replace('SELECT Id FROM', 'SELECT COUNT() FROM');
      // eslint-disable-next-line no-await-in-loop
      out.set(o.name, (await query(client, soql)).totalSize);
    } catch (e) {
      out.set(o.name, (e as Error).message);
    }
  }
  onProgress?.(objects.length, objects.length);
  return out;
}

// ---------- schedules ----------

const timeOf = (text: string): [number, number] => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error('Time as HH:MM, e.g. 02:00.');
  return [Number(m[1]), Number(m[2])];
};

/** The next scheduled moment after `after` (local time), or undefined when the schedule is off. */
export function nextRun(schedule: BackupSchedule, after: Date): Date | undefined {
  if (schedule.every === 'off') return undefined;
  const [h, m] = timeOf(schedule.time);
  const next = new Date(after);
  next.setHours(h, m, 0, 0);
  if (schedule.every === 'daily') {
    if (next <= after) next.setDate(next.getDate() + 1);
    return next;
  }
  const days = (schedule.weekday - next.getDay() + 7) % 7;
  next.setDate(next.getDate() + days);
  if (next <= after) next.setDate(next.getDate() + 7);
  return next;
}

/** A run is due when the schedule's moment after the last run has passed (missed runs count once). */
export function isDue(schedule: BackupSchedule, lastRun: Date | undefined, now: Date, created?: Date): boolean {
  if (schedule.every === 'off') return false;
  const from = lastRun ?? created;
  if (!from) return true;
  const next = nextRun(schedule, from);
  return Boolean(next && next <= now);
}

/** "daily at 02:00", "Mondays at 02:00", "off". */
export function describeSchedule(schedule: BackupSchedule): string {
  if (schedule.every === 'off') return 'not scheduled';
  if (schedule.every === 'daily') return `daily at ${schedule.time}`;
  const day = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'][schedule.weekday];
  return `${day} at ${schedule.time}`;
}

/** A sink in memory (tests, zip downloads). */
export function memorySink(
  files: Map<string, string | Uint8Array> = new Map()
): BackupSink & { files: Map<string, string | Uint8Array> } {
  return {
    files,
    async write(path, content) {
      files.set(path, content);
    },
    async read(path) {
      const value = files.get(path);
      return value instanceof Uint8Array ? new TextDecoder().decode(value) : value;
    },
    async writeBytes(path, content) {
      files.set(path, content);
    },
    async readBytes(path) {
      const value = files.get(path);
      return typeof value === 'string' ? new TextEncoder().encode(value) : value;
    },
    async list(dir) {
      const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
      return [
        ...new Set(
          [...files.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split('/')[0])
        ),
      ].sort();
    },
  };
}

// ---------- choosing objects by name, or from an AI answer ----------

export type ObjectPick = { name: string; where?: string; fields?: FieldChoice; relatedOnly?: boolean };

/** Matches a name typed by a person (API name or label, any case) to an object of the list. */
function matchObject(text: string, objects: Array<{ name: string; label: string }>): string | undefined {
  const t = text.trim().toLowerCase();
  return (objects.find((o) => o.name.toLowerCase() === t) ?? objects.find((o) => o.label.toLowerCase() === t))?.name;
}

/** "Account, Contact; Invoice__c" (commas, semicolons, new lines) -> the objects found and the names not found. */
export function parseObjectList(
  text: string,
  objects: Array<{ name: string; label: string }>
): { found: string[]; unknown: string[] } {
  const found: string[] = [];
  const unknown: string[] = [];
  for (const part of text
    .split(/[,;\n\t]+/)
    .map((p) => p.trim())
    .filter(Boolean)) {
    const name = matchObject(part, objects);
    if (name) {
      if (!found.includes(name)) found.push(name);
    } else unknown.push(part);
  }
  return { found, unknown };
}

/** The objects an AI chose ({"objects": [...], "note"}), kept only when they exist in the list. */
export function parseDataPicks(
  answer: string,
  objects: Array<{ name: string; label: string }>
): { picks: ObjectPick[]; unknown: string[]; note: string } {
  const code = (/```(?:json)?\s*([\s\S]*?)```/.exec(answer)?.[1] ?? answer).trim();
  let parsed: { objects?: Array<Record<string, unknown>>; note?: unknown };
  try {
    parsed = JSON.parse(code) as typeof parsed;
  } catch {
    throw new Error('The AI did not answer with a list of objects; try rephrasing.');
  }
  const picks: ObjectPick[] = [];
  const unknown: string[] = [];
  for (const o of parsed.objects ?? []) {
    const name = matchObject(String(o.name ?? ''), objects);
    if (!name) {
      unknown.push(String(o.name ?? '?'));
      continue;
    }
    const pick: ObjectPick = { name };
    const where = String(o.where ?? '').trim();
    if (where && !/;|\blimit\b/i.test(where)) pick.where = where.replace(/^where\s+/i, '');
    const f = o.fields as { mode?: string; fields?: unknown } | undefined;
    const list = Array.isArray(f?.fields) ? (f.fields as unknown[]).map(String).filter((x) => /^\w+$/.test(x)) : [];
    if ((f?.mode === 'only' || f?.mode === 'except') && list.length) pick.fields = { mode: f.mode, fields: list };
    if (o.relatedOnly === true) pick.relatedOnly = true;
    if (!picks.some((p) => p.name === name)) picks.push(pick);
  }
  return { picks, unknown, note: String(parsed.note ?? '') };
}
