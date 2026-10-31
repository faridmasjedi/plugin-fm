import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { GUIDE_URL, STUDIO_PAGES, studioHash } from './app';
import { handleCall } from './bridge';

/**
 * NomadSF for VS Code: NomadSF Studio in an editor tab, shipped with the extension (dist/studio)
 * and working on its own with the Salesforce CLI's logins (orgs.ts; the CLI is not needed).
 */

let panel: vscode.WebviewPanel | undefined;
let memento: vscode.Memento | undefined;

const output = vscode.window.createOutputChannel('NomadSF');

type Message = { type?: string; nomadsf?: string; id?: number; op?: string; args?: unknown[] };

/** The one NomadSF tab: requests from the Studio page go to bridge.ts. */
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
      if (message.nomadsf !== 'call' || !message.id || !message.op) return;
      const reply = (answer: { result?: unknown; error?: string }): Thenable<boolean> =>
        created.webview.postMessage({ nomadsf: 'reply', id: message.id, ...answer });
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

function selection(): string {
  const editor = vscode.window.activeTextEditor;
  return editor ? editor.document.getText(editor.selection).trim() : '';
}

export function activate(context: vscode.ExtensionContext): void {
  memento = context.globalState;
  extensionRoot = context.extensionUri;
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = '$(rocket) NomadSF';
  status.tooltip = 'Open NomadSF Studio';
  status.command = 'nomadsf.openStudio';
  status.show();

  context.subscriptions.push(
    status,
    output,
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
    vscode.commands.registerCommand('nomadsf.openGuide', () => vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL)))
  );
}

export function deactivate(): void {
  // nothing to stop: the Studio runs in the tab
}
