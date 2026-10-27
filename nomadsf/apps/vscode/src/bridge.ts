import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import * as vscode from 'vscode';
import { frontDoorUrl, listOrgs, loginWeb, proxySalesforce, type ProxyRequest } from './orgs';

/**
 * What the Studio asks the extension for (its page cannot do it in a webview): open links
 * in the default browser, the clipboard, saving downloads, the backup folders the person
 * picked (only those: every file call checks the folder), and the orgs: the list, their
 * requests, logged-in pages and the browser login (orgs.ts).
 */
const FOLDERS = 'nomadsf.folders';

const bytesOf = (data: unknown): Uint8Array =>
  data instanceof Uint8Array ? data : Uint8Array.from(Object.values((data ?? {}) as Record<string, number>));

function inside(memento: vscode.Memento, root: unknown, path: unknown): string {
  const folders = memento.get<string[]>(FOLDERS, []);
  if (typeof root !== 'string' || !folders.includes(root)) throw new Error('Choose the folder again.');
  const full = resolve(root, String(path ?? ''));
  if (full !== root && !full.startsWith(root + sep)) throw new Error('Outside the folder.');
  return full;
}

const exists = async (path: string, kind: 'file' | 'dir'): Promise<boolean> => {
  try {
    const s = await stat(path);
    return kind === 'file' ? s.isFile() : s.isDirectory();
  } catch {
    return false;
  }
};

/** The browser login of the Salesforce CLI; null when the person cancels. */
async function login(url: string, knownAlias?: string): Promise<string | null> {
  const alias =
    knownAlias ??
    (await vscode.window.showInputBox({
      title: 'NomadSF: log in to an org',
      prompt: 'Alias for the org (optional). The Salesforce CLI and other tools see the login too.',
      placeHolder: 'e.g. my-sandbox',
      validateInput: (v) => (!v || /^[\w.@+-]{1,80}$/.test(v) ? undefined : 'Letters, digits and . _ - @ + only'),
    }));
  if (alias === undefined) return null;
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'NomadSF: log in to Salesforce in your browser…',
    },
    () => loginWeb(url, alias || undefined, (authUrl) => void vscode.env.openExternal(vscode.Uri.parse(authUrl, true)))
  );
}

export async function handleCall(op: string, args: unknown[], memento: vscode.Memento): Promise<unknown> {
  const [a, b, c] = args;
  switch (op) {
    case 'open': {
      const url = vscode.Uri.parse(String(a), true);
      if (url.scheme !== 'https' && url.scheme !== 'http') throw new Error('Only web pages open.');
      return vscode.env.openExternal(url);
    }
    case 'orgs':
      return listOrgs();
    case 'sf':
      return proxySalesforce(String(a), (b ?? {}) as ProxyRequest);
    case 'openOrg':
      return vscode.env.openExternal(vscode.Uri.parse(await frontDoorUrl(String(a), String(b)), true));
    case 'login':
      return login(String(a), typeof b === 'string' ? b : undefined);
    case 'clipboardWrite':
      return vscode.env.clipboard.writeText(String(a));
    case 'clipboardRead':
      return vscode.env.clipboard.readText();
    case 'save': {
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir());
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.joinPath(folder, basename(String(a)) || 'download'),
      });
      if (!target) return null;
      await vscode.workspace.fs.writeFile(target, bytesOf(b));
      void vscode.window.showInformationMessage(`NomadSF: saved ${basename(target.fsPath)}.`);
      return target.fsPath;
    }
    case 'pickFolder': {
      const [picked] =
        (await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Use this folder',
          title: 'NomadSF: folder for the backups',
        })) ?? [];
      if (!picked) return null;
      const root = picked.fsPath;
      const folders = memento.get<string[]>(FOLDERS, []);
      if (!folders.includes(root)) await memento.update(FOLDERS, [...folders, root]);
      return { root, name: basename(root) };
    }
    case 'fsAllowed':
      return memento.get<string[]>(FOLDERS, []).includes(String(a));
    case 'fsIsDir':
      return exists(inside(memento, a, b), 'dir');
    case 'fsIsFile':
      return exists(inside(memento, a, b), 'file');
    case 'fsMkdir':
      await mkdir(inside(memento, a, b), { recursive: true });
      return true;
    case 'fsRead': {
      const path = inside(memento, a, b);
      return (await exists(path, 'file')) ? new Uint8Array(await readFile(path)) : null;
    }
    case 'fsWrite': {
      const path = inside(memento, a, b);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytesOf(c));
      return true;
    }
    case 'fsList': {
      const path = inside(memento, a, b);
      if (!(await exists(path, 'dir'))) return null;
      return (await readdir(path, { withFileTypes: true }))
        .filter((e) => e.isFile() || e.isDirectory())
        .map((e) => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file' }))
        .sort((x, y) => x.name.localeCompare(y.name));
    }
    default:
      throw new Error(`Unknown request: ${op}`);
  }
}
