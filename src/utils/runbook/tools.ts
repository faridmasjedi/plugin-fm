import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AiToolDefinition } from '../ai/index.js';

/**
 * Tools the runbook agent can use. Every tool has a kind that decides whether a
 * human must approve the call:
 * - read: never changes anything (queries, reading repo files)
 * - local: changes repository files only; reviewed later in the pull request
 * - org: changes the Salesforce org
 * - manual: a person has to do something (e.g. in Setup) and confirm it
 */
export type ToolKind = 'read' | 'local' | 'org' | 'manual';

export type ToolContext = { cwd: string; targetOrg: string };

export type ToolOutcome = { content: string; isError?: boolean; changedFiles?: string[] };

type RunbookTool = AiToolDefinition & {
  kind: ToolKind | ((input: Record<string, unknown>) => ToolKind);
  summarize: (input: Record<string, unknown>) => string;
  execute?: (input: Record<string, unknown>, context: ToolContext) => ToolOutcome;
};

const MAX_OUTPUT = 20_000;

function truncate(text: string, max = MAX_OUTPUT): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated ${text.length - max} characters)` : text;
}

function sf(args: string[], cwd: string): ToolOutcome {
  const res = spawnSync('sf', args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024, timeout: 10 * 60_000 });
  const output = (res.stdout || '') + (res.stderr ? `\n${res.stderr}` : '');
  return { content: truncate(output.trim() || `exit code ${res.status ?? 1}`), isError: res.status !== 0 };
}

/** Resolves a model-supplied path and rejects anything outside the repository. */
export function confinePath(cwd: string, path: string): string {
  const root = resolve(cwd);
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || rel.split(sep)[0] === '.git') {
    throw new Error(`Path "${path}" is outside the repository.`);
  }
  return target;
}

/** sf commands the agent may run; `org` ones need approval. `sf org display` is excluded: it prints the access token. */
export const SF_ALLOWLIST: Record<string, ToolKind> = {
  'data query': 'read',
  'data get record': 'read',
  'sobject describe': 'read',
  'sobject list': 'read',
  'org list metadata': 'read',
  'org list metadata-types': 'read',
  'project retrieve preview': 'read',
  'apex get test': 'read',
  'data create record': 'org',
  'data update record': 'org',
  'data delete record': 'org',
  'data import tree': 'org',
  'data upsert bulk': 'org',
  'org assign permset': 'org',
  'org assign permsetlicense': 'org',
  'apex run test': 'org',
  'community publish': 'org',
  'agent activate': 'org',
  'agent deactivate': 'org',
  'project deploy start': 'org',
  'project retrieve start': 'local',
};

export function sfCommandKind(args: string[]): ToolKind | undefined {
  for (const words of [3, 2]) {
    const key = args.slice(0, words).join(' ');
    if (SF_ALLOWLIST[key]) return SF_ALLOWLIST[key];
  }
  return undefined;
}

function listFiles(dir: string, root: string, out: string[], limit: number): void {
  for (const entry of readdirSync(dir)) {
    if (out.length >= limit || entry === '.git' || entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listFiles(full, root, out, limit);
    else out.push(relative(root, full));
  }
}

export const RUNBOOK_TOOLS: RunbookTool[] = [
  {
    name: 'report_plan',
    description:
      'Declare the checklist of runbook steps, in order, before doing anything else. Call it once; each title is one step of the runbook.',
    inputSchema: {
      type: 'object',
      properties: { steps: { type: 'array', items: { type: 'string' }, description: 'Step titles in order' } },
      required: ['steps'],
    },
    kind: 'read',
    summarize: (i) => `Plan with ${(i.steps as unknown[] | undefined)?.length ?? 0} steps`,
  },
  {
    name: 'update_step',
    description: 'Record the outcome of a runbook step (1-based index from report_plan).',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'integer' },
        status: { type: 'string', enum: ['done', 'skipped', 'failed', 'manual'] },
        note: { type: 'string', description: 'What was done or why not' },
      },
      required: ['index', 'status'],
    },
    kind: 'read',
    summarize: (i) => `Step ${String(i.index)}: ${String(i.status)}`,
  },
  {
    name: 'soql_query',
    description: 'Run a read-only SOQL query against the target org. Use it to find IDs and to verify changes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        tooling: { type: 'boolean', description: 'Use the Tooling API (metadata objects such as ApexClass, Flow)' },
      },
      required: ['query'],
    },
    kind: 'read',
    summarize: (i) => String(i.query),
    execute: (i, c): ToolOutcome => {
      const query = String(i.query);
      if (!/^\s*select\b/i.test(query)) return { content: 'Only SELECT queries are allowed.', isError: true };
      return sf(
        [
          'data',
          'query',
          '--query',
          query,
          '--target-org',
          c.targetOrg,
          '--json',
          ...(i.tooling ? ['--use-tooling-api'] : []),
        ],
        c.cwd
      );
    },
  },
  {
    name: 'run_apex',
    description:
      'Run anonymous Apex in the target org (data fixes, record updates, scheduling jobs). State the purpose; the code is shown to a human for approval.',
    inputSchema: {
      type: 'object',
      properties: { purpose: { type: 'string' }, code: { type: 'string' } },
      required: ['purpose', 'code'],
    },
    kind: 'org',
    summarize: (i) => String(i.purpose),
    execute: (i, c): ToolOutcome => {
      const dir = mkdtempSync(join(tmpdir(), 'fm-apex-'));
      try {
        const file = join(dir, 'runbook.apex');
        writeFileSync(file, String(i.code));
        return sf(['apex', 'run', '--file', file, '--target-org', c.targetOrg, '--json'], c.cwd);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'sf_cli',
    description: `Run an allowlisted Salesforce CLI command against the target org. args excludes "sf", e.g. ["org","assign","permset","--name","Sales_Ops","--on-behalf-of","user@example.com"]. --target-org and --json are added. Allowed: ${Object.keys(
      SF_ALLOWLIST
    ).join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: { purpose: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } },
      required: ['purpose', 'args'],
    },
    kind: (i) => sfCommandKind((i.args as string[] | undefined) ?? []) ?? 'org',
    summarize: (i) => `sf ${((i.args as string[] | undefined) ?? []).join(' ')}`,
    execute: (i, c): ToolOutcome => {
      const args = ((i.args as unknown[] | undefined) ?? []).map(String);
      if (!sfCommandKind(args))
        return { content: `Command not allowed. Allowed: ${Object.keys(SF_ALLOWLIST).join(', ')}`, isError: true };
      if (args.some((a) => ['--target-org', '-o', '--json'].includes(a))) {
        return { content: 'Do not pass --target-org/-o or --json; they are added automatically.', isError: true };
      }
      const before = gitChangedFiles(c.cwd);
      const result = sf([...args, '--target-org', c.targetOrg, '--json'], c.cwd);
      const after = gitChangedFiles(c.cwd);
      return { ...result, changedFiles: after.filter((f) => !before.includes(f)) };
    },
  },
  {
    name: 'read_file',
    description: 'Read a file from the repository (metadata, scripts, data plans).',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    kind: 'read',
    summarize: (i) => String(i.path),
    execute: (i, c): ToolOutcome => {
      const path = confinePath(c.cwd, String(i.path));
      if (!existsSync(path)) return { content: 'File not found.', isError: true };
      return { content: truncate(readFileSync(path, 'utf8'), 50_000) };
    },
  },
  {
    name: 'list_files',
    description: 'List files under a repository directory (max 500).',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] },
    kind: 'read',
    summarize: (i) => String(i.dir),
    execute: (i, c): ToolOutcome => {
      const dir = confinePath(c.cwd, String(i.dir));
      if (!existsSync(dir)) return { content: 'Directory not found.', isError: true };
      const out: string[] = [];
      listFiles(dir, resolve(c.cwd), out, 500);
      return { content: out.join('\n') || '(empty)' };
    },
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a repository file (e.g. metadata that the runbook changes). Changed files are committed to a pull request for review.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' }, purpose: { type: 'string' } },
      required: ['path', 'content', 'purpose'],
    },
    kind: 'local',
    summarize: (i) => `${String(i.path)} — ${String(i.purpose ?? '')}`,
    execute: (i, c): ToolOutcome => {
      const path = confinePath(c.cwd, String(i.path));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, String(i.content));
      return { content: `Wrote ${String(i.path)}`, changedFiles: [relative(resolve(c.cwd), path)] };
    },
  },
  {
    name: 'request_manual_step',
    description:
      'Ask a person to do something the tools cannot (e.g. a Setup-only change). Give exact, numbered instructions; the run waits until they confirm it is done.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' }, instructions: { type: 'string' } },
      required: ['title', 'instructions'],
    },
    kind: 'manual',
    summarize: (i) => String(i.title),
    execute: (): ToolOutcome => ({ content: 'The person confirmed the manual step is done.' }),
  },
];

export function findTool(name: string): RunbookTool | undefined {
  return RUNBOOK_TOOLS.find((t) => t.name === name);
}

export function toolKind(tool: RunbookTool, input: Record<string, unknown>): ToolKind {
  return typeof tool.kind === 'function' ? tool.kind(input) : tool.kind;
}

/** Files that differ from HEAD (modified or untracked). */
export function gitChangedFiles(cwd: string): string[] {
  const res = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' });
  return (res.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).replace(/^"|"$/g, ''));
}
