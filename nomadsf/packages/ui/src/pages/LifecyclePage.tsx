import { useEffect, useRef, useState } from 'react';
import {
  CHANGES_DATA,
  backupCandidates,
  defaultMasking,
  describeData,
  describeSchedule,
  describeStep,
  lifecycleTemplate,
  lifecycleWarnings,
  newLifecycleJob,
  stepId,
  type DataField,
  type DataObject,
  type LifecycleJob,
  type LifecycleRun,
  type LifecycleStep,
  type MaskRule,
  type SalesforceClient,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { storage, useStudio } from '../context';
import type { OrgChoice } from '../host';
import { backupJobs } from '../backups';
import {
  answerApproval,
  lastLifecycleRuns,
  lifecycleJobs,
  lifecycleRunning,
  lifecycleRuns,
  startLifecycle,
  useLifecycleRun,
} from '../lifecycle';
import { ScheduleEditor } from './BackupPage';
import { askConfirm, askTyped } from '../components/Dialogs';
import { Status } from '../statusLog';

type Tab = 'steps' | 'settings' | 'runs';
type Template = 'blank' | 'retention' | 'sandbox' | 'backup-archive';
const TEMPLATES: Array<{ id: Template; label: string; hint: string }> = [
  { id: 'blank', label: 'Empty job', hint: 'add your own steps' },
  { id: 'retention', label: 'Retention', hint: 'archive cases closed more than 7 years ago, weekly' },
  { id: 'sandbox', label: 'Sandbox refresh', hint: 'anonymize Contacts and Leads' },
  { id: 'backup-archive', label: 'Backup, then archive', hint: 'back up, then archive tasks older than 3 years' },
];

/** "+ New" with a small menu: an empty job or a template. */
function NewJobMenu({ onPick }: { onPick: (kind: Template) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div className="menu-wrap" ref={box}>
      <button className="primary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        + New
      </button>
      {open && (
        <div className="menu" role="menu">
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(t.id);
              }}
            >
              <b>{t.label}</b>
              <span className="muted">{t.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
const STEP_TYPES: Array<{ id: LifecycleStep['type']; label: string; hint: string }> = [
  { id: 'backup', label: 'Back up', hint: 'run one of your backup jobs (a safety net before changes)' },
  { id: 'check', label: 'Check', hint: 'count records; stop the run when there are more than a limit' },
  {
    id: 'archive',
    label: 'Archive',
    hint: 'copy every field of the records into a backup folder, check it, then delete them',
  },
  { id: 'anonymize', label: 'Anonymize', hint: 'replace personal fields in place with fake values (cannot be undone)' },
  { id: 'delete', label: 'Delete', hint: 'delete the records (optionally for good, past the recycle bin)' },
];
const RULES: MaskRule[] = ['email', 'phone', 'name', 'text', 'blank'];

const blankStep = (type: LifecycleStep['type']): LifecycleStep => {
  const id = stepId();
  switch (type) {
    case 'backup':
      return { id, type, backupJobId: '' };
    case 'check':
      return { id, type, object: '', max: 1000 };
    case 'archive':
      return { id, type, object: '', backupJobId: '' };
    case 'anonymize':
      return { id, type, object: '' };
    case 'delete':
      return { id, type, object: '' };
  }
};

/**
 * Data lifecycle jobs: steps on one org (back up, check, archive, anonymize, delete), run as a
 * dry run, now, or on a schedule, with a person's approval before data changes (unless the job
 * turns it off), and a report of every run.
 */
export function LifecyclePage({
  orgs,
  clientFor,
}: {
  orgs: OrgChoice[];
  clientFor: (org: string) => Promise<SalesforceClient>;
}) {
  const studio = useStudio();
  const [jobs, setJobs] = useState<LifecycleJob[]>(() => lifecycleJobs.list());
  const [draft, setDraft] = useState<LifecycleJob>(() => jobs[0] ?? newLifecycleJob(studio.org.id));
  const [saved, setSaved] = useState(() => JSON.stringify(jobs[0] ?? null));
  const [tab, setTabState] = useState<Tab>(() => storage.get<Tab>('lifecycle.tab', 'steps'));
  const [objects, setObjects] = useState<DataObject[]>([]);
  const [fieldsOf, setFieldsOf] = useState<Record<string, DataField[]>>({});
  const [openFields, setOpenFields] = useState('');
  const [runs, setRuns] = useState<LifecycleRun[]>([]);
  const [shown, setShown] = useState<LifecycleRun>();
  const [status, setStatus] = useState('');
  const live = useLifecycleRun();
  const dirty = JSON.stringify(draft) !== saved;
  const setTab = (t: Tab) => {
    setTabState(t);
    storage.set('lifecycle.tab', t);
  };
  const orgLabel = (id: string) => orgs.find((o) => o.id === id)?.label ?? id;
  const backups = backupJobs.list().filter((b) => b.org === draft.org);
  const backupName = (id: string) => backupJobs.list().find((b) => b.id === id)?.name ?? '';
  const warnings = lifecycleWarnings(draft);
  const changes = draft.steps.some((s) => CHANGES_DATA.has(s.type));
  const running = Boolean(live && (live.run.status === 'running' || live.run.status === 'waiting'));
  // The run going on for this job (once it ends, it shows among the reports)
  const liveHere =
    live && live.run.jobId === draft.id && (live.run.status === 'running' || live.run.status === 'waiting')
      ? live
      : null;

  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const client = await clientFor(draft.org);
        const list = await client.rest<{ sobjects: DataObject[] }>('GET', '/sobjects');
        if (!canceled) setObjects(backupCandidates(list.sobjects));
      } catch (e) {
        if (!canceled) setStatus(`❌ ${(e as Error).message}`);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [draft.org, clientFor]);
  useEffect(() => {
    setShown(undefined);
    void lifecycleRuns(draft.id).then(setRuns);
  }, [draft.id, live?.run.finishedAt]);

  const update = (patch: Partial<LifecycleJob>) => setDraft((d) => ({ ...d, ...patch }));
  const setStep = (id: string, patch: Partial<LifecycleStep>) =>
    setDraft((d) => ({ ...d, steps: d.steps.map((s) => (s.id === id ? ({ ...s, ...patch } as LifecycleStep) : s)) }));
  const move = (i: number, by: number) =>
    setDraft((d) => {
      const steps = [...d.steps];
      const [s] = steps.splice(i, 1);
      steps.splice(Math.max(0, Math.min(steps.length, i + by)), 0, s);
      return { ...d, steps };
    });

  const switchJob = async (job: LifecycleJob) => {
    if (dirty && !(await askConfirm('Discard unsaved changes to this lifecycle job?', { ok: 'Discard' }))) return;
    setDraft(job);
    setSaved(JSON.stringify(job));
    setStatus('');
  };
  const save = (): LifecycleJob => {
    const job = { ...draft, name: draft.name.trim() || 'Lifecycle' };
    lifecycleJobs.save(job);
    setJobs(lifecycleJobs.list());
    setDraft(job);
    setSaved(JSON.stringify(job));
    return job;
  };

  const loadFields = async (object: string) => {
    if (!object || fieldsOf[object]) return;
    try {
      const list = await describeData(await clientFor(draft.org), object);
      setFieldsOf((f) => ({ ...f, [object]: list }));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const start = async (dryRun: boolean) => {
    if (warnings.some((w) => /choose/.test(w))) {
      setStatus(`❌ ${warnings.find((w) => /choose/.test(w))}`);
      setTab('steps');
      return;
    }
    const job = save();
    if (!dryRun && changes) {
      const label = orgLabel(job.org);
      const ok = await askTyped(
        `Run "${job.name}" on ${label}: ${job.steps
          .map((s, i) => `\n${i + 1}. ${describeStep(s, backupName)}`)
          .join('')}\n\n${
          job.approval
            ? 'You approve again before the first step that changes data.'
            : '⚠ No approval step: data changes right away.'
        }`,
        label,
        { ok: 'Run', danger: !job.approval }
      );
      if (!ok) return;
    }
    setStatus('');
    setTab('runs');
    try {
      const run = await startLifecycle(job, await clientFor(job.org), clientFor, {
        dryRun,
        user: studio.user?.userName,
      });
      setShown(run);
      studio.logActivity(dryRun ? 'lifecycle dry run' : 'lifecycle run', {
        job: job.name,
        status: run.status,
        steps: run.steps.map((s) => `${s.type}:${s.status}:${s.changed ?? s.matched ?? ''}`),
      });
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const objectSelect = (step: Extract<LifecycleStep, { object: string }>) => (
    <label>
      Object
      <select
        value={step.object}
        onChange={(e) => {
          setStep(step.id, {
            object: e.target.value,
            ...(step.type === 'anonymize' ? { fields: undefined } : {}),
          } as Partial<LifecycleStep>);
          void loadFields(e.target.value);
        }}
      >
        <option value="">Choose…</option>
        {objects.map((o) => (
          <option key={o.name} value={o.name}>
            {o.label}
            {o.label !== o.name ? ` (${o.name})` : ''}
          </option>
        ))}
      </select>
    </label>
  );
  const whereInput = (step: Extract<LifecycleStep, { object: string }>) => (
    <label className="grow-field">
      Which records (SOQL condition)
      <input
        className="mono"
        placeholder="e.g. IsClosed = true AND ClosedDate < LAST_N_YEARS:7"
        value={step.where ?? ''}
        onChange={(e) => setStep(step.id, { where: e.target.value || undefined } as Partial<LifecycleStep>)}
      />
    </label>
  );
  const backupSelect = (step: Extract<LifecycleStep, { backupJobId: string }>, label: string) => (
    <label>
      {label}
      <select
        value={step.backupJobId}
        onChange={(e) => setStep(step.id, { backupJobId: e.target.value } as Partial<LifecycleStep>)}
      >
        <option value="">Choose a backup…</option>
        {backups.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
            {b.encryption ? ' 🔒' : ''}
          </option>
        ))}
      </select>
    </label>
  );

  const anonymizeFields = (step: Extract<LifecycleStep, { type: 'anonymize' }>) => {
    const all = fieldsOf[step.object];
    if (!all) return <p className="muted">Loading fields…</p>;
    const suggested = defaultMasking(all.filter((f) => f.updateable));
    const rules = step.fields ?? suggested;
    const candidates = all.filter(
      (f) =>
        f.updateable &&
        !['reference', 'id', 'boolean', 'date', 'datetime', 'currency', 'double', 'int', 'percent'].includes(f.type)
    );
    return (
      <div className="anonymize-fields">
        <span className="muted">
          {step.fields ? 'Fields chosen:' : 'Personal fields found (change them if needed):'}
        </span>
        {candidates.map((f) => (
          <label key={f.name} className="check">
            <input
              type="checkbox"
              checked={Boolean(rules[f.name])}
              onChange={(e) => {
                const next = { ...rules };
                if (e.target.checked) next[f.name] = suggested[f.name] ?? (f.nillable ? 'blank' : 'text');
                else delete next[f.name];
                setStep(step.id, { fields: next } as Partial<LifecycleStep>);
              }}
            />{' '}
            {f.label}
            {rules[f.name] && (
              <select
                value={rules[f.name]}
                onChange={(e) =>
                  setStep(step.id, {
                    fields: { ...rules, [f.name]: e.target.value as MaskRule },
                  } as Partial<LifecycleStep>)
                }
              >
                {RULES.map((r) => (
                  <option key={r}>{r}</option>
                ))}
              </select>
            )}
          </label>
        ))}
      </div>
    );
  };

  const runTable = (run: LifecycleRun) => (
    <DataTable
      columns={['#', 'step', 'status', 'matched', 'changed', 'failed', 'message']}
      rows={run.steps.map((s, i) => ({
        '#': i + 1,
        step: s.description,
        status: s.status,
        matched: s.matched ?? '',
        changed: s.changed ?? '',
        failed: s.failed ?? '',
        message: s.message ?? '',
      }))}
      rowKey="#"
      name={`lifecycle-${run.id}`}
    />
  );

  return (
    <div className="page data-page">
      <div className="toolbar">
        <h2>Lifecycle</h2>
        <span className="muted">
          Data jobs in steps: back up, check, archive, anonymize, delete — with approval and a report
        </span>
      </div>
      <div className="backup-layout">
        <aside className="card backup-jobs">
          <div className="jobs-head">
            <b>Jobs</b>
            <NewJobMenu
              onPick={(kind) =>
                switchJob(kind === 'blank' ? newLifecycleJob(studio.org.id) : lifecycleTemplate(kind, studio.org.id))
              }
            />
          </div>
          <ul>
            {jobs.map((j) => {
              const l = lastLifecycleRuns()[j.id];
              return (
                <li key={j.id}>
                  <button className={j.id === draft.id ? 'active' : ''} onClick={() => switchJob(j)}>
                    <span className="job-name">
                      <span className={`dot ${!l ? '' : l.status === 'done' ? 'good' : 'bad'}`} />
                      {j.name}
                    </span>
                    <span className="muted">
                      {orgLabel(j.org)} · {j.steps.length} step{j.steps.length === 1 ? '' : 's'}
                    </span>
                    <span className="muted">
                      {describeSchedule(j.schedule)}
                      {l ? ` · ${l.status} ${new Date(l.at).toLocaleDateString()}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!jobs.length && <p className="muted">No lifecycle jobs yet. Start from a template with + New.</p>}
        </aside>

        <div className="backup-main">
          <div className="card section job-head">
            <div className="form">
              <label>
                Name
                <input value={draft.name} onChange={(e) => update({ name: e.target.value })} />
              </label>
              <label>
                Org
                <select value={draft.org} onChange={(e) => update({ org: e.target.value })}>
                  {!orgs.some((o) => o.id === draft.org) && <option value={draft.org}>{draft.org}</option>}
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                      {o.type ? ` — ${o.type}` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <span className="grow" />
              <button disabled={!dirty} onClick={() => (save(), setStatus('✓ Saved.'))}>
                {dirty ? 'Save' : 'Saved'}
              </button>
              {jobs.some((j) => j.id === draft.id) && (
                <button
                  className="danger"
                  onClick={async () => {
                    if (
                      !(await askConfirm(`Delete the lifecycle job "${draft.name}" and its run reports?`, {
                        ok: 'Delete',
                        danger: true,
                      }))
                    )
                      return;
                    lifecycleJobs.remove(draft.id);
                    const rest = lifecycleJobs.list();
                    setJobs(rest);
                    setDraft(rest[0] ?? newLifecycleJob(studio.org.id));
                    setSaved(JSON.stringify(rest[0] ?? null));
                  }}
                >
                  Delete
                </button>
              )}
            </div>
            <div className="job-summary">
              <span className="chip">
                {draft.steps.length} step{draft.steps.length === 1 ? '' : 's'}
              </span>
              <span className="chip">{describeSchedule(draft.schedule)}</span>
              <span className={`chip ${draft.approval ? 'good' : 'warn'}`}>
                {draft.approval ? 'approval before changes' : 'no approval'}
              </span>
              {changes && <span className="chip warn">changes data</span>}
              <span className="grow" />
              <span className="job-actions">
                <button
                  disabled={running || !draft.steps.length}
                  onClick={() => void start(true)}
                  title="Counts only; nothing changes"
                >
                  Dry run
                </button>
                <button
                  className={changes ? 'danger' : 'primary'}
                  disabled={running || !draft.steps.length || lifecycleRunning()}
                  onClick={() => void start(false)}
                >
                  Run now…
                </button>
              </span>
            </div>
            {liveHere && (
              <div className="run-progress">
                <span className="muted">
                  {liveHere.run.dryRun ? 'Dry run' : liveHere.run.scheduled ? 'Scheduled run' : 'Running'} · step{' '}
                  {liveHere.run.steps.length}/{draft.steps.length} · {liveHere.text}
                </span>
              </div>
            )}
            {liveHere?.waiting && liveHere.run.status === 'waiting' && (
              <div className="approval">
                <b>Approval needed</b>
                <p>
                  Next: <b>{describeStep(liveHere.waiting, backupName)}</b>
                </p>
                <ul>
                  {liveHere.run.steps
                    .filter((s) => s.status !== 'waiting')
                    .map((s) => (
                      <li key={s.stepId}>
                        {s.description}: {s.status}
                        {s.matched !== undefined ? ` · ${s.matched.toLocaleString()} matched` : ''}
                        {s.message ? ` · ${s.message}` : ''}
                      </li>
                    ))}
                </ul>
                <div className="form">
                  <button className="danger" onClick={() => answerApproval(true)}>
                    Approve and continue
                  </button>
                  <button onClick={() => answerApproval(false)}>Stop the run</button>
                </div>
              </div>
            )}
            {status && <Status text={status} block />}
          </div>

          <div className="tabs page-tabs">
            {(
              [
                ['steps', `Steps (${draft.steps.length})`],
                ['settings', 'Settings'],
                ['runs', `Runs${runs.length ? ` (${runs.length})` : ''}`],
              ] as Array<[Tab, string]>
            ).map(([id, label]) => (
              <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'steps' && (
            <div className="card section">
              <ol className="steps">
                {draft.steps.map((step, i) => (
                  <li key={step.id} className={`step-card ${CHANGES_DATA.has(step.type) ? 'changes' : ''}`}>
                    <div className="step-head">
                      <span className="step">{i + 1}</span>
                      <select
                        value={step.type}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            steps: d.steps.map((s) =>
                              s.id === step.id ? blankStep(e.target.value as LifecycleStep['type']) : s
                            ),
                          }))
                        }
                      >
                        {STEP_TYPES.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                      <span className="muted">{STEP_TYPES.find((t) => t.id === step.type)?.hint}</span>
                      <span className="grow" />
                      <button className="link" disabled={i === 0} onClick={() => move(i, -1)} title="Up">
                        ↑
                      </button>
                      <button
                        className="link"
                        disabled={i === draft.steps.length - 1}
                        onClick={() => move(i, 1)}
                        title="Down"
                      >
                        ↓
                      </button>
                      <button
                        className="link"
                        title="Remove"
                        onClick={() => setDraft((d) => ({ ...d, steps: d.steps.filter((s) => s.id !== step.id) }))}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="form step-body">
                      {step.type === 'backup' && backupSelect(step, 'Backup job')}
                      {'object' in step && objectSelect(step)}
                      {'object' in step && step.type !== 'anonymize' && whereInput(step)}
                      {step.type === 'anonymize' && whereInput(step)}
                      {step.type === 'check' && (
                        <label>
                          Stop above
                          <input
                            type="number"
                            min={0}
                            style={{ width: 110 }}
                            value={step.max}
                            onChange={(e) => setStep(step.id, { max: Math.max(0, Number(e.target.value) || 0) })}
                          />
                        </label>
                      )}
                      {step.type === 'archive' && backupSelect(step, 'Archive into the folder of')}
                      {(step.type === 'archive' || step.type === 'delete') && (
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={Boolean(step.hardDelete)}
                            onChange={(e) => setStep(step.id, { hardDelete: e.target.checked })}
                          />{' '}
                          Delete for good (skip the recycle bin)
                        </label>
                      )}
                      {step.type === 'anonymize' && step.object && (
                        <button
                          className="link"
                          onClick={() => {
                            setOpenFields(openFields === step.id ? '' : step.id);
                            void loadFields(step.object);
                          }}
                        >
                          {openFields === step.id
                            ? 'Close fields'
                            : `Fields${step.fields ? ` (${Object.keys(step.fields).length})` : ' (personal fields)'}…`}
                        </button>
                      )}
                    </div>
                    {step.type === 'anonymize' && openFields === step.id && step.object && anonymizeFields(step)}
                  </li>
                ))}
              </ol>
              <div className="form">
                <select
                  value=""
                  onChange={(e) => {
                    const t = e.target.value as LifecycleStep['type'];
                    if (t) setDraft((d) => ({ ...d, steps: [...d.steps, blankStep(t)] }));
                  }}
                >
                  <option value="">+ Add a step…</option>
                  {STEP_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label} — {t.hint}
                    </option>
                  ))}
                </select>
                {!backups.length && draft.steps.some((s) => s.type === 'backup' || s.type === 'archive') && (
                  <span className="muted">
                    Back up and Archive use a backup job of this org: create one on the Backup page.
                  </span>
                )}
              </div>
              {warnings.length > 0 && (
                <ul className="capacity-warnings">
                  {warnings.map((w) => (
                    <li key={w}>⚠ {w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div className="card section settings-grid">
              <div className="setting">
                <h4>Approval</h4>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.approval}
                    onChange={(e) => update({ approval: e.target.checked })}
                  />{' '}
                  Ask for approval before the steps that change data
                </label>
                <p className="muted">
                  {draft.approval
                    ? 'The run stops before the first archive, anonymize or delete step and shows what the steps before it found; a person approves or stops it here. Scheduled runs wait too (keep the Studio open).'
                    : 'Data changes without asking, also on a schedule. Keep a Check step before the changes so an unexpected volume stops the run.'}
                </p>
              </div>
              <div className="setting">
                <h4>Schedule</h4>
                <ScheduleEditor schedule={draft.schedule} onChange={(schedule) => update({ schedule })} />
                <p className="muted">Scheduled runs happen while NomadSF is open in Chrome, like backups.</p>
              </div>
            </div>
          )}

          {tab === 'runs' && (
            <div className="card section">
              {liveHere && (
                <>
                  <h3>
                    {liveHere.run.dryRun ? 'Dry run' : 'Run'} · {liveHere.run.status}
                  </h3>
                  {runTable(liveHere.run)}
                </>
              )}
              <h3>Reports</h3>
              {!runs.length && <p className="muted">No runs yet. Start with a Dry run: it only counts.</p>}
              {runs.length > 0 && (
                <DataTable
                  columns={['startedAt', 'kind', 'status', 'summary']}
                  rows={runs.map((r) => ({
                    id: r.id,
                    startedAt: new Date(r.startedAt).toLocaleString(),
                    kind: r.dryRun ? 'dry run' : r.scheduled ? 'scheduled' : 'manual',
                    status: r.status,
                    summary: r.steps
                      .map(
                        (s) =>
                          `${s.type} ${s.status}${
                            s.changed !== undefined
                              ? ` (${s.changed})`
                              : s.matched !== undefined
                              ? ` (${s.matched})`
                              : ''
                          }`
                      )
                      .join(' → '),
                  }))}
                  rowKey="id"
                  name={`${draft.name}-runs`}
                  onRowClick={(r) => setShown(runs.find((x) => x.id === r.id))}
                  note={<span>· click a run for its report</span>}
                />
              )}
              {shown && (
                <>
                  <h3>
                    {shown.dryRun ? 'Dry run' : 'Run'} of {new Date(shown.startedAt).toLocaleString()} · {shown.status}
                    {shown.approval && 'by' in shown.approval ? (
                      <span className="muted"> · approved by {shown.approval.by}</span>
                    ) : shown.approval ? (
                      <span className="muted"> · approval declined</span>
                    ) : null}
                  </h3>
                  {runTable(shown)}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
