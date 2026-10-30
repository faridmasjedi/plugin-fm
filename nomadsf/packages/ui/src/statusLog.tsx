import { createContext, useContext, useEffect, useId, useState, useSyncExternalStore } from 'react';
import { StudioContext } from './context';

/**
 * Messages of the Studio's tools. Each shows next to the button that started it, drawn by kind
 * (working, done, problem, warning), and goes into the Log at the bottom of the Studio with the
 * time, the tab and the org — like an output panel. Progress of one job updates one log line.
 */

export type StatusKind = 'working' | 'done' | 'problem' | 'warning' | 'note';
export type LogEntry = {
  id: number;
  at: Date;
  tool: string;
  org: string;
  kind: StatusKind;
  text: string;
  source: string;
};

/** What a message is, from how the tools write them: ✓ done, ❌ problem, ⚠ warning, … working. */
export function statusKind(text: string): StatusKind {
  const t = text.trim();
  if (/^(❌|✗)/.test(t)) return 'problem';
  if (/^⚠/.test(t)) return 'warning';
  if (/^(✓|✔)/.test(t)) return 'done';
  if (
    /…$|\.\.\.$/.test(t) ||
    /^(Reading|Loading|Copying|Saving|Deploying|Counting|Searching|Finding|Checking|Applying|Creating|Uploading|Retrieving|Comparing|Matching|Bringing|Looking)\b/.test(
      t
    )
  )
    return 'working';
  return 'note';
}

// ---------- the log ----------

const MAX = 300;
let entries: LogEntry[] = [];
let unseenProblems = 0;
let seq = 0;
const listeners = new Set<() => void>();
const changed = (): void => listeners.forEach((l) => l());

export const statusLog = {
  add(entry: Omit<LogEntry, 'id' | 'at'>): void {
    const last = entries[entries.length - 1];
    // Progress of the same job (one message place, still working): the line is updated, not added
    if (last && last.source === entry.source && last.kind === 'working')
      entries = [...entries.slice(0, -1), { ...last, ...entry, at: new Date() }];
    else entries = [...entries, { ...entry, id: ++seq, at: new Date() }].slice(-MAX);
    if (entry.kind === 'problem') unseenProblems++;
    changed();
  },
  /** A job's message was cleared: its working line is done ("Loading…" → "Loading… done"). */
  finish(source: string): void {
    const i = entries.map((e) => e.source).lastIndexOf(source);
    if (i < 0 || entries[i].kind !== 'working') return;
    entries = entries.map((e, k) => (k === i ? { ...e, kind: 'done', text: `${e.text} done` } : e));
    changed();
  },
  clear(): void {
    entries = [];
    unseenProblems = 0;
    changed();
  },
  seen(): void {
    unseenProblems = 0;
    changed();
  },
};

function useLog(): { entries: LogEntry[]; unseenProblems: number } {
  const snapshot = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => entries
  );
  return { entries: snapshot, unseenProblems };
}

/** The tab a message comes from (set around each tool by the workspace). */
export const ToolContext = createContext('');

/**
 * A tool's message, next to what started it, and into the Log. `block` for a line of its own
 * (under a form), inline otherwise.
 */
export function Status({
  text,
  block = false,
  kind: given,
  mono = false,
}: {
  text: string;
  block?: boolean;
  kind?: StatusKind;
  /** Code-like text (a SOQL error points at its column). */
  mono?: boolean;
}) {
  const tool = useContext(ToolContext);
  const studio = useContext(StudioContext);
  const source = useId();
  // An error shown as such (a SOQL or Apex error) is a problem whatever its first character
  const kind = given ?? statusKind(text);
  useEffect(() => {
    if (text.trim()) statusLog.add({ tool, org: studio?.org.label ?? '', kind, text: text.trim(), source });
    else statusLog.finish(source);
    // a new message is what is logged
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);
  // Pages often show a message only while there is one: going away also ends its working line
  useEffect(() => () => statusLog.finish(source), [source]);
  if (!text) return null;
  const Tag = block ? 'p' : 'span';
  return (
    <Tag className={`status status-${kind}${mono ? ' mono' : ''}`} role={kind === 'problem' ? 'alert' : 'status'}>
      {kind === 'working' && <span className="status-spin" aria-hidden="true" />}
      {text}
    </Tag>
  );
}

const time = (d: Date): string => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** The Log at the bottom of the Studio: every message, newest first; opens by itself on a problem. */
export function LogDrawer() {
  const { entries: list, unseenProblems: problems } = useLog();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (problems > 0) setOpen(true);
  }, [problems]);
  const last = list[list.length - 1];
  const toggle = () => {
    setOpen(!open);
    statusLog.seen();
  };
  const copy = () =>
    void navigator.clipboard
      .writeText(list.map((e) => `${time(e.at)}\t${e.tool}\t${e.org}\t${e.text}`).join('\n'))
      .catch(() => undefined);
  return (
    <section className={`log-drawer ${open ? 'open' : ''}`} aria-label="Log">
      <div className="log-bar">
        <button className="log-toggle" onClick={toggle} title={open ? 'Hide the log' : 'Show every message'}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> Log
          <span className="log-count">{list.length}</span>
          {problems > 0 && (
            <span className="log-problems">
              {problems} problem{problems === 1 ? '' : 's'}
            </span>
          )}
        </button>
        {!open && last && (
          <span className={`log-last status-${last.kind}`} title={last.text}>
            <span className="muted">{last.tool}</span> {last.text}
          </span>
        )}
        <span className="grow" />
        {open && list.length > 0 && (
          <>
            <button className="link" onClick={copy}>
              Copy
            </button>
            <button className="link" onClick={() => statusLog.clear()}>
              Clear
            </button>
          </>
        )}
      </div>
      {open && (
        <ol className="log-list">
          {list.length === 0 && (
            <li className="muted">Messages of every tab show here: what ran, what it found, what failed.</li>
          )}
          {[...list].reverse().map((e) => (
            <li key={e.id} className={`log-row status-${e.kind}`}>
              <span className="log-time">{time(e.at)}</span>
              <span className="log-tool">{e.tool}</span>
              <span className="log-org">{e.org}</span>
              <span className="log-text">{e.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
