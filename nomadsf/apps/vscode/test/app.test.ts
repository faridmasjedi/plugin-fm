import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appInfo, browserCommand, isOlder, selectProject, targetPath, waitForApp } from '../src/app';

describe('local app helpers', () => {
  let server: Server;
  let port = 0;
  const selected: Array<{ path: string; header?: string }> = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/api/info') {
        res.end(JSON.stringify({ project: { name: 'a', path: '/work/a' } }));
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const path = (JSON.parse(body) as { path: string }).path;
        selected.push({ path, header: req.headers['x-fm-dashboard'] as string });
        res.writeHead(path === '/nope' ? 400 : 200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(path === '/nope' ? { error: '/nope is not a Salesforce project.' } : { name: 'b', path })
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => server.close());

  it('sees whether the app runs and which project it serves', async () => {
    expect((await appInfo(port))?.project?.path).toBe('/work/a');
    expect(await appInfo(9, 300)).toBeUndefined();
    expect((await waitForApp(port, 2000, () => true)).project?.name).toBe('a');
    await expect(waitForApp(9, 5000, () => false)).rejects.toThrow('stopped while starting');
  });

  it('switches the project with the dashboard header and reports refusals', async () => {
    await selectProject(port, '/work/b');
    expect(selected[0]).toEqual({ path: '/work/b', header: '1' });
    await expect(selectProject(port, '/nope')).rejects.toThrow('not a Salesforce project');
  });

  it('builds links for pages, records and queries', () => {
    expect(targetPath({ kind: 'studio', page: 'limits' })).toMatch(/^\/studio\/\?v=\d+#limits$/);
    expect(targetPath({ kind: 'record', id: '001000000000001AAA' })).toMatch(/#record=001000000000001AAA$/);
    expect(targetPath({ kind: 'query', soql: ' SELECT Id FROM Account ' })).toMatch(
      /#query=SELECT%20Id%20FROM%20Account$/
    );
    expect(() => targetPath({ kind: 'record', id: 'hello' })).toThrow('record Id');
    expect(() => targetPath({ kind: 'query', soql: 'DELETE x' })).toThrow('SOQL');
  });
});

describe('plugin version', () => {
  it('tells when the plugin is older than the extension', () => {
    expect(isOlder('1.0.0', '1.1.0')).toBe(true);
    expect(isOlder('1.1.0', '1.1.0')).toBe(false);
    expect(isOlder('1.2.0', '1.1.9')).toBe(false);
    expect(isOlder('v1.0.9', '1.0.10')).toBe(true);
    expect(isOlder(undefined, '1.0.0')).toBe(true);
    expect(isOlder('', '1.0.0')).toBe(true);
  });
});

describe('browserCommand', () => {
  // A front door link: a query inside the query must reach the browser unchanged
  const url =
    'https://x.my.salesforce.com/secur/frontdoor.jsp?sid=00D%21AQ.a%2Bb&retURL=%2Flightning%2Fo%2FAccount%2Flist%3Fa%3D1%26filterName%3DAll';
  it('passes the link as one argument, as written', () => {
    expect(browserCommand('darwin', url)).toEqual(['open', [url]]);
    expect(browserCommand('linux', url)).toEqual(['xdg-open', [url]]);
    expect(browserCommand('win32', url)).toEqual(['rundll32', ['url.dll,FileProtocolHandler', url]]);
  });
});
