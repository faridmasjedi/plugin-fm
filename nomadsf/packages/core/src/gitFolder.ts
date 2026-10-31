import { Buffer } from 'buffer';
import {
  findMergeBase,
  listBranches,
  listTags,
  readBlob,
  readTag,
  resolveRef,
  TREE,
  walk,
  type PromiseFsClient,
} from 'isomorphic-git';

/**
 * A git repository read from a folder handle: a folder picked in the browser (File System Access API) or VS Code's
 * stand-in for one. Branches, tags, merge-base and the files of any commit, through isomorphic-git. Read-only.
 * Moved from NomadSF Release Hub.
 */

// isomorphic-git uses Node's Buffer; the browser gets the 'buffer' package in its place
(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;

/** What is used of a folder handle (FileSystemDirectoryHandle, or VS Code's BridgeFolder). */
export type FolderHandle = {
  name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FolderHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
  entries(): AsyncIterable<[string, unknown]>;
  queryPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(options: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
};

export type FileHandleLike = {
  getFile(): Promise<{
    size: number;
    lastModified: number;
    text(): Promise<string>;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  createWritable?(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
};

const notFound = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });

type Stats = {
  type: 'file' | 'dir';
  mode: number;
  size: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  uid: number;
  gid: number;
  dev: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

/** The fs isomorphic-git needs, over a folder handle. Paths are like /.git/HEAD. */
export function handleFs(root: FolderHandle): PromiseFsClient {
  const dirs = new Map<string, FolderHandle>([['', root]]);
  const parts = (path: string): string[] => String(path).split('/').filter(Boolean);

  async function dir(segments: string[]): Promise<FolderHandle> {
    const key = segments.join('/');
    const known = dirs.get(key);
    if (known) return known;
    const parent = await dir(segments.slice(0, -1));
    let handle: FolderHandle;
    try {
      handle = await parent.getDirectoryHandle(segments[segments.length - 1]);
    } catch {
      throw notFound(key);
    }
    dirs.set(key, handle);
    return handle;
  }

  async function file(path: string): Promise<Awaited<ReturnType<FileHandleLike['getFile']>>> {
    const segments = parts(path);
    try {
      const parent = await dir(segments.slice(0, -1));
      return await (await parent.getFileHandle(segments[segments.length - 1])).getFile();
    } catch {
      throw notFound(path);
    }
  }

  const stats = (kind: 'file' | 'dir', size = 0, mtimeMs = 0): Stats => ({
    type: kind,
    mode: kind === 'dir' ? 0o40000 : 0o100644,
    size,
    ino: 0,
    mtimeMs,
    ctimeMs: mtimeMs,
    uid: 1,
    gid: 1,
    dev: 1,
    isFile: () => kind === 'file',
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => false,
  });

  const readOnly = (): Promise<never> => Promise.reject(new Error('The repository is read-only here'));

  const stat = async (path: string): Promise<Stats> => {
    try {
      await dir(parts(path));
      return stats('dir');
    } catch {
      const f = await file(path);
      return stats('file', f.size, f.lastModified);
    }
  };

  return {
    promises: {
      async readFile(path: string, options?: string | { encoding?: string }) {
        const f = await file(path);
        const encoding = typeof options === 'string' ? options : options?.encoding;
        if (encoding === 'utf8') return f.text();
        return new Uint8Array(await f.arrayBuffer());
      },
      async readdir(path: string) {
        const handle = await dir(parts(path)).catch(() => {
          throw notFound(path);
        });
        const names: string[] = [];
        for await (const [name] of handle.entries()) names.push(name);
        return names;
      },
      stat,
      lstat: stat,
      readlink: (path: string) => Promise.reject(notFound(path)),
      writeFile: readOnly,
      mkdir: readOnly,
      rmdir: readOnly,
      unlink: readOnly,
      symlink: readOnly,
      chmod: readOnly,
    },
  };
}

/** git on a folder handle: the repository's refs, commits and files. */
export class FolderRepo {
  private readonly fs: PromiseFsClient;
  private readonly dir = '/';
  private readonly trees = new Map<string, Map<string, string>>();
  private readonly texts = new Map<string, string>();

  public constructor(public readonly root: FolderHandle) {
    this.fs = handleFs(root);
  }

  /** Branches (local and remote) and tags, newest tags first by name. */
  public async refs(): Promise<{ branches: string[]; remoteBranches: string[]; tags: string[] }> {
    const { fs, dir } = this;
    const branches = await listBranches({ fs, dir });
    const remotes: string[] = [];
    for (const remote of await this.remotes()) {
      // eslint-disable-next-line no-await-in-loop
      for (const b of await listBranches({ fs, dir, remote }).catch(() => [] as string[]))
        if (b !== 'HEAD') remotes.push(`${remote}/${b}`);
    }
    const tags = await listTags({ fs, dir });
    return { branches: branches.sort(), remoteBranches: remotes.sort(), tags: tags.sort().reverse() };
  }

  private async remotes(): Promise<string[]> {
    const read = this.fs.promises as unknown as {
      readdir(p: string): Promise<string[]>;
      readFile(p: string, e: string): Promise<string>;
    };
    const names = await read.readdir('/.git/refs/remotes').catch(() => [] as string[]);
    const packed = await read.readFile('/.git/packed-refs', 'utf8').catch(() => '');
    for (const m of packed.matchAll(/refs\/remotes\/([^/\s]+)\//g)) names.push(m[1]);
    return [...new Set(names)];
  }

  /** The branch checked out (or an empty string when detached). */
  public async currentBranch(): Promise<string> {
    const read = this.fs.promises as unknown as { readFile(p: string, e: string): Promise<string> };
    const head = await read.readFile('/.git/HEAD', 'utf8').catch(() => '');
    return /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]?.trim() ?? '';
  }

  /** A branch, remote branch, tag or commit id → the commit id. */
  public async commit(ref: string): Promise<string> {
    const { fs, dir } = this;
    for (const candidate of [ref, `refs/heads/${ref}`, `refs/remotes/${ref}`, `refs/tags/${ref}`]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const oid = await resolveRef({ fs, dir, ref: candidate });
        // eslint-disable-next-line no-await-in-loop
        return await this.peel(oid);
      } catch {
        // try the next form
      }
    }
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    throw new Error(`No branch, tag or commit called ${ref}`);
  }

  /** An annotated tag points to a tag object: follow it to the commit. */
  private async peel(oid: string): Promise<string> {
    try {
      const { tag } = await readTag({ fs: this.fs, dir: this.dir, oid });
      return tag.type === 'commit' ? tag.object : oid;
    } catch {
      return oid;
    }
  }

  public async mergeBase(a: string, b: string): Promise<string | undefined> {
    const [base] = (await findMergeBase({ fs: this.fs, dir: this.dir, oids: [a, b] })) as string[];
    return base;
  }

  /** Every file of a commit: path → blob id. */
  public async files(commit: string): Promise<Map<string, string>> {
    const known = this.trees.get(commit);
    if (known) return known;
    const out = new Map<string, string>();
    await walk({
      fs: this.fs,
      dir: this.dir,
      trees: [TREE({ ref: commit })],
      map: async (path, [entry]) => {
        if (!entry || path === '.') return undefined;
        if ((await entry.type()) === 'blob') out.set(path, await entry.oid());
        return true;
      },
    });
    this.trees.set(commit, out);
    return out;
  }

  /** A file's content at a commit, as bytes. */
  public async bytes(commit: string, path: string): Promise<Uint8Array> {
    const { blob } = await readBlob({ fs: this.fs, dir: this.dir, oid: commit, filepath: path });
    return blob;
  }

  /** A file's text by its blob id (cached). */
  public async text(oid: string): Promise<string> {
    const known = this.texts.get(oid);
    if (known !== undefined) return known;
    const { blob } = await readBlob({ fs: this.fs, dir: this.dir, oid });
    const text = new TextDecoder().decode(blob);
    this.texts.set(oid, text);
    return text;
  }
}
