import { useEffect, useState } from 'react';
import { Select } from '../components/Select';
import { abortJob, asyncJobs, backgroundJobs, scheduledJobs, type Row } from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { Status } from '../statusLog';
import { openExternal } from '../embed';
import type { OrgChoice } from '../host';

/** Setup › Background Jobs of the org (its menu path: Environments › Jobs › Background Jobs). */
function setupUrl(org: OrgChoice): string | undefined {
  const host = org.instanceUrl ?? (/\.(salesforce|force)\.com$/.test(org.id) ? `https://${org.id}` : undefined);
  return host ? `${host.replace(/\/$/, '')}/lightning/setup/ParallelJobsStatus/home` : undefined;
}

type Tab = 'scheduled' | 'apex' | 'background';

const COLUMNS: Record<Tab, string[]> = {
  scheduled: ['Name', 'Type', 'State', 'NextRun', 'LastRun', 'Cron', 'Runs', 'By'],
  apex: ['Type', 'Class', 'Status', 'Progress', 'Errors', 'Detail', 'Started', 'Finished', 'By'],
  background: ['Name', 'Type', 'Status', 'Submitted', 'Started', 'Finished', 'Error', 'Retries', 'Waiting', 'By'],
};

/**
 * Scheduled jobs (CronTrigger), Apex jobs (batch, queueable, future) with Stop, and Salesforce's background jobs
 * (BackgroundOperation: sharing recalculations, index builds…), as Setup shows them.
 */
export function JobsPage() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [tab, setTab] = useState<Tab>(() => {
    // 'background' used to be the Apex jobs
    const saved = storage.get<string>(
      'jobs.tab2',
      storage.get<string>('jobs.tab', 'scheduled') === 'background' ? 'apex' : 'scheduled'
    );
    return (Object.keys(COLUMNS).includes(saved) ? saved : 'scheduled') as Tab;
  });
  const [days, setDays] = useState(7);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');

  const load = async (t = tab, d = days) => {
    setRows(null);
    setSelected(new Set());
    setStatus('Reading jobs…');
    try {
      setRows(
        t === 'scheduled'
          ? await scheduledJobs(client)
          : t === 'apex'
          ? await asyncJobs(client, d)
          : await backgroundJobs(client, d)
      );
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
        <span className="muted">Scheduled, Apex and background jobs on {org.label}</span>
        <span className="grow" />
        <button onClick={() => void load()}>Refresh</button>
      </div>
      <div className="tabs">
        {(
          [
            ['scheduled', 'Scheduled'],
            ['apex', 'Apex jobs'],
            ['background', 'Background jobs'],
          ] as Array<[Tab, string]>
        ).map(([id, text]) => (
          <button
            key={id}
            className={`tab ${tab === id ? 'active' : ''}`}
            onClick={() => {
              setTab(id);
              storage.set('jobs.tab2', id);
            }}
          >
            {text}
          </button>
        ))}
      </div>
      <div className="form">
        {tab !== 'scheduled' && (
          <label>
            Last
            <Select
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
            </Select>
          </label>
        )}
        {tab !== 'background' && (
          <button className="danger" disabled={selected.size === 0} onClick={() => void stop()}>
            Stop {selected.size || ''} selected…
          </button>
        )}
        <Status text={status} />
      </div>
      {tab === 'background' && (
        <div className="note">
          Setup › Background Jobs also lists Salesforce's own jobs (Chatter digests, status updates, sharing
          recalculations…) that the API does not let any tool read; this tab shows the ones it can.{' '}
          {setupUrl(org) ? (
            <button onClick={() => openExternal(setupUrl(org)!)}>Open Setup › Background Jobs ↗</button>
          ) : (
            <span className="muted">In Setup: Environments › Jobs › Background Jobs.</span>
          )}
        </div>
      )}
      {rows &&
        (rows.length === 0 ? (
          <EmptyHint what="jobs" />
        ) : (
          <DataTable
            columns={COLUMNS[tab]}
            rows={rows}
            rowKey="Id"
            name={`${org.label}-${tab}-jobs`}
            selected={tab === 'background' ? undefined : selected}
            onSelectedChange={
              tab === 'background'
                ? undefined
                : (next) =>
                    setSelected(new Set([...next].filter((id) => running(rows.find((r) => String(r.Id) === id) ?? {}))))
            }
            note={
              <span>
                ·{' '}
                {tab === 'scheduled'
                  ? 'tick jobs to stop them (they no longer run)'
                  : tab === 'apex'
                  ? 'tick queued or running jobs to stop them'
                  : "Salesforce's own work (sharing recalculations, index builds, cleanups); it cannot be stopped here"}
              </span>
            }
          />
        ))}
    </div>
  );
}
