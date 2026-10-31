import ignore from 'ignore';
import type { TestSelection } from './apexGraph.js';
import { apexSourcesFromFiles, testsForPackage } from './dependentTests.js';
import { FolderRepo, type FolderHandle } from './gitFolder.js';
import { unifiedDiff } from './projectCode.js';
import { toMetadataFormat, type ConvertResult } from './sourceConvert.js';
import { buildPackage, manifestXml, type SourcePackage } from './sourcePackage.js';
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
    const record: ComparedPackage = {
      ...built,
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
  private kept(
    record: ComparedPackage,
    exclude: string[]
  ): { deploy: SourcePackage['components']; remove: SourcePackage['components'] } {
    const out = new Set(exclude);
    const kept = record.components.filter((c) => !out.has(`${c.type}:${c.name}`));
    return { deploy: kept.filter((c) => c.change !== 'deleted'), remove: kept.filter((c) => c.change === 'deleted') };
  }

  /** The package in Metadata API format, ready to validate or deploy: Source's files converted (sourceConvert.ts). */
  public async metadataZip(
    id: string,
    { exclude = [], removeWhen = 'post' }: { exclude?: string[]; removeWhen?: 'pre' | 'post' } = {}
  ): Promise<ConvertResult> {
    const record = this.get(id);
    const { deploy, remove } = this.kept(record, exclude);
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
  public async findTests(id: string, exclude: string[] = []): Promise<TestSelection> {
    const record = this.get(id);
    const after = await this.repo.files(record.refB);
    const sources = await apexSourcesFromFiles([...after.keys()], (path) => this.repo.text(after.get(path) ?? ''));
    return testsForPackage(sources, this.kept(record, exclude).deploy);
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
    { files = false, exclude = [] }: { files?: boolean; exclude?: string[] } = {}
  ): Promise<{ bytes: Uint8Array; name: string }> {
    const record = this.get(id);
    const out = new Set(exclude);
    const kept = record.components.filter((c) => !out.has(`${c.type}:${c.name}`));
    const deploy = kept.filter((c) => c.change !== 'deleted');
    const remove = kept.filter((c) => c.change === 'deleted');
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
