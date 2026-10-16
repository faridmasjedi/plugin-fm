import type { IncomingMessage, ServerResponse } from 'node:http';
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
