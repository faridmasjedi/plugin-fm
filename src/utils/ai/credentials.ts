import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiConfig, AiProviderId } from './types.js';

/**
 * Keys from the app's "Connect" buttons, kept outside every project in a file only the
 * user can read (~/.nomadsf/credentials.json, mode 600), so they never end up in a repository.
 * Environment variables still win, so CI keeps working unchanged.
 */

export type KeySource = 'env' | 'connected' | 'gh' | 'none';

type Stored = { ai?: Partial<Record<AiProviderId, { key: string; connectedAt: string; via: string }>> };

const dir = (): string => process.env.NOMADSF_HOME ?? join(homedir(), '.nomadsf');
const file = (): string => join(dir(), 'credentials.json');

function read(): Stored {
  try {
    return JSON.parse(readFileSync(file(), 'utf8')) as Stored;
  } catch {
    return {};
  }
}

function write(data: Stored): void {
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  writeFileSync(file(), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file(), 0o600);
}

export function saveConnectedKey(provider: AiProviderId, key: string, via: string): void {
  const value = key.trim();
  if (value.length < 8 || /\s/.test(value)) throw new Error('That does not look like an API key.');
  const data = read();
  data.ai = { ...data.ai, [provider]: { key: value, connectedAt: new Date().toISOString(), via } };
  write(data);
}

export function removeConnectedKey(provider: AiProviderId): void {
  const data = read();
  if (!data.ai?.[provider]) return;
  delete data.ai[provider];
  write(data);
}

/** Providers connected through the app (no keys returned). */
export function connectedProviders(): Partial<Record<AiProviderId, { connectedAt: string; via: string }>> {
  if (!existsSync(file())) return {};
  return Object.fromEntries(
    Object.entries(read().ai ?? {}).map(([id, entry]) => [id, { connectedAt: entry.connectedAt, via: entry.via }])
  );
}

/** The GitHub CLI's login token, used for GitHub Models and repository access. */
export function githubCliToken(): string | undefined {
  const res = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 10_000 });
  const token = res.status === 0 ? res.stdout.trim() : '';
  return token || undefined;
}

/** API key for a provider: environment variable, then a connected key, then (GitHub Models) the gh login. */
export function resolveApiKey(config: Pick<AiConfig, 'provider' | 'apiKeyEnv'>): {
  key?: string;
  source: KeySource;
} {
  const fromEnv = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  if (fromEnv) return { key: fromEnv, source: 'env' };
  const stored = read().ai?.[config.provider]?.key;
  if (stored) return { key: stored, source: 'connected' };
  if (config.provider === 'github-models') {
    const token = githubCliToken();
    if (token) return { key: token, source: 'gh' };
  }
  return { source: 'none' };
}
