import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  SalesforceError,
  apiHostFor,
  ensureTraceFlag,
  executeAnonymousEnvelope,
  fetchTransport,
  flattenRecord,
  parseExecuteAnonymous,
  parseLog,
  query,
  type HttpRequest,
  type HttpResponse,
} from '../src/index.js';

/** Fake transport: answers by matching the request, records every call. */
function fake(handler: (r: HttpRequest) => Partial<HttpResponse> & { json?: unknown }) {
  const calls: HttpRequest[] = [];
  const transport = async (r: HttpRequest): Promise<HttpResponse> => {
    calls.push(r);
    const out = handler(r);
    return {
      status: out.status ?? 200,
      headers: {},
      body: out.json !== undefined ? JSON.stringify(out.json) : out.body ?? '',
    };
  };
  return { calls, client: new SalesforceClient(transport, '62.0') };
}

describe('client', () => {
  it('discovers the latest API version', async () => {
    const client = new SalesforceClient(async () => ({
      status: 200,
      headers: {},
      body: JSON.stringify([{ version: '61.0' }, { version: '64.0' }]),
    }));
    expect(await client.version()).toBe('64.0');
  });

  it('turns REST errors into SalesforceError', async () => {
    const { client } = fake(() => ({
      status: 400,
      json: [{ message: 'unexpected token', errorCode: 'MALFORMED_QUERY' }],
    }));
    await expect(client.rest('GET', '/query?q=x')).rejects.toMatchObject({
      message: 'unexpected token',
      errorCode: 'MALFORMED_QUERY',
      status: 400,
    });
    await expect(client.rest('GET', '/query?q=x')).rejects.toBeInstanceOf(SalesforceError);
  });

  it('fetchTransport sends the token and fills the SOAP session', async () => {
    let seen: RequestInit | undefined;
    const transport = fetchTransport('https://x.my.salesforce.com/', 'TOKEN', (async (
      _url: string,
      init: RequestInit
    ) => {
      seen = init;
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch);
    await transport({ method: 'POST', path: '/services/Soap/s/62.0', body: '<sessionId>{{SESSION_ID}}</sessionId>' });
    expect((seen?.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN');
    expect(seen?.body).toBe('<sessionId>TOKEN</sessionId>');
  });
});

describe('execute anonymous', () => {
  it('escapes the code and asks for the log levels', () => {
    const xml = executeAnonymousEnvelope(`System.debug('a < b & "c"');`, { Apex_code: 'FINEST' });
    expect(xml).toContain('System.debug(&apos;a &lt; b &amp; &quot;c&quot;&apos;);');
    expect(xml).toContain('<apex:category>Apex_code</apex:category><apex:level>FINEST</apex:level>');
    expect(xml).toContain('<apex:sessionId>{{SESSION_ID}}</apex:sessionId>');
  });

  it('parses success with the debug log', () => {
    const r = parseExecuteAnonymous(
      `<soapenv:Envelope><soapenv:Header><DebuggingInfo><debugLog>64.0 APEX_CODE,DEBUG
12:00:00.1 (100)|USER_DEBUG|[1]|DEBUG|hello &amp; bye</debugLog></DebuggingInfo></soapenv:Header>
<soapenv:Body><executeAnonymousResponse><result><column>-1</column><compileProblem xsi:nil="true"/><compiled>true</compiled><exceptionMessage xsi:nil="true"/><line>-1</line><success>true</success></result></executeAnonymousResponse></soapenv:Body></soapenv:Envelope>`
    );
    expect(r).toMatchObject({ compiled: true, success: true, line: undefined });
    expect(r.log).toContain('hello & bye');
  });

  it('parses a compile problem with its position', () => {
    const r = parseExecuteAnonymous(
      '<result><column>5</column><compileProblem>Unexpected token &apos;x&apos;.</compileProblem><compiled>false</compiled><line>2</line><success>false</success></result>'
    );
    expect(r).toMatchObject({
      compiled: false,
      success: false,
      compileProblem: "Unexpected token 'x'.",
      line: 2,
      column: 5,
    });
  });
});

describe('log parser', () => {
  const log = `64.0 APEX_CODE,FINEST;APEX_PROFILING,INFO
12:00:00.0 (1000)|EXECUTION_STARTED
12:00:00.1 (2000000)|USER_DEBUG|[3]|DEBUG|first line
second line
12:00:00.2 (3000000)|SOQL_EXECUTE_BEGIN|[4]|Aggregations:0|SELECT Id FROM Account
12:00:00.3 (4000000)|DML_BEGIN|[5]|Op:Update|Type:Account|Rows:1
12:00:00.4 (5000000)|EXCEPTION_THROWN|[6]|System.NullPointerException: boom
12:00:00.5 (6000000)|LIMIT_USAGE_FOR_NS|(default)|
  Number of SOQL queries: 1 out of 100
  Maximum CPU time: 12 out of 10000
12:00:00.6 (7500000)|EXECUTION_FINISHED`;

  it('extracts debug messages, errors, counts and limits', () => {
    const s = parseLog(log);
    expect(s.debugs).toEqual([{ line: 3, level: 'DEBUG', message: 'first line\nsecond line', nanos: 2000000 }]);
    expect(s.errors.map((e) => e.line)).toEqual([6]);
    expect([s.soqlQueries, s.dmlStatements, s.durationMs]).toEqual([1, 1, 8]);
    expect(s.limits).toContainEqual({ namespace: '(default)', name: 'Number of SOQL queries', used: 1, max: 100 });
    expect(s.events[0].type).toBe('EXECUTION_STARTED');
  });
});

describe('query', () => {
  it('follows nextRecordsUrl and flattens lookups', async () => {
    const { client, calls } = fake((r) =>
      r.path.includes('/query?q=')
        ? {
            json: {
              totalSize: 3,
              done: false,
              nextRecordsUrl: '/services/data/v62.0/query/01g-2000',
              records: [{ attributes: { type: 'Account' }, Id: '1', Owner: { Name: 'Ada' } }],
            },
          }
        : {
            json: {
              totalSize: 3,
              done: true,
              records: [
                { Id: '2', Owner: null },
                { Id: '3', Contacts: { records: [{}, {}] } },
              ],
            },
          }
    );
    const r = await query(client, 'SELECT Id, Owner.Name FROM Account');
    expect(r.rows).toEqual([
      { Id: '1', 'Owner.Name': 'Ada' },
      { Id: '2', Owner: null },
      { Id: '3', Contacts: '2 record(s)' },
    ]);
    expect(r.sobject).toBe('Account');
    expect(calls[1].path).toBe('/services/data/v62.0/query/01g-2000');
  });

  it('uses queryAll and the Tooling API when asked', async () => {
    const { client, calls } = fake(() => ({ json: { totalSize: 0, done: true, records: [] } }));
    await query(client, 'SELECT Id FROM Account', { includeDeleted: true });
    await query(client, 'SELECT Id FROM ApexClass', { tooling: true });
    expect(calls[0].path).toContain('/v62.0/queryAll?q=');
    expect(calls[1].path).toContain('/v62.0/tooling/query?q=');
  });

  it('finds the main object of a query with subqueries', async () => {
    const { mainSObject } = await import('../src/index.js');
    expect(
      mainSObject(
        'SELECT Id, (SELECT Id FROM Contacts), (SELECT Id FROM Cases WHERE (Status = 1)) FROM Account WHERE Id IN (SELECT AccountId FROM Opportunity)'
      )
    ).toBe('Account');
    expect(mainSObject('SELECT Id FROM')).toBe(undefined);
  });

  it('flattenRecord keeps nulls and drops attributes', () => {
    expect(flattenRecord({ attributes: {}, A: null, B: { attributes: {}, C: 1 } })).toEqual({ A: null, 'B.C': 1 });
  });
});

describe('trace flags', () => {
  it('creates the NomadSF debug level and a trace flag when none is active', async () => {
    const { client, calls } = fake((r) => {
      if (r.path.includes('FROM+TraceFlag') || r.path.includes('FROM%20TraceFlag'))
        return { json: { totalSize: 0, done: true, records: [] } };
      if (r.path.includes('DebugLevel') && r.method === 'GET')
        return { json: { totalSize: 0, done: true, records: [] } };
      if (r.path.endsWith('/sobjects/DebugLevel')) return { json: { id: '7dl000000000001AAA' } };
      return { json: { id: '7tf000000000001AAA' } };
    });
    const result = await ensureTraceFlag(client, '005000000000001AAA', 30);
    expect(result.id).toBe('7tf000000000001AAA');
    const post = calls.find((c) => c.path.endsWith('/sobjects/TraceFlag'));
    expect(JSON.parse(post?.body ?? '{}')).toMatchObject({
      TracedEntityId: '005000000000001AAA',
      DebugLevelId: '7dl000000000001AAA',
      LogType: 'DEVELOPER_LOG',
    });
  });
});

describe('hosts', () => {
  it.each([
    ['acme.lightning.force.com', 'acme.my.salesforce.com'],
    ['acme--uat.sandbox.lightning.force.com', 'acme--uat.sandbox.my.salesforce.com'],
    ['acme.my.salesforce-setup.com', 'acme.my.salesforce.com'],
    ['acme--c.vf.force.com', 'acme.my.salesforce.com'],
    ['acme--uat--c.sandbox.vf.force.com', 'acme--uat.sandbox.my.salesforce.com'],
    ['fm-dev-ed.develop.lightning.force.com', 'fm-dev-ed.develop.my.salesforce.com'],
    ['acme.my.salesforce.com', 'acme.my.salesforce.com'],
    ['example.com', undefined],
  ])('%s -> %s', (page, api) => {
    expect(apiHostFor(page)).toBe(api);
  });
});
