import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  eventLogFiles,
  readEventLogCsvs,
  readEventLogs,
  summarizeEvents,
  type HttpRequest,
} from '../src/index.js';

// Samples in Salesforce's own column names (Login and ApexExecution event log files)
const login = [
  '"EVENT_TYPE","TIMESTAMP","USER_ID","SOURCE_IP","LOGIN_STATUS","CLIENT_IP","RUN_TIME","TIMESTAMP_DERIVED","USER_ID_DERIVED"',
  '"Login","20261110093015.123","005000000000001","10.0.0.1","LOGIN_NO_ERROR","10.0.0.1","120","2026-11-10T09:30:15.123Z","005000000000001AAA"',
  '"Login","20261110093115.123","005000000000002","66.6.6.6","LOGIN_ERROR_INVALID_PASSWORD","66.6.6.6","80","2026-11-10T09:31:15.123Z","005000000000002AAA"',
  '"Login","20261110093215.123","005000000000002","66.6.6.6","LOGIN_ERROR_INVALID_PASSWORD","66.6.6.6","90","2026-11-10T09:32:15.123Z","005000000000002AAA"',
].join('\n');
const apex = [
  '"EVENT_TYPE","TIMESTAMP","USER_ID","ENTRY_POINT","EXEC_TIME","TIMESTAMP_DERIVED","USER_ID_DERIVED"',
  '"ApexExecution","20261111080000.000","005000000000001","InvoiceService.markOverdue","900","2026-11-11T08:00:00.000Z","005000000000001AAA"',
  '"ApexExecution","20261111080100.000","005000000000001","InvoiceService.markOverdue","1100","2026-11-11T08:01:00.000Z","005000000000001AAA"',
  '"ApexExecution","20261111080200.000","005000000000002","CaseHandler.afterInsert","40","2026-11-11T08:02:00.000Z","005000000000002AAA"',
].join('\n');

describe('event log files', () => {
  it('joins files, puts a readable time first, newest first', () => {
    const t = readEventLogCsvs([login]);
    expect(t.columns.slice(0, 3)).toEqual(['TIME', 'USER_ID_DERIVED', 'SOURCE_IP']);
    expect(t.columns.slice(-3)).toEqual(['TIMESTAMP', 'TIMESTAMP_DERIVED', 'EVENT_TYPE']);
    expect(t.rows.map((r) => r.TIME)).toEqual(['2026-11-10 09:32:15', '2026-11-10 09:31:15', '2026-11-10 09:30:15']);
  });

  it('summarizes logins: failed by IP first, then by user and by result', () => {
    const s = summarizeEvents(readEventLogCsvs([login]));
    expect(s.map((x) => x.id)).toEqual(['failed', 'users', 'ips', 'status']);
    expect(s[0].rows).toEqual([{ SOURCE_IP: '66.6.6.6', events: 2 }]);
  });

  it('summarizes Apex: slowest entry point first, with average and max', () => {
    const what = summarizeEvents(readEventLogCsvs([apex])).find((x) => x.id === 'what')!;
    expect(what.rows[0]).toEqual({
      ENTRY_POINT: 'InvoiceService.markOverdue',
      events: 2,
      'avg ms': 1000,
      'max ms': 1100,
    });
  });

  it('reads the files of the org: daily ones when there are daily and hourly, then their CSVs', async () => {
    const asked: string[] = [];
    const org = new SalesforceClient(async (r: HttpRequest) => {
      asked.push(r.path);
      if (r.path.includes('/LogFile')) return { status: 200, headers: {}, body: login };
      const records = [
        {
          Id: '0AT1',
          EventType: 'Login',
          LogDate: '2026-11-10T00:00:00.000+0000',
          Interval: 'Hourly',
          LogFileLength: 10,
        },
        {
          Id: '0AT2',
          EventType: 'Login',
          LogDate: '2026-11-10T00:00:00.000+0000',
          Interval: 'Daily',
          LogFileLength: 99,
        },
      ];
      return { status: 200, headers: {}, body: JSON.stringify({ totalSize: 2, done: true, records }) };
    }, '62.0');
    const files = await eventLogFiles(org, 'Login', '2026-11-10', '2026-11-10');
    expect(files.map((f) => f.id)).toEqual(['0AT2']);
    const t = await readEventLogs(org, files);
    expect(t.rows).toHaveLength(3);
    expect(asked.some((p) => p.endsWith('/sobjects/EventLogFile/0AT2/LogFile'))).toBe(true);
    await expect(eventLogFiles(org, "Login' OR", '2026-11-10', '2026-11-10')).rejects.toThrow();
  });
});
