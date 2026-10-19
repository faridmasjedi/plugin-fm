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
  type DataField,
  type DataObject,
  type FieldChoice,
  type SalesforceClient,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { RestorePanel } from '../components/RestorePanel';
import { storage, useStudio } from '../context';
import type { OrgChoice } from '../host';
import {
  backupFolder,
  backupJobs,
  canPickFolder,
  folderAccess,
  folderSink,
  lastRuns,
  pickBackupFolder,
  runJob,
  useBackupRun,
  type JobRecord,
} from '../backups';

const SCOPES: Array<{ id: BackupScope; label: string }> = [
  { id: 'picked', label: 'Objects I pick' },
  { id: 'custom', label: 'All custom objects' },
  { id: 'standard', label: 'All standard objects' },
  { id: 'all', label: 'All objects' },
];
/** Compound and file-body fields: the bulk API cannot return them. */
const NOT_IN_BULK = new Set(['address', 'location', 'base64']);
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
  const [filter, setFilter] = useState('');
  const [onlyIncluded, setOnlyIncluded] = useState(false);
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
    setIndex(access === 'granted' && handle ? await readIndex(folderSink(handle), draft) : undefined);
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
      setManifest(await readManifest(folderSink(handle), `${jobFolder(draft)}/${folderName}`));
      setStatus('');
    });

  const previewFile = (object: string, file: string) =>
    act('', async () => {
      const handle = await backupFolder(draft.id);
      if (!handle || !manifest) return;
      const run = index?.runs.find((r) => r.finishedAt === manifest.finishedAt)?.folder;
      const text = await folderSink(handle).read(`${jobFolder(draft)}/${run ?? ''}/${file}`);
      if (text === undefined) throw new Error('File not found in the folder.');
      const table = parseCsv(text);
      setPreview({ title: `${object} · ${file}`, columns: table.columns, rows: table.rows.slice(0, 500) });
      setStatus(table.rows.length > 500 ? `Showing 500 of ${table.rows.length} rows.` : '');
    });

  const switchJob = (job: JobRecord) => {
    if (dirty && !confirm('Discard unsaved changes to this backup?')) return;
    setDraft(job);
    setSaved(JSON.stringify(job));
    setOpen('');
    setStatus('');
  };

  const shown = (candidates ?? []).filter(
    (o) =>
      (!onlyIncluded || included.has(o.name)) && `${o.label} ${o.name}`.toLowerCase().includes(filter.toLowerCase())
  );
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

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Backup</h2>
        <span className="muted">Data backups to a folder on this computer, now or on a schedule</span>
      </div>
      <div className="backup-layout">
        <div className="card backup-jobs">
          <button className="primary" onClick={() => switchJob(fresh(studio.org.id))}>
            New backup
          </button>
          <ul>
            {jobs.map((j) => {
              const l = lastRuns()[j.id];
              return (
                <li key={j.id}>
                  <button className={j.id === draft.id ? 'active' : ''} onClick={() => switchJob(j)}>
                    <b>{j.name}</b>
                    <span className="muted">
                      {orgs.find((o) => o.id === j.org)?.label ?? j.org} · {describeSchedule(j.schedule)}
                    </span>
                    {l && (
                      <span className={l.ok ? 'good' : 'bad'}>
                        {l.ok ? '✓' : '❌'} {new Date(l.at).toLocaleString()}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {!jobs.length && <p className="muted">No backups yet.</p>}
        </div>

        <div className="backup-main">
          <div className="card section">
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
                Save
              </button>
              {jobs.some((j) => j.id === draft.id) && (
                <button
                  className="danger"
                  onClick={() => {
                    if (!confirm(`Delete the backup job "${draft.name}"? Backups already in the folder stay.`)) return;
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
          </div>

          <div className="card section">
            <h3>What to back up</h3>
            <div className="tabs">
              {SCOPES.map((s) => (
                <button
                  key={s.id}
                  className={`tab ${draft.scope === s.id ? 'active' : ''}`}
                  onClick={() => update({ scope: s.id, exclude: [] })}
                >
                  {s.label}
                </button>
              ))}
            </div>
            <p className="muted" style={{ margin: '6px 0' }}>
              {draft.scope === 'picked'
                ? 'Tick the objects to back up.'
                : 'New objects of this kind are included automatically; untick any to leave out.'}{' '}
              Each object can have a condition (which records) and a field choice (which fields). Sharing rows, history,
              feeds, events and custom metadata are not listed.
            </p>
            <div className="form">
              <input
                placeholder={`Filter ${candidates?.length ?? ''} objects`}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <label className="check">
                <input type="checkbox" checked={onlyIncluded} onChange={(e) => setOnlyIncluded(e.target.checked)} />{' '}
                Only included ({included.size})
              </label>
              <span className="grow" />
              <button disabled={busy || !included.size} onClick={() => void estimate()}>
                Count records
              </button>
            </div>
            {candidates === null && <p className="muted">Loading objects…</p>}
            <div className="backup-objects">
              {shown.map((o) => {
                const on = included.has(o.name);
                const settings = settingsOf(o.name);
                const count = counts.get(o.name);
                const disabled = draft.scope !== 'picked' && !inScope(draft.scope, o);
                return (
                  <div key={o.name} className={`backup-object ${on ? 'on' : ''}`}>
                    <div className="row">
                      <label className="check" title={disabled ? 'Not part of this choice' : o.name}>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={disabled}
                          onChange={(e) => toggle(o, e.target.checked)}
                        />{' '}
                        {o.label} {o.label !== o.name && <span className="muted mono">{o.name}</span>}
                      </label>
                      {o.custom && <span className="backup-tag">custom</span>}
                      <span className="grow" />
                      {on && settings.where && (
                        <span className="backup-tag" title={settings.where}>
                          where
                        </span>
                      )}
                      {on && <span className="muted">{fieldsSummary(settings.fields)}</span>}
                      {count !== undefined && (
                        <span className={typeof count === 'number' ? 'muted' : 'bad'} title={String(count)}>
                          {typeof count === 'number' ? `${count.toLocaleString()} rec.` : 'error'}
                        </span>
                      )}
                      {on && (
                        <button className="link" onClick={() => void openSettings(o.name)}>
                          {open === o.name ? 'Close' : 'Settings'}
                        </button>
                      )}
                    </div>
                    {on && open === o.name && (
                      <ObjectSettings
                        settings={settings}
                        fields={fields[o.name]}
                        filter={fieldFilter}
                        onFilter={setFieldFilter}
                        onChange={(patch) => setSettings(o.name, patch)}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="card section">
            <h3>When and where</h3>
            <div className="form">
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
            </div>
            <ScheduleEditor schedule={draft.schedule} onChange={(schedule) => update({ schedule })} />
            <p className="muted" style={{ margin: '6px 0' }}>
              {draft.schedule.every === 'off'
                ? 'Runs only when you press Back up now.'
                : `Next: ${
                    next ? next.toLocaleString() : '—'
                  }. Scheduled backups run while NomadSF is open in Chrome (the extension shows a badge when one is due); the folder must allow writing.`}{' '}
              Next run: <b>{kind}</b>.
            </p>
            <div className="form">
              <span>
                Folder: <b>{folder.name || 'none'}</b>
                {folder.name && folder.access !== 'granted' && <span className="muted"> (needs your OK once)</span>}
              </span>
              <button disabled={!canPickFolder() || busy} onClick={() => void chooseFolder()}>
                {folder.name ? 'Change folder…' : 'Choose folder…'}
              </button>
              {folder.name && folder.access !== 'granted' && (
                <button onClick={() => void act('', () => loadFolder(true))}>Allow writing</button>
              )}
              <span className="grow" />
              <button
                disabled={busy || Boolean(run && !run.done && !run.error) || !included.size}
                onClick={() => void runNow(true)}
              >
                Download as zip
              </button>
              <button
                className="primary"
                disabled={busy || Boolean(run && !run.done && !run.error) || !included.size || !folder.name}
                onClick={() => void runNow(false)}
              >
                Back up now
              </button>
            </div>
            {running && (
              <p className="muted">
                {running.scheduled ? 'Scheduled backup' : 'Backing up'} · {running.object || '…'} ({running.index + 1}/
                {running.total || '?'}) · {running.state} · {running.rows.toLocaleString()} rows
              </p>
            )}
            {status && <p className="muted">{status}</p>}
            {last && !last.ok && last.message && <p className="bad">Last run failed: {last.message}</p>}
          </div>

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
                  note={<span>· click a run to see what it holds</span>}
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
            <span className="muted">
              {listed.length} ticked · Id and SystemModstamp are always kept; address and file-body fields cannot be
              backed up by the bulk API
            </span>
          </div>
          {!fields && <p className="muted">Loading fields…</p>}
          <div className="field-checks">
            {shown.map((f) => (
              <label
                key={f.name}
                className="check"
                title={
                  NOT_IN_BULK.has(f.type)
                    ? `${f.type} fields cannot be backed up by the bulk API`
                    : `${f.name} · ${f.type}`
                }
              >
                <input
                  type="checkbox"
                  disabled={NOT_IN_BULK.has(f.type)}
                  checked={listed.includes(f.name)}
                  onChange={(e) => tick(f.name, e.target.checked)}
                />{' '}
                {f.label} {f.label !== f.name && <span className="muted mono">{f.name}</span>}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ScheduleEditor({ schedule, onChange }: { schedule: BackupSchedule; onChange: (s: BackupSchedule) => void }) {
  const time = schedule.every === 'off' ? '02:00' : schedule.time;
  const weekday = schedule.every === 'weekly' ? schedule.weekday : 1;
  return (
    <div className="form">
      <label>
        Schedule
        <select
          value={schedule.every}
          onChange={(e) => {
            const every = e.target.value as BackupSchedule['every'];
            onChange(every === 'off' ? { every } : every === 'daily' ? { every, time } : { every, time, weekday });
          }}
        >
          <option value="off">Off (only when I run it)</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>
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
      {schedule.every !== 'off' && (
        <label>
          at
          <input
            type="time"
            value={time}
            onChange={(e) => onChange({ ...schedule, time: e.target.value || '02:00' } as BackupSchedule)}
          />
        </label>
      )}
    </div>
  );
}
