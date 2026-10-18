import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import {
  analyzeProject,
  githubProjectFs,
  httpProjectFs,
  type GitHubTransport,
  type ProjectEntry,
  type ProjectFs,
  type ProjectInfo,
} from '@nomadsf/core';
import { storage } from './context';
import { currentGitHub, lastRepo } from './github';

/**
 * The Salesforce project (repository) the Studio works with:
 * - local: the project of the local NomadSF app (`sf fm dashboard`), switchable there;
 * - folder: a folder picked in the browser (File System Access API), no CLI needed;
 * - github: a branch of any GitHub repository the person can read.
 */
export type ProjectSource = {
  kind: 'local' | 'folder' | 'github';
  name: string;
  fs: ProjectFs;
  path?: string;
  /** GitHub: owner/repo and branch. */
  repo?: string;
  ref?: string;
};

export type RecentProject = { name: string; path: string; sfdx: boolean };

// ---------- browser folder (File System Access API) ----------

type DirHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterable<[string, FileSystemHandle]>;
  queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
  requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
};

const SKIPPED = new Set(['node_modules', '.sf', '.sfdx', '.fm']);

export function browserProjectFs(root: DirHandle): ProjectFs {
  const dirAt = async (path: string): Promise<DirHandle> => {
    let dir = root;
    for (const part of path.split('/').filter(Boolean)) dir = (await dir.getDirectoryHandle(part)) as DirHandle;
    return dir;
  };
  return {
    name: root.name,
    async list(path) {
      const dir = await dirAt(path);
      const out: ProjectEntry[] = [];
      for await (const [name, handle] of dir.entries()) {
        if (SKIPPED.has(name) || name === '.git') continue;
        out.push({ name, kind: handle.kind === 'directory' ? 'dir' : 'file' });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name));
    },
    async readText(path) {
      try {
        const parts = path.split('/');
        const dir = await dirAt(parts.slice(0, -1).join('/'));
        const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
        return file.size > 2 * 1024 * 1024 ? undefined : await file.text();
      } catch {
        return undefined;
      }
    },
  };
}

// Handles survive restarts in IndexedDB (they cannot go to localStorage)
function idb<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('nomadsf', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = fn(open.result.transaction('handles', mode).objectStore('handles'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
}

const supportsFolders = (): boolean =>
  typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';

// ---------- local app ----------

export const localAppBase = (kind: 'app' | 'extension'): string =>
  kind === 'app' ? '' : `http://127.0.0.1:${storage.get('local.port', 7007)}`;

async function localProject(base: string): Promise<{ current: RecentProject; recent: RecentProject[] } | undefined> {
  try {
    const res = await fetch(`${base}/api/projects`, { cache: 'no-store' });
    return res.ok ? ((await res.json()) as { current: RecentProject; recent: RecentProject[] }) : undefined;
  } catch {
    return undefined;
  }
}

// ---------- shared state ----------

export type ProjectState = {
  source?: ProjectSource;
  info?: ProjectInfo;
  recent: RecentProject[];
  loading: boolean;
  error: string;
  /** A stored folder needs the person to grant access again (browser rule). */
  needsPermission: boolean;
  canPickFolder: boolean;
  localAvailable: boolean;
  pickFolder(): Promise<void>;
  reconnectFolder(): Promise<void>;
  useLocal(): Promise<void>;
  switchLocal(path: string): Promise<void>;
  openGitHub(api: GitHubTransport, fullName: string, ref: string): Promise<void>;
  refresh(): Promise<void>;
  /** Components waiting to be loaded into the Metadata page's package (from a manifest or a type). */
  pendingPackage?: PendingPackage;
  openPackage(pending: PendingPackage | undefined): void;
};

export type PendingPackage = { label: string; types: Array<{ type: string; members: string[] }> };

export const ProjectStateContext = createContext<ProjectState | null>(null);

export function useProject(): ProjectState {
  const state = useContext(ProjectStateContext);
  if (!state) throw new Error('No project state.');
  return state;
}

export function useProjectState(hostKind: 'app' | 'extension', describeFolders?: Record<string, string>): ProjectState {
  const [source, setSource] = useState<ProjectSource>();
  const [info, setInfo] = useState<ProjectInfo>();
  const [recent, setRecent] = useState<RecentProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [needsPermission, setNeedsPermission] = useState(false);
  const [localAvailable, setLocalAvailable] = useState(false);
  const [pendingPackage, setPendingPackage] = useState<PendingPackage>();
  const base = localAppBase(hostKind);

  const load = useCallback(
    async (next: ProjectSource) => {
      setSource(next);
      setLoading(true);
      setError('');
      try {
        setInfo(await analyzeProject(next.fs, describeFolders));
      } catch (e) {
        setInfo(undefined);
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [describeFolders]
  );

  const useLocal = useCallback(async () => {
    const projects = await localProject(base);
    setLocalAvailable(Boolean(projects));
    if (!projects) {
      setError(`The local NomadSF app is not running (${base || 'this app'}).`);
      return;
    }
    setRecent(projects.recent);
    storage.set('project.source', 'local');
    await load({
      kind: 'local',
      name: projects.current.name,
      path: projects.current.path,
      fs: httpProjectFs(projects.current.name, base),
    });
  }, [base, load]);

  const fromHandle = useCallback(
    async (handle: DirHandle) => {
      storage.set('project.source', 'folder');
      setNeedsPermission(false);
      await load({ kind: 'folder', name: handle.name, fs: browserProjectFs(handle) });
    },
    [load]
  );

  const pickFolder = useCallback(async () => {
    const handle = (await (
      window as unknown as { showDirectoryPicker(o: { mode: 'read' }): Promise<DirHandle> }
    ).showDirectoryPicker({ mode: 'read' })) as DirHandle;
    await idb('readwrite', (s) => s.put(handle, 'project'));
    await fromHandle(handle);
  }, [fromHandle]);

  const reconnectFolder = useCallback(async () => {
    const handle = await idb<DirHandle | undefined>(
      'readonly',
      (s) => s.get('project') as IDBRequest<DirHandle | undefined>
    );
    if (handle && (await handle.requestPermission({ mode: 'read' })) === 'granted') await fromHandle(handle);
  }, [fromHandle]);

  const switchLocal = useCallback(
    async (path: string) => {
      const res = await fetch(`${base}/api/projects/select`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-fm-dashboard': '1' },
        body: JSON.stringify({ path }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok || body.error) {
        setError(body.error ?? res.statusText);
        return;
      }
      await useLocal();
    },
    [base, useLocal]
  );

  const openGitHub = useCallback(
    async (api: GitHubTransport, fullName: string, ref: string) => {
      storage.set('project.source', 'github');
      lastRepo.set({ fullName, ref });
      await load({
        kind: 'github',
        name: fullName.split('/')[1] ?? fullName,
        repo: fullName,
        ref,
        path: `github.com/${fullName} @ ${ref}`,
        fs: githubProjectFs(api, fullName, ref),
      });
    },
    [load]
  );

  const refresh = useCallback(async () => {
    if (source) await load(source);
  }, [source, load]);

  // Start with the last choice: local app first, then a stored folder
  useEffect(() => {
    void (async () => {
      const preferred = storage.get<string>('project.source', hostKind === 'app' ? 'local' : 'folder');
      const projects = await localProject(base);
      setLocalAvailable(Boolean(projects));
      const repo = lastRepo.get();
      if (preferred === 'github' && repo) {
        const github = await currentGitHub(hostKind);
        if (github) {
          await openGitHub(github.api, repo.fullName, repo.ref);
          return;
        }
      }
      if (hostKind === 'app' && projects) {
        await useLocal();
        return;
      }
      if (!supportsFolders()) return;
      const handle = await idb<DirHandle | undefined>(
        'readonly',
        (s) => s.get('project') as IDBRequest<DirHandle | undefined>
      ).catch(() => undefined);
      if (!handle) return;
      if ((await handle.queryPermission({ mode: 'read' })) === 'granted') await fromHandle(handle);
      else setNeedsPermission(true);
    })();
    // Runs once on start; later changes come from the buttons
  }, []);

  return {
    source,
    info,
    recent,
    loading,
    error,
    needsPermission,
    canPickFolder: supportsFolders(),
    localAvailable,
    pickFolder,
    reconnectFolder,
    useLocal,
    switchLocal,
    openGitHub,
    refresh,
    pendingPackage,
    openPackage: setPendingPackage,
  };
}
