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

type StudioTarget =
  | { kind: 'studio'; page?: string }
  | { kind: 'record'; id: string }
  | { kind: 'query'; soql: string };

/** The Studio's #link for a target: a tool, a record or a query ('' = the last tool used). */
export function studioHash(target: StudioTarget): string {
  switch (target.kind) {
    case 'studio':
      return target.page ?? '';
    case 'record':
      if (!ID.test(target.id)) throw new Error('Select a 15- or 18-character record Id.');
      return `record=${target.id}`;
    case 'query':
      if (!/^\s*select\b/i.test(target.soql)) throw new Error('Select a SOQL query (SELECT …).');
      return `query=${encodeURIComponent(target.soql.trim())}`;
  }
}

/** Path (with hash) inside the app for a target: app, studio page, a record or a query. */
export function targetPath(target: { kind: 'app' } | StudioTarget): string {
  // A changing query string makes the frame load again (a new hash alone would not)
  const fresh = `v=${Date.now()}`;
  if (target.kind === 'app') return `/?${fresh}`;
  const hash = studioHash(target);
  return `/studio/?${fresh}${hash ? `#${hash}` : ''}`;
}

/** Studio tools by hub (the ids are the Studio's #links). */
export const STUDIO_PAGES = [
  ['code', 'Code', 'Develop'],
  ['apex', 'Execute Apex', 'Develop'],
  ['apextests', 'Apex tests', 'Develop'],
  ['logs', 'Debug logs', 'Develop'],
  ['jobs', 'Jobs', 'Develop'],
  ['automation', 'Automation', 'Develop'],
  ['events', 'Events', 'Develop'],
  ['rest', 'REST Explorer', 'Develop'],
  ['query', 'Query', 'Data'],
  ['record', 'Record', 'Data'],
  ['data', 'Import / Update / Delete', 'Data'],
  ['csvcompare', 'Compare with CSV', 'Data'],
  ['lookup', 'Lookup', 'Data'],
  ['schema', 'Schema', 'Data'],
  ['fields', 'Field usage', 'Data'],
  ['project', 'Project', 'Release'],
  ['metadata', 'Metadata', 'Release'],
  ['deployments', 'Deployments', 'Release'],
  ['access', 'Users', 'Access'],
  ['permsets', 'Permission sets', 'Access'],
  ['permissions', 'Permissions', 'Access'],
  ['custperms', 'Custom permissions', 'Access'],
  ['groups', 'Groups & queues', 'Access'],
  ['assigned', 'Assigned users', 'Access'],
  ['objectaccess', 'Object access', 'Access'],
  ['accessmap', 'Overview', 'Access'],
  ['compare', 'Compare', 'Access'],
  ['myaccess', 'Your access', 'Access'],
  ['company', 'Company information', 'Org'],
  ['health', 'Org health', 'Org'],
  ['limits', 'Limits', 'Org'],
  ['apps', 'Connected apps', 'Org'],
  ['audit', 'Logins & audit', 'Org'],
  ['activity', 'Activity', 'Org'],
  ['backup', 'Backup and restore', 'Data protection'],
  ['lifecycle', 'Lifecycle', 'Data protection'],
  ['migrate', 'Migrate', 'Org to org'],
  ['orgdiff', 'Org compare', 'Org to org'],
  ['orgaccess', 'Access', 'Org to org'],
  ['orgapps', 'Connected apps', 'Org to org'],
  ['settings', 'Settings', 'Settings'],
] as const;

/** The system's own "open this link" command, with the link as one argument (no shell). */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}
