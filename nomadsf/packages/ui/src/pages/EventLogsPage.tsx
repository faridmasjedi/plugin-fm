import { Select } from '../components/Select';
import { useEffect, useMemo, useState } from 'react';
import {
  eventLogFiles,
  eventLogTypes,
  lookupIdNames,
  readEventLogCsvs,
  readEventLogs,
  summarizeEvents,
  withIdNames,
  type CsvTable,
  type EventLogType,
  type IdNameLookup,
  type Row,
} from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { TableTabs } from '../components/TableTabs';
import { storage, useStudio } from '../context';
import { Status } from '../statusLog';

type Source = 'org' | 'files';
const day = (d: Date): string => d.toISOString().slice(0, 10);
const daysAgo = (n: number): string => day(new Date(Date.now() - n * 86_400_000));
/** Columns holding the user of an event: shown with the user's name next to them. */
const USER_COLUMNS = ['USER_ID_DERIVED', 'USER_ID'];
/** More files than this are read one by one in a long wait: ask for fewer days first. */
const MAX_FILES = 31;

/**
 * Event Log Files, readable: choose a kind of log and days (or open CSV files), then every event in one table and
 * summaries by user, app, what was used (slowest first), IP and result. Nothing is read until you press Read.
 */
export function EventLogsPage() {
  const { client, org, logActivity } = useStudio();
  const [source, setSource] = useState<Source>(() => storage.get<Source>('eventlogs.source', 'org'));
  const [types, setTypes] = useState<EventLogType[] | null>(null);
  const [type, setType] = useState(() => storage.get('eventlogs.type', 'Login'));
  const [from, setFrom] = useState(daysAgo(7));
  const [to, setTo] = useState(day(new Date()));
  const [table, setTable] = useState<CsvTable | null>(null);
  const [names, setNames] = useState<IdNameLookup | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  // The dates follow what the org keeps of the kind chosen: its last week of logs (a quiet org may have only old ones)
  useEffect(() => {
    const kept = types?.find((t) => t.type === type);
    if (!kept?.last) return;
    const last = String(kept.last).slice(0, 10);
    const weekBefore = new Date(Date.parse(last) - 6 * 86_400_000).toISOString().slice(0, 10);
    const first = String(kept.first).slice(0, 10);
    setTo(last);
    setFrom(first > weekBefore ? first : weekBefore);
  }, [types, type]);

  // The kinds of logs this org has (one small query); the files themselves only on Read
  useEffect(() => {
    setTypes(null);
    setTable(null);
    eventLogTypes(client)
      .then((list) => {
        setTypes(list);
        if (list.length && !list.some((t) => t.type === type)) setType(list[0].type);
      })
      .catch((e: Error) => {
        setTypes([]);
        setStatus(`❌ ${e.message}`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const choose = (s: Source) => {
    setSource(s);
    storage.set('eventlogs.source', s);
    setTable(null);
    setStatus('');
  };

  /** The user Ids of the events with their names (the org's users). */
  const show = async (t: CsvTable) => {
    const column = USER_COLUMNS.find((c) => t.columns.includes(c));
    const rows: Row[] = column ? t.rows.map((r) => ({ [column]: r[column] })) : [];
    // Names first, so every table shows them from the start
    setNames(column ? await lookupIdNames(client, [column], rows, { maxIds: 5000 }).catch(() => null) : null);
    setTable(t);
  };

  const readOrg = async () => {
    setBusy(true);
    setTable(null);
    setNames(null);
    storage.set('eventlogs.type', type);
    try {
      setStatus(`Finding ${type} log files…`);
      const files = await eventLogFiles(client, type, from, to);
      if (!files.length) {
        setStatus(`No ${type} log files between ${from} and ${to}.`);
        return;
      }
      if (files.length > MAX_FILES)
        throw new Error(`${files.length} files: choose fewer days (at most ${MAX_FILES} files).`);
      const t = await readEventLogs(client, files, (done, total) =>
        setStatus(`Reading ${type} log files… ${done}/${total}`)
      );
      setStatus('Looking up user names…');
      await show(t);
      setStatus(`✓ ${t.rows.length.toLocaleString()} events from ${files.length} file(s).`);
      logActivity('read event logs', { type, from, to, files: files.length, events: t.rows.length });
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const openFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    setNames(null);
    try {
      const t = readEventLogCsvs(await Promise.all([...list].map((f) => f.text())));
      await show(t);
      setStatus(`✓ ${t.rows.length.toLocaleString()} events from ${list.length} file(s).`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const summaries = useMemo(() => (table ? summarizeEvents(table) : []), [table]);
  const named = (columns: string[], rows: Row[]) => (names ? withIdNames(columns, rows, names) : { columns, rows });
  const events = table ? named(table.columns, table.rows as Row[]) : null;
  const current = types?.find((t) => t.type === type);

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Event logs</h2>
        <span className="muted">What happened in {org.label}: logins, API calls, Apex, pages, reports…</span>
      </div>
      <div className="tabs">
        {(
          [
            ['org', `From ${org.label}`],
            ['files', 'Open CSV files'],
          ] as Array<[Source, string]>
        ).map(([id, label]) => (
          <button key={id} className={`tab ${source === id ? 'active' : ''}`} onClick={() => choose(id)}>
            {label}
          </button>
        ))}
      </div>

      {source === 'org' && types === null && <p className="muted">Finding the kinds of logs this org has…</p>}
      {source === 'org' && types?.length === 0 && (
        <div className="note">
          <b>No event log files in {org.label}.</b> Developer Edition and scratch orgs have none; other orgs get a few
          kinds (Login, Logout, API Total Usage…) kept one day, and every kind for 30 days with the Event Monitoring
          add-on (Salesforce Shield). Users also need the <i>View Event Log Files</i> permission. You can still open
          event log CSV files you have, under <b>Open CSV files</b>.
        </div>
      )}
      {source === 'org' && !!types?.length && (
        <div className="form">
          <label>
            Kind
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {types.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.type} ({t.files} file{t.files === 1 ? '' : 's'}, {t.first} → {t.last})
                </option>
              ))}
            </Select>
          </label>
          <label>
            From
            <input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
          <button className="primary" disabled={busy} onClick={() => void readOrg()}>
            Read
          </button>
          {current && (
            <span className="muted">
              kept from {current.first} to {current.last}
            </span>
          )}
        </div>
      )}
      {source === 'files' && (
        <div className="form">
          <label className="file-button">
            Choose CSV files…
            <input
              type="file"
              accept=".csv,text/csv"
              multiple
              hidden
              onChange={(e) => void openFiles(e.target.files)}
            />
          </label>
          <span className="muted">
            Event log files downloaded from Salesforce (any org): several days of the same kind are read as one.
          </span>
        </div>
      )}
      {status && <Status text={status} block />}

      {events &&
        (events.rows.length === 0 ? (
          <EmptyHint what="events" />
        ) : (
          <TableTabs
            tabs={[
              ...summaries.map((s) => {
                const shown = s.id === 'users' ? named(s.columns, s.rows) : { columns: s.columns, rows: s.rows };
                return {
                  id: s.id,
                  label: s.title,
                  count: s.rows.length,
                  content: (
                    <DataTable
                      columns={shown.columns}
                      rows={shown.rows.map((r, i) => ({ ...r, __k: i }))}
                      rowKey="__k"
                      name={`event-logs-${s.id}`}
                      note={<span>· {s.hint}</span>}
                    />
                  ),
                };
              }),
              {
                id: 'events',
                label: 'Every event',
                count: events.rows.length,
                content: (
                  <DataTable
                    columns={events.columns}
                    rows={events.rows.map((r, i) => ({ ...r, __k: i }))}
                    rowKey="__k"
                    name="event-logs"
                    note={<span>· newest first; Filters for a user, an IP, a page…</span>}
                  />
                ),
              },
            ]}
          />
        ))}
    </div>
  );
}
