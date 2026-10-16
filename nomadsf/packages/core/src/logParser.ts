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
