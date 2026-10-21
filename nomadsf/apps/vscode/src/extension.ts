import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { STUDIO_PAGES, appInfo, baseUrl, selectProject, targetPath, waitForApp } from './app';

/**
 * NomadSF for VS Code: the local NomadSF app (`sf fm dashboard`) for the workspace's
 * Salesforce project, shown in an editor tab. The Studio inside it uses the Salesforce CLI's
 * orgs; nothing is stored by the extension.
 */

let child: ChildProcess | undefined;
let panel: vscode.WebviewPanel | undefined;
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
  if (project && info.project?.path !== project) {
    output.appendLine(`Switching the app to ${project}`);
    await selectProject(port, project);
  }
  return port;
}

async function show(target: Parameters<typeof targetPath>[0], title: string): Promise<void> {
  try {
    const port = await ensureApp();
    // asExternalUri also works in remote windows and Codespaces (forwards the port)
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(baseUrl(port)));
    const origin = external.toString(true).replace(/\/$/, '');
    const url = `${origin}${targetPath(target)}`;
    if (!panel) {
      panel = vscode.window.createWebviewPanel('nomadsf', title, vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      panel.onDidDispose(() => (panel = undefined));
    }
    panel.title = title;
    panel.webview.html = frame(url, origin);
    panel.reveal();
  } catch (error) {
    void vscode.window.showErrorMessage(`NomadSF: ${(error as Error).message}`, 'Show output').then((choice) => {
      if (choice) output.show();
    });
  }
}

function frame(url: string, origin: string): string {
  const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${escape(
    origin
  )}; style-src 'unsafe-inline';">
<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;overflow:hidden;background:transparent}</style>
</head><body><iframe src="${escape(url)}" allow="clipboard-read; clipboard-write"></iframe></body></html>`;
}

function selection(): string {
  const editor = vscode.window.activeTextEditor;
  return editor ? editor.document.getText(editor.selection).trim() : '';
}

export function activate(context: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = '$(rocket) NomadSF';
  status.tooltip = 'Open NomadSF Studio';
  status.command = 'nomadsf.openStudio';
  status.show();

  context.subscriptions.push(
    status,
    output,
    vscode.commands.registerCommand('nomadsf.open', () => show({ kind: 'app' }, 'NomadSF')),
    vscode.commands.registerCommand('nomadsf.openStudio', () => show({ kind: 'studio' }, 'NomadSF Studio')),
    vscode.commands.registerCommand('nomadsf.openStudioPage', async () => {
      const pick = await vscode.window.showQuickPick(
        STUDIO_PAGES.map(([id, label, hub]) => ({ label, description: hub, id })),
        { placeHolder: 'Studio tool', matchOnDescription: true }
      );
      if (pick) await show({ kind: 'studio', page: pick.id }, `NomadSF · ${pick.label}`);
    }),
    vscode.commands.registerCommand('nomadsf.inspectSelection', () =>
      show({ kind: 'record', id: selection().replace(/['"]/g, '') }, 'NomadSF · Record')
    ),
    vscode.commands.registerCommand('nomadsf.querySelection', () =>
      show({ kind: 'query', soql: selection().replace(/^\[|\]$/g, '') }, 'NomadSF · Query')
    ),
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
