import {
  backupSoql,
  chooseFields,
  describeData,
  type BackupManifest,
  type BackupSchedule,
  type BackupSink,
} from './backup.js';
import { bulkIngest, bulkQuery } from './bulk.js';
import type { SalesforceClient } from './client.js';
import { parseCsv, toCsv } from './csv.js';
import { defaultMasking, maskValue, type MaskRule } from './dataLoad.js';
import { BULK_NULL } from './ingestCheck.js';
import { query } from './query.js';

/**
 * Data lifecycle jobs (in the spirit of Odaseva's data compliance): a sequence of steps on one
 * org — back up, check a limit, archive (back up then delete), anonymize in place, delete — run
 * now, as a dry run (counts only), or on a schedule. Steps that change data wait for a person's
 * approval unless the job says otherwise. Every run produces a report of what each step did.
 */

export type LifecycleStep =
  | { id: string; type: 'backup'; backupJobId: string }
  | { id: string; type: 'check'; object: string; where?: string; max: number }
  | { id: string; type: 'archive'; object: string; where?: string; backupJobId: string; hardDelete?: boolean }
  | { id: string; type: 'anonymize'; object: string; where?: string; fields?: Record<string, MaskRule> }
  | { id: string; type: 'delete'; object: string; where?: string; hardDelete?: boolean };

export type LifecycleJob = {
  id: string;
  name: string;
  org: string;
  steps: LifecycleStep[];
  schedule: BackupSchedule;
  /** Ask a person before the first step that changes data (on by default). */
  approval: boolean;
  created: string;
};

export const CHANGES_DATA = new Set<LifecycleStep['type']>(['archive', 'anonymize', 'delete']);

export const newLifecycleJob = (org: string, name = 'Lifecycle'): LifecycleJob => ({
  id: `l${Date.now().toString(36)}`,
  name,
  org,
  steps: [],
  schedule: { every: 'off' },
  approval: true,
  created: new Date().toISOString(),
});

export const stepId = (): string => `s${Math.random().toString(36).slice(2, 9)}`;

/** Templates to start from. */
export function lifecycleTemplate(kind: 'retention' | 'sandbox' | 'backup-archive', org: string): LifecycleJob {
  const job = newLifecycleJob(org);
  if (kind === 'retention')
    return {
      ...job,
      name: 'Retention: archive closed cases',
      steps: [
        {
          id: stepId(),
          type: 'check',
          object: 'Case',
          where: 'IsClosed = true AND ClosedDate < LAST_N_YEARS:7',
          max: 10_000,
        },
        {
          id: stepId(),
          type: 'archive',
          object: 'Case',
          where: 'IsClosed = true AND ClosedDate < LAST_N_YEARS:7',
          backupJobId: '',
        },
      ],
      schedule: { every: 'weekly', time: '03:00', weekday: 0 },
    };
  if (kind === 'sandbox')
    return {
      ...job,
      name: 'Sandbox refresh: anonymize',
      steps: [
        { id: stepId(), type: 'anonymize', object: 'Contact' },
        { id: stepId(), type: 'anonymize', object: 'Lead' },
      ],
    };
  return {
    ...job,
    name: 'Backup, then archive old tasks',
    steps: [
      { id: stepId(), type: 'backup', backupJobId: '' },
      { id: stepId(), type: 'check', object: 'Task', where: 'ActivityDate < LAST_N_YEARS:3', max: 50_000 },
      { id: stepId(), type: 'archive', object: 'Task', where: 'ActivityDate < LAST_N_YEARS:3', backupJobId: '' },
    ],
  };
}

/** What a step does, in a few words (lists, reports, approval). */
export function describeStep(step: LifecycleStep, backupName: (id: string) => string = (id) => id): string {
  const which = 'object' in step ? `${step.object}${step.where ? ` where ${step.where}` : ' (all records)'}` : '';
  switch (step.type) {
    case 'backup':
      return `Back up with "${backupName(step.backupJobId) || '?'}"`;
    case 'check':
      return `Stop if ${which} has more than ${step.max.toLocaleString()} records`;
    case 'archive':
      return `Archive ${which} into "${backupName(step.backupJobId) || '?'}", then ${
        step.hardDelete ? 'delete for good' : 'delete'
      }`;
    case 'anonymize':
      return `Anonymize ${which}${step.fields ? ` (${Object.keys(step.fields).join(', ')})` : ' (personal fields)'}`;
    case 'delete':
      return `${step.hardDelete ? 'Delete for good' : 'Delete'} ${which}`;
  }
}

// ---------- running ----------

export type StepStatus = 'done' | 'dry' | 'stopped' | 'failed' | 'skipped' | 'waiting';
export type StepResult = {
  stepId: string;
  type: LifecycleStep['type'];
  description: string;
  status: StepStatus;
  /** Records matched by the step's condition. */
  matched?: number;
  /** Records changed (archived, anonymized, deleted) or backed up. */
  changed?: number;
  failed?: number;
  message?: string;
  startedAt: string;
  finishedAt?: string;
};

export type LifecycleRun = {
  id: string;
  jobId: string;
  jobName: string;
  org: string;
  dryRun: boolean;
  scheduled: boolean;
  status: 'running' | 'waiting' | 'done' | 'stopped' | 'failed';
  startedAt: string;
  finishedAt?: string;
  steps: StepResult[];
  approval?: { by: string; at: string } | { declined: true; at: string };
};

export type LifecycleContext = {
  dryRun: boolean;
  scheduled?: boolean;
  /** Who approves (shown in the report). */
  user?: string;
  /** Asked before the first step that changes data when the job requires approval; resolves true to go on. */
  approve: (run: LifecycleRun, next: LifecycleStep) => Promise<boolean>;
  /** Runs a backup job (Backup step). */
  runBackup: (backupJobId: string) => Promise<BackupManifest>;
  /** Where an Archive step writes: the sink and folder of a backup job (encrypted when that job is). */
  archiveSink: (backupJobId: string) => Promise<{ sink: BackupSink; root: string }>;
  onProgress?: (run: LifecycleRun, text: string) => void;
  pollMs?: number;
  /** Names of backup jobs, for the report. */
  backupName?: (id: string) => string;
};

const now = (): string => new Date().toISOString();

async function count(client: SalesforceClient, object: string, where?: string): Promise<number> {
  return (await query(client, backupSoql(object, ['Id'], where).replace('SELECT Id FROM', 'SELECT COUNT() FROM')))
    .totalSize;
}

async function idsOf(client: SalesforceClient, object: string, where?: string): Promise<string[]> {
  const result = await bulkQuery(client, backupSoql(object, ['Id'], where));
  return parseCsv(result.csv).rows.map((r) => r.Id);
}

async function deleteIds(
  client: SalesforceClient,
  object: string,
  ids: string[],
  hard: boolean,
  pollMs?: number
): Promise<{ deleted: number; failed: number; error?: string }> {
  if (!ids.length) return { deleted: 0, failed: 0 };
  const job = await bulkIngest(
    client,
    {
      object,
      operation: hard ? 'hardDelete' : 'delete',
      csv: toCsv(
        ['Id'],
        ids.map((Id) => ({ Id }))
      ),
    },
    { pollMs }
  );
  const failed = parseCsv(job.failedCsv || '').rows;
  return { deleted: parseCsv(job.successfulCsv || '').rows.length, failed: failed.length, error: failed[0]?.sf__Error };
}

/** Runs a lifecycle job: steps in order; a Check over its limit, a failure or a refused approval stops it. */
export async function runLifecycle(
  client: SalesforceClient,
  job: LifecycleJob,
  ctx: LifecycleContext
): Promise<LifecycleRun> {
  const run: LifecycleRun = {
    id: `${job.id}-${Date.now().toString(36)}`,
    jobId: job.id,
    jobName: job.name,
    org: job.org,
    dryRun: ctx.dryRun,
    scheduled: Boolean(ctx.scheduled),
    status: 'running',
    startedAt: now(),
    steps: [],
  };
  const progress = (text: string): void => ctx.onProgress?.(run, text);
  let approved = !job.approval || ctx.dryRun;
  for (const step of job.steps) {
    const result: StepResult = {
      stepId: step.id,
      type: step.type,
      description: describeStep(step, ctx.backupName),
      status: 'done',
      startedAt: now(),
    };
    run.steps.push(result);
    try {
      // Approval once, before the first step that changes data
      if (CHANGES_DATA.has(step.type) && !approved) {
        result.status = 'waiting';
        run.status = 'waiting';
        progress(`Waiting for approval: ${result.description}`);
        /* eslint-disable no-await-in-loop */
        const ok = await ctx.approve(run, step);
        run.status = 'running';
        if (!ok) {
          run.approval = { declined: true, at: now() };
          result.status = 'stopped';
          result.message = 'Approval declined.';
          run.status = 'stopped';
          break;
        }
        run.approval = { by: ctx.user ?? 'you', at: now() };
        approved = true;
        result.status = 'done';
      }
      progress(result.description);
      switch (step.type) {
        case 'backup': {
          if (ctx.dryRun) {
            result.status = 'dry';
            result.message = 'Would run the backup.';
            break;
          }
          const manifest = await ctx.runBackup(step.backupJobId);
          result.changed = manifest.objects.reduce((n, o) => n + o.rows, 0);
          const failed = manifest.objects.filter((o) => o.error);
          if (failed.length) {
            result.status = 'failed';
            result.message = `${failed.length} object(s) failed: ${failed[0].name}: ${failed[0].error}`;
          } else result.message = `${manifest.kind} backup, ${manifest.objects.length} object(s).`;
          break;
        }
        case 'check': {
          result.matched = await count(client, step.object, step.where);
          if (result.matched > step.max) {
            result.status = 'stopped';
            result.message = `${result.matched.toLocaleString()} records, more than the limit of ${step.max.toLocaleString()}: stopped before anything changes.`;
          } else result.message = `${result.matched.toLocaleString()} records, within the limit.`;
          break;
        }
        case 'archive': {
          result.matched = await count(client, step.object, step.where);
          if (ctx.dryRun) {
            result.status = 'dry';
            result.message = `Would archive and delete ${result.matched.toLocaleString()} record(s).`;
            break;
          }
          if (!step.backupJobId) throw new Error('Choose the backup whose folder keeps the archive.');
          // 1. Every field of the matching records into the archive folder
          const { sink, root } = await ctx.archiveSink(step.backupJobId);
          const fields = chooseFields(await describeData(client, step.object));
          const folder = `${root}/archives/${run.id}/${step.object}`;
          const ids: string[] = [];
          let part = 0;
          await bulkQuery(client, backupSoql(step.object, fields, step.where), {
            onFile: async (csv) => {
              part++;
              await sink.write(`${folder}/part-${String(part).padStart(4, '0')}.csv`, csv);
              ids.push(...parseCsv(csv).rows.map((r) => r.Id));
            },
          });
          // 2. Read it back: only records safely in the archive are deleted
          const kept = new Set<string>();
          for (let i = 1; i <= part; i++) {
            const text = await sink.read(`${folder}/part-${String(i).padStart(4, '0')}.csv`);
            for (const r of text ? parseCsv(text).rows : []) kept.add(r.Id);
          }
          const safe = ids.filter((id) => kept.has(id));
          if (safe.length !== ids.length) throw new Error('The archive could not be read back; nothing was deleted.');
          await sink.write(
            `${folder}/archive.json`,
            JSON.stringify(
              { object: step.object, where: step.where ?? '', records: ids.length, at: now(), run: run.id },
              null,
              2
            )
          );
          // 3. Delete them
          progress(`Deleting ${ids.length} archived ${step.object} record(s)…`);
          const deleted = await deleteIds(client, step.object, safe, Boolean(step.hardDelete), ctx.pollMs);
          result.changed = deleted.deleted;
          result.failed = deleted.failed;
          result.message = `${ids.length} archived to ${folder}, ${deleted.deleted} deleted${
            deleted.failed ? `, ${deleted.failed} not deleted: ${deleted.error}` : ''
          }.`;
          if (deleted.failed) result.status = 'failed';
          break;
        }
        case 'anonymize': {
          result.matched = await count(client, step.object, step.where);
          const all = await describeData(client, step.object);
          const rules = step.fields ?? defaultMasking(all.filter((f) => f.updateable));
          const names = Object.keys(rules).filter((f) => all.some((x) => x.name === f && x.updateable));
          if (!names.length) throw new Error(`No personal fields to anonymize on ${step.object}; choose the fields.`);
          if (ctx.dryRun) {
            result.status = 'dry';
            result.message = `Would anonymize ${names.join(', ')} on ${result.matched.toLocaleString()} record(s).`;
            break;
          }
          const rows = parseCsv(
            (await bulkQuery(client, backupSoql(step.object, ['Id', ...names], step.where))).csv
          ).rows;
          const masked = rows.map((r) =>
            Object.fromEntries([
              ['Id', r.Id],
              ...names.map((f) => {
                const v = r[f] ? maskValue(rules[f], r[f]) : '';
                // Cleared values are sent as #N/A (Bulk API: empty would leave the old value)
                return [f, r[f] && !v ? BULK_NULL : v];
              }),
            ])
          );
          if (masked.length) {
            const job2 = await bulkIngest(
              client,
              { object: step.object, operation: 'update', csv: toCsv(['Id', ...names], masked) },
              { pollMs: ctx.pollMs }
            );
            const failed = parseCsv(job2.failedCsv || '').rows;
            result.changed = parseCsv(job2.successfulCsv || '').rows.length;
            result.failed = failed.length;
            if (failed.length) {
              result.status = 'failed';
              result.message = `${failed.length} not anonymized: ${failed[0].sf__Error}`;
            }
          } else result.changed = 0;
          result.message ??= `${names.join(', ')} anonymized on ${result.changed} record(s).`;
          break;
        }
        case 'delete': {
          result.matched = await count(client, step.object, step.where);
          if (ctx.dryRun) {
            result.status = 'dry';
            result.message = `Would ${
              step.hardDelete ? 'delete for good' : 'delete'
            } ${result.matched.toLocaleString()} record(s).`;
            break;
          }
          const deleted = await deleteIds(
            client,
            step.object,
            await idsOf(client, step.object, step.where),
            Boolean(step.hardDelete),
            ctx.pollMs
          );
          result.changed = deleted.deleted;
          result.failed = deleted.failed;
          result.message = `${deleted.deleted} deleted${
            deleted.failed ? `, ${deleted.failed} not deleted: ${deleted.error}` : ''
          }.`;
          if (deleted.failed) result.status = 'failed';
          break;
        }
      }
      /* eslint-enable no-await-in-loop */
    } catch (e) {
      result.status = 'failed';
      result.message = (e as Error).message;
    }
    result.finishedAt = now();
    if (result.status === 'stopped' || result.status === 'failed') {
      run.status = result.status;
      break;
    }
  }
  // Steps not reached
  for (const step of job.steps.slice(run.steps.length))
    run.steps.push({
      stepId: step.id,
      type: step.type,
      description: describeStep(step, ctx.backupName),
      status: 'skipped',
      startedAt: now(),
    });
  if (run.status === 'running') run.status = 'done';
  run.finishedAt = now();
  return run;
}

/** Problems with a job before it runs (also shown while editing). */
export function lifecycleWarnings(job: LifecycleJob): string[] {
  const out: string[] = [];
  if (!job.steps.length) out.push('Add at least one step.');
  for (const [i, s] of job.steps.entries()) {
    if ((s.type === 'backup' || s.type === 'archive') && !s.backupJobId) out.push(`Step ${i + 1}: choose a backup.`);
    if ('object' in s && !s.object) out.push(`Step ${i + 1}: choose an object.`);
    if ((s.type === 'delete' || s.type === 'archive') && !s.where)
      out.push(`Step ${i + 1} has no condition: every ${s.object || ''} record is included.`);
  }
  const firstChange = job.steps.findIndex((s) => CHANGES_DATA.has(s.type));
  if (firstChange >= 0 && !job.approval && !job.steps.slice(0, firstChange).some((s) => s.type === 'check'))
    out.push(
      'Without approval, add a Check step before the steps that change data, so an unexpected volume stops the run.'
    );
  if (
    firstChange >= 0 &&
    !job.steps.slice(0, firstChange).some((s) => s.type === 'backup' || s.type === 'archive') &&
    job.steps[firstChange].type !== 'archive'
  )
    out.push('Consider a Backup step first: anonymize and delete cannot be undone.');
  return out;
}
