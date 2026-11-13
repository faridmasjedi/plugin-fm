/**
 * Parses Apex debug logs into events, like the Developer Console log inspector.
 * Line format: `HH:mm:ss.S (nanos)|EVENT_TYPE|[line]|details...`; lines without a
 * timestamp continue the previous event (multi-line USER_DEBUG messages).
 */

export type LogEvent = {
  index: number;
  time: string;
  /** Nanoseconds since the start of the request. */
  nanos: number;
  type: string;
  /** Apex line number, when the event has one. */
  line?: number;
  details: string;
};

export type LogLimit = { namespace: string; name: string; used: number; max: number };

export type LogSummary = {
  events: LogEvent[];
  debugs: Array<{ line?: number; level: string; message: string; nanos: number }>;
  errors: LogEvent[];
  soqlQueries: number;
  dmlStatements: number;
  limits: LogLimit[];
  durationMs: number;
};

const EVENT_LINE = /^(\d{2}:\d{2}:\d{2}\.\d+) \((\d+)\)\|([A-Z_]+)(?:\|(.*))?$/;

export function parseLog(text: string): LogSummary {
  const events: LogEvent[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = EVENT_LINE.exec(raw);
    if (match) {
      const [, time, nanos, type, rest = ''] = match;
      const lineMatch = /^\[(\d+)\]\|?/.exec(rest);
      events.push({
        index: events.length,
        time,
        nanos: Number(nanos),
        type,
        line: lineMatch ? Number(lineMatch[1]) : undefined,
        details: lineMatch ? rest.slice(lineMatch[0].length) : rest,
      });
    } else if (events.length > 0 && raw.length > 0) {
      events[events.length - 1].details += `\n${raw}`;
    }
  }

  const debugs = events
    .filter((e) => e.type === 'USER_DEBUG')
    .map((e) => {
      const separator = e.details.indexOf('|');
      return {
        line: e.line,
        level: separator >= 0 ? e.details.slice(0, separator) : 'DEBUG',
        message: separator >= 0 ? e.details.slice(separator + 1) : e.details,
        nanos: e.nanos,
      };
    });

  const limits: LogLimit[] = [];
  let namespace = '';
  for (const e of events) {
    if (e.type === 'LIMIT_USAGE_FOR_NS') {
      namespace = e.details.split('|')[0] ?? '';
      for (const m of e.details.matchAll(/^\s*(.+?):\s*(\d+)\s+out of\s+(\d+)/gm)) {
        limits.push({ namespace, name: m[1].trim(), used: Number(m[2]), max: Number(m[3]) });
      }
    }
  }

  const last = events[events.length - 1];
  return {
    events,
    debugs,
    errors: events.filter((e) => ['EXCEPTION_THROWN', 'FATAL_ERROR'].includes(e.type)),
    soqlQueries: events.filter((e) => e.type === 'SOQL_EXECUTE_BEGIN').length,
    dmlStatements: events.filter((e) => e.type === 'DML_BEGIN').length,
    limits,
    durationMs: last ? Math.round(last.nanos / 1e6) : 0,
  };
}

// ---------- insights: what ran, what was slow, what repeats ----------

export type LogNode = { name: string; kind: string; ms: number; children: LogNode[] };
export type LogStatement = { text: string; count: number; rows: number; ms: number; lines: number[] };
export type LogInsight = { level: 'bad' | 'warn' | 'info'; text: string };
export type LogInsights = {
  insights: LogInsight[];
  /** Triggers, flows, validation rules, workflow and classes, nested as they ran. */
  ran: LogNode[];
  slowest: Array<{ method: string; calls: number; ms: number }>;
  queries: LogStatement[];
  dml: LogStatement[];
};

const ms = (nanos: number): number => Math.round(nanos / 1e5) / 10;

/** "AccountTrigger on Account trigger event BeforeUpdate" → a name and its kind. */
function unitOf(details: string): { name: string; kind: string } {
  const text = details.split('|').pop()?.trim() ?? details;
  if (/ trigger event /.test(text)) return { name: text.replace(/ trigger event /, ' · '), kind: 'Trigger' };
  if (/^Validation:/i.test(text)) return { name: text.replace(/^Validation:/i, '').trim(), kind: 'Validation' };
  if (/^Workflow:/i.test(text)) return { name: text.replace(/^Workflow:/i, '').trim(), kind: 'Workflow' };
  if (/^Flow:/i.test(text)) return { name: text.replace(/^Flow:/i, '').trim(), kind: 'Flow' };
  if (/execute_anonymous/i.test(text)) return { name: 'Anonymous Apex', kind: 'Apex' };
  return { name: text, kind: 'Apex' };
}

/** A query with its literals blanked, so the same query run with other values counts as one. */
const shape = (soql: string): string =>
  soql
    .replace(/'(?:[^'\\]|\\.)*'/g, "'…'")
    .replace(/\b\d+(\.\d+)?\b/g, 'n')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * What a log says, without an AI: the errors and the limits close to their maximum first, the same query or DML many
 * times (a query or DML in a loop), what ran as a tree (triggers, flows, validation rules, classes), the slowest
 * methods, and every query and DML grouped with the lines that ran them.
 */
export function logInsights(summary: LogSummary): LogInsights {
  const insights: LogInsight[] = [];
  const roots: LogNode[] = [];
  const stack: Array<{ node: LogNode; start: number }> = [];
  const methods = new Map<string, { calls: number; ms: number }>();
  const methodStack: Array<{ name: string; start: number }> = [];
  const queries = new Map<string, LogStatement>();
  const dml = new Map<string, LogStatement>();
  let openQuery: { key: string; start: number } | undefined;
  let openDml: { key: string; start: number } | undefined;

  const push = (name: string, kind: string, start: number): void => {
    const node: LogNode = { name, kind, ms: 0, children: [] };
    (stack.length ? stack[stack.length - 1].node.children : roots).push(node);
    stack.push({ node, start });
  };
  const pop = (end: number): void => {
    const top = stack.pop();
    if (top) top.node.ms = ms(end - top.start);
  };

  for (const e of summary.events) {
    switch (e.type) {
      case 'CODE_UNIT_STARTED': {
        const u = unitOf(e.details);
        push(u.name, u.kind, e.nanos);
        break;
      }
      case 'CODE_UNIT_FINISHED':
        pop(e.nanos);
        break;
      case 'FLOW_START_INTERVIEW_BEGIN':
        push(e.details.split('|').pop() ?? 'Flow', 'Flow', e.nanos);
        break;
      case 'FLOW_START_INTERVIEW_END':
        pop(e.nanos);
        break;
      case 'VALIDATION_RULE':
        (stack.length ? stack[stack.length - 1].node.children : roots).push({
          name: e.details.split('|').pop() ?? 'Validation rule',
          kind: 'Validation',
          ms: 0,
          children: [],
        });
        break;
      case 'METHOD_ENTRY':
        methodStack.push({ name: e.details.split('|').pop() ?? '', start: e.nanos });
        break;
      case 'METHOD_EXIT': {
        const m = methodStack.pop();
        if (m) {
          const name = m.name.replace(/\(.*\)$/, '()');
          const was = methods.get(name) ?? { calls: 0, ms: 0 };
          methods.set(name, { calls: was.calls + 1, ms: was.ms + (e.nanos - m.start) / 1e6 });
        }
        break;
      }
      case 'SOQL_EXECUTE_BEGIN': {
        const text = e.details.split('|').pop() ?? '';
        const key = shape(text);
        const q = queries.get(key) ?? { text: key, count: 0, rows: 0, ms: 0, lines: [] };
        q.count++;
        if (e.line && !q.lines.includes(e.line)) q.lines.push(e.line);
        queries.set(key, q);
        openQuery = { key, start: e.nanos };
        break;
      }
      case 'SOQL_EXECUTE_END': {
        const q = openQuery && queries.get(openQuery.key);
        if (q && openQuery) {
          q.rows += Number(/Rows:(\d+)/.exec(e.details)?.[1] ?? 0);
          q.ms += (e.nanos - openQuery.start) / 1e6;
        }
        openQuery = undefined;
        break;
      }
      case 'DML_BEGIN': {
        const op = /Op:(\w+)/.exec(e.details)?.[1] ?? 'DML';
        const type = /Type:([\w]+)/.exec(e.details)?.[1] ?? '';
        const key = `${op} ${type}`.trim();
        const d = dml.get(key) ?? { text: key, count: 0, rows: 0, ms: 0, lines: [] };
        d.count++;
        d.rows += Number(/Rows:(\d+)/.exec(e.details)?.[1] ?? 0);
        if (e.line && !d.lines.includes(e.line)) d.lines.push(e.line);
        dml.set(key, d);
        openDml = { key, start: e.nanos };
        break;
      }
      case 'DML_END': {
        const d = openDml && dml.get(openDml.key);
        if (d && openDml) d.ms += (e.nanos - openDml.start) / 1e6;
        openDml = undefined;
        break;
      }
      default:
    }
  }
  const last = summary.events[summary.events.length - 1]?.nanos ?? 0;
  while (stack.length) pop(last);

  // What to look at first
  for (const err of summary.errors)
    insights.push({
      level: 'bad',
      text: `${err.type === 'FATAL_ERROR' ? 'Fatal error' : 'Exception'}${err.line ? ` at line ${err.line}` : ''}: ${
        err.details.split('\n')[0]
      }`,
    });
  for (const l of summary.limits.filter((x) => x.max > 0 && x.used / x.max >= 0.7))
    insights.push({
      level: l.used >= l.max ? 'bad' : 'warn',
      text: `${l.name}: ${l.used} of ${l.max} (${Math.round((l.used / l.max) * 100)}%)${
        l.namespace && l.namespace !== '(default)' ? ` in ${l.namespace}` : ''
      }`,
    });
  const round = (n: number): number => Math.round(n * 10) / 10;
  const qList = [...queries.values()]
    .map((q) => ({ ...q, ms: round(q.ms) }))
    .sort((a, b) => b.count - a.count || b.ms - a.ms);
  const dList = [...dml.values()].map((d) => ({ ...d, ms: round(d.ms) })).sort((a, b) => b.count - a.count);
  for (const q of qList.filter((x) => x.count >= 5))
    insights.push({
      level: 'warn',
      text: `The same query ran ${q.count} times${
        q.lines.length ? ` (line ${q.lines.join(', ')})` : ''
      }: probably inside a loop — query once, before it. ${q.text.slice(0, 120)}`,
    });
  for (const d of dList.filter((x) => x.count >= 5))
    insights.push({
      level: 'warn',
      text: `${d.text} ran ${d.count} times${
        d.lines.length ? ` (line ${d.lines.join(', ')})` : ''
      }: probably inside a loop — collect the records and save them once.`,
    });
  const slowest = [...methods.entries()]
    .map(([method, m]) => ({ method, calls: m.calls, ms: round(m.ms) }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 15);
  if (summary.durationMs > 5000)
    insights.push({ level: 'warn', text: `The whole request took ${(summary.durationMs / 1000).toFixed(1)} s.` });
  const units = (list: LogNode[]): number => list.reduce((n, x) => n + 1 + units(x.children), 0);
  insights.push({
    level: 'info',
    text: `${units(roots)} thing(s) ran, ${summary.soqlQueries} queries, ${summary.dmlStatements} DML, ${
      summary.debugs.length
    } debug line(s), ${summary.durationMs} ms.`,
  });
  return { insights, ran: roots, slowest, queries: qList, dml: dList };
}
