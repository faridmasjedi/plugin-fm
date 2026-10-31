import ignore from 'ignore';
import type { TestSelection } from './apexGraph.js';
import { apexSourcesFromFiles, testsForPackage } from './dependentTests.js';
import { FolderRepo, type FolderHandle } from './gitFolder.js';
import { unifiedDiff } from './projectCode.js';
import { parsePackageXml } from './project.js';
import { toMetadataFormat, type ConvertResult } from './sourceConvert.js';
import {
  buildPackage,
  isRemoval,
  labelBlocks,
  manifestXml,
  resolveComponent,
  type SourcePackage,
} from './sourcePackage.js';
import { makeZip } from './zip.js';

/**
 * Compare & package on a project folder, with no CLI: what a branch brings into another, read from the folder's git
 * history (FolderRepo), as a Salesforce package (sourcePackage.ts) to look at, untick and download. Nothing is
 * written to the folder except, when the person asks, renamed-away files into .forceignore. Moved from NomadSF
 * Release Hub.
 */

const DEFAULT_API_VERSION = '61.0';

/** How Target's side is found: from where Source branched off it (like a pull request), or Target as it is. */
export type CompareHow = 'merge-base' | 'direct';

export type CompareRequest = { source: string; target: string; how?: CompareHow; forceignore?: string };

export type ComparedPackage = SourcePackage & {
  id: string;
  source: string;
  target: string;
  how: CompareHow;
  /** The commits compared: refA on Target's side, refB = Source. */
  refA: string;
  refB: string;
  forceignore: string;
  apiVersion: string;
  packageDirs: string[];
  /** Components offered to choose, left out until you add them (every other custom label). */
  optional: string[];
};

/** The .forceignore path: inside the project, default .forceignore. */
export function checkForceignore(path: string | undefined): string {
  const value = String(path ?? '').trim() || '.forceignore';
  if (value.startsWith('/') || value.split(/[\\/]/).includes('..'))
    throw new Error('.forceignore: a path inside the project');
  return value;
}

export class CompareEngine {
  public readonly repo: FolderRepo;
  private readonly packages = new Map<string, ComparedPackage>();

  public constructor(private readonly root: FolderHandle) {
    this.repo = new FolderRepo(root);
  }

  public get name(): string {
    return this.root.name;
  }

  public refs(): ReturnType<FolderRepo['refs']> {
    return this.repo.refs();
  }

  public currentBranch(): Promise<string> {
    return this.repo.currentBranch();
  }

  /** Like a pull request: what `source` brings into `target`. */
  public async compare(request: CompareRequest): Promise<ComparedPackage> {
    const { source, target, how = 'merge-base' } = request;
    const repo = this.repo;
    const forceignore = checkForceignore(request.forceignore);
    const refB = await repo.commit(source);
    let refA: string | undefined;
    if (how === 'merge-base') {
      refA = await repo.mergeBase(await repo.commit(target), refB);
      if (!refA) throw new Error(`${source} and ${target} have no commit in common`);
    } else {
      refA = await repo.commit(target);
    }
    if (refA === refB) throw new Error(`Nothing to bring: ${target} already has everything in ${source}`);

    const [before, after] = await Promise.all([repo.files(refA), repo.files(refB)]);
    const project = await this.projectJson(after, before);
    const ignored = await this.ignoreRules(forceignore, after);
    const read = async (side: 'before' | 'after', path: string): Promise<string> => {
      const oid = (side === 'before' ? before : after).get(path);
      return oid ? repo.text(oid) : '';
    };
    const built = await buildPackage({ before, after, read, packageDirs: project.packageDirs, ignored });
    const optional = await this.otherLabels(built, before, after, project.packageDirs, ignored);
    built.components.push(...optional);
    const record: ComparedPackage = {
      ...built,
      optional: optional.map((c) => `${c.type}:${c.name}`),
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      source,
      target,
      how,
      refA,
      refB,
      forceignore,
      apiVersion: project.apiVersion,
      packageDirs: project.packageDirs,
    };
    this.packages.set(record.id, record);
    return record;
  }

  /**
   * A package from a manifest: the components a package.xml names (and a destructiveChanges.xml deletes), with the
   * files of a branch, tag or commit — the same package to look at, untick, validate and deploy. "*" takes every
   * component of that type in the source; a member the source does not have is named, not guessed.
   */
  public async fromManifest(request: {
    ref: string;
    packageXml: string;
    destructiveXml?: string;
    forceignore?: string;
  }): Promise<ComparedPackage> {
    const forceignore = checkForceignore(request.forceignore);
    const refB = await this.repo.commit(request.ref);
    const files = await this.repo.files(refB);
    const project = await this.projectJson(files, files);
    const ignored = await this.ignoreRules(forceignore, files);
    // Every component of the source, with its files (labels one by one)
    const index = new Map<string, { type: string; name: string; files: string[]; main?: string; folder?: string }>();
    const note = (type: string, name: string, file: string, main?: string, folder?: string): void => {
      const key = `${type}:${name}`;
      const found = index.get(key);
      if (found) found.files.push(file);
      else index.set(key, { type, name, files: [file], main, folder });
    };
    for (const path of files.keys()) {
      if (ignored(path)) continue;
      const c = resolveComponent(path, project.packageDirs);
      if (!c) continue;
      if (c.labels) {
        // eslint-disable-next-line no-await-in-loop
        for (const name of labelBlocks(await this.repo.text(files.get(path) ?? '')).keys())
          note('CustomLabel', name, path);
      } else note(c.type, c.name, path, c.xml, c.folder);
    }
    // Only components that are whole in the source: their -meta.xml is there (an Aura bundle: any of them), or a
    // folder without one has files (left-over files of a deleted bundle are not a component)
    for (const [key, c] of index) {
      const whole = c.main
        ? files.has(c.main) || (c.main === c.folder && c.files.length > 0)
        : c.files.some((f) => f.endsWith('-meta.xml'));
      if (!whole) index.delete(key);
    }
    const components: SourcePackage['components'] = [];
    const take = (xml: string, change: 'changed' | 'deleted'): void => {
      for (const { type, members } of parsePackageXml(xml)) {
        const names = members.includes('*')
          ? [...index.values()].filter((c) => c.type === type).map((c) => c.name)
          : members;
        for (const name of names) {
          const found = index.get(`${type}:${name}`);
          components.push({
            type,
            name,
            change,
            files: found?.files ?? [],
            deploy: change === 'deleted' ? [] : found?.files ?? [],
            ...(found || change === 'deleted'
              ? {}
              : { note: `not in ${request.ref}: it cannot be deployed from there` }),
          });
        }
      }
    };
    take(request.packageXml, 'changed');
    if (request.destructiveXml) take(request.destructiveXml, 'deleted');
    const version = /<version>\s*([\d.]+)\s*<\/version>/.exec(request.packageXml)?.[1] ?? project.apiVersion;
    // The branch's other labels, to add if you want
    const optional = await this.otherLabels(
      { components, renames: [], files: [] },
      new Map(),
      files,
      project.packageDirs,
      ignored
    );
    components.push(...optional);
    const record: ComparedPackage = {
      optional: optional.map((c) => `${c.type}:${c.name}`),
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      source: request.ref,
      target: 'manifest',
      how: 'direct',
      refA: refB,
      refB,
      forceignore,
      apiVersion: version,
      packageDirs: project.packageDirs,
      components: components.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
      renames: [],
      files: [],
    };
    this.packages.set(record.id, record);
    return record;
  }

  /** Package directories and API version from sfdx-project.json (Source's side first). */
  private async projectJson(
    after: Map<string, string>,
    before: Map<string, string>
  ): Promise<{ packageDirs: string[]; apiVersion: string }> {
    const oid = after.get('sfdx-project.json') ?? before.get('sfdx-project.json');
    let json: { packageDirectories?: Array<{ path?: string }>; sourceApiVersion?: string } = {};
    try {
      json = oid ? (JSON.parse(await this.repo.text(oid)) as typeof json) : {};
    } catch {
      json = {};
    }
    const dirs = (json.packageDirectories ?? []).map((d) =>
      String(d.path ?? '')
        .replace(/^\.\//, '')
        .replace(/\/+$/, '')
    );
    return {
      packageDirs: dirs.length ? dirs : ['force-app'],
      apiVersion: json.sourceApiVersion ?? DEFAULT_API_VERSION,
    };
  }

  /**
   * Every custom label the package does not hold yet, to choose: Source's (unchanged) and Target's that Source does
   * not have. Labels are one file, so picking them one by one is the only way to send some and not others.
   */
  private async otherLabels(
    built: SourcePackage,
    before: Map<string, string>,
    after: Map<string, string>,
    packageDirs: string[],
    ignored: (file: string) => boolean
  ): Promise<SourcePackage['components']> {
    const labelsOf = async (files: Map<string, string>): Promise<Map<string, string>> => {
      const out = new Map<string, string>();
      for (const [path, oid] of files) {
        if (ignored(path) || !resolveComponent(path, packageDirs)?.labels) continue;
        // eslint-disable-next-line no-await-in-loop
        for (const name of labelBlocks(await this.repo.text(oid)).keys()) out.set(name, path);
      }
      return out;
    };
    const [source, target] = await Promise.all([labelsOf(after), labelsOf(before)]);
    const inPackage = new Set(built.components.filter((c) => c.type === 'CustomLabel').map((c) => c.name));
    const offer = (name: string, change: 'unchanged' | 'only in target', path: string) => ({
      type: 'CustomLabel',
      name,
      change,
      files: [path],
      deploy: change === 'unchanged' ? [path] : [],
    });
    return [
      ...[...source].filter(([n]) => !inPackage.has(n)).map(([n, p]) => offer(n, 'unchanged', p)),
      ...[...target]
        .filter(([n]) => !inPackage.has(n) && !source.has(n))
        .map(([n, p]) => offer(n, 'only in target', p)),
    ];
  }

  /** The .forceignore as a matcher: the folder's own file (it may not be committed), else Source's. */
  private async ignoreRules(path: string, after: Map<string, string>): Promise<(file: string) => boolean> {
    let text = await this.readWorkingFile(path);
    const committed = after.get(path);
    if (text === undefined && committed) text = await this.repo.text(committed);
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

  private async readWorkingFile(path: string): Promise<string | undefined> {
    try {
      return await (await (await this.fileHandle(path)).getFile()).text();
    } catch {
      return undefined;
    }
  }

  private async fileHandle(path: string, create = false): ReturnType<FolderHandle['getFileHandle']> {
    const parts = path.split('/').filter(Boolean);
    let dir = this.root;
    // eslint-disable-next-line no-await-in-loop
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
    return dir.getFileHandle(parts[parts.length - 1], { create });
  }

  public get(id: string): ComparedPackage {
    const record = this.packages.get(id);
    if (!record) throw new Error('No such package: compare again');
    return record;
  }

  /** The components kept (not unticked), split into what is deployed and what is deleted. */
  /**
   * What goes, without what was left out: the components excluded, and the offered ones (other labels) unless they
   * were added.
   */
  private kept(
    record: ComparedPackage,
    exclude: string[],
    include: string[] = []
  ): { deploy: SourcePackage['components']; remove: SourcePackage['components'] } {
    const out = new Set([...exclude, ...record.optional.filter((k) => !include.includes(k))]);
    const kept = record.components.filter((c) => !out.has(`${c.type}:${c.name}`));
    return { deploy: kept.filter((c) => !isRemoval(c.change)), remove: kept.filter((c) => isRemoval(c.change)) };
  }

  /** The package in Metadata API format, ready to validate or deploy: Source's files converted (sourceConvert.ts). */
  public async metadataZip(
    id: string,
    {
      exclude = [],
      include = [],
      removeWhen = 'post',
    }: { exclude?: string[]; include?: string[]; removeWhen?: 'pre' | 'post' } = {}
  ): Promise<ConvertResult> {
    const record = this.get(id);
    const { deploy, remove } = this.kept(record, exclude, include);
    const after = await this.repo.files(record.refB);
    return toMetadataFormat({
      deploy,
      remove,
      removeWhen,
      files: [...after.keys()],
      read: (path) => this.repo.bytes(record.refB, path),
      packageDirs: record.packageDirs,
      apiVersion: record.apiVersion,
    });
  }

  /** The test classes that reach the package's Apex, from Source's Apex. */
  public async findTests(id: string, exclude: string[] = [], include: string[] = []): Promise<TestSelection> {
    const record = this.get(id);
    const after = await this.repo.files(record.refB);
    const sources = await apexSourcesFromFiles([...after.keys()], (path) => this.repo.text(after.get(path) ?? ''));
    return testsForPackage(sources, this.kept(record, exclude, include).deploy);
  }

  /** Both versions of one changed file: Target's side and Source's ('' where it does not exist). */
  public async texts(id: string, file: string): Promise<{ before: string; after: string }> {
    const record = this.get(id);
    if (!record.files.some((f) => f.path === file)) throw new Error('That file is not part of this comparison');
    const [before, after] = await Promise.all([this.repo.files(record.refA), this.repo.files(record.refB)]);
    const a = before.get(file);
    const b = after.get(file);
    return { before: a ? await this.repo.text(a) : '', after: b ? await this.repo.text(b) : '' };
  }

  /** The diff of one changed file, Target → Source. */
  public async diff(id: string, file: string): Promise<string> {
    const record = this.get(id);
    if (!record.files.some((f) => f.path === file)) throw new Error('That file is not part of this comparison');
    const [before, after] = await Promise.all([this.repo.files(record.refA), this.repo.files(record.refB)]);
    const a = before.get(file);
    const b = after.get(file);
    return unifiedDiff(a ? await this.repo.text(a) : '', b ? await this.repo.text(b) : '', [
      `${record.target} (${file})`,
      `${record.source} (${file})`,
    ]);
  }

  /**
   * manifest/package.xml and manifest/destructiveChanges.xml (when something is deleted), and with files the source
   * of everything deployed, read from git at Source. `exclude` ("Type:Name") leaves components out of all of it.
   */
  public async download(
    id: string,
    { files = false, exclude = [], include = [] }: { files?: boolean; exclude?: string[]; include?: string[] } = {}
  ): Promise<{ bytes: Uint8Array; name: string }> {
    const record = this.get(id);
    const { deploy, remove } = this.kept(record, exclude, include);
    const entries: Array<{ path: string; content: string | Uint8Array }> = [
      { path: 'manifest/package.xml', content: manifestXml(deploy, record.apiVersion) },
    ];
    if (remove.length)
      entries.push({ path: 'manifest/destructiveChanges.xml', content: manifestXml(remove, record.apiVersion) });
    if (files) {
      // eslint-disable-next-line no-await-in-loop
      for (const path of [...new Set(deploy.flatMap((c) => c.deploy))].sort())
        entries.push({ path, content: await this.repo.bytes(record.refB, path) });
    }
    const name = `${record.source.replace(/[^\w.-]+/g, '-')}-${files ? 'package' : 'manifest'}.zip`;
    return { bytes: makeZip(entries), name };
  }

  /**
   * Keeps renamed-away components for good: their old files go into the folder's .forceignore. This writes to the
   * repository (the screen asks first). The whole file is written (VS Code's folder writes replace a file).
   */
  public async ignoreRenamed(id: string, paths: string[]): Promise<string[]> {
    const record = this.get(id);
    const allowed = new Set(record.renames.flatMap((r) => r.from.files));
    const wanted = [...new Set(paths)];
    if (!wanted.length || wanted.some((p) => !allowed.has(p)))
      throw new Error("Only old files of this package's renames");
    if ((await this.root.requestPermission?.({ mode: 'readwrite' })) === 'denied')
      throw new Error('Changing the folder was not allowed');
    const existing = (await this.readWorkingFile(record.forceignore)) ?? '';
    const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const added = wanted.filter((p) => !lines.has(p));
    if (added.length) {
      const lead = existing && !existing.endsWith('\n') ? '\n' : '';
      const handle = await this.fileHandle(record.forceignore, true);
      if (!handle.createWritable) throw new Error('This folder cannot be written to here');
      const writable = await handle.createWritable();
      await writable.write(`${existing}${lead}# Renamed away; kept in the org (NomadSF)\n${added.join('\n')}\n`);
      await writable.close();
    }
    return added;
  }
}
