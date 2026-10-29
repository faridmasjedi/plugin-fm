import { useCallback, useEffect, useState } from 'react';
import {
  activeTraceFlag,
  deleteLogs,
  disableTraceFlag,
  ensureTraceFlag,
  getLogBody,
  listLogs,
  type ApexLogSummary,
  type TraceFlag,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { LogViewer } from '../components/LogViewer';
import { storage, useStudio } from '../context';
import { askConfirm } from '../components/Dialogs';
import { Status } from '../statusLog';

const fmtTime = (iso: string): string =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

export function LogsPage() {
  const { client, user, confirmRisky } = useStudio();
  const [logs, setLogs] = useState<ApexLogSummary[]>([]);
  const [mine, setMine] = useState<boolean>(() => storage.get('logs.mine', true));
  const [auto, setAuto] = useState(false);
  const [flag, setFlag] = useState<TraceFlag | undefined>();
  const [selected, setSelected] = useState<string>('');
  const [body, setBody] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setError('');
      const [list, active] = await Promise.all([
        listLogs(client, { userId: mine ? user?.userId : undefined, limit: 200 }),
        user ? activeTraceFlag(client, user.userId) : Promise.resolve(undefined),
      ]);
      setLogs(list);
      setFlag(active);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client, mine, user]);

  useEffect(() => {
    void load();
    storage.set('logs.mine', mine);
  }, [load, mine]);
  useEffect(() => {
    if (!auto) return undefined;
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [auto, load]);

  const open = async (id: string) => {
    setSelected(id);
    setBody('');
    try {
      setBody(await getLogBody(client, id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const traceOn = async (minutes: number) => {
    if (!user || !(await confirmRisky(`Turn on debug logs for ${user.userName}`))) return;
    void act(() => ensureTraceFlag(client, user.userId, minutes));
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Debug logs</h2>
        <span className="grow" />
        <label className="check">
          <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only mine
        </label>
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-refresh
        </label>
        <button onClick={() => void load()}>Refresh</button>
        <button
          className="danger"
          disabled={busy || logs.length === 0}
          onClick={async () =>
            (await askConfirm(`Delete ${logs.length} log(s)?`, { ok: 'Delete', danger: true })) &&
            void act(() =>
              deleteLogs(
                client,
                logs.map((l) => l.Id)
              )
            )
          }
        >
          Delete listed
        </button>
      </div>

      <div className="card trace">
        {flag ? (
          <span>
            <span className="pill good">Logging on</span> for {user?.userFullName} until{' '}
            <b>{fmtTime(flag.ExpirationDate)}</b>
            {flag['DebugLevel.DeveloperName'] ? (
              <span className="muted"> · level {flag['DebugLevel.DeveloperName']}</span>
            ) : null}
          </span>
        ) : (
          <span>
            <span className="pill">Logging off</span>{' '}
            <span className="muted">Turn it on to capture logs of your actions in the org.</span>
          </span>
        )}
        <span className="grow" />
        <button disabled={busy} onClick={() => traceOn(30)}>
          {flag ? 'Extend' : 'On'} 30 min
        </button>
        <button disabled={busy} onClick={() => traceOn(60)}>
          {flag ? 'Extend' : 'On'} 1 h
        </button>
        {flag && (
          <button disabled={busy} onClick={() => user && void act(() => disableTraceFlag(client, user.userId))}>
            Off
          </button>
        )}
      </div>
      <Status text={error} kind="problem" block />

      <div className="split">
        <div className="card">
          <DataTable
            name="apex-logs"
            columns={['StartTime', 'LogUser.Name', 'Operation', 'Status', 'DurationMilliseconds', 'LogLength']}
            rows={logs.map((l) => ({ ...l, StartTime: fmtTime(l.StartTime) }))}
            onRowClick={(row) => void open(String(row.Id))}
            selectedKey={selected}
          />
        </div>
        <div className="card">
          {selected ? (
            body ? (
              <LogViewer log={body} name={selected} />
            ) : (
              <p className="muted">Loading log…</p>
            )
          ) : (
            <p className="muted">Select a log.</p>
          )}
        </div>
      </div>
    </div>
  );
}
