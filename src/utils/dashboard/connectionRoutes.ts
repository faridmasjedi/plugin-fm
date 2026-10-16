import type { IncomingMessage, ServerResponse } from 'node:http';
import { assist, extractSoql, releaseContext, type AssistTask } from '../ai/assist.js';
import type { ProjectContext } from './projects.js';
import {
  connectWithKey,
  connectionStatus,
  disconnect,
  finishOpenRouterSignIn,
  openRouterSignInUrl,
  proxyGitHub,
} from './connections.js';

type Body = Record<string, unknown>;

export type ConnectionRouteContext = {
  port: number;
  project: ProjectContext;
  readBody: (req: IncomingMessage) => Promise<Body>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
};

type Handler = (req: IncomingMessage, res: ServerResponse, ctx: ConnectionRouteContext) => Promise<void> | void;

const ok = (res: ServerResponse, ctx: ConnectionRouteContext): void => ctx.sendJson(res, 200, { ok: true });

/** "Connect" routes of the local app: AI accounts and the read-only GitHub proxy. */
const ROUTES: Record<string, Handler> = {
  async 'POST ai/connect'(req, res, ctx) {
    const body = await ctx.readBody(req);
    connectWithKey(String(body.provider ?? ''), String(body.key ?? ''));
    ok(res, ctx);
  },
  async 'POST ai/disconnect'(req, res, ctx) {
    disconnect(String((await ctx.readBody(req)).provider ?? ''));
    ok(res, ctx);
  },
  'POST ai/connect/openrouter'(req, res, ctx) {
    ctx.sendJson(res, 200, { url: openRouterSignInUrl(ctx.port) });
  },
  // OpenRouter sends the browser back here with the code; then on to the AI page
  async 'GET ai/callback/openrouter'(req, res) {
    const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
    let note = 'connected';
    try {
      await finishOpenRouterSignIn(query.get('state') ?? '', query.get('code') ?? '');
    } catch (e) {
      note = `error:${(e as Error).message}`;
    }
    res.writeHead(302, { location: `/?ai=${encodeURIComponent(note)}#page=ai`, 'cache-control': 'no-store' });
    res.end();
  },
  // AI help in the Studio and the dashboard (explain a log / test / deployment, SOQL, release notes)
  async 'POST ai/assist'(req, res, ctx) {
    const body = await ctx.readBody(req);
    const task = String(body.task ?? '') as AssistTask;
    if (task === 'explain-deploy' || task === 'release-notes') throw new Error('Use the dedicated route.');
    const answer = await assist(ctx.project.cwd, task, body);
    ctx.sendJson(res, 200, task === 'soql' ? { ...answer, soql: extractSoql(answer.text) } : answer);
  },
  async 'POST ai/assist/deploy'(req, res, ctx) {
    const body = await ctx.readBody(req);
    const run = ctx.project.store().load(String(body.runId ?? ''));
    const stage = run?.stages.find((s) => s.id === body.stageId);
    if (!run || !stage) throw new Error('Run or stage not found.');
    const log = ctx.project.store().readLog(run.id, stage.id);
    const text = `Stage ${stage.id} (${stage.uses}) ${stage.status}${stage.error ? `: ${stage.error}` : ''}

Log:
${log}`;
    ctx.sendJson(res, 200, await assist(ctx.project.cwd, 'explain-deploy', { text }));
  },
  async 'POST ai/assist/release-notes'(req, res, ctx) {
    const body = await ctx.readBody(req);
    const range = releaseContext(
      ctx.project.cwd,
      typeof body.from === 'string' && body.from ? body.from : undefined,
      typeof body.to === 'string' && body.to ? body.to : undefined
    );
    const answer = await assist(ctx.project.cwd, 'release-notes', { text: range.text });
    ctx.sendJson(res, 200, { ...answer, from: range.from, to: range.to });
  },
  'GET github/status'(req, res, ctx) {
    ctx.sendJson(res, 200, connectionStatus().github);
  },
  async 'POST github'(req, res, ctx) {
    const answer = await proxyGitHub(String((await ctx.readBody(req)).path ?? ''));
    res.writeHead(answer.status, { 'content-type': answer.type, 'cache-control': 'no-store' });
    res.end(answer.body);
  },
};

export async function handleConnectionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  ctx: ConnectionRouteContext
): Promise<boolean> {
  const handler = ROUTES[`${req.method ?? 'GET'} ${parts.slice(1).join('/')}`];
  if (!handler) return false;
  await handler(req, res, ctx);
  return true;
}
