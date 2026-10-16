'use strict';
/**
 * Helpers of the NomadSF desktop app, free of Electron so they can be tested with Node:
 * the user's shell PATH (GUI apps on macOS do not get it), free ports, waiting for the app.
 */
const { spawnSync } = require('node:child_process');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { createServer } = require('node:net');
const { dirname, join } = require('node:path');

/** PATH of a login shell, so `sf` (Homebrew, npm global, nvm…) is found from Finder or the Dock. */
function shellPath(env = process.env) {
  if (process.platform === 'win32') return env.PATH;
  const shell = env.SHELL || '/bin/zsh';
  const res = spawnSync(shell, ['-ilc', 'printf "__PATH__%s" "$PATH"'], { encoding: 'utf8', timeout: 5000 });
  const found = /__PATH__(.*)$/s.exec(res.stdout || '');
  return found ? found[1].trim() : env.PATH;
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function freePort(from = 7007, tries = 50) {
  for (let port = from; port < from + tries; port++) {
    // eslint-disable-next-line no-await-in-loop
    if (await portFree(port)) return port;
  }
  throw new Error('No free port for the local app.');
}

async function appInfo(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/info`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
}

async function waitForApp(port, timeoutMs, isAlive) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    const info = await appInfo(port);
    if (info) return info;
    if (!isAlive()) throw new Error('The local app stopped while starting.');
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new Error(`The local app did not start on port ${port}.`);
}

const isProject = (dir) => Boolean(dir) && existsSync(join(dir, 'sfdx-project.json'));

function readSettings(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(file, settings) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Only pages of the local app stay in the window; everything else opens in the browser. */
function isAppUrl(url, port) {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost') && Number(u.port) === port
    );
  } catch {
    return false;
  }
}

module.exports = { shellPath, freePort, appInfo, waitForApp, isProject, readSettings, writeSettings, isAppUrl };
