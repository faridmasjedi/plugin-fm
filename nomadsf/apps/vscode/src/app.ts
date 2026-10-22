/**
 * Talks to the local NomadSF app (`sf fm dashboard`): is it up, which project does it serve,
 * switch it to the workspace's project. Kept free of the VS Code API so it is easy to test.
 */

export type AppInfo = { project?: { name: string; path: string }; version?: string };

/** True when version `a` is older than `b` (x.y.z; a missing version counts as older). */
export function isOlder(a: string | undefined, b: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/, '')
      .split(/[.-]/)
      .slice(0, 3)
      .map((n) => Number(n) || 0);
  if (!a) return true;
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

export const GUIDE_URL = 'https://faridmasjedi.github.io/plugin-fm/guide.html';
export const PLUGIN_INSTALL = 'sf plugins install https://github.com/faridmasjedi/plugin-fm';

const HEADERS = { 'content-type': 'application/json', 'x-fm-dashboard': '1' };

export function baseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export async function appInfo(port: number, timeoutMs = 1500): Promise<AppInfo | undefined> {
  try {
    const res = await fetch(`${baseUrl(port)}/api/info`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as AppInfo) : undefined;
  } catch {
    return undefined;
  }
}

export async function waitForApp(port: number, timeoutMs: number, isAlive: () => boolean): Promise<AppInfo> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    const info = await appInfo(port);
    if (info) return info;
    if (!isAlive()) throw new Error('The local app stopped while starting; see the NomadSF output.');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`The local app did not start on port ${port}.`);
}

/** Makes the running app serve this project (it keeps a list of recent projects). */
export async function selectProject(port: number, path: string): Promise<void> {
  const res = await fetch(`${baseUrl(port)}/api/projects/select`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ path }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok || body.error) throw new Error(body.error ?? `HTTP ${res.status}`);
}

const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/** Path (with hash) inside the app for a target: app, studio page, a record or a query. */
export function targetPath(
  target:
    | { kind: 'app' }
    | { kind: 'studio'; page?: string }
    | { kind: 'record'; id: string }
    | { kind: 'query'; soql: string }
): string {
  // A changing query string makes the frame load again (a new hash alone would not)
  const fresh = `v=${Date.now()}`;
  switch (target.kind) {
    case 'app':
      return `/?${fresh}`;
    case 'studio':
      return `/studio/?${fresh}${target.page ? `#${target.page}` : ''}`;
    case 'record':
      if (!ID.test(target.id)) throw new Error('Select a 15- or 18-character record Id.');
      return `/studio/?${fresh}#record=${target.id}`;
    case 'query':
      if (!/^\s*select\b/i.test(target.soql)) throw new Error('Select a SOQL query (SELECT …).');
      return `/studio/?${fresh}#query=${encodeURIComponent(target.soql.trim())}`;
  }
}

/** Studio tools by hub (the ids are the Studio's #links). */
export const STUDIO_PAGES = [
  ['apex', 'Execute Apex', 'Develop'],
  ['code', 'Code', 'Develop'],
  ['apextests', 'Apex tests', 'Develop'],
  ['logs', 'Debug Logs', 'Develop'],
  ['query', 'Query', 'Data'],
  ['record', 'Record', 'Data'],
  ['data', 'Import / Update / Delete', 'Data'],
  ['lookup', 'Lookup', 'Data'],
  ['fields', 'Field usage', 'Data'],
  ['backup', 'Backup and restore', 'Data protection'],
  ['migrate', 'Migrate', 'Data protection'],
  ['lifecycle', 'Lifecycle', 'Data protection'],
  ['project', 'Project', 'Release'],
  ['metadata', 'Metadata', 'Release'],
  ['orgdiff', 'Org compare', 'Release'],
  ['tests', 'E2E tests', 'Release'],
  ['access', 'Users & access', 'Org'],
  ['apps', 'Connected apps', 'Org'],
  ['limits', 'Limits', 'Org'],
  ['events', 'Events', 'Org'],
  ['rest', 'REST Explorer', 'Org'],
  ['activity', 'Activity', 'Org'],
  ['settings', 'Settings', 'Settings'],
] as const;
