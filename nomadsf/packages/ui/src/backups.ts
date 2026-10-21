import { useEffect, useSyncExternalStore } from 'react';
import {
  isDue,
  makeZip,
  memorySink,
  runBackup,
  type BackupJob,
  encryptedSink,
  newEncryption,
  unlockEncryption,
  type BackupManifest,
  type BackupSink,
  type SalesforceClient,
} from '@nomadsf/core';
import { storage } from './context';
import { BridgeFolder, fromStored, isStoredFolder, type StoredFolder } from './embed';

/**
 * Backup jobs of this browser profile: the jobs (with their schedules), the folder each one
 * writes to (kept in IndexedDB; the browser asks once for access), and the one run going on.
 * Scheduled jobs run while the Studio is open; the extension's badge says when one is due.
 */

const JOBS = 'backup.jobs';
const LAST = 'backup.last';

export type JobRecord = BackupJob & { created: string };
export type LastRun = { at: string; ok: boolean; rows: number; failed: number; message?: string };

export const backupJobs = {
  list: (): JobRecord[] => storage.get<JobRecord[]>(JOBS, []),
  save(job: JobRecord): void {
    const jobs = backupJobs.list().filter((j) => j.id !== job.id);
    storage.set(
      JOBS,
      [...jobs, job].sort((a, b) => a.name.localeCompare(b.name))
    );
    syncSchedules();
  },
  remove(id: string): void {
    storage.set(
      JOBS,
      backupJobs.list().filter((j) => j.id !== id)
    );
    const last = lastRuns();
    delete last[id];
    storage.set(LAST, last);
    void idb('readwrite', (s) => s.delete(`backup:${id}`)).catch(() => undefined);
    syncSchedules();
  },
};

export const lastRuns = (): Record<string, LastRun> => storage.get<Record<string, LastRun>>(LAST, {});
function setLastRun(id: string, run: LastRun): void {
  storage.set(LAST, { ...lastRuns(), [id]: run });
  syncSchedules();
}

/** The extension's background worker reads the schedules to show a "due" badge (it cannot read localStorage). */
function syncSchedules(): void {
  const chromeStorage = (globalThis as { chrome?: { storage?: { local?: { set(v: unknown): Promise<void> } } } }).chrome
    ?.storage?.local;
  if (!chromeStorage) return;
  const last = lastRuns();
  void chromeStorage
    .set({
      backupSchedules: backupJobs
        .list()
        .map((j) => ({ id: j.id, name: j.name, schedule: j.schedule, created: j.created, lastRun: last[j.id]?.at })),
    })
    .catch(() => undefined);
}

// ---------- the folder of a job (File System Access API) ----------

type DirHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
  queryPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'readwrite' }): Promise<PermissionState>;
};

// Same database as the project folder (handles cannot go to localStorage)
function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('nomadsf', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = fn(open.result.transaction('handles', mode).objectStore('handles'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
}

export const canPickFolder = (): boolean =>
  typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

export async function pickBackupFolder(jobId: string): Promise<string> {
  const handle = await (
    window as unknown as { showDirectoryPicker(o: { mode: 'readwrite'; id?: string }): Promise<DirHandle> }
  ).showDirectoryPicker({ mode: 'readwrite', id: 'nomadsf-backups' });
  // In VS Code the folder is the extension's (embed.ts): kept as its path
  const kept = handle instanceof BridgeFolder ? handle.toStored() : handle;
  await idb('readwrite', (s) => s.put(kept, `backup:${jobId}`));
  return handle.name;
}

export async function backupFolder(jobId: string): Promise<DirHandle | undefined> {
  const kept = await idb<DirHandle | StoredFolder | undefined>(
    'readonly',
    (s) => s.get(`backup:${jobId}`) as IDBRequest<DirHandle | StoredFolder | undefined>
  ).catch(() => undefined);
  return isStoredFolder(kept) ? (fromStored(kept) as unknown as DirHandle) : kept;
}

/** Access to the folder: 'granted', or 'prompt' (needs a click), or 'none' (no folder chosen). */
export async function folderAccess(jobId: string, ask = false): Promise<'granted' | 'prompt' | 'none'> {
  const handle = await backupFolder(jobId);
  if (!handle) return 'none';
  let state = await handle.queryPermission({ mode: 'readwrite' });
  if (state !== 'granted' && ask) state = await handle.requestPermission({ mode: 'readwrite' });
  return state === 'granted' ? 'granted' : 'prompt';
}

/** A BackupSink writing into a folder picked in the browser. */
export function folderSink(root: DirHandle): BackupSink {
  const dirAt = async (parts: string[], create: boolean): Promise<DirHandle> => {
    let dir = root;
    for (const part of parts) dir = (await dir.getDirectoryHandle(part, { create })) as DirHandle;
    return dir;
  };
  return {
    async write(path, content) {
      const parts = path.split('/').filter(Boolean);
      const dir = await dirAt(parts.slice(0, -1), true);
      const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const writable = await file.createWritable();
      await writable.write(content);
      await writable.close();
    },
    async read(path) {
      try {
        const parts = path.split('/').filter(Boolean);
        const dir = await dirAt(parts.slice(0, -1), false);
        return await (await (await dir.getFileHandle(parts[parts.length - 1])).getFile()).text();
      } catch {
        return undefined;
      }
    },
    async writeBytes(path, content) {
      const parts = path.split('/').filter(Boolean);
      const dir = await dirAt(parts.slice(0, -1), true);
      const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const writable = await file.createWritable();
      await writable.write(content);
      await writable.close();
    },
    async readBytes(path) {
      try {
        const parts = path.split('/').filter(Boolean);
        const dir = await dirAt(parts.slice(0, -1), false);
        return new Uint8Array(await (await (await dir.getFileHandle(parts[parts.length - 1])).getFile()).arrayBuffer());
      } catch {
        return undefined;
      }
    },
    async list(path) {
      try {
        const dir = await dirAt(path.split('/').filter(Boolean), false);
        const names: string[] = [];
        for await (const [name] of dir.entries()) names.push(name);
        return names.sort();
      } catch {
        return [];
      }
    },
  };
}

// ---------- encrypted backups: the key of a job ----------

/** Keys unlocked in this session; a key kept on this computer lives in IndexedDB (not extractable). */
const sessionKeys = new Map<string, CryptoKey>();

export async function jobKey(job: Pick<BackupJob, 'id' | 'encryption'>): Promise<CryptoKey | undefined> {
  if (!job.encryption) return undefined;
  const inSession = sessionKeys.get(job.id);
  if (inSession) return inSession;
  const kept = await idb<CryptoKey | undefined>(
    'readonly',
    (s) => s.get(`crypto:${job.id}`) as IDBRequest<CryptoKey | undefined>
  ).catch(() => undefined);
  if (kept) sessionKeys.set(job.id, kept);
  return kept;
}

export async function isLocked(job: Pick<BackupJob, 'id' | 'encryption'>): Promise<boolean> {
  return Boolean(job.encryption) && !(await jobKey(job));
}

/** Checks the passphrase and keeps the key for this session, and on this computer when `remember`. */
export async function unlockJob(
  job: Pick<BackupJob, 'id' | 'encryption'>,
  passphrase: string,
  remember: boolean
): Promise<void> {
  if (!job.encryption) return;
  const key = await unlockEncryption(job.encryption, passphrase);
  sessionKeys.set(job.id, key);
  if (remember) await idb('readwrite', (s) => s.put(key, `crypto:${job.id}`));
  else await idb('readwrite', (s) => s.delete(`crypto:${job.id}`)).catch(() => undefined);
}

/** A new passphrase for a job: returns the job with its encryption info (the key is kept like unlockJob). */
export async function encryptJob<T extends BackupJob>(job: T, passphrase: string, remember: boolean): Promise<T> {
  const { info, key } = await newEncryption(passphrase);
  sessionKeys.set(job.id, key);
  if (remember) await idb('readwrite', (s) => s.put(key, `crypto:${job.id}`));
  return { ...job, encryption: info };
}

export async function forgetJobKey(jobId: string): Promise<void> {
  sessionKeys.delete(jobId);
  await idb('readwrite', (s) => s.delete(`crypto:${jobId}`)).catch(() => undefined);
}

/** The sink of a job's folder, decrypting / encrypting when the job is encrypted. */
export async function jobSink(job: Pick<BackupJob, 'id' | 'encryption'>): Promise<BackupSink> {
  const handle = await backupFolder(job.id);
  if (!handle) throw new Error('Choose the folder this backup writes to.');
  const plain = folderSink(handle);
  if (!job.encryption) return plain;
  const key = await jobKey(job);
  if (!key) throw new Error('This backup is encrypted: unlock it with its passphrase first.');
  return encryptedSink(plain, key);
}

// ---------- the run going on (one at a time) ----------

export type RunState = {
  jobId: string;
  jobName: string;
  scheduled: boolean;
  object: string;
  index: number;
  total: number;
  rows: number;
  state: string;
  done?: BackupManifest;
  error?: string;
};

let current: RunState | null = null;
const listeners = new Set<() => void>();
const publish = (next: RunState | null): void => {
  current = next;
  listeners.forEach((l) => l());
};
export function useBackupRun(): RunState | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current
  );
}
export const runningBackup = (): boolean => Boolean(current && !current.done && !current.error);

/**
 * Runs a job into its folder (or into memory for a zip when `zip` is set) and records the
 * result. The zip download is for small backups: everything is held in memory first.
 */
export async function runJob(
  job: JobRecord,
  client: SalesforceClient,
  options: { scheduled?: boolean; zip?: boolean } = {}
): Promise<BackupManifest> {
  if (runningBackup()) throw new Error(`A backup is already running (${current!.jobName}).`);
  const base: RunState = {
    jobId: job.id,
    jobName: job.name,
    scheduled: Boolean(options.scheduled),
    object: '',
    index: 0,
    total: 0,
    rows: 0,
    state: 'starting',
  };
  publish(base);
  try {
    let sink: BackupSink;
    let memory: ReturnType<typeof memorySink> | undefined;
    if (options.zip) {
      memory = memorySink();
      const key = await jobKey(job);
      if (job.encryption && !key) throw new Error('This backup is encrypted: unlock it with its passphrase first.');
      sink = key ? encryptedSink(memory, key) : memory;
    } else {
      sink = await jobSink(job);
    }
    const manifest = await runBackup(client, job, sink, {
      onProgress: (s) => {
        publish({ ...base, object: s.object, index: s.index, total: s.total, rows: s.rows, state: s.state });
      },
    });
    const total = manifest.objects.reduce((n, o) => n + o.rows, 0);
    const failed = manifest.objects.filter((o) => o.error).length;
    if (memory) {
      const zip = makeZip([...memory.files].map(([path, content]) => ({ path, content })));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([zip], { type: 'application/zip' }));
      a.download = `${job.name.replace(/[^\w.-]+/g, '-')}-${manifest.startedAt.slice(0, 10)}.zip`;
      a.click();
    } else {
      setLastRun(job.id, { at: manifest.finishedAt, ok: failed === 0, rows: total, failed });
    }
    publish({
      ...base,
      object: '',
      index: manifest.objects.length,
      total: manifest.objects.length,
      rows: total,
      state: 'done',
      done: manifest,
    });
    return manifest;
  } catch (e) {
    const message = (e as Error).message;
    if (!options.zip) setLastRun(job.id, { at: new Date().toISOString(), ok: false, rows: 0, failed: 0, message });
    publish({ ...base, state: 'failed', error: message });
    throw e;
  }
}

/**
 * Runs scheduled jobs that are due while the Studio is open: checked at start and every
 * minute. A job runs only when its folder can be written without asking (else it waits for a
 * click on the Backup page) and its org can be reached.
 */
export function useBackupScheduler(clientFor: (org: string) => Promise<SalesforceClient>): void {
  useEffect(() => {
    let stopped = false;
    const tick = async (): Promise<void> => {
      if (runningBackup()) return;
      const last = lastRuns();
      for (const job of backupJobs.list()) {
        if (stopped) return;
        const lastAt = last[job.id]?.at;
        if (!isDue(job.schedule, lastAt ? new Date(lastAt) : undefined, new Date(), new Date(job.created))) continue;
        // eslint-disable-next-line no-await-in-loop
        if ((await folderAccess(job.id)) !== 'granted') continue;
        // Encrypted and not unlocked (key not kept on this computer): waits for the person
        // eslint-disable-next-line no-await-in-loop
        if (await isLocked(job)) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await runJob(job, await clientFor(job.org), { scheduled: true });
        } catch {
          // recorded as the job's last run
        }
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [clientFor]);
}

/** Larger values of this profile (Id maps of migrations): IndexedDB, next to the folder handles. */
export const bigStore = {
  get: <T>(key: string): Promise<T | undefined> =>
    idb<T | undefined>('readonly', (s) => s.get(`kv:${key}`) as IDBRequest<T | undefined>).catch(() => undefined),
  set: (key: string, value: unknown): Promise<void> =>
    idb('readwrite', (s) => s.put(value, `kv:${key}`)).then(() => undefined),
  remove: (key: string): Promise<void> => idb('readwrite', (s) => s.delete(`kv:${key}`)).then(() => undefined),
};
