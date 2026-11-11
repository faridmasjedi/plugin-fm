import type { SalesforceClient } from './client.js';
import { parseCsv, type CsvTable } from './csv.js';
import { query, type Row } from './query.js';

/**
 * Event Log Files: Salesforce's hourly or daily CSV logs of what happened in the org (logins, API calls, Apex, page
 * views, report exports…). Read here and put together across days, with summaries a person can read. Orgs without the
 * Event Monitoring add-on get only a few types, kept one day; Developer Edition and scratch orgs get none.
 */

export type EventLogType = { type: string; files: number; first: string; last: string };
export type EventLogFile = { id: string; type: string; date: string; interval: string; size: number };

/** The kinds of logs the org has, with how many files and from when to when. */
export async function eventLogTypes(client: SalesforceClient): Promise<EventLogType[]> {
  const rows = (
    await query(
      client,
      // (first and last are SOQL words: not usable as names)
      'SELECT EventType, COUNT(Id) n, MIN(LogDate) fromDay, MAX(LogDate) toDay FROM EventLogFile GROUP BY EventType ORDER BY EventType',
      { maxRows: 2000 }
    )
  ).rows;
  return rows.map((r) => ({
    type: String(r.EventType),
    files: Number(r.n ?? 0),
    first: String(r.fromDay ?? '').slice(0, 10),
    last: String(r.toDay ?? '').slice(0, 10),
  }));
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The files of one kind between two days (inclusive), oldest first. */
export async function eventLogFiles(
  client: SalesforceClient,
  type: string,
  from: string,
  to: string
): Promise<EventLogFile[]> {
  if (!/^\w+$/.test(type)) throw new Error('Invalid event type.');
  if (!DAY.test(from) || !DAY.test(to)) throw new Error('Dates are YYYY-MM-DD.');
  const rows = (
    await query(
      client,
      `SELECT Id, EventType, LogDate, Interval, LogFileLength FROM EventLogFile WHERE EventType = '${type}' AND LogDate >= ${from}T00:00:00Z AND LogDate <= ${to}T23:59:59Z ORDER BY LogDate`,
      { maxRows: 5000 }
    )
  ).rows;
  // Hourly and daily files of the same day hold the same events: the daily ones when there are both
  const daily = rows.some((r) => r.Interval === 'Daily');
  return rows
    .filter((r) => !daily || r.Interval === 'Daily')
    .map((r) => ({
      id: String(r.Id),
      type: String(r.EventType),
      date: String(r.LogDate ?? ''),
      interval: String(r.Interval ?? ''),
      size: Number(r.LogFileLength ?? 0),
    }));
}

/** Several log files (or CSV files) as one table: every column any of them has. */
export function joinEventLogs(tables: CsvTable[]): CsvTable {
  const columns: string[] = [];
  for (const t of tables) for (const c of t.columns) if (!columns.includes(c)) columns.push(c);
  return { columns, rows: tables.flatMap((t) => t.rows) };
}

/** The events of the files, read one by one (each file is a CSV). */
export async function readEventLogs(
  client: SalesforceClient,
  files: EventLogFile[],
  onProgress?: (done: number, total: number) => void
): Promise<CsvTable> {
  const tables: CsvTable[] = [];
  for (const [i, f] of files.entries()) {
    onProgress?.(i, files.length);
    // eslint-disable-next-line no-await-in-loop
    tables.push(parseCsv(await client.text(`/sobjects/EventLogFile/${f.id}/LogFile`)));
  }
  onProgress?.(files.length, files.length);
  return withTime(joinEventLogs(tables));
}

/** A readable time first: TIMESTAMP_DERIVED (ISO) or TIMESTAMP (20261111093015.123). */
export function withTime(table: CsvTable): CsvTable {
  if (table.columns.includes('TIME')) return table;
  const time = (r: Record<string, string>): string => {
    if (r.TIMESTAMP_DERIVED) return r.TIMESTAMP_DERIVED.replace('T', ' ').replace(/(\.\d+)?Z$/, '');
    const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(r.TIMESTAMP ?? '');
    return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : '';
  };
  const rows = table.rows.map((r) => ({ TIME: time(r), ...r })).sort((a, b) => b.TIME.localeCompare(a.TIME));
  // The time and the user first; Salesforce's raw copies (15-character Id, compact time, the kind) last
  const user = ['USER_ID_DERIVED', 'USER_ID'].find((c) => table.columns.includes(c));
  const raw = ['USER_ID', 'TIMESTAMP', 'TIMESTAMP_DERIVED', 'EVENT_TYPE', 'REQUEST_ID'].filter(
    (c) => c !== user && table.columns.includes(c)
  );
  const rest = table.columns.filter((c) => c !== user && !raw.includes(c));
  return { columns: ['TIME', ...(user ? [user] : []), ...rest, ...raw], rows };
}

export type EventSummary = { id: string; title: string; hint: string; columns: string[]; rows: Row[] };

const first = (columns: string[], names: string[]): string | undefined => names.find((n) => columns.includes(n));
/** How long each event took, in ms, by the column its type has. */
const TIME_COLUMNS = [
  'RUN_TIME',
  'EXEC_TIME',
  'EFFECTIVE_PAGE_TIME',
  'DURATION',
  'TOTAL_TIME',
  'CPU_TIME',
  'DB_TOTAL_TIME',
];
const DIMENSIONS: Array<{ id: string; title: string; hint: string; columns: string[] }> = [
  { id: 'users', title: 'By user', hint: 'who did the most', columns: ['USER_ID_DERIVED', 'USER_ID', 'USER_NAME'] },
  {
    id: 'apps',
    title: 'By app or client',
    hint: 'which connected app or client made the calls',
    columns: ['CONNECTED_APP_NAME', 'CLIENT_NAME', 'CONNECTED_APP_ID', 'API_TYPE'],
  },
  {
    id: 'what',
    title: 'By what was used',
    hint: 'pages, Apex, reports, API resources — slowest first when the log has times',
    columns: [
      'ENTRY_POINT',
      'QUALIFIED_API_NAME',
      'PAGE_URL',
      'URI',
      'REPORT_ID',
      'API_RESOURCE',
      'METHOD_NAME',
      'ENTITY_NAME',
    ],
  },
  { id: 'ips', title: 'By IP', hint: 'where the requests came from', columns: ['CLIENT_IP', 'SOURCE_IP'] },
  {
    id: 'status',
    title: 'By result',
    hint: 'success and failure',
    columns: ['LOGIN_STATUS', 'REQUEST_STATUS', 'STATUS_CODE', 'HTTP_STATUS_CODE'],
  },
];

/** Events counted by one column, with average and slowest time when the log has times; the biggest first. */
function groupBy(rows: Array<Record<string, string>>, key: string, time?: string, max = 50): Row[] {
  const groups = new Map<string, { n: number; total: number; timed: number; slowest: number }>();
  for (const r of rows) {
    const k = r[key] || '(empty)';
    const g = groups.get(k) ?? { n: 0, total: 0, timed: 0, slowest: 0 };
    g.n++;
    const t = time ? Number(r[time]) : NaN;
    if (Number.isFinite(t)) {
      g.total += t;
      g.timed++;
      g.slowest = Math.max(g.slowest, t);
    }
    groups.set(k, g);
  }
  return [...groups]
    .map(([k, g]) => ({
      [key]: k,
      events: g.n,
      ...(time ? { 'avg ms': g.timed ? Math.round(g.total / g.timed) : '', 'max ms': g.timed ? g.slowest : '' } : {}),
    }))
    .sort((a, b) =>
      time && key !== 'USER_ID_DERIVED' && key !== 'USER_ID'
        ? Number(b['avg ms'] || 0) - Number(a['avg ms'] || 0)
        : Number(b.events) - Number(a.events)
    )
    .slice(0, max);
}

/**
 * Summaries of a log, from the columns it has (each event type has its own): by user, by app, by what was used
 * (slowest first when there are times), by IP, by result — and failed logins by IP for login logs.
 */
export function summarizeEvents(table: CsvTable): EventSummary[] {
  const time = first(table.columns, TIME_COLUMNS);
  const out: EventSummary[] = [];
  for (const d of DIMENSIONS) {
    const key = first(table.columns, d.columns);
    if (!key) continue;
    const rows = groupBy(table.rows, key, time);
    // A column with one value for every event says nothing
    if (rows.length < 2 && d.id !== 'status') continue;
    out.push({ id: d.id, title: d.title, hint: d.hint, columns: Object.keys(rows[0] ?? { [key]: '' }), rows });
  }
  if (table.columns.includes('LOGIN_STATUS')) {
    const ip = first(table.columns, ['SOURCE_IP', 'CLIENT_IP']);
    const failed = table.rows.filter((r) => r.LOGIN_STATUS && r.LOGIN_STATUS !== 'LOGIN_NO_ERROR');
    if (ip && failed.length) {
      const rows = groupBy(failed, ip);
      out.unshift({
        id: 'failed',
        title: 'Failed logins by IP',
        hint: 'many failures from one address can be someone guessing passwords',
        columns: Object.keys(rows[0]),
        rows,
      });
    }
  }
  return out;
}

/** Event log CSV files picked from disk (downloaded from Salesforce or another org), as one table. */
export function readEventLogCsvs(texts: string[]): CsvTable {
  return withTime(joinEventLogs(texts.map((t) => parseCsv(t))));
}
