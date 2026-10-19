import { useEffect, useSyncExternalStore } from 'react';
import {
  isDue,
  jobFolder,
  runLifecycle,
  type LifecycleJob,
  type LifecycleRun,
  type LifecycleStep,
  type SalesforceClient,
} from '@nomadsf/core';
import { storage } from './context';
import { backupJobs, bigStore, jobSink, runJob } from './backups';

/**
 * Lifecycle jobs of this browser profile, their runs (kept in IndexedDB, last 50 per job),
 * and the one run going on — with its approval question when it waits for a person.
 * Scheduled jobs run while the Studio is open, like backups.
 */

const JOBS = 'lifecycle.jobs';
const LAST = 'lifecycle.last';

export const lifecycleJobs = {
  list: (): LifecycleJob[] => storage.get<LifecycleJob[]>(JOBS, []),
  save(job: LifecycleJob): void {
    storage.set(
      JOBS,
      [...lifecycleJobs.list().filter((j) => j.id !== job.id), job].sort((a, b) => a.name.localeCompare(b.name))
    );
  },
  remove(id: string): void {
    storage.set(
      JOBS,
      lifecycleJobs.list().filter((j) => j.id !== id)
    );
    void bigStore.remove(`lifecycle.runs.${id}`);
  },
};

export const lastLifecycleRuns = (): Record<string, { at: string; status: LifecycleRun['status'] }> =>
  storage.get(LAST, {});

export const lifecycleRuns = async (jobId: string): Promise<LifecycleRun[]> =>
  (await bigStore.get<LifecycleRun[]>(`lifecycle.runs.${jobId}`)) ?? [];

async function keepRun(run: LifecycleRun): Promise<void> {
  const runs = (await lifecycleRuns(run.jobId)).filter((r) => r.id !== run.id);
  await bigStore.set(`lifecycle.runs.${run.jobId}`, [run, ...runs].slice(0, 50));
  if (!run.dryRun)
    storage.set(LAST, {
      ...lastLifecycleRuns(),
      [run.jobId]: { at: run.finishedAt ?? run.startedAt, status: run.status },
    });
}

// ---------- the run going on ----------

export type LiveLifecycle = { run: LifecycleRun; text: string; waiting?: LifecycleStep };
let live: LiveLifecycle | null = null;
let answer: ((ok: boolean) => void) | null = null;
const listeners = new Set<() => void>();
const publish = (next: LiveLifecycle | null): void => {
  live = next && { ...next, run: { ...next.run, steps: [...next.run.steps] } };
  listeners.forEach((l) => l());
};
export function useLifecycleRun(): LiveLifecycle | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => live
  );
}
export const lifecycleRunning = (): boolean =>
  Boolean(live && (live.run.status === 'running' || live.run.status === 'waiting'));

/** The person's answer to the approval question of the run going on. */
export function answerApproval(ok: boolean): void {
  answer?.(ok);
  answer = null;
}

export async function startLifecycle(
  job: LifecycleJob,
  client: SalesforceClient,
  clientFor: (org: string) => Promise<SalesforceClient>,
  options: { dryRun: boolean; scheduled?: boolean; user?: string }
): Promise<LifecycleRun> {
  if (lifecycleRunning()) throw new Error(`A lifecycle job is already running (${live!.run.jobName}).`);
  const backupOf = (id: string) => {
    const b = backupJobs.list().find((x) => x.id === id);
    if (!b) throw new Error('The backup of this step no longer exists.');
    return b;
  };
  const run = await runLifecycle(client, job, {
    dryRun: options.dryRun,
    scheduled: options.scheduled,
    user: options.user,
    backupName: (id) => backupJobs.list().find((b) => b.id === id)?.name ?? id,
    onProgress: (r, text) => publish({ run: r, text, waiting: live?.waiting }),
    approve: (r, next) =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
        publish({ run: r, text: 'Waiting for approval', waiting: next });
      }),
    runBackup: async (id) => {
      const b = backupOf(id);
      return runJob(b, await clientFor(b.org));
    },
    archiveSink: async (id) => {
      const b = backupOf(id);
      return { sink: await jobSink(b), root: jobFolder(b) };
    },
  });
  // Saved first, so the page reading the reports after the run sees it
  await keepRun(run);
  publish({ run, text: '' });
  return run;
}

/** Runs scheduled lifecycle jobs that are due while the Studio is open (checked every minute). */
export function useLifecycleScheduler(clientFor: (org: string) => Promise<SalesforceClient>): void {
  useEffect(() => {
    const tick = async (): Promise<void> => {
      if (lifecycleRunning()) return;
      const last = lastLifecycleRuns();
      for (const job of lifecycleJobs.list()) {
        const at = last[job.id]?.at;
        if (!isDue(job.schedule, at ? new Date(at) : undefined, new Date(), new Date(job.created))) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await startLifecycle(job, await clientFor(job.org), clientFor, { dryRun: false, scheduled: true });
        } catch {
          // kept in the run report
        }
        return;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 60_000);
    return () => clearInterval(timer);
  }, [clientFor]);
}
