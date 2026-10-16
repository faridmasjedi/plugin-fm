import { useMemo, useState } from 'react';
import { parseLog } from '@nomadsf/core';
import { DataTable } from './DataTable';
import { CodeEditor } from './CodeEditor';
import { AiExplain } from './AiHelp';

type Tab = 'debug' | 'events' | 'limits' | 'raw';

/** Developer Console style log inspector: debug messages, all events, limits and the raw log. */
export function LogViewer({ log, name = 'apex-log' }: { log: string; name?: string }) {
  const summary = useMemo(() => parseLog(log), [log]);
  const [tab, setTab] = useState<Tab>(summary.debugs.length > 0 ? 'debug' : 'events');
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
          <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
            <option value="">All event types</option>
            {types.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
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
