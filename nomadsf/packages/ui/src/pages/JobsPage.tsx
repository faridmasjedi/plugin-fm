import { useEffect, useState } from 'react';
import { abortJob, asyncJobs, scheduledJobs, type Row } from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { storage, useStudio } from '../context';

type Tab = 'scheduled' | 'background';

/** Scheduled jobs (CronTrigger) and background Apex jobs (batch, queueable, future), with Stop. */
export function JobsPage() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [tab, setTab] = useState<Tab>(() => storage.get('jobs.tab', 'scheduled'));
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');

  const load = async (t = tab, d = days) => {
    setRows(null);
    setSelected(new Set());
    setStatus('Reading jobs…');
    try {
      setRows(t === 'scheduled' ? await scheduledJobs(client) : await asyncJobs(client, d));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, tab]);

  const stop = async () => {
    const ids = [...selected];
    const names = (rows ?? []).filter((r) => selected.has(String(r.Id))).map((r) => String(r.Name ?? r.Class));
    if (!(await confirmChange(`Stop ${ids.length} job(s) in ${org.label}: ${names.join(', ')}`))) return;
    let stopped = 0;
    const failed: string[] = [];
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await abortJob(client, id);
        stopped++;
      } catch (e) {
        failed.push((e as Error).message);
      }
    }
    logActivity('stop jobs', { stopped, failed: failed.length });
    setStatus(`✓ Stopped ${stopped}.${failed.length ? ` ❌ ${failed.join('; ')}` : ''}`);
    await load();
  };

  const running = (r: Row): boolean =>
    tab === 'scheduled'
      ? r.State !== 'DELETED'
      : ['Queued', 'Preparing', 'Processing', 'Holding'].includes(String(r.Status));

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Jobs</h2>
        <span className="muted">Scheduled and background jobs on {org.label}</span>
        <span className="grow" />
        <button onClick={() => void load()}>Refresh</button>
      </div>
      <div className="tabs">
        {(
          [
            ['scheduled', 'Scheduled'],
            ['background', 'Background Apex'],
          ] as Array<[Tab, string]>
        ).map(([id, text]) => (
          <button
            key={id}
            className={`tab ${tab === id ? 'active' : ''}`}
            onClick={() => {
              setTab(id);
              storage.set('jobs.tab', id);
            }}
          >
            {text}
          </button>
        ))}
      </div>
      <div className="form">
        {tab === 'background' && (
          <label>
            Last
            <select
              value={days}
              onChange={(e) => {
                setDays(Number(e.target.value));
                void load(tab, Number(e.target.value));
              }}
            >
              {[1, 7, 30, 90].map((d) => (
                <option key={d} value={d}>
                  {d} day(s)
                </option>
              ))}
            </select>
          </label>
        )}
        <button className="danger" disabled={selected.size === 0} onClick={() => void stop()}>
          Stop {selected.size || ''} selected…
        </button>
        <span className="muted">{status}</span>
      </div>
      {rows &&
        (rows.length === 0 ? (
          <EmptyHint what="jobs" />
        ) : (
          <DataTable
            columns={
              tab === 'scheduled'
                ? ['Name', 'Type', 'State', 'NextRun', 'LastRun', 'Cron', 'Runs', 'By']
                : ['Type', 'Class', 'Status', 'Progress', 'Errors', 'Detail', 'Started', 'Finished', 'By']
            }
            rows={rows}
            rowKey="Id"
            name={`${org.label}-${tab}-jobs`}
            selected={selected}
            onSelectedChange={(next) =>
              setSelected(new Set([...next].filter((id) => running(rows.find((r) => String(r.Id) === id) ?? {}))))
            }
            note={
              <span>
                ·{' '}
                {tab === 'scheduled'
                  ? 'tick jobs to stop them (they no longer run)'
                  : 'tick queued or running jobs to stop them'}
              </span>
            }
          />
        ))}
    </div>
  );
}
