#!/usr/bin/env node
// NomadQA headless runner: runs NomadQA test files in Chrome, with nothing to install (Node 22+, Chrome).
//
//   node nomadqa/runner/run.mjs my-test.nomadqa.json [more.json | a-group.nomadqa-group.json | a.junit.xml]
//        --org uat [--logins logins.json] [--parallel 4] [--headed] [--out reports]
//
// --parallel N runs N tests at the same time, each in a browser context of its own (its own cookies: a test that
// logs in as someone else does not change the others).
//
// "Log in" steps take their username and password from --logins (or NOMADQA_LOGINS, the same JSON):
//   { "sales-user": { "url": "https://test.salesforce.com", "username": "…", "password": "…" } }
//
// Login: --org <alias> asks the Salesforce CLI for a one-time login link (sf org open --url-only); or give that link
// yourself with --login-url or NOMADQA_LOGIN_URL (CI). The session stays in the browser and in memory: nothing is
// written but the reports (JUnit XML, and a screenshot of each failed step).
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Salesforce } from '../extension/core/salesforce.js';
import { runTest, stepText, junit, groupJunit, testsFromFile } from '../extension/core/steps.js';

const ENGINE = readFileSync(fileURLToPath(new URL('../extension/core/engine.js', import.meta.url)), 'utf8');

function args(argv) {
  const out = { files: [], headed: false, out: 'nomadqa-reports' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--org') out.org = argv[++i];
    else if (a === '--login-url') out.loginUrl = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--logins') out.logins = argv[++i];
    else if (a === '--chrome') out.chrome = argv[++i];
    else if (a === '--parallel') out.parallel = Math.max(1, parseInt(argv[++i], 10) || 1);
    else if (a === '--headed') out.headed = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.files.push(a);
  }
  return out;
}

function chromePath(given) {
  const list = [
    given,
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const found = list.find((p) => existsSync(p));
  if (!found) throw new Error('Chrome not found: give --chrome <path> or set CHROME_PATH.');
  return found;
}

/** A small Chrome DevTools Protocol client over Node's own WebSocket. */
class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.waiting = new Map();
    this.listeners = [];
    this.opened = new Promise((ok, fail) => {
      this.ws.addEventListener('open', ok);
      this.ws.addEventListener('error', fail);
    });
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id && this.waiting.has(msg.id)) {
        const { ok, fail } = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        msg.error ? fail(new Error(msg.error.message)) : ok(msg.result);
      } else for (const l of this.listeners) l(msg);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise((ok, fail) => this.waiting.set(id, { ok, fail }));
  }
  once(method, sessionId, timeout = 60000) {
    return new Promise((ok, fail) => {
      const t = setTimeout(() => {
        this.listeners = this.listeners.filter((l) => l !== fn);
        fail(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      const fn = (msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          clearTimeout(t);
          this.listeners = this.listeners.filter((l) => l !== fn);
          ok(msg.params);
        }
      };
      this.listeners.push(fn);
    });
  }
  close() {
    this.ws.close();
  }
}

async function launch(opts) {
  const profile = mkdtempSync(join(tmpdir(), 'nomadqa-'));
  const chrome = spawn(
    chromePath(opts.chrome),
    [
      ...(opts.headed ? [] : ['--headless=new']),
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,900',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
  const wsUrl = await new Promise((ok, fail) => {
    let buf = '';
    const t = setTimeout(() => fail(new Error('Chrome did not start.')), 30000);
    chrome.stderr.on('data', (d) => {
      buf += d;
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(t);
        ok(m[1]);
      }
    });
    chrome.on('exit', () => fail(new Error('Chrome closed at start.')));
  });
  const cdp = new Cdp(wsUrl);
  await cdp.opened;
  const first = await tab(cdp);
  return {
    cdp,
    ...first,
    /** A tab in a browser context of its own, logged in with a copy of the first tab's cookies. */
    async isolated() {
      const { browserContextId } = await cdp.send('Target.createBrowserContext', { disposeOnDetach: true });
      const { cookies } = await cdp.send('Storage.getCookies', {});
      await cdp.send('Storage.setCookies', {
        browserContextId,
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          httpOnly: c.httpOnly,
          ...(c.sameSite ? { sameSite: c.sameSite } : {}),
          ...(c.expires > 0 ? { expires: c.expires } : {}),
        })),
      });
      const t = await tab(cdp, browserContextId);
      return {
        ...t,
        async close() {
          await cdp.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
        },
      };
    },
    async close() {
      cdp.close();
      chrome.kill();
      await sleep(500);
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A tab (in a browser context, or the first one) and its driver for the step engine. */
async function tab(cdp, browserContextId) {
  const { targetId } = await cdp.send('Target.createTarget', {
    url: 'about:blank',
    ...(browserContextId ? { browserContextId } : {}),
  });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);

  /** Evaluates in NomadQA's own isolated world (where Lightning's components are plain DOM). */
  async function inPage(expression, tries = 6) {
    for (let i = 0; ; i++) {
      try {
        const tree = await cdp.send('Page.getFrameTree', {}, sessionId);
        const world = await cdp.send(
          'Page.createIsolatedWorld',
          { frameId: tree.frameTree.frame.id, worldName: 'nomadqa' },
          sessionId
        );
        await cdp.send('Runtime.evaluate', { contextId: world.executionContextId, expression: ENGINE }, sessionId);
        const r = await cdp.send(
          'Runtime.evaluate',
          { contextId: world.executionContextId, expression, awaitPromise: true, returnByValue: true },
          sessionId
        );
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'page error');
        return r.result.value;
      } catch (e) {
        if (i >= tries || !/context|navigat|destroyed|not found|Cannot find/i.test(e.message)) throw e;
        await sleep(1000);
      }
    }
  }

  const driver = {
    async open(url) {
      const loaded = cdp.once('Page.loadEventFired', sessionId, 90000);
      await cdp.send('Page.navigate', { url }, sessionId);
      await loaded;
      await inPage('__nomadqa.ready(90000)');
    },
    // The login form makes the page go away: it runs once, never again on the next page
    step: (s) =>
      s.action === 'login-form'
        ? inPage(`__nomadqa.run(${JSON.stringify(s)})`, 0).catch(() => undefined)
        : inPage(`__nomadqa.run(${JSON.stringify(s)})`),
    async load(url) {
      const loaded = cdp.once('Page.loadEventFired', sessionId, 90000);
      await cdp.send('Page.navigate', { url }, sessionId);
      await loaded;
    },
    url: () => inPage('location.href'),
    // After the login form is sent: the redirects end on Lightning (or stay on a login or verification page)
    async settle(timeout = 90000) {
      const end = Date.now() + timeout;
      let still = 0;
      let last = '';
      while (Date.now() < end) {
        await sleep(700);
        const now = await inPage('location.href', 2).catch(() => '');
        if (/\/lightning\//.test(now)) return void (await inPage('__nomadqa.ready(60000)'));
        still = now && now === last ? still + 1 : 0;
        last = now;
        if (still > 12) return;
      }
    },
    async shot() {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      return `data:image/png;base64,${r.data}`;
    },
  };
  async function session(host) {
    const { cookies } = await cdp.send('Network.getCookies', { urls: [`https://${host}`] }, sessionId);
    return cookies.find((c) => c.name === 'sid')?.value;
  }
  return {
    driver,
    session,
    async login(url) {
      const loaded = cdp.once('Page.loadEventFired', sessionId, 120000);
      await cdp.send('Page.navigate', { url }, sessionId);
      await loaded;
      await inPage('__nomadqa.ready(120000)');
    },
  };
}

async function main() {
  const opts = args(process.argv.slice(2));
  if (opts.help || !opts.files.length) {
    console.log(
      'Usage: node nomadqa/runner/run.mjs <test.nomadqa.json | group.json | report.junit.xml…> --org <alias> [--logins logins.json] [--parallel N] [--headed] [--out <folder>]'
    );
    process.exit(opts.help ? 0 : 2);
  }
  const loginUrl =
    opts.loginUrl ??
    process.env.NOMADQA_LOGIN_URL ??
    (opts.org
      ? JSON.parse(execFileSync('sf', ['org', 'open', '--url-only', '--json', '-o', opts.org], { encoding: 'utf8' }))
          .result.url
      : undefined);
  if (!loginUrl) throw new Error('Give --org <alias> (Salesforce CLI) or --login-url.');
  const host = new URL(loginUrl).host;
  // A test, a group of tests, or a JUnit report NomadQA wrote: every test in it
  const tests = opts.files.flatMap((f) => {
    const text = readFileSync(f, 'utf8');
    const list = testsFromFile(text);
    const group = /^\s*\{/.test(text) && JSON.parse(text).nomadqa === 'group' ? JSON.parse(text).name : '';
    return list.map((test, i) => ({
      file: list.length > 1 ? `${f.replace(/\.(json|xml)$/, '')}-${i + 1}.json` : f,
      test,
      group,
    }));
  });
  const logins = JSON.parse(opts.logins ? readFileSync(opts.logins, 'utf8') : process.env.NOMADQA_LOGINS ?? '{}');
  const groups = new Map();
  mkdirSync(opts.out, { recursive: true });
  const browser = await launch(opts);
  let failedTests = 0;
  try {
    console.log(`Logging in to ${host}…`);
    await browser.login(loginUrl);
    const sid = await browser.session(host);
    if (!sid) throw new Error('Logged in, but no session was found for the API.');
    const sf = new Salesforce(host, sid);
    const parallel = Math.min(opts.parallel ?? 1, tests.length);
    const runOne = async ({ file, test, group }, driver) => {
      const lines = [`\n${test.name ?? basename(file)}`];
      const say = (line) => (parallel > 1 ? lines.push(line) : console.log(line));
      if (parallel === 1) console.log(lines.shift());
      const run = await runTest(test, {
        driver,
        sf,
        logins,
        onStep: (i, r) => {
          const mark = r.ok ? '✓' : r.ok === null ? '·' : '✕';
          say(`  ${mark} ${i + 1}. ${stepText(test.steps[i])}${r.ok === false ? `\n      ${r.message}` : ''}`);
        },
      }).catch((e) => ({ ok: false, ms: 0, results: [{ ok: false, message: e.message, ms: 0 }] }));
      const stem = basename(file).replace(/\.json$/, '');
      writeFileSync(join(opts.out, `${stem}.junit.xml`), junit(test, run));
      run.results.forEach((r, i) => {
        if (r.shot)
          writeFileSync(join(opts.out, `${stem}-step${i + 1}.png`), Buffer.from(r.shot.split(',')[1], 'base64'));
      });
      say(
        `  ${run.ok ? 'passed' : 'FAILED'} in ${(run.ms / 1000).toFixed(1)} s${
          run.cleaned ? ` · ${run.cleaned} test record(s) deleted` : ''
        }`
      );
      // Side by side, a test's lines are written together when it ends
      if (parallel > 1) console.log(lines.join('\n'));
      if (!run.ok) failedTests++;
      return { group, test, run };
    };
    const results = new Array(tests.length);
    if (parallel === 1) for (const [k, t] of tests.entries()) results[k] = await runOne(t, browser.driver);
    else {
      console.log(`${tests.length} tests, ${parallel} at a time…`);
      let next = 0;
      await Promise.all(
        Array.from({ length: parallel }, async () => {
          const tab = await browser.isolated();
          try {
            while (next < tests.length) {
              const k = next++;
              results[k] = await runOne(tests[k], tab.driver);
            }
          } finally {
            await tab.close();
          }
        })
      );
    }
    for (const { group, test, run } of results.filter(Boolean))
      if (group) groups.set(group, [...(groups.get(group) ?? []), { test, run }]);
    // One report for each group as well
    for (const [name, list] of groups)
      writeFileSync(
        join(opts.out, `${name.replace(/[^\w-]+/g, '-').toLowerCase()}.group.junit.xml`),
        groupJunit(name, list)
      );
  } finally {
    await browser.close();
  }
  console.log(`\n${tests.length - failedTests} of ${tests.length} test(s) passed · reports in ${opts.out}`);
  process.exit(failedTests ? 1 : 0);
}

main().catch((e) => {
  console.error(`NomadQA: ${e.message}`);
  process.exit(2);
});
