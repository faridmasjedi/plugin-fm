import { createHash, randomBytes } from 'node:crypto';
import {
  PROVIDER_PRESETS,
  connectedProviders,
  githubCliToken,
  removeConnectedKey,
  saveConnectedKey,
  type AiProviderId,
} from '../ai/index.js';

/**
 * "Connect" actions of the local NomadSF app: AI accounts and GitHub.
 * - OpenRouter: browser sign-in (OAuth PKCE); OpenRouter hands back a key for this user.
 * - GitHub Models: the GitHub CLI's login (gh auth login), nothing stored.
 * - Others: a key pasted once, kept in ~/.nomadsf/credentials.json (mode 600).
 * - GitHub repositories: read-only REST calls with the gh login, for the Studio's repo browser.
 */

const OPENROUTER_AUTH = 'https://openrouter.ai/auth';
const OPENROUTER_KEYS = 'https://openrouter.ai/api/v1/auth/keys';
const PENDING_TTL = 10 * 60_000;
const pending = new Map<string, { verifier: string; at: number }>();

const base64url = (data: Buffer): string => data.toString('base64url');

/** Where the browser goes to sign in to OpenRouter; it comes back to the callback with a code. */
export function openRouterSignInUrl(port: number): string {
  for (const [state, entry] of pending) if (Date.now() - entry.at > PENDING_TTL) pending.delete(state);
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(16));
  pending.set(state, { verifier, at: Date.now() });
  const callback = new URL(`http://localhost:${port}/api/ai/callback/openrouter`);
  callback.searchParams.set('state', state);
  const url = new URL(OPENROUTER_AUTH);
  url.searchParams.set('callback_url', callback.toString());
  url.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/** Exchanges the code from OpenRouter's redirect for a key and stores it. */
export async function finishOpenRouterSignIn(state: string, code: string): Promise<void> {
  const entry = pending.get(state);
  pending.delete(state);
  if (!entry || Date.now() - entry.at > PENDING_TTL) throw new Error('The sign-in expired; try Connect again.');
  if (!code) throw new Error('OpenRouter did not return a code.');
  const res = await fetch(OPENROUTER_KEYS, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // eslint-disable-next-line camelcase
    body: JSON.stringify({ code, code_verifier: entry.verifier, code_challenge_method: 'S256' }),
  });
  const body = (await res.json().catch(() => ({}))) as { key?: string; error?: { message?: string } };
  if (!res.ok || !body.key) throw new Error(body.error?.message ?? `OpenRouter refused the sign-in (${res.status}).`);
  saveConnectedKey('openrouter', body.key, 'OpenRouter sign-in');
}

export function connectWithKey(provider: string, key: string): void {
  if (!(provider in PROVIDER_PRESETS)) throw new Error('Unknown provider.');
  saveConnectedKey(provider as AiProviderId, key, 'key pasted in the app');
}

export function disconnect(provider: string): void {
  if (!(provider in PROVIDER_PRESETS)) throw new Error('Unknown provider.');
  removeConnectedKey(provider as AiProviderId);
}

export function connectionStatus(): {
  connected: ReturnType<typeof connectedProviders>;
  github: { cli: boolean; login?: string };
} {
  return { connected: connectedProviders(), github: { cli: Boolean(githubCliToken()) } };
}

/** Read-only GitHub REST paths the Studio may call through the app. */
const GITHUB_PATHS = [
  /^\/user$/,
  /^\/user\/repos(\?.*)?$/,
  /^\/user\/orgs(\?.*)?$/,
  /^\/orgs\/[\w.-]+\/repos(\?.*)?$/,
  /^\/repos\/[\w.-]+\/[\w.-]+(\/(branches|git\/trees\/[^?]+|contents\/[^?]*))?(\?.*)?$/,
];

/** GET on api.github.com with the GitHub CLI's login; the token never reaches the browser. */
export async function proxyGitHub(path: string): Promise<{ status: number; type: string; body: string }> {
  if (path.includes('..') || !GITHUB_PATHS.some((re) => re.test(path))) throw new Error('GitHub path not allowed.');
  const token = githubCliToken();
  if (!token) throw new Error('The GitHub CLI is not logged in. Run: gh auth login');
  const raw = path.includes('/contents/');
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'NomadSF',
    },
  });
  return { status: res.status, type: res.headers.get('content-type') ?? 'application/json', body: await res.text() };
}
