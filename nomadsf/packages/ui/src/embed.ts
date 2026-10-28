/**
 * The Studio inside the VS Code extension, in a sandboxed webview: either the webview page
 * itself (the extension ships the Studio) or an iframe of the local app (`sf fm dashboard`).
 * There the browser cannot open windows, use the clipboard, download files or show a folder
 * picker, and VS Code turns ⌘C / ⌘V into execCommand on the webview page. The extension
 * (apps/vscode) does what the browser cannot: open links, read and write the clipboard,
 * save files, folders, and (webview page only) the orgs and their requests.
 */

/** The Studio is the webview page itself (the extension's page sets this meta tag). */
export const inVsCodeWebview = (): boolean =>
  Boolean(document.querySelector('meta[name="nomadsf-host"][content="vscode"]'));

export const inVsCode = (): boolean =>
  inVsCodeWebview() || (window.parent !== window && new URLSearchParams(location.search).get('embed') === 'vscode');

type VsCodeApi = { postMessage(message: unknown): void };
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;
let vscodeApi: VsCodeApi | undefined;

/** To the extension: straight from the webview page, else through the page around the frame. */
function post(message: unknown): void {
  if (inVsCodeWebview() && typeof acquireVsCodeApi === 'function') {
    vscodeApi ??= acquireVsCodeApi();
    vscodeApi.postMessage(message);
  } else window.parent.postMessage(message, '*');
}

/** The browser's execCommand (the webview page replaces document.execCommand, see installEmbed). */
let nativeExec = (cmd: string, value?: string): boolean => document.execCommand(cmd, false, value);

type Reply = { nomadsf: 'reply'; id: number; result?: unknown; error?: string };
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 0;

/** Asks the extension to do something (open, clipboard, save, files). */
export function call<T>(op: string, ...args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    post({ nomadsf: 'call', id, op, args });
  });
}

/** Links the Studio opens itself (pages of the org, logged in); true when handled. */
let linkHandler: ((url: URL) => boolean) | undefined;
export function setLinkHandler(handler: ((url: URL) => boolean) | undefined): void {
  linkHandler = handler;
}

/** Opens a page in the default browser (in VS Code) or a new tab. */
export function openExternal(url: string): void {
  if (inVsCode()) void call('open', url);
  else window.open(url, '_blank', 'noopener');
}

// ---------- clipboard and editing commands from VS Code ----------

function selectedText(): string {
  const el = document.activeElement;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try {
      return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
    } catch {
      return ''; // inputs without a selection (number, email…)
    }
  }
  return window.getSelection()?.toString() ?? '';
}

/** Text selected on the page (a table cell, an Id), not inside a field or an editor. */
function pageSelection(): string {
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const where = node instanceof Element ? node : node?.parentElement;
  if (!selection || selection.isCollapsed || !where) return '';
  if (where.closest('.monaco-editor, input, textarea, [contenteditable="true"]')) return '';
  return selection.toString();
}

/** The copy event of the focused element (Monaco answers it), else the selection. */
function copyText(kind: 'copy' | 'cut'): string {
  // Like the browser: what is highlighted on the page, even while an editor keeps the focus
  const onPage = pageSelection();
  if (onPage && kind === 'copy') return onPage;
  const target = document.activeElement ?? document.body;
  const data = new DataTransfer();
  const event = new ClipboardEvent(kind, { clipboardData: data, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  const handled = event.defaultPrevented ? data.getData('text/plain') : '';
  return handled || selectedText();
}

function paste(text: string): void {
  const target = document.activeElement ?? document.body;
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  // Monaco and other editors take the text from the event; plain fields get it typed in
  if (!event.defaultPrevented) nativeExec('insertText', text);
}

/** The last edit key handled in the Studio itself (so VS Code's copy of it is not run twice). */
let lastKey: { cmd: string; at: number } | undefined;

/** Focused when the right-click menu opened (the menu takes the focus from code editors). */
let menuFocus: HTMLElement | null = null;

function command(cmd: string, text?: string): void {
  const active = document.activeElement;
  if ((!active || active === document.body) && menuFocus?.isConnected) menuFocus.focus();
  menuFocus = null;
  if (cmd === 'copy' || cmd === 'cut') {
    const copied = copyText(cmd);
    if (!copied) return;
    void call('clipboardWrite', copied);
    const el = document.activeElement;
    const editable =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement)?.isContentEditable;
    if (cmd === 'cut' && editable && selectedText()) nativeExec('delete');
  } else if (cmd === 'paste') {
    if (text) paste(text);
  } else if (['selectAll', 'undo', 'redo'].includes(cmd)) {
    nativeExec(cmd);
  }
}

/** The same key already handled in the Studio (keydown below), when VS Code also sends it. */
const justHandled = (cmd: string): boolean => Boolean(lastKey && lastKey.cmd === cmd && Date.now() - lastKey.at < 600);

const EDIT_COMMANDS = new Set(['copy', 'cut', 'paste', 'selectAll', 'undo', 'redo']);

/**
 * The webview page: VS Code runs ⌘C, ⌘V… as document.execCommand here. They go to the Studio's
 * own handling (the frame's page around the app's Studio does the same, apps/vscode).
 */
function routeEditCommands(): void {
  const original = document.execCommand.bind(document);
  nativeExec = (cmd, value) => original(cmd, false, value);
  document.execCommand = (cmd: string, showUi?: boolean, value?: string): boolean => {
    if (!EDIT_COMMANDS.has(cmd)) return original(cmd, showUi, value);
    if (justHandled(cmd)) return true;
    if (cmd === 'paste') void call<string>('clipboardRead').then((text) => command('paste', text));
    else command(cmd);
    return true;
  };
}

/** A link from the extension (#apex, #record=…, #query=…) opens that tool. */
function startAt(): void {
  const hash = document.querySelector<HTMLMetaElement>('meta[name="nomadsf-hash"]')?.content;
  if (hash) history.replaceState(null, '', `${location.href.split('#')[0]}#${hash}`);
}

// ---------- downloads ----------

async function save(a: HTMLAnchorElement): Promise<void> {
  const bytes = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
  await call('save', a.download || 'download', bytes);
}

// ---------- folders (backups): a folder handle backed by the extension ----------

type Entry = { name: string; kind: 'file' | 'directory' };
const notFound = (name: string): DOMException => new DOMException(`${name} was not found`, 'NotFoundError');
const join = (a: string, b: string): string => (a ? `${a}/${b}` : b);

class BridgeFile {
  readonly kind = 'file';
  constructor(private readonly root: string, private readonly path: string, readonly name: string) {}
  async getFile(): Promise<File> {
    const bytes = await call<Uint8Array | null>('fsRead', this.root, this.path);
    if (!bytes) throw notFound(this.name);
    return new File([bytes], this.name);
  }
  async createWritable(): Promise<{ write(d: BlobPart): Promise<void>; close(): Promise<void> }> {
    const parts: BlobPart[] = [];
    return {
      write: async (d) => void parts.push(d),
      close: async () => {
        await call('fsWrite', this.root, this.path, new Uint8Array(await new Blob(parts).arrayBuffer()));
      },
    };
  }
}

/** Stands in for FileSystemDirectoryHandle in what the backups use. */
export class BridgeFolder {
  readonly kind = 'directory';
  constructor(readonly root: string, private readonly path: string, readonly name: string) {}
  async getDirectoryHandle(name: string, options: { create?: boolean } = {}): Promise<BridgeFolder> {
    const path = join(this.path, name);
    if (!(await call<boolean>(options.create ? 'fsMkdir' : 'fsIsDir', this.root, path))) throw notFound(name);
    return new BridgeFolder(this.root, path, name);
  }
  async getFileHandle(name: string, options: { create?: boolean } = {}): Promise<BridgeFile> {
    const path = join(this.path, name);
    if (!options.create && !(await call<boolean>('fsIsFile', this.root, path))) throw notFound(name);
    return new BridgeFile(this.root, path, name);
  }
  async *entries(): AsyncIterable<[string, BridgeFolder | BridgeFile]> {
    for (const e of (await call<Entry[] | null>('fsList', this.root, this.path)) ?? [])
      yield [
        e.name,
        e.kind === 'directory'
          ? new BridgeFolder(this.root, join(this.path, e.name), e.name)
          : new BridgeFile(this.root, join(this.path, e.name), e.name),
      ];
  }
  async queryPermission(): Promise<PermissionState> {
    return (await call<boolean>('fsAllowed', this.root)) ? 'granted' : 'prompt';
  }
  async requestPermission(): Promise<PermissionState> {
    return this.queryPermission();
  }
  /** What is kept in IndexedDB (a handle object cannot be). */
  toStored(): StoredFolder {
    return { vscodeFolder: this.root, name: this.name };
  }
}

export type StoredFolder = { vscodeFolder: string; name: string };
export const isStoredFolder = (v: unknown): v is StoredFolder => typeof (v as StoredFolder)?.vscodeFolder === 'string';
export const fromStored = (v: StoredFolder): BridgeFolder => new BridgeFolder(v.vscodeFolder, '', v.name);

// ---------- install ----------

/** Wires links (and, inside VS Code, the extension) to the Studio. */
export function installEmbed(): void {
  // Links: the org's pages through linkHandler (logged in); others in VS Code's default browser
  document.addEventListener(
    'click',
    (e) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const a = (e.target as Element | null)?.closest?.('a');
      if (!a?.href || a.download) return;
      const url = new URL(a.href, location.href);
      if (!/^https?:$/.test(url.protocol)) return;
      // VS Code's webview also opens clicked links (asking "open the external website?") and
      // ignores preventDefault: a link handled here goes no further
      const handled = (): void => {
        e.preventDefault();
        if (inVsCode()) e.stopPropagation();
      };
      if (linkHandler?.(url)) {
        handled();
        return;
      }
      if (!inVsCode()) return;
      handled();
      if (url.origin === location.origin && !a.target) {
        // Pages of the app (← NomadSF) keep the bridge
        url.searchParams.set('embed', 'vscode');
        location.href = url.href;
      } else openExternal(url.href);
    },
    true
  );
  if (!inVsCode()) return;
  document.documentElement.dataset.embed = 'vscode';
  const webview = inVsCodeWebview();
  if (webview) {
    startAt();
    routeEditCommands();
  }

  window.addEventListener('message', (e) => {
    // The webview page gets the extension's messages through VS Code's frames (only VS Code can post here)
    if (!webview && e.source !== window.parent) return;
    const msg = e.data as Reply | { nomadsf: 'exec'; cmd: string; text?: string };
    if (msg?.nomadsf === 'reply') {
      const wait = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) wait?.reject(new Error(msg.error));
      else wait?.resolve(msg.result);
    } else if (msg?.nomadsf === 'exec') {
      if (justHandled(msg.cmd)) return;
      command(msg.cmd, msg.text);
    }
  });

  window.open = ((url?: string | URL) => {
    if (!url) return null;
    const target = new URL(String(url), location.href);
    if (!linkHandler?.(target)) openExternal(target.href);
    return null;
  }) as typeof window.open;

  // ⌘C / ⌘X / ⌘V typed in the Studio: VS Code does not see keys inside this frame
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  window.addEventListener(
    'keydown',
    (e) => {
      if (!(mac ? e.metaKey : e.ctrlKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      // Plain fields: select all, undo, redo (the code editors handle these themselves)
      const el = document.activeElement;
      const field =
        (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.closest('.monaco-editor');
      const fieldCmd = !field
        ? undefined
        : k === 'a' && !e.shiftKey
        ? 'selectAll'
        : k === 'z'
        ? e.shiftKey
          ? 'redo'
          : 'undo'
        : undefined;
      const cmd =
        fieldCmd ?? (e.shiftKey ? undefined : ({ c: 'copy', x: 'cut', v: 'paste' } as Record<string, string>)[k]);
      if (!cmd) return;
      e.preventDefault();
      e.stopPropagation();
      lastKey = { cmd, at: Date.now() };
      if (cmd === 'paste') void call<string>('clipboardRead').then((text) => command('paste', text));
      else command(cmd);
    },
    true
  );

  // Right-click: VS Code's own menu for the webview (Cut / Copy / Paste come back as edit commands)
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    menuFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // An Id: the whole Id, so Copy has something to copy
    const id = (e.target as Element | null)?.closest?.('.id-text');
    if (id && !window.getSelection()?.toString()) window.getSelection()?.selectAllChildren(id);
    // The webview page gets VS Code's menu itself; a frame asks the page around it
    if (webview) return;
    e.preventDefault();
    window.parent.postMessage({ nomadsf: 'contextmenu', x: e.clientX, y: e.clientY }, '*');
  });

  // Clipboard buttons (Copy, Copy package.xml…)
  try {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: (text: string) => call('clipboardWrite', text),
    });
  } catch {
    // no clipboard object: the Copy buttons fail as before
  }

  // Downloads (CSV, JSON, zip): VS Code's Save dialog
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    if (this.download && /^(blob|data):/.test(this.href)) {
      save(this).catch((err: Error) => console.error(err));
      return;
    }
    click.call(this);
  };

  // Folders (backups): VS Code's folder picker
  (window as unknown as { showDirectoryPicker: () => Promise<BridgeFolder> }).showDirectoryPicker = async () => {
    const picked = await call<{ root: string; name: string } | null>('pickFolder');
    if (!picked) throw new DOMException('No folder chosen', 'AbortError');
    return new BridgeFolder(picked.root, '', picked.name);
  };
}
