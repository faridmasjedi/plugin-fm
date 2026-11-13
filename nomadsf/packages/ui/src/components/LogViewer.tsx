import { useEffect, useMemo, useState } from 'react';
import { Select } from './Select';
import { logInsights, parseLog, type LogNode } from '@nomadsf/core';
import { DataTable } from './DataTable';
import { CodeEditor } from './CodeEditor';
import { AiExplain } from './AiHelp';

export type LogTab = 'insights' | 'debug' | 'events' | 'limits' | 'raw';
type Tab = LogTab;

/** One thing that ran, with what it ran in turn (folded below the first level). */
function RanNode({ node, depth = 0 }: { node: LogNode; depth?: number }) {
  const [open, setOpen] = useState(depth < 1);
  return (
    <li>
      <span className="log-ran-row">
        {node.children.length > 0 ? (
          <button className="tree-toggle link" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="tree-toggle" />
        )}
        <span className="pill">{node.kind}</span> {node.name}
        {node.ms > 0 && <span className="muted small"> · {node.ms} ms</span>}
      </span>
      {open && node.children.length > 0 && (
        <ul>
          {node.children.map((c, i) => (
            <RanNode key={i} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Developer Console style log inspector: insights first, then debug messages, all events, limits and the raw log. */
export function LogViewer({
  log,
  name = 'apex-log',
  start = 'insights',
}: {
  log: string;
  name?: string;
  /** The tab it opens on: Insights in Debug logs; Debug (your System.debug lines) after Execute Apex. */
  start?: Tab;
}) {
  const summary = useMemo(() => parseLog(log), [log]);
  const insights = useMemo(() => logInsights(summary), [summary]);
  const [tab, setTab] = useState<Tab>(start);
  // A new log (another run) opens on the starting tab again
  useEffect(() => setTab(start), [log, start]);
  const [eventType, setEventType] = useState('');
  const types = useMemo(() => [...new Set(summary.events.map((e) => e.type))].sort(), [summary]);

  if (!log) return <p className="muted">No log returned.</p>;

  const events = eventType ? summary.events.filter((e) => e.type === eventType) : summary.events;
  return (
    <div className="logviewer">
      <div className="chips">
        <span className="chip">{summary.durationMs} ms</span>
        <span className="chip">{summary.soqlQueries} SOQL</span>
        <span className="chip">{summary.dmlStatements} DML</span>
        <span className="chip">{summary.debugs.length} debug</span>
        {summary.errors.length > 0 && <span className="chip bad">{summary.errors.length} error(s)</span>}
        <span className="grow" />
        <AiExplain task="explain-log" getText={() => log} what="the debug log" />
        <button
          onClick={() => {
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([log], { type: 'text/plain' }));
            a.download = `${name}.log`;
            a.click();
          }}
        >
          Download log
        </button>
      </div>
      <div className="tabs">
        {(
          [
            ['insights', 'Insights'],
            ['debug', `Debug (${summary.debugs.length})`],
            ['events', `Events (${summary.events.length})`],
            ['limits', `Limits (${summary.limits.length})`],
            ['raw', 'Raw'],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {summary.errors.length > 0 && (
        <div className="error">
          {summary.errors.map((e) => (
            <div key={e.index}>
              {e.line ? `Line ${e.line}: ` : ''}
              {e.details}
            </div>
          ))}
        </div>
      )}
      {tab === 'insights' && (
        <div className="log-insights">
          <ul className="log-findings">
            {insights.insights.map((f, i) => (
              <li key={i} className={`finding ${f.level}`}>
                <span className="finding-icon">{f.level === 'bad' ? '✗' : f.level === 'warn' ? '⚠' : 'ℹ'}</span>
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
          {insights.ran.length > 0 && (
            <>
              <h4>What ran</h4>
              <ul className="log-ran">
                {insights.ran.map((n, i) => (
                  <RanNode key={i} node={n} />
                ))}
              </ul>
            </>
          )}
          {insights.slowest.length > 0 && (
            <>
              <h4>Slowest methods</h4>
              <DataTable name={`${name}-slowest`} columns={['method', 'calls', 'ms']} rows={insights.slowest} />
            </>
          )}
          {insights.queries.length > 0 && (
            <>
              <h4>Queries ({summary.soqlQueries})</h4>
              <DataTable
                name={`${name}-queries`}
                columns={['count', 'rows', 'ms', 'lines', 'text']}
                rows={insights.queries.map((q) => ({ ...q, lines: q.lines.join(', ') }))}
              />
            </>
          )}
          {insights.dml.length > 0 && (
            <>
              <h4>DML ({summary.dmlStatements})</h4>
              <DataTable
                name={`${name}-dml`}
                columns={['text', 'count', 'rows', 'ms', 'lines']}
                rows={insights.dml.map((d) => ({ ...d, lines: d.lines.join(', ') }))}
              />
            </>
          )}
        </div>
      )}
      {tab === 'debug' && (
        <DataTable
          name={`${name}-debug`}
          columns={['line', 'level', 'message', 'ms']}
          rows={summary.debugs.map((d, i) => ({
            Id: i,
            line: d.line ?? '',
            level: d.level,
            message: d.message,
            ms: (d.nanos / 1e6).toFixed(1),
          }))}
        />
      )}
      {tab === 'events' && (
        <>
          <Select value={eventType} onChange={(e) => setEventType(e.target.value)}>
            <option value="">All event types</option>
            {types.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
          <DataTable
            name={`${name}-events`}
            columns={['time', 'ms', 'type', 'line', 'details']}
            rows={events.map((e) => ({
              Id: e.index,
              time: e.time,
              ms: (e.nanos / 1e6).toFixed(2),
              type: e.type,
              line: e.line ?? '',
              details: e.details,
            }))}
          />
        </>
      )}
      {tab === 'limits' && (
        <table className="limits">
          <tbody>
            {summary.limits.map((l) => (
              <tr key={`${l.namespace}-${l.name}`}>
                <td>{l.name}</td>
                <td className="num">
                  {l.used} / {l.max}
                </td>
                <td className="bar">
                  <div
                    style={{ width: `${Math.min(100, (l.used / Math.max(1, l.max)) * 100)}%` }}
                    className={l.used / l.max > 0.8 ? 'hot' : ''}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tab === 'raw' && (
        <div className="raw">
          <CodeEditor language="plaintext" value={log} readOnly height="60vh" />
        </div>
      )}
    </div>
  );
}
