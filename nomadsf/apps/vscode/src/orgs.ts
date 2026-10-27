import { AuthInfo, Org, WebOAuthServer, type Connection } from '@salesforce/core-bundle';

/**
 * The Studio's orgs in VS Code: the Salesforce CLI's logins, read from its files with
 * @salesforce/core (bundled), so neither the CLI nor the local app has to be installed.
 * Tokens stay in the extension; the Studio only sends requests (like the app's /api/sf).
 * Kept free of the VS Code API so it is easy to test.
 */

export type OrgChoice = { id: string; label: string; type?: string; instanceUrl?: string };

export type ProxyRequest = {
  method?: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
  binary?: boolean;
};

export type ProxyResponse = { status: number; headers: Record<string, string>; body: string; bodyBase64?: string };

type Auth = Awaited<ReturnType<typeof AuthInfo.listAllAuthorizations>>[number];

/** Every login of the CLI, by alias when it has one (the same list as `sf org list`). */
export function toChoices(auths: Auth[]): OrgChoice[] {
  return auths.map((auth) => {
    const name = auth.aliases?.[0] ?? auth.username;
    return {
      id: name,
      label: name,
      type: auth.isDevHub ? 'Dev Hub' : auth.isScratchOrg ? 'Scratch' : auth.isSandbox ? 'Sandbox' : 'Production',
      instanceUrl: auth.instanceUrl,
    };
  });
}

export async function listOrgs(): Promise<OrgChoice[]> {
  return toChoices(await AuthInfo.listAllAuthorizations());
}

const connections = new Map<string, { conn: Connection; at: number }>();

/** Connection with the CLI's login for an alias or username (cached 10 minutes). */
async function connect(org: string): Promise<Connection> {
  const hit = connections.get(org);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.conn;
  const conn = (await Org.create({ aliasOrUsername: org })).getConnection();
  connections.set(org, { conn, at: Date.now() });
  return conn;
}

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

/** Streaming (CometD) pins a client to one Salesforce server with cookies: one jar per org. */
const cometdCookies = new Map<string, Map<string, string>>();

function keepCookies(org: string, response: Response): void {
  const jar = cometdCookies.get(org) ?? new Map<string, string>();
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(';');
    const at = pair.indexOf('=');
    if (at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim());
  }
  cometdCookies.set(org, jar);
}

/** Which requests the Studio may send: /services/* API paths and streaming POSTs (as the app allows). */
export function checkRequest(request: ProxyRequest): { method: string; path: string; streaming: boolean } {
  const method = String(request.method ?? 'GET').toUpperCase();
  const path = String(request.path ?? '');
  if (!METHODS.has(method)) throw new Error('Method not allowed.');
  const streaming = method === 'POST' && COMETD.test(path);
  if (!streaming && (!/^\/services\/[\w./%-]*(\?.*)?$/.test(path) || path.includes('..')))
    throw new Error('Only Salesforce /services/ API paths are allowed.');
  return { method, path, streaming };
}

/** Sends one Studio request to the org with the CLI's access token; an expired token is refreshed once. */
export async function proxySalesforce(org: string, request: ProxyRequest): Promise<ProxyResponse> {
  const { method, path, streaming } = checkRequest(request);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (FORWARDED_HEADERS.has(key.toLowerCase())) headers[key] = String(value);
  }

  const send = async (refresh: boolean): Promise<Response> => {
    const conn = await connect(org);
    if (refresh) await conn.refreshAuth();
    const token = String(conn.accessToken ?? '');
    const jar = streaming ? cometdCookies.get(org) : undefined;
    const cookie = jar ? [...jar].map(([k, v]) => `${k}=${v}`).join('; ') : '';
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
  // Files (ContentVersion data, attachment bodies) travel base64-encoded
  if (request.binary && response.ok)
    return {
      status: response.status,
      headers: responseHeaders,
      body: '',
      bodyBase64: Buffer.from(await response.arrayBuffer()).toString('base64'),
    };
  return { status: response.status, headers: responseHeaders, body: await response.text() };
}

/** A page of the org, logged in through its front door (like `sf org open --path`). */
export async function frontDoorUrl(org: string, path: string): Promise<string> {
  // Salesforce paths and queries only (no other site, no scripts)
  if (!/^\/[\w/.?=&%+:#~,!-]*$/.test(path)) throw new Error('Invalid path.');
  const conn = await connect(org);
  await conn.refreshAuth();
  const sid = encodeURIComponent(String(conn.accessToken ?? ''));
  return `${conn.instanceUrl}/secur/frontdoor.jsp?sid=${sid}&retURL=${encodeURIComponent(path)}`;
}

/** Login addresses the Studio offers: Salesforce's login pages or an org's own domain. */
export function checkLoginUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !/\.(salesforce|force)\.com$/.test(parsed.hostname))
    throw new Error('Log in on a Salesforce address (https://….salesforce.com).');
  return parsed.origin;
}

/**
 * The CLI's browser login (`sf org login web`): Salesforce's login page in the browser, then the
 * login is saved where the CLI keeps it, with the alias. Resolves with the username.
 */
export async function loginWeb(
  loginUrl: string,
  alias: string | undefined,
  open: (url: string) => void
): Promise<string> {
  const server = await WebOAuthServer.create({ oauthConfig: { loginUrl: checkLoginUrl(loginUrl) } });
  await server.start();
  open(server.getAuthorizationUrl());
  const auth = await server.authorizeAndSave();
  await auth.handleAliasAndDefaultSettings({ alias, setDefault: false, setDefaultDevHub: false });
  const username = auth.getUsername();
  for (const key of [...connections.keys()]) if (key === alias || key === username) connections.delete(key);
  return username;
}
