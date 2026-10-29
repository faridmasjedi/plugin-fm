import { useEffect, useMemo, useState } from 'react';
import {
  backupCandidates,
  describeData,
  describeSchedule,
  estimateBackup,
  nextKind,
  nextRun,
  parseCsv,
  readIndex,
  readManifest,
  resolveObjects,
  jobFolder,
  newBackupJob,
  type BackupIndex,
  type BackupManifest,
  type BackupObject,
  type BackupScope,
  type BackupSchedule,
  type ScheduleUnit,
  type DataField,
  type DataObject,
  type FieldChoice,
  type FilesChoice,
  type ObjectPick,
  type SalesforceClient,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { ObjectPicker, type PickerObject } from '../components/ObjectPicker';
import { RestorePanel } from '../components/RestorePanel';
import { UnlockBackup } from '../components/UnlockBackup';
import { storage, useStudio } from '../context';
import type { OrgChoice } from '../host';
import {
  backupFolder,
  backupJobs,
  canPickFolder,
  folderAccess,
  encryptJob,
  folderSink,
  forgetJobKey,
  isLocked,
  jobSink,
  lastRuns,
  pickBackupFolder,
  runJob,
  useBackupRun,
  type JobRecord,
} from '../backups';
import { askConfirm } from '../components/Dialogs';
import { Status } from '../statusLog';

const SCOPES: Array<{ id: BackupScope; label: string }> = [
  { id: 'picked', label: 'Objects I pick' },
  { id: 'custom', label: 'All custom objects' },
  { id: 'standard', label: 'All standard objects' },
  { id: 'all', label: 'All objects' },
];
/** Compound and file-body fields: the bulk API cannot return them. */
const NOT_IN_BULK = new Set(['address', 'location', 'base64']);
type Tab = 'what' | 'when' | 'runs';
const filesOf = (job: { files?: FilesChoice }): FilesChoice =>
  job.files ?? { files: false, attachments: false, maxMB: 25 };
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const inScope = (scope: BackupScope, o: DataObject): boolean =>
  scope === 'all' || (scope === 'custom' ? o.custom : scope === 'standard' ? !o.custom : false);

const fieldsSummary = (choice?: FieldChoice): string =>
  !choice || choice.mode === 'all'
    ? 'all fields'
    : choice.mode === 'only'
    ? `${choice.fields.length} field${choice.fields.length === 1 ? '' : 's'}`
    : `all but ${choice.fields.length}`;

const fresh = (org: string): JobRecord => ({ ...newBackupJob(org, 'Backup'), created: new Date().toISOString() });

/**
 * Data backups: which objects (picked, or all custom / standard), which records (a condition
 * per object), which fields (all, only, all except); where they go (a folder on this
 * computer, or a zip); when (now, daily, weekly). Runs are listed with what they hold.
 */
export function BackupPage({
  orgs,
  clientFor,
  onOpenMigrate,
}: {
  orgs: OrgChoice[];
  clientFor: (org: string) => Promise<SalesforceClient>;
  /** Opens Migrate with a backup run as the source (set in storage first). */
  onOpenMigrate?: () => void;
}) {
  const studio = useStudio();
  const [jobs, setJobs] = useState<JobRecord[]>(() => backupJobs.list());
  const [draft, setDraft] = useState<JobRecord>(() => jobs[0] ?? fresh(studio.org.id));
  const [saved, setSaved] = useState(() => JSON.stringify(jobs[0] ?? null));
  const [candidates, setCandidates] = useState<DataObject[] | null>(null);
  const [open, setOpen] = useState('');
  const [fields, setFields] = useState<Record<string, DataField[]>>({});
  const [fieldFilter, setFieldFilter] = useState('');
  const [counts, setCounts] = useState<Map<string, number | string>>(new Map());
  const [folder, setFolder] = useState<{ name: string; access: 'granted' | 'prompt' | 'none' }>({
    name: '',
    access: 'none',
  });
  const [index, setIndex] = useState<BackupIndex>();
  const [manifest, setManifest] = useState<BackupManifest>();
  const [preview, setPreview] = useState<{ title: string; columns: string[]; rows: Array<Record<string, string>> }>();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [encrypting, setEncrypting] = useState({ open: false, pass: '', repeat: '', remember: true });
  const [tab, setTabState] = useState<Tab>(() => storage.get<Tab>('backup.tab', 'what'));
  const setTab = (t: Tab) => {
    setTabState(t);
    storage.set('backup.tab', t);
  };
  const run = useBackupRun();
  const running = run && run.jobId === draft.id && !run.done && !run.error ? run : null;
  const dirty = JSON.stringify(draft) !== saved;
  const last = lastRuns()[draft.id];

  // The objects of the job's org
  useEffect(() => {
    setCandidates(null);
    setCounts(new Map());
    let canceled = false;
    void (async () => {
      try {
        const client = await clientFor(draft.org);
        const list = await client.rest<{ sobjects: DataObject[] }>('GET', '/sobjects');
        if (!canceled) setCandidates(backupCandidates(list.sobjects));
      } catch (e) {
        if (!canceled) setStatus(`❌ ${(e as Error).message}`);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [draft.org, clientFor]);

  // The job's folder and the runs in it
  const loadFolder = async (ask = false) => {
    const handle = await backupFolder(draft.id);
    const access = await folderAccess(draft.id, ask);
    setFolder({ name: handle?.name ?? '', access });
    // The list of runs is never encrypted
    setIndex(access === 'granted' && handle ? await readIndex(folderSink(handle), draft) : undefined);
    setLocked(await isLocked(draft));
  };
  useEffect(() => {
    setManifest(undefined);
    setPreview(undefined);
    void loadFolder();
  }, [draft.id]);
  // A run of this job finished: show the new run
  useEffect(() => {
    if (run?.jobId === draft.id && run.done) {
      setJobs(backupJobs.list());
      void loadFolder();
    }
  }, [run?.done]);

  const included = useMemo(
    () => (candidates ? new Set(resolveObjects(draft, candidates).map((o) => o.name)) : new Set<string>()),
    [draft, candidates]
  );
  const settingsOf = (name: string): BackupObject => draft.objects.find((o) => o.name === name) ?? { name };
  const update = (patch: Partial<JobRecord>) => setDraft((d) => ({ ...d, ...patch }));
  const setSettings = (name: string, patch: Partial<BackupObject>) =>
    setDraft((d) => {
      const others = d.objects.filter((o) => o.name !== name);
      const next = { ...(d.objects.find((o) => o.name === name) ?? { name }), ...patch };
      return { ...d, objects: [...others, next].sort((a, b) => a.name.localeCompare(b.name)) };
    });
  const toggle = (o: DataObject, on: boolean) => {
    if (draft.scope === 'picked') {
      if (on) setSettings(o.name, {});
      else update({ objects: draft.objects.filter((x) => x.name !== o.name) });
    } else {
      update({ exclude: on ? draft.exclude.filter((x) => x !== o.name) : [...draft.exclude, o.name] });
    }
  };

  const openSettings = async (name: string) => {
    setOpen(open === name ? '' : name);
    setFieldFilter('');
    if (fields[name]) return;
    try {
      const list = await describeData(await clientFor(draft.org), name);
      setFields((f) => ({ ...f, [name]: list }));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const save = (): JobRecord => {
    const job = { ...draft, name: draft.name.trim() || 'Backup' };
    if (job.schedule.every !== 'off') nextRun(job.schedule, new Date()); // checks the time
    backupJobs.save(job);
    setJobs(backupJobs.list());
    setDraft(job);
    setSaved(JSON.stringify(job));
    return job;
  };

  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(true);
    setStatus(what);
    try {
      await fn();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const chooseFolder = () =>
    act('', async () => {
      const name = await pickBackupFolder(draft.id);
      setStatus(`✓ Backups of "${draft.name}" go to the folder ${name}.`);
      await loadFolder();
    });

  const runNow = (zip = false) =>
    act(zip ? 'Backing up for the zip…' : 'Backing up…', async () => {
      const job = save();
      if (!zip && (await folderAccess(job.id, true)) !== 'granted')
        throw new Error('Choose a folder and allow NomadSF to write to it.');
      const result = await runJob(job, await clientFor(job.org), { zip });
      const failed = result.objects.filter((o) => o.error).length;
      setStatus(
        `${failed ? '⚠' : '✓'} ${result.kind === 'full' ? 'Full' : 'Incremental'} backup: ${result.objects.reduce(
          (n, o) => n + o.rows,
          0
        )} records from ${result.objects.length} objects${failed ? `, ${failed} failed (see below)` : ''}.${
          zip ? ' Zip downloaded.' : ''
        }`
      );
      setManifest(result);
      setTab('runs');
      studio.logActivity('backup', { job: job.name, kind: result.kind, objects: result.objects.length, failed, zip });
    });

  const estimate = () =>
    act('Counting records…', async () => {
      const objects = resolveObjects(draft, candidates ?? []);
      const result = await estimateBackup(await clientFor(draft.org), objects, (d, t) =>
        setStatus(`Counting records… ${d}/${t}`)
      );
      setCounts(result);
      const total = [...result.values()].reduce<number>((n, v) => n + (typeof v === 'number' ? v : 0), 0);
      setStatus(
        `${total.toLocaleString()} records in ${objects.length} objects (before conditions on incremental runs).`
      );
    });

  const openRun = (folderName: string) =>
    act('', async () => {
      const handle = await backupFolder(draft.id);
      if (!handle) return;
      setPreview(undefined);
      setManifest(await readManifest(await jobSink(draft), `${jobFolder(draft)}/${folderName}`));
      setStatus('');
    });

  const previewFile = (object: string, file: string) =>
    act('', async () => {
      const handle = await backupFolder(draft.id);
      if (!handle || !manifest) return;
      const run = index?.runs.find((r) => r.finishedAt === manifest.finishedAt)?.folder;
      const text = await (await jobSink(draft)).read(`${jobFolder(draft)}/${run ?? ''}/${file}`);
      if (text === undefined) throw new Error('File not found in the folder.');
      const table = parseCsv(text);
      setPreview({ title: `${object} · ${file}`, columns: table.columns, rows: table.rows.slice(0, 500) });
      setStatus(table.rows.length > 500 ? `Showing 500 of ${table.rows.length} rows.` : '');
    });

  /** Objects chosen by typed names or by the AI: the job becomes "Objects I pick". */
  const applyPicks = (picks: ObjectPick[], replace: boolean) =>
    setDraft((d) => {
      const clean = picks.map(({ relatedOnly: _related, ...o }) => o);
      const merged = replace ? clean : [...d.objects.filter((o) => !clean.some((p) => p.name === o.name)), ...clean];
      return { ...d, scope: 'picked', exclude: [], objects: merged.sort((a, b) => a.name.localeCompare(b.name)) };
    });

  const switchJob = async (job: JobRecord) => {
    if (dirty && !(await askConfirm('Discard unsaved changes to this backup?', { ok: 'Discard' }))) return;
    setDraft(job);
    setSaved(JSON.stringify(job));
    setOpen('');
    setStatus('');
  };

  const next =
    draft.schedule.every !== 'off'
      ? (() => {
          try {
            return nextRun(draft.schedule, last ? new Date(last.at) : new Date());
          } catch {
            return undefined;
          }
        })()
      : undefined;
  const kind = nextKind(draft, index);
  const runOfManifest = manifest ? index?.runs.find((r) => r.finishedAt === manifest.finishedAt)?.folder : undefined;

  const isRunning = Boolean(run && !run.done && !run.error);
  const progress = running && running.total ? Math.round(((running.index + 0.5) / running.total) * 100) : 0;
  const objectRows: PickerObject[] = candidates ?? [];

  return (
    <div className="page data-page">
      <div className="toolbar">
        <h2>Backup</h2>
        <span className="muted">Data backups to a folder on this computer, now or on a schedule</span>
      </div>
      <div className="backup-layout">
        <aside className="card backup-jobs">
          <div className="jobs-head">
            <b>Backups</b>
            <button className="primary" onClick={() => switchJob(fresh(studio.org.id))}>
              + New
            </button>
          </div>
          <ul>
            {jobs.map((j) => {
              const l = lastRuns()[j.id];
              return (
                <li key={j.id}>
                  <button className={j.id === draft.id ? 'active' : ''} onClick={() => switchJob(j)}>
                    <span className="job-name">
                      <span className={`dot ${!l ? '' : l.ok ? 'good' : 'bad'}`} />
                      {j.name}
                    </span>
                    <span className="muted">{orgs.find((o) => o.id === j.org)?.label ?? j.org}</span>
                    <span className="muted">
                      {describeSchedule(j.schedule)}
                      {l ? ` · last ${new Date(l.at).toLocaleDateString()}` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {!jobs.length && <p className="muted">No backups yet. Start with + New.</p>}
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
                <select value={draft.org} onChange={(e) => update({ org: e.target.value, objects: [], exclude: [] })}>
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
              <button disabled={!dirty} onClick={() => void act('', async () => (save(), setStatus('✓ Saved.')))}>
                {dirty ? 'Save' : 'Saved'}
              </button>
              {jobs.some((j) => j.id === draft.id) && (
                <button
                  className="danger"
                  onClick={async () => {
                    if (
                      !(await askConfirm(`Delete the backup job "${draft.name}"? Backups already in the folder stay.`, {
                        ok: 'Delete',
                        danger: true,
                      }))
                    )
                      return;
                    backupJobs.remove(draft.id);
                    const rest = backupJobs.list();
                    setJobs(rest);
                    const nextJob = rest[0] ?? fresh(studio.org.id);
                    setDraft(nextJob);
                    setSaved(JSON.stringify(rest[0] ?? null));
                  }}
                >
                  Delete
                </button>
              )}
            </div>
            <div className="job-summary">
              <span className="chip">
                {included.size} object{included.size === 1 ? '' : 's'}
              </span>
              <span className="chip">{describeSchedule(draft.schedule)}</span>
              {next && <span className="chip">next {next.toLocaleString()}</span>}
              <span className="chip">next run: {kind}</span>
              <span className={`chip ${folder.name ? '' : 'warn'}`}>folder: {folder.name || 'not chosen'}</span>
              {(draft.files?.files || draft.files?.attachments) && (
                <span className="chip">
                  {[draft.files.files && 'files', draft.files.attachments && 'attachments'].filter(Boolean).join(' + ')}{' '}
                  ≤ {draft.files.maxMB} MB
                </span>
              )}
              {draft.encryption && (
                <span className={`chip ${locked ? 'warn' : 'good'}`}>🔒 {locked ? 'locked' : 'encrypted'}</span>
              )}
              {last && (
                <span className={`chip ${last.ok ? 'good' : 'bad'}`}>
                  last: {last.ok ? '✓' : '❌'} {new Date(last.at).toLocaleString()}
                </span>
              )}
              <span className="grow" />
              <span className="job-actions">
                <button disabled={busy || isRunning || !included.size} onClick={() => void runNow(true)}>
                  Download as zip
                </button>
                <button
                  className="primary"
                  disabled={busy || isRunning || !included.size || !folder.name}
                  title={folder.name ? '' : 'Choose a folder under Schedule & folder'}
                  onClick={() => void runNow(false)}
                >
                  Back up now
                </button>
              </span>
            </div>
            {running && (
              <div className="run-progress">
                <div className="progress">
                  <span style={{ width: `${progress}%` }} />
                </div>
                <span className="muted">
                  {running.scheduled ? 'Scheduled backup' : 'Backing up'} · {running.object || '…'} ({running.index + 1}
                  /{running.total || '?'}) · {running.state} · {running.rows.toLocaleString()} rows
                </span>
              </div>
            )}
            {draft.encryption && locked && (
              <UnlockBackup
                job={draft}
                onUnlocked={() => {
                  setLocked(false);
                  setStatus('✓ Unlocked.');
                  void loadFolder();
                }}
              />
            )}
            {status && <Status text={status} block />}
            {last && !last.ok && last.message && <p className="bad status-line">Last run failed: {last.message}</p>}
          </div>

          <div className="tabs page-tabs">
            {(
              [
                ['what', 'What to back up'],
                ['when', 'Settings'],
                ['runs', `Backups & restore${index?.runs.length ? ` (${index.runs.length})` : ''}`],
              ] as Array<[Tab, string]>
            ).map(([id, label]) => (
              <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'what' && (
            <div className="card section">
              <div className="segmented">
                {SCOPES.map((sc) => (
                  <button
                    key={sc.id}
                    className={draft.scope === sc.id ? 'active' : ''}
                    onClick={() => update({ scope: sc.id, exclude: [] })}
                  >
                    {sc.label}
                  </button>
                ))}
              </div>
              <p className="muted help">
                {draft.scope === 'picked'
                  ? 'Tick objects, type their names, or describe what you need.'
                  : 'New objects of this kind join automatically; untick any to leave out.'}{' '}
                Each object can have a condition (which records) and a field choice (which fields). Sharing rows,
                history, feeds, events and custom metadata are not listed.
              </p>
              <ObjectPicker
                objects={objectRows}
                purpose="backup"
                chosenCount={included.size}
                isChosen={(name) => included.has(name)}
                disabledReason={(o) =>
                  draft.scope !== 'picked' && !inScope(draft.scope, o as DataObject)
                    ? 'Not part of this choice'
                    : undefined
                }
                onToggle={(name, on) => {
                  const o = objectRows.find((x) => x.name === name);
                  if (o) toggle(o as DataObject, on);
                }}
                onApply={applyPicks}
                toolbar={
                  <button disabled={busy || !included.size} onClick={() => void estimate()}>
                    Count records
                  </button>
                }
                renderTags={(o) => {
                  if (!included.has(o.name)) return null;
                  const settings = settingsOf(o.name);
                  const count = counts.get(o.name);
                  return (
                    <>
                      {settings.where && (
                        <span className="backup-tag" title={settings.where}>
                          where
                        </span>
                      )}
                      <span className="backup-tag">{fieldsSummary(settings.fields)}</span>
                      {count !== undefined && (
                        <span className={`backup-tag ${typeof count === 'number' ? '' : 'bad'}`} title={String(count)}>
                          {typeof count === 'number' ? `${count.toLocaleString()} rec.` : 'error'}
                        </span>
                      )}
                    </>
                  );
                }}
                renderActions={(o) =>
                  included.has(o.name) && (
                    <button className="link" onClick={() => void openSettings(o.name)}>
                      {open === o.name ? 'Close' : 'Settings'}
                    </button>
                  )
                }
                renderSettings={(o) =>
                  included.has(o.name) &&
                  open === o.name && (
                    <ObjectSettings
                      settings={settingsOf(o.name)}
                      fields={fields[o.name]}
                      filter={fieldFilter}
                      onFilter={setFieldFilter}
                      onChange={(patch) => setSettings(o.name, patch)}
                    />
                  )
                }
              />
            </div>
          )}

          {tab === 'when' && (
            <div className="card section settings-grid">
              <div className="setting">
                <h4>Kind of backup</h4>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.incremental}
                    onChange={(e) => update({ incremental: e.target.checked })}
                  />{' '}
                  Incremental after the first full backup
                </label>
                {draft.incremental && (
                  <label className="check">
                    Full backup again every{' '}
                    <input
                      type="number"
                      min={0}
                      style={{ width: 64 }}
                      value={draft.fullEveryDays}
                      onChange={(e) => update({ fullEveryDays: Math.max(0, Number(e.target.value) || 0) })}
                    />{' '}
                    days (0 = never)
                  </label>
                )}
                <p className="muted">
                  Incremental runs take only records changed since the last run, plus the Ids deleted since.
                </p>
              </div>
              <div className="setting">
                <h4>Schedule</h4>
                <ScheduleEditor schedule={draft.schedule} onChange={(schedule) => update({ schedule })} />
                <p className="muted">
                  {draft.schedule.every === 'off'
                    ? 'Runs only when you press Back up now.'
                    : 'Scheduled backups run while NomadSF is open in Chrome; a missed one runs once when you open it, and the extension icon shows a badge when one is due.'}
                </p>
              </div>
              <div className="setting">
                <h4>Folder</h4>
                <div className="form">
                  <b>{folder.name || 'No folder yet'}</b>
                  <button disabled={!canPickFolder() || busy} onClick={() => void chooseFolder()}>
                    {folder.name ? 'Change folder…' : 'Choose folder…'}
                  </button>
                  {folder.name && folder.access !== 'granted' && (
                    <button onClick={() => void act('', () => loadFolder(true))}>Allow writing</button>
                  )}
                </div>
                <p className="muted">
                  A folder on this computer (Chrome asks once to allow writing). Each run becomes a folder with one CSV
                  folder per object and a manifest.
                </p>
              </div>
              <div className="setting">
                <h4>Files and attachments</h4>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={Boolean(draft.files?.files)}
                    onChange={(e) => update({ files: { ...filesOf(draft), files: e.target.checked } })}
                  />{' '}
                  Salesforce Files of the records
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={Boolean(draft.files?.attachments)}
                    onChange={(e) => update({ files: { ...filesOf(draft), attachments: e.target.checked } })}
                  />{' '}
                  Attachments of the records
                </label>
                <label className="check">
                  Up to{' '}
                  <input
                    type="number"
                    min={1}
                    max={2000}
                    style={{ width: 70 }}
                    value={filesOf(draft).maxMB}
                    onChange={(e) =>
                      update({ files: { ...filesOf(draft), maxMB: Math.max(1, Number(e.target.value) || 1) } })
                    }
                  />{' '}
                  MB per file
                </label>
                <p className="muted">
                  The latest version of each file linked to the backed-up records (and who it is shared with) is saved
                  in the run's _files folder; larger ones are listed as skipped. Incremental runs add files changed
                  since.
                </p>
              </div>
              <div className="setting">
                <h4>Encryption</h4>
                {draft.encryption ? (
                  <>
                    <p>
                      🔒 Encrypted with a passphrase (AES-256-GCM).{' '}
                      {locked ? 'Locked: unlock it in the header.' : 'Unlocked.'}
                    </p>
                    {!locked && (
                      <button
                        onClick={() =>
                          void act('', async () => {
                            await forgetJobKey(draft.id);
                            setLocked(true);
                            setStatus(
                              'The key is no longer kept on this computer; scheduled runs wait until you unlock.'
                            );
                          })
                        }
                      >
                        Forget the key on this computer
                      </button>
                    )}
                    <p className="muted">
                      The passphrase cannot be changed or removed: without it these backups cannot be read, not even by
                      NomadSF. For another passphrase, start a new backup job.
                    </p>
                  </>
                ) : (
                  <>
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={encrypting.open}
                        onChange={(e) => setEncrypting({ ...encrypting, open: e.target.checked })}
                      />{' '}
                      Encrypt this backup
                    </label>
                    {encrypting.open && (
                      <div className="encrypt-form">
                        <input
                          type="password"
                          autoComplete="new-password"
                          placeholder="Passphrase (at least 8 characters)"
                          value={encrypting.pass}
                          onChange={(e) => setEncrypting({ ...encrypting, pass: e.target.value })}
                        />
                        <input
                          type="password"
                          autoComplete="new-password"
                          placeholder="Repeat the passphrase"
                          value={encrypting.repeat}
                          onChange={(e) => setEncrypting({ ...encrypting, repeat: e.target.value })}
                        />
                        <label className="check">
                          <input
                            type="checkbox"
                            checked={encrypting.remember}
                            onChange={(e) => setEncrypting({ ...encrypting, remember: e.target.checked })}
                          />{' '}
                          Keep the key on this computer (needed for scheduled runs)
                        </label>
                        <button
                          className="primary"
                          disabled={encrypting.pass.length < 8 || encrypting.pass !== encrypting.repeat || busy}
                          onClick={() =>
                            void act('', async () => {
                              const job = await encryptJob(draft, encrypting.pass, encrypting.remember);
                              backupJobs.save(job);
                              setJobs(backupJobs.list());
                              setDraft(job);
                              setSaved(JSON.stringify(job));
                              setEncrypting({ open: false, pass: '', repeat: '', remember: true });
                              setLocked(false);
                              setStatus(
                                '✓ Encrypted from the next run on. Keep the passphrase safe: it cannot be recovered.'
                              );
                            })
                          }
                        >
                          Encrypt from the next run on
                        </button>
                        {encrypting.repeat && encrypting.pass !== encrypting.repeat && (
                          <span className="bad">The two passphrases differ.</span>
                        )}
                      </div>
                    )}
                    <p className="muted">
                      Every data file and file of the backup is encrypted in the browser before it is written; only the
                      list of runs stays readable. Without the passphrase nobody can read the data, not even NomadSF.
                    </p>
                  </>
                )}
              </div>
            </div>
          )}

          {tab === 'runs' && (
            <>
              {!index?.runs.length && !manifest && (
                <div className="card section">
                  <p className="muted">
                    {folder.name
                      ? 'No backups in the folder yet. Press Back up now.'
                      : 'Choose a folder under Schedule & folder.'}
                  </p>
                </div>
              )}
              {(index?.runs.length || manifest) && (
                <div className="card section">
                  <h3>Backups in the folder</h3>
                  {index && (
                    <DataTable
                      columns={['finishedAt', 'kind', 'rows', 'failed', 'folder']}
                      rows={[...index.runs].reverse()}
                      rowKey="folder"
                      name={`${draft.name}-runs`}
                      onRowClick={(r) => void openRun(String(r.folder))}
                      note={<span>· click a run to see what it holds and restore from it</span>}
                    />
                  )}
                  {manifest && (
                    <>
                      <h3>
                        {manifest.kind === 'full' ? 'Full' : 'Incremental'} backup of {manifest.org.name} ·{' '}
                        {new Date(manifest.finishedAt).toLocaleString()}
                        {manifest.since && (
                          <span className="muted"> · changes since {new Date(manifest.since).toLocaleString()}</span>
                        )}
                      </h3>
                      {(manifest.files || manifest.filesError) && (
                        <p className={manifest.filesError ? 'bad' : 'muted'}>
                          {manifest.files
                            ? `Files: ${manifest.files.versions} file(s), ${
                                manifest.files.attachments
                              } attachment(s), ${(manifest.files.bytes / (1024 * 1024)).toFixed(1)} MB${
                                manifest.files.skipped.length
                                  ? ` · ${manifest.files.skipped.length} skipped (too large)`
                                  : ''
                              }`
                            : ''}
                          {manifest.filesError ? `Files failed: ${manifest.filesError}` : ''}
                          {manifest.encrypted ? ' · 🔒 encrypted' : ''}
                        </p>
                      )}
                      <DataTable
                        columns={['name', 'rows', 'deleted', 'fields', 'files', 'error']}
                        rows={manifest.objects.map((o) => ({
                          ...o,
                          fields: o.fields.length,
                          files: o.files.length,
                          error: o.error ?? '',
                        }))}
                        rowKey="name"
                        name={`${draft.name}-objects`}
                        onRowClick={(r) => {
                          const o = manifest.objects.find((x) => x.name === r.name);
                          if (o?.files[0]) void previewFile(o.name, o.files[0]);
                        }}
                        note={<span>· click an object to see its records</span>}
                      />
                    </>
                  )}
                  {preview && (
                    <>
                      <h3>{preview.title}</h3>
                      <DataTable
                        columns={preview.columns}
                        rows={preview.rows}
                        rowKey="Id"
                        name={preview.title.replace(/\W+/g, '-')}
                      />
                    </>
                  )}
                </div>
              )}
              {manifest && runOfManifest && (
                <RestorePanel
                  job={draft}
                  run={runOfManifest}
                  manifest={manifest}
                  onCopyElsewhere={
                    onOpenMigrate &&
                    (() => {
                      storage.set('migrate.from', { jobId: draft.id, folder: runOfManifest });
                      onOpenMigrate();
                    })
                  }
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function ObjectSettings({
  settings,
  fields,
  filter,
  onFilter,
  onChange,
  noCondition = false,
}: {
  settings: BackupObject;
  fields?: DataField[];
  filter: string;
  onFilter: (v: string) => void;
  onChange: (patch: Partial<BackupObject>) => void;
  /** Rows from a backup: no SOQL condition. */
  noCondition?: boolean;
}) {
  const choice = settings.fields ?? { mode: 'all' as const };
  const listed = choice.mode === 'all' ? [] : choice.fields;
  const setMode = (mode: FieldChoice['mode']) =>
    onChange({ fields: mode === 'all' ? { mode } : { mode, fields: choice.mode === 'all' ? [] : choice.fields } });
  const tick = (name: string, on: boolean) => {
    if (choice.mode === 'all') return;
    onChange({ fields: { mode: choice.mode, fields: on ? [...listed, name] : listed.filter((f) => f !== name) } });
  };
  const shown = (fields ?? []).filter((f) => `${f.label} ${f.name}`.toLowerCase().includes(filter.toLowerCase()));
  const [names, setNames] = useState<'label' | 'name' | 'both'>(() => storage.get('fields.names', 'label'));
  const showNames = (v: typeof names) => {
    setNames(v);
    storage.set('fields.names', v);
  };
  return (
    <div className="backup-settings">
      {!noCondition && (
        <label>
          Which records (SOQL condition, empty = all)
          <input
            className="mono"
            placeholder="e.g. CreatedDate = LAST_N_YEARS:2 AND Status__c != 'Draft'"
            value={settings.where ?? ''}
            onChange={(e) => onChange({ where: e.target.value })}
          />
        </label>
      )}
      <div className="form">
        <span className="muted">Fields:</span>
        {(['all', 'only', 'except'] as const).map((m) => (
          <label key={m} className="check">
            <input type="radio" checked={choice.mode === m} onChange={() => setMode(m)} />{' '}
            {m === 'all' ? 'All fields' : m === 'only' ? 'Only these' : 'All except these'}
          </label>
        ))}
      </div>
      {choice.mode !== 'all' && (
        <>
          <div className="form">
            <input
              placeholder={`Filter ${fields?.length ?? ''} fields`}
              value={filter}
              onChange={(e) => onFilter(e.target.value)}
            />
            <select value={names} onChange={(e) => showNames(e.target.value as typeof names)} title="Show fields by">
              <option value="label">Labels</option>
              <option value="name">API names</option>
              <option value="both">Labels and API names</option>
            </select>
            <span className="muted">
              {listed.length} ticked · Id and SystemModstamp are always kept; address and file-body fields cannot be
              backed up by the bulk API
            </span>
          </div>
          {!fields && <p className="muted">Loading fields…</p>}
          <div className={`field-checks ${names === 'both' ? 'two-lines' : ''}`}>
            {shown.map((f) => (
              <label
                key={f.name}
                className="check"
                title={
                  NOT_IN_BULK.has(f.type)
                    ? `${f.label} (${f.name}): ${f.type} fields cannot be backed up by the bulk API`
                    : `${f.label} · ${f.name} · ${f.type}`
                }
              >
                <input
                  type="checkbox"
                  disabled={NOT_IN_BULK.has(f.type)}
                  checked={listed.includes(f.name)}
                  onChange={(e) => tick(f.name, e.target.checked)}
                />{' '}
                <span className="field-check-text">
                  {names === 'name' ? <span className="mono">{f.name}</span> : <span>{f.label}</span>}
                  {names === 'both' && <span className="muted mono">{f.name}</span>}
                </span>
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: BackupSchedule;
  onChange: (s: BackupSchedule) => void;
}) {
  const time = schedule.every === 'off' ? '02:00' : schedule.time;
  const weekday = schedule.every === 'weekly' ? schedule.weekday : 1;
  const count = schedule.every === 'interval' ? schedule.count : 1;
  const unit = schedule.every === 'interval' ? schedule.unit : 'days';
  return (
    <div className="form">
      <label>
        Repeat
        <select
          value={schedule.every}
          onChange={(e) => {
            const every = e.target.value as BackupSchedule['every'];
            onChange(
              every === 'off'
                ? { every }
                : every === 'daily'
                ? { every, time }
                : every === 'weekly'
                ? { every, time, weekday }
                : { every, time, count, unit }
            );
          }}
        >
          <option value="off">Off (only when I run it)</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="interval">Every…</option>
        </select>
      </label>
      {schedule.every === 'interval' && (
        <>
          <label>
            every
            <input
              type="number"
              min={1}
              max={999}
              style={{ width: 80 }}
              value={count}
              onChange={(e) =>
                onChange({ ...schedule, count: Math.max(1, Math.min(999, Math.floor(Number(e.target.value) || 1))) })
              }
            />
          </label>
          <label>
            unit
            <select value={unit} onChange={(e) => onChange({ ...schedule, unit: e.target.value as ScheduleUnit })}>
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
              <option value="months">months</option>
            </select>
          </label>
        </>
      )}
      {schedule.every === 'weekly' && (
        <label>
          on
          <select
            value={weekday}
            onChange={(e) => onChange({ every: 'weekly', time, weekday: Number(e.target.value) })}
          >
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
        </label>
      )}
      {schedule.every !== 'off' && !(schedule.every === 'interval' && schedule.unit === 'hours') && (
        <label>
          at
          <input
            type="time"
            value={time}
            onChange={(e) => onChange({ ...schedule, time: e.target.value || '02:00' } as BackupSchedule)}
          />
        </label>
      )}
      {schedule.every === 'interval' && schedule.unit === 'hours' && (
        <span className="muted">counted from the last run</span>
      )}
    </div>
  );
}
