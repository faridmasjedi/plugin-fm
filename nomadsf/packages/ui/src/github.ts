import { tokenTransport, type GitHubTransport } from '@nomadsf/core';
import { storage } from './context';
import { localAppBase } from './project';

/**
 * How the Studio reaches GitHub:
 * - token: a token from "Sign in with GitHub" or pasted by the person, kept in this browser profile;
 * - app: the local NomadSF app, using the GitHub CLI's login (the token stays on the machine).
 */
export type GitHubConnection = { mode: 'token' | 'app'; api: GitHubTransport };

const TOKEN_KEY = 'github.token';

/** Client ID of a GitHub OAuth app with device flow enabled (build setting or entered once). */
export const githubClientId = (): string =>
  storage.get('github.clientId', '') ||
  ((import.meta as unknown as { env?: Record<string, string> }).env?.VITE_NOMADSF_GITHUB_CLIENT_ID ?? '');

export function appTransport(base: string): GitHubTransport {
  return {
    async get(path) {
      const res = await fetch(`${base}/api/github`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fm-dashboard': '1' },
        body: JSON.stringify({ path }),
      });
      return { status: res.status, text: await res.text() };
    },
  };
}

export const githubToken = {
  get: (): string => storage.get(TOKEN_KEY, ''),
  set: (token: string): void => storage.set(TOKEN_KEY, token.trim()),
  clear: (): void => storage.set(TOKEN_KEY, ''),
};

/** The connection to use now: a stored token first, then the local app's gh login. */
export async function currentGitHub(hostKind: 'app' | 'extension'): Promise<GitHubConnection | undefined> {
  const token = githubToken.get();
  if (token) return { mode: 'token', api: tokenTransport(token) };
  const base = localAppBase(hostKind);
  try {
    const res = await fetch(`${base}/api/github/status`, { cache: 'no-store' });
    if (res.ok && ((await res.json()) as { cli?: boolean }).cli) return { mode: 'app', api: appTransport(base) };
  } catch {
    // local app not running
  }
  return undefined;
}

export type GitHubRepoChoice = { fullName: string; ref: string };
export const lastRepo = {
  get: (): GitHubRepoChoice | undefined => storage.get<GitHubRepoChoice | undefined>('github.repo', undefined),
  set: (choice: GitHubRepoChoice): void => storage.set('github.repo', choice),
};
