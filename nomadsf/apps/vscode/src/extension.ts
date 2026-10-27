import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  GUIDE_URL,
  PLUGIN_INSTALL,
  STUDIO_PAGES,
  appInfo,
  baseUrl,
  isOlder,
  selectProject,
  studioHash,
  targetPath,
  waitForApp,
} from './app';
import { handleCall } from './bridge';

/**
 * NomadSF for VS Code: NomadSF Studio in an editor tab, shipped with the extension (dist/studio)
 * and working on its own with the Salesforce CLI's logins (orgs.ts; the CLI is not needed).
 * "Open the app" shows the local NomadSF app (`sf fm dashboard`) when the sf fm plugin is installed.
 */

let child: ChildProcess | undefined;
let panel: vscode.WebviewPanel | undefined;
let memento: vscode.Memento | undefined;
let extensionVersion = '';
let versionChecked = false;

/** The Studio comes from the sf fm plugin: an older plugin shows an older Studio, so offer the update once. */
function checkPluginVersion(pluginVersion: string | undefined): void {
  if (versionChecked || !extensionVersion || !isOlder(pluginVersion, extensionVersion)) return;
  versionChecked = true;
  void vscode.window
    .showWarningMessage(
      `NomadSF: the sf fm plugin (${
        pluginVersion || 'an older version'
      }) is older than this extension (${extensionVersion}), so the Studio may miss the latest features. Update the plugin, then restart NomadSF.`,
      'Update the plugin',
      'Not now'
    )
    .then((choice) => {
      if (choice !== 'Update the plugin') return;
      const terminal = vscode.window.createTerminal('NomadSF update');
      terminal.show();
      terminal.sendText(PLUGIN_INSTALL);
      void vscode.window.showInformationMessage(
        'NomadSF: when the update finishes, run "NomadSF: Stop the local app" and open the Studio again.'
      );
    });
}
const output = vscode.window.createOutputChannel('NomadSF');

const settings = (): { port: number; sf: string; autoStart: boolean } => {
  const config = vscode.workspace.getConfiguration('nomadsf');
  return {
    port: config.get<number>('port', 7007),
    sf: config.get<string>('sfCommand', 'sf'),
    autoStart: config.get<boolean>('autoStart', true),
  };
};

/** The workspace folder that is a Salesforce DX project. */
function projectFolder(): string | undefined {
  return vscode.workspace.workspaceFolders
    ?.map((f) => f.uri.fsPath)
    .find((p) => existsSync(join(p, 'sfdx-project.json')));
}

/** Makes sure the app runs and serves this workspace's project. */
async function ensureApp(): Promise<number> {
  const { port, sf, autoStart } = settings();
  const project = projectFolder();
  let info = await appInfo(port);
  if (!info) {
    if (!autoStart) throw new Error(`The local NomadSF app is not running on port ${port} (sf fm dashboard).`);
    if (!project) throw new Error('Open a Salesforce DX project (a folder with sfdx-project.json).');
    output.appendLine(`Starting: ${sf} fm dashboard --port ${port} (in ${project})`);
    // Own process group: `sf` is a wrapper, and stopping it must stop the Node server it starts
    child = spawn(sf, ['fm', 'dashboard', '--port', String(port)], {
      cwd: project,
      shell: process.platform === 'win32',
      detached: process.platform !== 'win32',
    });
    child.stdout?.on('data', (d: Buffer) => output.append(d.toString()));
    child.stderr?.on('data', (d: Buffer) => output.append(d.toString()));
    child.on('exit', (code) => {
      output.appendLine(`The local app stopped (${code ?? 'signal'}).`);
      child = undefined;
    });
    info = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Starting NomadSF…' },
      () => waitForApp(port, 60_000, () => Boolean(child))
    );
  }
  checkPluginVersion(info.version);
  if (project && info.project?.path !== project) {
    output.appendLine(`Switching the app to ${project}`);
    await selectProject(port, project);
  }
  return port;
}

type Message = { type?: string; nomadsf?: string; id?: number; op?: string; args?: unknown[] };

/** The one NomadSF tab: requests from the Studio (its own page, or the app's frame) go to bridge.ts. */
function openPanel(title: string): vscode.WebviewPanel {
  if (!panel) {
    const created = vscode.window.createWebviewPanel('nomadsf', title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [studioRoot()],
    });
    created.webview.onDidReceiveMessage((message: Message) => {
      if (message.type === 'paste') {
        void vscode.env.clipboard.readText().then((text) => created.webview.postMessage({ type: 'paste', text }));
        return;
      }
      // type 'call': through the app frame's page (BRIDGE); nomadsf 'call': the Studio page itself
      const direct = message.nomadsf === 'call';
      if ((message.type !== 'call' && !direct) || !message.id || !message.op) return;
      const reply = (answer: { result?: unknown; error?: string }): Thenable<boolean> =>
        created.webview.postMessage(
          direct ? { nomadsf: 'reply', id: message.id, ...answer } : { type: 'reply', id: message.id, ...answer }
        );
      handleCall(message.op, message.args ?? [], memento!).then(
        (result) => reply({ result }),
        (error: Error) => reply({ error: error.message })
      );
    });
    created.onDidDispose(() => (panel = undefined));
    panel = created;
  }
  panel.title = title;
  return panel;
}

const fail = (error: unknown): void => {
  void vscode.window.showErrorMessage(`NomadSF: ${(error as Error).message}`, 'Show output').then((choice) => {
    if (choice) output.show();
  });
};

/** The local NomadSF app (`sf fm dashboard`): runs, pipelines, runbooks, AI. Needs the sf fm plugin. */
async function showApp(): Promise<void> {
  try {
    const port = await ensureApp();
    // asExternalUri also works in remote windows and Codespaces (forwards the port)
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(baseUrl(port)));
    const origin = external.toString(true).replace(/\/$/, '');
    // embed=vscode: the app's Studio asks this extension for links, clipboard, files (bridge.ts)
    const url = `${origin}${targetPath({ kind: 'app' })}&embed=vscode`;
    const shown = openPanel('NomadSF');
    shown.webview.html = frame(url, origin);
    shown.reveal();
  } catch (error) {
    fail(error);
  }
}

/** NomadSF Studio, shipped with the extension: nothing else to install. */
function showStudio(target: Parameters<typeof studioHash>[0], title: string): void {
  try {
    const hash = studioHash(target);
    const shown = openPanel(title);
    shown.webview.html = studioPage(shown.webview, hash);
    shown.reveal();
  } catch (error) {
    fail(error);
  }
}

let extensionRoot: vscode.Uri | undefined;
const studioRoot = (): vscode.Uri => vscode.Uri.joinPath(extensionRoot!, 'dist', 'studio');

/**
 * The Studio's index.html as the webview page: its files from the extension (base), the meta
 * tags that tell it it runs in VS Code and which tool to open, and a CSP for the webview.
 */
function studioPage(webview: vscode.Webview, hash: string): string {
  const root = studioRoot();
  const index = join(root.fsPath, 'index.html');
  if (!existsSync(index)) throw new Error('NomadSF Studio is missing from this build of the extension.');
  const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const files = webview.cspSource;
  const csp = [
    "default-src 'none'",
    `script-src ${files} blob:`,
    `style-src ${files} 'unsafe-inline'`,
    `font-src ${files} data:`,
    `img-src ${files} https: data: blob:`,
    `connect-src ${files} blob: data:`,
    'worker-src blob:',
  ].join('; ');
  const head = `<base href="${escape(`${webview.asWebviewUri(root).toString()}/`)}">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="nomadsf-host" content="vscode">
<meta name="nomadsf-hash" content="${escape(hash)}">`;
  return readFileSync(index, 'utf8').replace('<head>', `<head>\n${head}`);
}

function frame(url: string, origin: string): string {
  const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escape(
    origin
  )}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;overflow:hidden;background:transparent}</style>
</head><body><iframe src="${escape(url)}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">${BRIDGE.replace('ORIGIN', JSON.stringify(origin))}</script></body></html>`;
}

/**
 * Runs in the webview page around the Studio frame. VS Code turns ⌘C, ⌘V, ⌘X, ⌘A, ⌘Z into
 * execCommand on this page (not on the frame): they go on to the Studio, paste with the
 * clipboard's text. The Studio's requests go to the extension and the answers come back.
 */
const BRIDGE = `(() => {
  const vscode = acquireVsCodeApi();
  const origin = ORIGIN;
  const studio = () => document.querySelector('iframe').contentWindow;
  document.execCommand = (cmd) => {
    if (cmd === 'paste') vscode.postMessage({ type: 'paste' });
    else studio().postMessage({ nomadsf: 'exec', cmd }, origin);
    return true;
  };
  window.addEventListener('message', (e) => {
    const m = e.data;
    // From the Studio frame: requests. Anything else comes from VS Code (no source window)
    if (e.source === studio()) {
      if (m && m.nomadsf === 'call') vscode.postMessage({ type: 'call', id: m.id, op: m.op, args: m.args });
      // Right-click in the Studio: VS Code shows the webview menu for a contextmenu on this page
      if (m && m.nomadsf === 'contextmenu')
        document.body.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: m.x, clientY: m.y }));
    } else if (m && m.type === 'reply') {
      studio().postMessage({ nomadsf: 'reply', id: m.id, result: m.result, error: m.error }, origin);
    } else if (m && m.type === 'paste') {
      studio().postMessage({ nomadsf: 'exec', cmd: 'paste', text: m.text }, origin);
    }
  });
})();`;

function selection(): string {
  const editor = vscode.window.activeTextEditor;
  return editor ? editor.document.getText(editor.selection).trim() : '';
}

export function activate(context: vscode.ExtensionContext): void {
  memento = context.globalState;
  extensionRoot = context.extensionUri;
  extensionVersion = String((context.extension.packageJSON as { version?: string }).version ?? '');
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = '$(rocket) NomadSF';
  status.tooltip = 'Open NomadSF Studio';
  status.command = 'nomadsf.openStudio';
  status.show();

  context.subscriptions.push(
    status,
    output,
    vscode.commands.registerCommand('nomadsf.open', () => showApp()),
    vscode.commands.registerCommand('nomadsf.login', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: 'Production or developer org', url: 'https://login.salesforce.com' },
          { label: 'Sandbox', url: 'https://test.salesforce.com' },
        ],
        { placeHolder: 'Log in to…' }
      );
      if (!pick) return;
      try {
        const username = await handleCall('login', [pick.url], memento!);
        if (username) void vscode.window.showInformationMessage(`NomadSF: logged in as ${String(username)}.`);
      } catch (error) {
        fail(error);
      }
    }),
    vscode.commands.registerCommand('nomadsf.openStudio', () => showStudio({ kind: 'studio' }, 'NomadSF Studio')),
    vscode.commands.registerCommand('nomadsf.openStudioPage', async () => {
      const pick = await vscode.window.showQuickPick(
        STUDIO_PAGES.map(([id, label, hub]) => ({ label, description: hub, id })),
        { placeHolder: 'Studio tool', matchOnDescription: true }
      );
      if (pick) showStudio({ kind: 'studio', page: pick.id }, `NomadSF · ${pick.label}`);
    }),
    vscode.commands.registerCommand('nomadsf.inspectSelection', () =>
      showStudio({ kind: 'record', id: selection().replace(/['"]/g, '') }, 'NomadSF · Record')
    ),
    vscode.commands.registerCommand('nomadsf.querySelection', () =>
      showStudio({ kind: 'query', soql: selection().replace(/^\[|\]$/g, '') }, 'NomadSF · Query')
    ),
    vscode.commands.registerCommand('nomadsf.openGuide', () => vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL))),
    vscode.commands.registerCommand('nomadsf.stop', () => {
      if (child) {
        stopChild();
        void vscode.window.showInformationMessage('NomadSF: the local app was stopped.');
      } else {
        void vscode.window.showInformationMessage('NomadSF: this window did not start the local app.');
      }
    })
  );
}

function stopChild(): void {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}

export function deactivate(): void {
  stopChild();
}
