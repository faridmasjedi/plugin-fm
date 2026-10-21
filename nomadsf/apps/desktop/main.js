'use strict';
/**
 * NomadSF desktop: starts the local NomadSF app (`sf fm dashboard`) for a Salesforce project
 * and shows it in a window. Runs, approvals, runbooks, AI and the whole Studio work as in the
 * browser; orgs come from the Salesforce CLI on this machine.
 */
const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const { join } = require('node:path');
const helpers = require('./src/app');

// Tests and portable setups can keep settings elsewhere
if (process.env.NOMADSF_USER_DATA) app.setPath('userData', process.env.NOMADSF_USER_DATA);

const SETTINGS = () => join(app.getPath('userData'), 'settings.json');
let child;
let port;
let win;

async function chooseProject(current) {
  const res = await dialog.showOpenDialog({
    title: 'Open a Salesforce project (folder with sfdx-project.json)',
    defaultPath: current,
    properties: ['openDirectory'],
  });
  if (res.canceled || !res.filePaths[0]) return undefined;
  if (!helpers.isProject(res.filePaths[0])) {
    await dialog.showMessageBox({ type: 'warning', message: 'That folder has no sfdx-project.json.' });
    return chooseProject(current);
  }
  return res.filePaths[0];
}

async function startApp(project) {
  port = await helpers.freePort(7007);
  const env = { ...process.env, PATH: helpers.shellPath() };
  delete env.ELECTRON_RUN_AS_NODE;
  // Own process group: `sf` is a wrapper, and stopping it must stop the Node server it starts
  child = spawn('sf', ['fm', 'dashboard', '--port', String(port)], {
    cwd: project,
    env,
    shell: process.platform === 'win32',
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('exit', () => (child = undefined));
  try {
    await helpers.waitForApp(port, 90_000, () => Boolean(child));
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      message: 'NomadSF could not start the local app.',
      detail: `${error.message}\n\nNomadSF needs the Salesforce CLI with plugin-fm:\n  sf plugins install https://github.com/faridmasjedi/plugin-fm`,
    });
    app.quit();
  }
}

async function switchProject() {
  const settings = helpers.readSettings(SETTINGS());
  const project = await chooseProject(settings.project);
  if (!project) return;
  const res = await fetch(`http://127.0.0.1:${port}/api/projects/select`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fm-dashboard': '1' },
    body: JSON.stringify({ path: project }),
  });
  if (!res.ok) {
    dialog.showErrorBox('NomadSF', (await res.json().catch(() => ({}))).error || 'Could not open that project.');
    return;
  }
  helpers.writeSettings(SETTINGS(), { ...settings, project });
  win.loadURL(`http://127.0.0.1:${port}/studio/`);
}

function menu() {
  const go = (path) => () => win && win.loadURL(`http://127.0.0.1:${port}${path}`);
  return Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Salesforce project…', accelerator: 'CmdOrCtrl+O', click: () => void switchProject() },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Go',
      submenu: [
        { label: 'Studio', accelerator: 'CmdOrCtrl+1', click: go('/studio/') },
        { label: 'Runs and releases', accelerator: 'CmdOrCtrl+2', click: go('/') },
        { label: 'Orgs', click: go('/#page=orgs') },
        { label: 'AI', click: go('/#page=ai') },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ]);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    title: 'NomadSF',
    // The NomadSF icon in the window and taskbar (Windows, Linux); macOS takes it from the app bundle
    icon: join(__dirname, 'build', 'icon.png'),
    backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  // Sign-ins (OpenRouter, GitHub) and Salesforce links open in the browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (helpers.isAppUrl(url, port)) return { action: 'allow' };
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!helpers.isAppUrl(url, port)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });
  // Opens on the Studio, like the browser and VS Code extensions
  win.loadURL(`http://127.0.0.1:${port}/studio/`);
  if (process.env.NOMADSF_SMOKE) {
    win.webContents.once('did-finish-load', () => {
      console.log(`SMOKE loaded ${win.webContents.getURL()} title=${win.getTitle()}`);
      setTimeout(async () => {
        if (process.env.NOMADSF_SMOKE_SHOT) {
          require('node:fs').writeFileSync(
            process.env.NOMADSF_SMOKE_SHOT,
            (await win.webContents.capturePage()).toPNG()
          );
        }
        app.quit();
      }, 2500);
    });
  }
}

app.whenReady().then(async () => {
  const settings = helpers.readSettings(SETTINGS());
  let project = process.env.NOMADSF_PROJECT || settings.project;
  if (!helpers.isProject(project)) project = await chooseProject();
  if (!project) return app.quit();
  helpers.writeSettings(SETTINGS(), { ...settings, project });
  await startApp(project);
  Menu.setApplicationMenu(menu());
  createWindow();
});

app.on('window-all-closed', () => app.quit());
function stopApp() {
  if (!child) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}

app.on('quit', stopApp);
