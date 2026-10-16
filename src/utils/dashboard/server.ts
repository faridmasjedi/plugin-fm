import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RunStore } from '../pipeline/store.js';
import type { RunState } from '../pipeline/types.js';
import {
  aiSettings,
  listOrgs,
  listRunbooks,
  loginOrg,
  openOrg,
  repoInfo,
  saveAiSettings,
  startRunbook,
  type RepoInfo,
} from './appApi.js';
import { handleOrgRoute } from './orgRoutes.js';
import { ProjectContext } from './projects.js';
import { FRAME_POLICY, handleStudioRoute } from './studio.js';

const TEMPLATE_URL = new URL('../../../dashboard/index.html', import.meta.url);
const MAX_EXPORTED_LOG = 20_000;

export type DashboardInfo = {
  mode: 'live' | 'static';
  pipelineName?: string;
  configPath?: string;
  canStart: boolean;
  generatedAt: string;
};

export type DashboardData = {
  info: DashboardInfo;
  runs: RunState[];
  logs?: Record<string, Record<string, string>>;
  /** Repository snapshot (deployment tags, commits, pull requests) for static exports. */
  repo?: RepoInfo;
};

function template(): string {
  return readFileSync(TEMPLATE_URL, 'utf8');
}

function embed(html: string, data: DashboardData): string {
  // Escape "</" so run content can never close the script tag
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return html.replace('<!--FM_DATA-->', `<script>window.__FM_DATA__ = ${json};</script>`);
}

/**
 * Builds a self-contained HTML dashboard (runs and log tails embedded) for CI artifacts.
 */
export function renderStaticDashboard(
  store: RunStore,
  info: Omit<DashboardInfo, 'mode' | 'canStart' | 'generatedAt'>,
  cwd = process.cwd()
): string {
  const runs = store.list();
  const logs: DashboardData['logs'] = {};
  for (const run of runs) {
    logs[run.id] = {};
    for (const stage of run.stages) {
      const log = store.readLog(run.id, stage.id);
      if (log) logs[run.id][stage.id] = log.length > MAX_EXPORTED_LOG ? `…\n${log.slice(-MAX_EXPORTED_LOG)}` : log;
    }
  }
  return embed(template(), {
    info: { ...info, mode: 'static', canStart: false, generatedAt: new Date().toISOString() },
    runs,
    logs,
    repo: repoInfo(cwd),
  });
}

export type ServeOptions = {
  /** Current Salesforce project (switchable from the app). */
  project: ProjectContext;
  port: number;
  /** Command line of this plugin's CLI, e.g. [node, bin/run.js], used to start runbooks. */
  pluginCommand: string[];
  runsDir: string;
  user: string;
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolveBody) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolveBody(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch {
        resolveBody({});
      }
    });
  });
}

/**
 * Serves the live dashboard on 127.0.0.1. Approvals and cancel requests are written
 * to the run's control file, which the pipeline runner polls.
 */
export function startDashboardServer(options: ServeOptions): Promise<Server> {
  const { project } = options;
  const store = (): RunStore => project.store();
  const info = (): DashboardInfo & { project: ReturnType<typeof ProjectContext.summary> } => ({
    mode: 'live',
    ...project.pipeline(),
    canStart: Boolean(project.startCommand()),
    generatedAt: new Date().toISOString(),
    project: ProjectContext.summary(project.cwd),
  });

  const handleRun = async (req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> => {
    const run = store().load(parts[2]);
    if (!run) return sendJson(res, 404, { error: 'Run not found' });

    if (req.method === 'GET' && parts.length === 3) return sendJson(res, 200, run);
    if (req.method === 'GET' && parts[3] === 'logs' && parts[4]) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(store().readLog(run.id, parts[4]));
      return;
    }
    if (req.method === 'POST' && parts[3] === 'approve' && parts[4]) {
      const body = await readBody(req);
      const decision = body.decision === 'reject' ? 'reject' : 'approve';
      store().updateControl(run.id, (c) => {
        c.approvals[parts[4]] = { decision, by: options.user, at: new Date().toISOString() };
      });
      return sendJson(res, 200, { ok: true, decision });
    }
    if (req.method === 'POST' && parts[3] === 'cancel') {
      store().updateControl(run.id, (c) => {
        c.cancel = { by: options.user, at: new Date().toISOString() };
      });
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Not found' });
  };

  /** Project list / switch, and read-only file access inside the current project. */
  const handleProject = async (req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = `${req.method ?? 'GET'} ${parts.slice(1).join('/')}`;
    if (route === 'GET projects') return sendJson(res, 200, project.list());
    if (route === 'POST projects/select') {
      const selected = project.select(String((await readBody(req)).path ?? ''));
      return sendJson(res, 200, { ok: true, current: selected });
    }
    if (route === 'GET project/list') return sendJson(res, 200, project.listDir(url.searchParams.get('dir') ?? ''));
    if (route === 'GET project/file') {
      // Read first: an error must still be able to answer with JSON
      const text = project.readFile(url.searchParams.get('path') ?? '');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text);
      return;
    }
    return sendJson(res, 404, { error: 'Not found' });
  };

  const handleStart = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const startCommand = project.startCommand();
    if (!startCommand) return sendJson(res, 400, { error: 'No pipeline file found to start.' });
    const body = await readBody(req);
    const [cmd, ...args] = startCommand;
    args.push('--wait-for-approval', '--trigger', 'dashboard');
    if (body.stepByStep) args.push('--step-by-step');
    if (typeof body.release === 'string' && body.release.trim()) args.push('--release', body.release.trim());
    const child = spawn(cmd, args, { cwd: project.cwd, detached: true, stdio: 'ignore', env: process.env });
    child.unref();
    return sendJson(res, 202, { ok: true });
  };

  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);

  /**
   * The server only listens on 127.0.0.1, but a web page in the browser could still try to
   * reach it. Reject other Host names (DNS rebinding) and cross-site POSTs: actions need a
   * custom header, which browsers only send cross-origin after a CORS preflight we never allow.
   */
  const isTrusted = (req: IncomingMessage): boolean => {
    if (!allowedHosts.has(req.headers.host ?? '')) return false;
    if (req.method === 'GET') return true;
    const origin = req.headers.origin;
    // The NomadSF browser extension calls the app from its own origin; websites never can
    const fromExtension = origin !== undefined && /^(chrome|moz)-extension:\/\/[\w-]+$/.test(origin);
    if (origin && !fromExtension && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) return false;
    return req.headers['x-fm-dashboard'] === '1';
  };

  const handleApp = async (req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> => {
    const { cwd } = project;
    const route = `${req.method ?? 'GET'} ${parts.slice(1).join('/')}`;
    switch (route) {
      case 'GET orgs':
        return sendJson(res, 200, listOrgs(cwd, new URL(req.url ?? '/', 'http://x').searchParams.has('refresh')));
      case 'POST orgs/login': {
        const body = await readBody(req);
        loginOrg(cwd, String(body.alias ?? ''), String(body.instanceUrl ?? 'https://login.salesforce.com'));
        return sendJson(res, 202, { ok: true });
      }
      case 'POST orgs/open':
        openOrg(cwd, String((await readBody(req)).org ?? ''));
        return sendJson(res, 202, { ok: true });
      case 'GET repo':
        return sendJson(res, 200, repoInfo(cwd));
      case 'GET runbooks':
        return sendJson(res, 200, listRunbooks(cwd));
      case 'POST runbooks/run': {
        const body = await readBody(req);
        startRunbook(cwd, options.pluginCommand, {
          file: String(body.file ?? ''),
          org: String(body.org ?? ''),
          plan: Boolean(body.plan),
          pr: Boolean(body.pr),
          runsDir: options.runsDir,
        });
        return sendJson(res, 202, { ok: true });
      }
      case 'GET ai':
        return sendJson(res, 200, aiSettings(cwd));
      case 'POST ai':
        saveAiSettings(cwd, await readBody(req));
        return sendJson(res, 200, aiSettings(cwd));
      default:
        return sendJson(res, 404, { error: 'Not found' });
    }
  };

  /** The dashboard page and its Org explorer script. */
  const servePage = (res: ServerResponse, pathname: string): boolean => {
    const page = {
      '/': { type: 'text/html', body: template },
    }[pathname];
    if (!page) return false;
    res.writeHead(200, {
      'content-type': `${page.type}; charset=utf-8`,
      'cache-control': 'no-store',
      'content-security-policy': FRAME_POLICY,
    });
    res.end(page.body());
    return true;
  };

  /** /api/* routes. */
  const handleApi = async (req: IncomingMessage, res: ServerResponse, parts: string[]): Promise<void> => {
    if (req.method === 'GET' && parts[1] === 'info') return sendJson(res, 200, info());
    if (req.method === 'GET' && parts[1] === 'runs' && parts.length === 2) return sendJson(res, 200, store().list());
    if (parts[1] === 'runs' && parts[2]) return handleRun(req, res, parts);
    if (req.method === 'POST' && parts[1] === 'start') return handleStart(req, res);
    if (parts[1] === 'projects' || parts[1] === 'project') return handleProject(req, res, parts);
    if (parts[1] === 'org' || parts[1] === 'e2e') {
      const context = {
        cwd: project.cwd,
        runsDir: options.runsDir,
        pluginCommand: options.pluginCommand,
        readBody,
        sendJson,
      };
      const handled = await handleOrgRoute(req, res, parts, context);
      if (handled) return;
    }
    return handleApp(req, res, parts);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isTrusted(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

    if (await handleStudioRoute(req, res, url.pathname, readBody, sendJson)) return;
    if (req.method === 'GET' && servePage(res, url.pathname)) return;
    if (parts[0] !== 'api') return sendJson(res, 404, { error: 'Not found' });
    return handleApi(req, res, parts);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: Error) => {
      // Never let one failed request take the app down
      if (res.headersSent) res.end();
      else sendJson(res, 400, { error: error.message });
    });
  });

  return new Promise((resolveServer, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => resolveServer(server));
  });
}
