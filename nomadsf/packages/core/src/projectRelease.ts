import ignore from 'ignore';
import { checkForceignore } from './compareEngine.js';
import { apexSourcesFromFiles, testsForPackage } from './dependentTests.js';
import type { TestSelection } from './apexGraph.js';
import type { FolderHandle, FolderRepo } from './gitFolder.js';
import type { ProjectFs, ProjectInfo } from './project.js';
import { toMetadataFormat, type ConvertResult } from './sourceConvert.js';
import { resolveComponent } from './sourcePackage.js';

/**
 * A package from the project as it is on disk (not a branch): the same converter and dependent tests as Compare &
 * package, for the Project page and Code. Files in the .forceignore stay out, named, like the CLI's deploy.
 */

const SKIPPED = new Set(['node_modules', '.git', '.sfdx', '.sf']);

/** Every file under the package directories. */
export async function projectFiles(fs: ProjectFs, info: ProjectInfo): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.list(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      // eslint-disable-next-line no-await-in-loop
      if (entry.kind === 'dir') await walk(path);
      else out.push(path);
    }
  };
  for (const dir of info.packageDirectories) {
    // eslint-disable-next-line no-await-in-loop
    await walk(dir.path);
  }
  return out;
}

/**
 * A branch, tag or commit of the folder's git history as a read-only project: its files as they are at that ref, so
 * what reads a project (compare with an org, the converter, dependent tests) reads a branch the same way.
 */
export async function refProjectFs(
  repo: FolderRepo,
  ref: string
): Promise<{ fs: ProjectFs; readBytes: (path: string) => Promise<Uint8Array> }> {
  const commit = await repo.commit(ref);
  const files = await repo.files(commit);
  const fs: ProjectFs = {
    name: ref,
    list: async (dir) => {
      const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
      const out = new Map<string, 'file' | 'dir'>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const [first, ...rest] = path.slice(prefix.length).split('/');
        if (!out.has(first) || rest.length) out.set(first, rest.length ? 'dir' : 'file');
      }
      if (!out.size && dir) throw new Error(`${dir} is not in ${ref}`);
      return [...out].map(([name, kind]) => ({ name, kind }));
    },
    readText: async (path) => {
      const oid = files.get(path);
      return oid ? repo.text(oid) : undefined;
    },
  };
  return { fs, readBytes: (path) => repo.bytes(commit, path) };
}

/** A file's bytes from a picked folder (binary static resources survive, unlike text). */
export async function folderBytes(root: FolderHandle, path: string): Promise<Uint8Array> {
  const parts = path.split('/').filter(Boolean);
  let dir = root;
  // eslint-disable-next-line no-await-in-loop
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/** The .forceignore of the project as a matcher (nothing ignored when there is none). */
export async function projectIgnore(fs: ProjectFs, path?: string): Promise<(file: string) => boolean> {
  const text = await fs.readText(checkForceignore(path)).catch(() => undefined);
  if (!text) return () => false;
  const rules = ignore().add(text);
  return (file) => {
    try {
      return rules.ignores(file);
    } catch {
      return false;
    }
  };
}

export type ProjectPackageInput = {
  fs: ProjectFs;
  info: ProjectInfo;
  deploy: Array<{ type: string; name: string }>;
  remove?: Array<{ type: string; name: string }>;
  removeWhen?: 'post' | 'pre';
  apiVersion: string;
  forceignore?: string;
  /** The bytes of a file, when the project can give them (a folder): static resources may be binary. */
  readBytes?: (path: string) => Promise<Uint8Array>;
};

/** The Metadata API zip of components of the project. */
export async function projectMetadataZip(input: ProjectPackageInput): Promise<ConvertResult> {
  const { fs, info, readBytes } = input;
  const all = await projectFiles(fs, info);
  const ignored = await projectIgnore(fs, input.forceignore);
  const files = all.filter((f) => !ignored(f));
  const deploy = withObjectChildren(
    input.deploy,
    files,
    info.packageDirectories.map((d) => d.path)
  );
  const read =
    readBytes ??
    (async (path: string): Promise<Uint8Array> => new TextEncoder().encode((await fs.readText(path)) ?? ''));
  const result = await toMetadataFormat({
    deploy,
    remove: input.remove,
    removeWhen: input.removeWhen,
    files,
    read,
    packageDirs: info.packageDirectories.map((d) => d.path),
    apiVersion: input.apiVersion,
  });
  // "No source file" for a component whose files are all ignored: say it is the .forceignore
  if (files.length < all.length) {
    const left = await toMetadataFormat({
      deploy: result.notConverted.filter((c) => c.reason === 'no source file for it'),
      files: all,
      read: async () => new Uint8Array(),
      packageDirs: info.packageDirectories.map((d) => d.path),
      apiVersion: input.apiVersion,
    });
    const inIgnore = new Set(left.deployed.map((c) => `${c.type}:${c.name}`));
    for (const c of result.notConverted)
      if (inIgnore.has(`${c.type}:${c.name}`)) c.reason = `in ${checkForceignore(input.forceignore)}`;
  }
  return result;
}

/**
 * An object of the project is its folder: deploying it sends its fields, record types, validation rules… too, as the
 * CLI's deploy of CustomObject:X does; an object folder with no object file of its own (a standard object's fields)
 * is just those children.
 */
function withObjectChildren(
  deploy: Array<{ type: string; name: string }>,
  files: string[],
  packageDirs: string[]
): Array<{ type: string; name: string }> {
  const objects = new Set(deploy.filter((c) => c.type === 'CustomObject').map((c) => c.name));
  if (!objects.size) return deploy;
  const out = [...deploy];
  const keys = new Set(deploy.map((c) => `${c.type}:${c.name}`));
  const own = new Set<string>();
  const withChildren = new Set<string>();
  for (const path of files) {
    const c = resolveComponent(path, packageDirs);
    if (!c) continue;
    if (c.type === 'CustomObject') own.add(c.name);
    else if (c.object && objects.has(c.object)) {
      withChildren.add(c.object);
      const key = `${c.type}:${c.name}`;
      if (!keys.has(key)) {
        keys.add(key);
        out.push({ type: c.type, name: c.name });
      }
    }
  }
  return out.filter((c) => c.type !== 'CustomObject' || own.has(c.name) || !withChildren.has(c.name));
}

/** The tests that reach the Apex of a package, from the project's Apex. */
export async function projectTests(
  fs: ProjectFs,
  info: ProjectInfo,
  components: Array<{ type: string; name: string }>
): Promise<TestSelection> {
  const files = await projectFiles(fs, info);
  const sources = await apexSourcesFromFiles(files, async (p) => (await fs.readText(p)) ?? '');
  return testsForPackage(sources, components);
}
