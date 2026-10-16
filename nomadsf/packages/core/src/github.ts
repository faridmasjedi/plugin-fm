import type { ProjectEntry, ProjectFs } from './project.js';

/**
 * Read-only GitHub access for the Studio: pick any repository and branch the person can see
 * and read it as a project. Two transports: a token kept by the extension, or the local
 * NomadSF app, which calls GitHub with the GitHub CLI's login so no token reaches the browser.
 */

export type GitHubTransport = {
  /** GET on api.github.com; `raw` asks for file contents instead of JSON metadata. */
  get(path: string, raw?: boolean): Promise<{ status: number; text: string }>;
};

export type GitHubRepo = {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  description?: string;
  pushedAt?: string;
};

export function tokenTransport(token: string): GitHubTransport {
  return {
    async get(path, raw) {
      const res = await fetch(`https://api.github.com${path}`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      });
      return { status: res.status, text: await res.text() };
    },
  };
}

async function getJson<T>(api: GitHubTransport, path: string): Promise<T> {
  const res = await api.get(path);
  if (res.status >= 400) {
    let message = `GitHub answered ${res.status}`;
    try {
      message = (JSON.parse(res.text) as { message?: string; error?: string }).message ?? message;
    } catch {
      // keep the status
    }
    if (res.status === 401) message = 'GitHub rejected the login; connect again.';
    throw new Error(message);
  }
  return JSON.parse(res.text) as T;
}

export async function githubUser(api: GitHubTransport): Promise<{ login: string; name?: string }> {
  return getJson(api, '/user');
}

type RawRepo = {
  full_name: string;
  default_branch: string;
  private: boolean;
  description?: string | null;
  pushed_at?: string;
};

/** Repositories of the person (own, collaborator, organisations), most recently pushed first. */
export async function listRepos(api: GitHubTransport, maxPages = 5): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= maxPages; page++) {
    // eslint-disable-next-line no-await-in-loop
    const batch = await getJson<RawRepo[]>(api, `/user/repos?per_page=100&sort=pushed&page=${page}`);
    repos.push(
      ...batch.map((r) => ({
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        private: r.private,
        description: r.description ?? undefined,
        pushedAt: r.pushed_at,
      }))
    );
    if (batch.length < 100) break;
  }
  return repos;
}

export async function listBranches(api: GitHubTransport, fullName: string): Promise<string[]> {
  const branches = await getJson<Array<{ name: string }>>(api, `/repos/${fullName}/branches?per_page=100`);
  return branches.map((b) => b.name);
}

const SKIPPED = new Set(['node_modules', '.sf', '.sfdx', '.fm']);
const encodePath = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/**
 * A repository branch as a project. The whole tree comes in one call (GitHub cuts it at
 * about 100,000 entries); files are fetched when read.
 */
export function githubProjectFs(
  api: GitHubTransport,
  fullName: string,
  ref: string
): ProjectFs & { truncated(): boolean } {
  let tree: Promise<Map<string, ProjectEntry[]>> | undefined;
  let cut = false;
  const load = (): Promise<Map<string, ProjectEntry[]>> => {
    tree ??= getJson<{ tree: Array<{ path: string; type: string }>; truncated: boolean }>(
      api,
      `/repos/${fullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`
    ).then((body) => {
      cut = body.truncated;
      const dirs = new Map<string, ProjectEntry[]>([['', []]]);
      for (const item of body.tree) {
        if (item.type !== 'blob' && item.type !== 'tree') continue;
        const parts = item.path.split('/');
        if (parts.some((p) => SKIPPED.has(p))) continue;
        const parent = parts.slice(0, -1).join('/');
        if (!dirs.has(parent)) dirs.set(parent, []);
        dirs.get(parent)!.push({ name: parts[parts.length - 1], kind: item.type === 'tree' ? 'dir' : 'file' });
        if (item.type === 'tree' && !dirs.has(item.path)) dirs.set(item.path, []);
      }
      return dirs;
    });
    return tree;
  };
  return {
    name: fullName.split('/')[1] ?? fullName,
    truncated: () => cut,
    async list(dir) {
      const entries = (await load()).get(dir.replace(/^\/|\/$/g, ''));
      if (!entries) throw new Error(`Folder not found: ${dir}`);
      return [...entries].sort((a, b) => a.name.localeCompare(b.name));
    },
    async readText(path) {
      // analyzeProject reads the branch from .git/HEAD
      if (path === '.git/HEAD') return `ref: refs/heads/${ref}\n`;
      const res = await api.get(`/repos/${fullName}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`, true);
      return res.status === 200 ? res.text : undefined;
    },
  };
}

// ---------- "Sign in with GitHub" (OAuth device flow, needs a GitHub OAuth app's client ID) ----------

export type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
};

/* eslint-disable camelcase -- GitHub's OAuth wire format */
export async function startDeviceFlow(clientId: string, scope = 'repo read:org'): Promise<DeviceCode> {
  const res = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, scope }),
  });
  const body = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    interval?: number;
    expires_in?: number;
    error_description?: string;
  };
  if (!body.device_code) throw new Error(body.error_description ?? 'GitHub did not start the sign-in.');
  return {
    deviceCode: body.device_code,
    userCode: body.user_code ?? '',
    verificationUri: body.verification_uri ?? 'https://github.com/login/device',
    interval: body.interval ?? 5,
    expiresIn: body.expires_in ?? 900,
  };
}

/** Waits until the person enters the code on github.com; resolves with the access token. */
export async function finishDeviceFlow(clientId: string, code: DeviceCode, signal?: AbortSignal): Promise<string> {
  let interval = code.interval;
  const until = Date.now() + code.expiresIn * 1000;
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, interval * 1000));
    if (signal?.aborted) throw new Error('Sign-in cancelled.');
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        device_code: code.deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    // eslint-disable-next-line no-await-in-loop
    const body = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
    if (body.access_token) return body.access_token;
    if (body.error === 'slow_down') interval += 5;
    else if (body.error !== 'authorization_pending')
      throw new Error(body.error_description ?? body.error ?? 'Sign-in failed.');
  }
  throw new Error('The code expired; start the sign-in again.');
}
/* eslint-enable camelcase */
