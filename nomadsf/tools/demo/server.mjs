// The Studio for the guide recordings: serves the built Studio (packages/ui/dist) as the NomadSF app
// does, with two made-up demo scratch orgs. Salesforce calls are forwarded with the orgs' CLI logins;
// the page never sees a token. Run: node tools/demo/server.mjs [port]
import { Org } from '@salesforce/core-bundle';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = join(here, '../../packages/ui/dist');
const port = Number(process.argv[2] ?? 7171);
// A Salesforce project folder for Release › Project (read only), as the NomadSF app offers its own
const project = process.env.DEMO_PROJECT ? resolve(process.env.DEMO_PROJECT) : undefined;
const inProject = (path) => {
  const full = normalize(join(project, path ?? ''));
  if (full !== project && !full.startsWith(`${project}/`)) throw new Error('Outside the project.');
  return full;
};

// A real AI for the ✦ buttons, when ~/.nomadsf-demo-ai.env names one (FM_AI_PROVIDER, FM_AI_MODEL, FM_AI_KEY,
// optional FM_AI_BASE_URL): the Studio's own prompts (packages/core, bundled here) go to that provider. The key
// stays in this process; it is never printed. Without the file the ✦ buttons answer "Not in the demo".
const aiFile = join(homedir(), '.nomadsf-demo-ai.env');
let ai;
if (existsSync(aiFile)) {
  const env = Object.fromEntries(
    readFileSync(aiFile, 'utf8')
      .split('\n')
      .map((l) => l.replace(/\s+#.*$/, '').trim())
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  );
  const core = join(here, '.recordings', 'core.mjs');
  execFileSync(join(here, '../../node_modules/.bin/esbuild'), [
    join(here, '../../packages/core/src/ai.ts'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    '--log-level=error',
    `--outfile=${core}`,
  ]);
  const { aiAssist, aiChat, AI_PRESETS } = await import(core);
  const settings = {
    provider: env.FM_AI_PROVIDER,
    model: env.FM_AI_MODEL,
    apiKey: env.FM_AI_KEY,
    baseUrl: env.FM_AI_BASE_URL,
  };
  ai = {
    provider: AI_PRESETS[settings.provider]?.label ?? settings.provider,
    // Newer tasks come as a ready-made prompt (task 'chat'); the older ones by name
    answer: async (body) => {
      if (body.task !== 'chat') return aiAssist(settings, body.task, body);
      const reply = await aiChat(settings, String(body.system ?? ''), String(body.message ?? ''));
      return { ...reply, provider: ai.provider, sentChars: String(body.message ?? '').length };
    },
  };
  console.log(`AI for the ✦ buttons: ${ai.provider} · ${settings.model}`);
}

/** The demo orgs: the name shown in the Studio, and the CLI alias of the scratch org. */
const ORGS = [
  { id: 'acme-uat', alias: 'nomadsf-demo', type: 'Sandbox' },
  { id: 'acme-dev', alias: 'nomadsf-demo-b', type: 'Sandbox' },
];

// The CLI's login of each org (refreshed by @salesforce/core when it expires)
const connections = new Map();
async function connect(org, fresh = false) {
  if (fresh || !connections.has(org.id)) {
    const conn = (await Org.create({ aliasOrUsername: org.alias })).getConnection();
    if (fresh) await conn.refreshAuth();
    connections.set(org.id, conn);
  }
  return connections.get(org.id);
}

// Streaming (Events) pins a client to one server with cookies: kept per org, as a browser would
const cometdCookies = new Map();

const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const bodyOf = (req) =>
  new Promise((resolve) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname === '/api/orgs')
      return json(
        res,
        200,
        await Promise.all(
          ORGS.map(async (o) => ({
            alias: o.id,
            username: o.id,
            type: o.type,
            instanceUrl: (await connect(o)).instanceUrl,
          }))
        )
      );
    const sf = /^\/api\/sf\/([^/]+)$/.exec(url.pathname);
    if (sf && req.method === 'POST') {
      const org = ORGS.find((o) => o.id === decodeURIComponent(sf[1]));
      if (!org) return json(res, 404, { error: 'No such demo org.' });
      const request = JSON.parse(await bodyOf(req));
      const streaming = request.path.startsWith('/cometd/');
      const send = async (fresh) => {
        const conn = await connect(org, fresh);
        const token = String(conn.accessToken);
        const jar = streaming ? cometdCookies.get(org.id) : undefined;
        return fetch(conn.instanceUrl + request.path, {
          method: request.method,
          headers: {
            Authorization: `Bearer ${token}`,
            ...(request.headers ?? {}),
            ...(jar?.size ? { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
          },
          body: request.method === 'GET' ? undefined : request.body?.split('{{SESSION_ID}}').join(token),
        });
      };
      let response = await send(false);
      // An expired login: REST answers 401, the Metadata API a SOAP fault
      const expired = async (r) =>
        r.status === 401 || (r.status === 500 && (await r.clone().text()).includes('INVALID_SESSION_ID'));
      if (await expired(response)) response = await send(true);
      if (streaming) {
        const jar = cometdCookies.get(org.id) ?? new Map();
        for (const c of response.headers.getSetCookie()) {
          const [pair] = c.split(';');
          const at = pair.indexOf('=');
          jar.set(pair.slice(0, at).trim(), pair.slice(at + 1));
        }
        cometdCookies.set(org.id, jar);
      }
      const headers = {};
      response.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      if (request.binary && response.ok)
        return json(res, 200, {
          status: response.status,
          headers,
          body: '',
          bodyBase64: Buffer.from(await response.arrayBuffer()).toString('base64'),
        });
      return json(res, 200, { status: response.status, headers, body: await response.text() });
    }
    if (project && url.pathname === '/api/projects') {
      const current = { name: basename(project), path: project, sfdx: true };
      return json(res, 200, { current, recent: [current] });
    }
    if (project && url.pathname === '/api/project/list') {
      const entries = await readdir(inProject(url.searchParams.get('dir')), { withFileTypes: true });
      return json(
        res,
        200,
        entries
          .filter((e) => !['node_modules', '.git', '.sf', '.sfdx'].includes(e.name))
          .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'dir' : 'file' }))
      );
    }
    if (project && url.pathname === '/api/project/file') {
      const text = await readFile(inProject(url.searchParams.get('path')), 'utf8');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end(text);
    }
    if (ai && url.pathname === '/api/ai')
      return json(res, 200, { current: { apiKeySet: true, provider: ai.provider } });
    if (ai && url.pathname === '/api/ai/assist' && req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      try {
        return json(res, 200, await ai.answer(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
      } catch (e) {
        return json(res, 502, { error: e.message });
      }
    }
    // The app's other services (opening an org…) are not part of the demo
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not in the demo.' });

    const file = normalize(join(dist, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(dist)) return json(res, 403, { error: 'No.' });
    const data = await readFile(file).catch(() => readFile(join(dist, 'index.html')));
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  } catch (e) {
    if (res.headersSent) res.end();
    else json(res, 500, { error: e.message });
  }
}).listen(port, () => console.log(`NomadSF demo Studio on http://localhost:${port}`));
