import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import {
  AI_CONFIG_FILE,
  PROVIDER_PRESETS,
  describeAiConfig,
  loadAiConfig,
  resolveApiKey,
  type AiConfig,
  type AiProviderId,
} from '../ai/index.js';
import { DEPLOY_TAG_PREFIX } from '../deployTagUtils.js';

/**
 * Data and actions behind the dashboard's Orgs, Repo, Runbooks and AI pages.
 * Org access uses the Salesforce CLI's own authentication; nothing is stored here.
 */

export type OrgInfo = {
  alias?: string;
  username: string;
  instanceUrl?: string;
  type: 'Dev Hub' | 'Sandbox' | 'Scratch' | 'Production';
  connected: string;
  expires?: string;
};

const SAFE_NAME = /^[\w.@+-]{1,80}$/;
let orgCache: { at: number; orgs: OrgInfo[] } | undefined;

function run(cmd: string, args: string[], cwd: string, timeout = 30_000): { ok: boolean; out: string } {
  const res = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 20 * 1024 * 1024 });
  return { ok: res.status === 0, out: (res.stdout ?? '').trim() };
}

export function listOrgs(cwd: string, refresh = false): OrgInfo[] {
  if (!refresh && orgCache && Date.now() - orgCache.at < 30_000) return orgCache.orgs;
  const res = run('sf', ['org', 'list', '--json'], cwd, 60_000);
  type RawOrg = Record<string, unknown>;
  let groups: Record<string, RawOrg[]> = {};
  try {
    groups = (JSON.parse(res.out) as { result?: Record<string, RawOrg[]> }).result ?? {};
  } catch {
    groups = {};
  }
  const byUser = new Map<string, OrgInfo>();
  for (const org of Object.values(groups).flat()) {
    const username = String(org.username ?? '');
    if (!username || byUser.has(username)) continue;
    const type: OrgInfo['type'] = org.isDevHub
      ? 'Dev Hub'
      : org.isScratch
      ? 'Scratch'
      : org.isSandbox
      ? 'Sandbox'
      : 'Production';
    byUser.set(username, {
      alias: org.alias ? String(org.alias) : undefined,
      username,
      instanceUrl: org.instanceUrl ? String(org.instanceUrl) : undefined,
      type,
      connected: String(org.connectedStatus ?? org.status ?? 'Unknown'),
      expires: org.expirationDate ? String(org.expirationDate) : undefined,
    });
  }
  orgCache = { at: Date.now(), orgs: [...byUser.values()] };
  return orgCache.orgs;
}

/** Opens the browser login of the Salesforce CLI for a new org. */
export function loginOrg(cwd: string, alias: string, instanceUrl: string): void {
  if (!SAFE_NAME.test(alias)) throw new Error('Alias may only contain letters, digits and . _ - @ +');
  const url = new URL(instanceUrl);
  if (url.protocol !== 'https:') throw new Error('The login URL must use https.');
  orgCache = undefined;
  spawn('sf', ['org', 'login', 'web', '--alias', alias, '--instance-url', url.origin], {
    cwd,
    detached: true,
    stdio: 'ignore',
  }).unref();
}

/** Opens the org in the browser, optionally at a path (e.g. a record or "login as" link). */
export function openOrg(cwd: string, org: string, path?: string): void {
  if (!SAFE_NAME.test(org)) throw new Error('Unknown org.');
  const args = ['org', 'open', '--target-org', org];
  if (path) {
    if (!/^\/[\w/.?=&%+-]*$/.test(path)) throw new Error('Invalid path.');
    args.push('--path', path);
  }
  spawn('sf', args, { cwd, detached: true, stdio: 'ignore' }).unref();
}

function stripCredentials(remote: string): string {
  try {
    const url = new URL(remote);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    return remote; // scp-style git@host:org/repo
  }
}

export type RepoInfo = {
  remote?: string;
  branch?: string;
  commits: Array<{ sha: string; short: string; subject: string; author: string; date: string }>;
  deployments: Array<{ tag: string; branch: string; commit: string; date: string }>;
  pullRequests?: Array<{
    number: number;
    title: string;
    branch: string;
    author: string;
    url: string;
    updatedAt: string;
  }>;
  pullRequestsError?: string;
};

export function repoInfo(cwd: string, includePullRequests = true): RepoInfo {
  const remote = run('git', ['remote', 'get-url', 'origin'], cwd);
  const commits = run('git', ['log', '-20', '--format=%H%x1f%h%x1f%s%x1f%an%x1f%aI'], cwd)
    .out.split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, short, subject, author, date] = line.split('\x1f');
      return { sha, short, subject, author, date };
    });
  const deployments = run(
    'git',
    [
      'for-each-ref',
      `refs/tags/${DEPLOY_TAG_PREFIX}`,
      '--sort=-creatordate',
      '--count=50',
      '--format=%(refname:short)%1f%(*objectname:short)%1f%(objectname:short)%1f%(creatordate:iso8601-strict)',
    ],
    cwd
  )
    .out.split('\n')
    .filter(Boolean)
    .map((line) => {
      // Annotated tags: the peeled commit is in the second field; lightweight tags point at the commit directly
      const [tag, peeled, object, date] = line.split('\x1f');
      return { tag, branch: tag.split('/').slice(1, -1).join('/'), commit: peeled || object, date };
    });

  const info: RepoInfo = {
    remote: remote.ok ? stripCredentials(remote.out) : undefined,
    branch: run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd).out,
    commits,
    deployments,
  };
  if (includePullRequests) {
    const prs = run(
      'gh',
      ['pr', 'list', '--limit', '20', '--json', 'number,title,headRefName,author,url,updatedAt'],
      cwd,
      15_000
    );
    if (prs.ok) {
      type RawPr = {
        number: number;
        title: string;
        headRefName: string;
        author?: { login?: string };
        url: string;
        updatedAt: string;
      };
      info.pullRequests = (JSON.parse(prs.out || '[]') as RawPr[]).map((p) => ({
        number: p.number,
        title: p.title,
        branch: p.headRefName,
        author: p.author?.login ?? '',
        url: p.url,
        updatedAt: p.updatedAt,
      }));
    } else {
      info.pullRequestsError = 'GitHub CLI not available or not logged in (gh auth login).';
    }
  }
  return info;
}

const RUNBOOKS_DIR = '.fm/runbooks';

export type RunbookFile = { path: string; title: string; content: string };

export function listRunbooks(cwd: string): RunbookFile[] {
  const root = resolve(cwd, RUNBOOKS_DIR);
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.toLowerCase().endsWith('.md')) files.push(full);
    }
  };
  walk(root);
  return files.sort().map((full) => {
    const content = readFileSync(full, 'utf8');
    return {
      path: relative(cwd, full).split(sep).join('/'),
      title: /^#\s+(.+)$/m.exec(content)?.[1] ?? relative(root, full),
      content,
    };
  });
}

/** Starts `sf fm runbook run` for a runbook in .fm/runbooks, with approvals in the dashboard. */
export function startRunbook(
  cwd: string,
  runCommand: string[],
  request: { file: string; org: string; plan?: boolean; pr?: boolean; runsDir: string }
): void {
  const file = resolve(cwd, request.file);
  const rel = relative(resolve(cwd, RUNBOOKS_DIR), file);
  if (rel.startsWith('..') || !existsSync(file)) throw new Error('Runbook not found in .fm/runbooks.');
  if (!SAFE_NAME.test(request.org)) throw new Error('Choose a connected org.');
  const [cmd, ...args] = runCommand;
  args.push(
    'fm',
    'runbook',
    'run',
    '--file',
    request.file,
    '--target-org',
    request.org,
    '--wait-for-approval',
    '--runs-dir',
    request.runsDir
  );
  if (request.plan) args.push('--plan');
  if (request.pr) args.push('--pr');
  spawn(cmd, args, { cwd, detached: true, stdio: 'ignore', env: process.env }).unref();
}

export function aiSettings(cwd: string): {
  current?: ReturnType<typeof describeAiConfig>;
  error?: string;
  configFile: string;
  providers: Array<{
    id: string;
    label: string;
    defaultModel?: string;
    baseUrl?: string;
    apiKeyEnv?: string;
    apiKeySet: boolean;
    keySource: string;
  }>;
} {
  let current: ReturnType<typeof describeAiConfig> | undefined;
  let error: string | undefined;
  try {
    current = describeAiConfig(loadAiConfig(cwd));
  } catch (e) {
    error = (e as Error).message;
  }
  return {
    current,
    error,
    configFile: AI_CONFIG_FILE,
    providers: Object.entries(PROVIDER_PRESETS).map(([id, p]) => {
      const keySource =
        p.auth === 'none' ? 'none' : resolveApiKey({ provider: id as AiProviderId, apiKeyEnv: p.apiKeyEnv }).source;
      return {
        id,
        label: p.label,
        defaultModel: p.defaultModel,
        baseUrl: p.baseUrl,
        apiKeyEnv: p.apiKeyEnv,
        apiKeySet: p.auth === 'none' || keySource !== 'none',
        keySource,
      };
    }),
  };
}

/** Saves provider settings to .fm/ai.yml. Keys are never written; only the variable name. */
export function saveAiSettings(cwd: string, input: Record<string, unknown>): void {
  const provider = String(input.provider ?? '') as AiProviderId;
  if (!PROVIDER_PRESETS[provider]) throw new Error('Unknown provider.');
  const config: Partial<AiConfig> = { provider };
  for (const key of ['model', 'baseUrl', 'apiKeyEnv', 'effort'] as const) {
    const value = typeof input[key] === 'string' ? input[key].trim() : '';
    if (value) (config as Record<string, string>)[key] = value;
  }
  if (config.apiKeyEnv && !/^[A-Z_][A-Z0-9_]*$/.test(config.apiKeyEnv))
    throw new Error('apiKeyEnv must be an environment variable name.');
  if (config.baseUrl) new URL(config.baseUrl);
  const path = resolve(cwd, AI_CONFIG_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `# AI provider for plugin-fm runbooks. Keys come from environment variables or the app's Connect button (~/.nomadsf), never from this file.\n${stringify(
      config
    )}`
  );
}
