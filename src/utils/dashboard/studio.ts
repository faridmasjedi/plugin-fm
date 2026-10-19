import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from './orgExplorer.js';

/**
 * NomadSF Studio inside the local app: serves the built Studio (dashboard/studio) and a
 * Salesforce proxy, so the page never sees the CLI's access token.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
// Packaged plugin: dashboard/studio. Working copy: the Studio build output.
const STUDIO_DIRS = [resolve(PACKAGE_ROOT, 'dashboard/studio'), resolve(PACKAGE_ROOT, 'nomadsf/packages/ui/dist')];

/**
 * Pages may be framed by the app itself and by browser extensions (the NomadSF extension
 * shows the local pages); never by websites, which would allow clickjacking.
 */
// The app may be framed by itself, the browser extension, and VS Code webviews (desktop and web)
export const FRAME_POLICY =
  "frame-ancestors 'self' chrome-extension: moz-extension: vscode-webview: vscode-file: https://*.vscode-cdn.net";

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

export function studioDir(): string | undefined {
  return STUDIO_DIRS.find((dir) => existsSync(resolve(dir, 'index.html')));
}

/** Serves /studio/* from the Studio build; returns false when the Studio is not built. */
export function serveStudio(res: ServerResponse, pathname: string): boolean {
  const root = studioDir();
  if (!root) return false;
  const rel = decodeURIComponent(pathname.replace(/^\/studio\/?/, '')) || 'index.html';
  const path = resolve(root, rel);
  const inside = relative(root, path);
  const file =
    !inside.startsWith('..') && !inside.split(sep).includes('..') && existsSync(path) && statSync(path).isFile()
      ? path
      : resolve(root, 'index.html');
  res.writeHead(200, {
    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    // Hashed assets can be cached; index.html must always be fresh
    'cache-control': file.endsWith('index.html') ? 'no-store' : 'public, max-age=31536000, immutable',
    'content-security-policy': FRAME_POLICY,
  });
  createReadStream(file).pipe(res);
  return true;
}

type ProxyRequest = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  binary?: boolean;
};

const METHODS = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);
const FORWARDED_HEADERS = new Set([
  'content-type',
  'soapaction',
  'accept',
  'sforce-call-options',
  'sforce-query-options',
]);
const SESSION_PLACEHOLDER = '{{SESSION_ID}}';
const COMETD = /^\/cometd\/\d+\.\d$/;

/**
 * Streaming (CometD) pins a client to one Salesforce server with cookies (BAYEUX_BROWSER),
 * which browsers keep but a proxy must keep itself: one jar per org.
 */
const cometdCookies = new Map<string, Map<string, string>>();

function cookieHeader(org: string): string {
  return [...(cometdCookies.get(org) ?? new Map<string, string>())].map(([k, v]) => `${k}=${v}`).join('; ');
}

function keepCookies(org: string, response: Response): void {
  const jar = cometdCookies.get(org) ?? new Map<string, string>();
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const at = pair.indexOf('=');
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  cometdCookies.set(org, jar);
}

/**
 * Forwards one Studio request to the org with the Salesforce CLI's access token.
 * Only /services/* API paths (and streaming POSTs to /cometd/<version>) are allowed; an
 * expired token is refreshed once.
 */
export async function proxySalesforce(
  org: string,
  body: Record<string, unknown>
): Promise<{ status: number; headers: Record<string, string>; body: string; bodyBase64?: string }> {
  const request = body as ProxyRequest;
  const method = String(request.method ?? 'GET').toUpperCase();
  const path = String(request.path ?? '');
  if (!METHODS.has(method)) throw new Error('Method not allowed.');
  const streaming = method === 'POST' && COMETD.test(path);
  if (!streaming && (!/^\/services\/[\w./%-]*(\?.*)?$/.test(path) || path.includes('..')))
    throw new Error('Only Salesforce /services/ API paths are allowed.');

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (FORWARDED_HEADERS.has(key.toLowerCase())) headers[key] = String(value);
  }

  const send = async (refresh: boolean): Promise<Response> => {
    const conn = await connect(org);
    if (refresh) await conn.refreshAuth?.();
    const token = String(conn.accessToken ?? '');
    const cookie = streaming ? cookieHeader(org) : '';
    return fetch(`${conn.instanceUrl}${path}`, {
      method,
      headers: { ...headers, Authorization: `Bearer ${token}`, ...(cookie ? { cookie } : {}) },
      body:
        request.body === undefined || method === 'GET'
          ? undefined
          : String(request.body).split(SESSION_PLACEHOLDER).join(token),
    });
  };

  let response = await send(false);
  if (response.status === 401) response = await send(true);
  if (streaming) keepCookies(org, response);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    if (['content-type', 'sforce-limit-info', 'sforce-locator', 'sforce-numberofrecords'].includes(key))
      responseHeaders[key] = value;
  });
  // Files (ContentVersion data, attachment bodies) travel base64-encoded in the JSON answer
  if (request.binary && response.ok)
    return {
      status: response.status,
      headers: responseHeaders,
      body: '',
      bodyBase64: Buffer.from(await response.arrayBuffer()).toString('base64'),
    };
  return { status: response.status, headers: responseHeaders, body: await response.text() };
}

/** Routes for the Studio; returns false when the request is not for the Studio. */
export async function handleStudioRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  readBody: (req: IncomingMessage) => Promise<Record<string, unknown>>,
  sendJson: (res: ServerResponse, status: number, body: unknown) => void
): Promise<boolean> {
  if (req.method === 'GET' && (pathname === '/studio' || pathname.startsWith('/studio/'))) {
    if (pathname === '/studio') {
      res.writeHead(302, { location: '/studio/' });
      res.end();
      return true;
    }
    if (!serveStudio(res, pathname)) {
      sendJson(res, 404, { error: 'NomadSF Studio is not built. Run: yarn build:studio' });
    }
    return true;
  }
  const match = /^\/api\/sf\/([^/]+)$/.exec(pathname);
  if (req.method === 'POST' && match) {
    sendJson(res, 200, await proxySalesforce(decodeURIComponent(match[1]), await readBody(req)));
    return true;
  }
  return false;
}
