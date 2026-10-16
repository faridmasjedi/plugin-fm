import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_PIPELINE_FILES, loadPipelineConfig } from '../pipeline/config.js';
import { RunStore } from '../pipeline/store.js';
import { findFirstExisting } from '../qualityUtils.js';

/**
 * The Salesforce project (repository) the local NomadSF app works on. It can be switched
 * at runtime; runs, runbooks, retrieve, repository info and file access follow it.
 */

export type ProjectSummary = { name: string; path: string; sfdx: boolean };

const REGISTRY = join(homedir(), '.nomadsf', 'projects.json');
const SKIPPED = new Set(['.git', 'node_modules', '.sf', '.sfdx', '.fm', '.husky']);
const MAX_FILE = 2 * 1024 * 1024;

function readRegistry(): string[] {
  try {
    return (JSON.parse(readFileSync(REGISTRY, 'utf8')) as { recent?: string[] }).recent ?? [];
  } catch {
    return [];
  }
}

function writeRegistry(recent: string[]): void {
  try {
    mkdirSync(join(homedir(), '.nomadsf'), { recursive: true });
    writeFileSync(REGISTRY, `${JSON.stringify({ recent }, null, 2)}\n`);
  } catch {
    // The list of recent projects is a convenience only
  }
}

export class ProjectContext {
  public cwd: string;

  public constructor(
    cwd: string,
    private readonly runsDir: string,
    private readonly pluginCommand: string[],
    private explicitPipeline?: string
  ) {
    this.cwd = resolve(cwd);
    ProjectContext.remember(this.cwd);
  }

  public static summary(path: string): ProjectSummary {
    return { name: basename(path), path, sfdx: existsSync(join(path, 'sfdx-project.json')) };
  }

  private static remember(path: string): void {
    if (!existsSync(join(path, 'sfdx-project.json'))) return;
    writeRegistry([path, ...readRegistry().filter((p) => p !== path)].slice(0, 15));
  }
  public store(): RunStore {
    return new RunStore(this.cwd, this.runsDir);
  }

  public pipeline(): { configPath?: string; pipelineName?: string } {
    const configPath = this.explicitPipeline ?? findFirstExisting(this.cwd, DEFAULT_PIPELINE_FILES);
    if (!configPath) return {};
    try {
      return { configPath, pipelineName: loadPipelineConfig(configPath).name };
    } catch {
      return { configPath };
    }
  }

  /** Command line that starts a pipeline run of the current project, when it has a pipeline file. */
  public startCommand(): string[] | undefined {
    const { configPath, pipelineName } = this.pipeline();
    if (!configPath || !pipelineName) return undefined;
    return [...this.pluginCommand, 'fm', 'pipeline', 'run', '--file', configPath, '--runs-dir', this.runsDir];
  }

  public list(): { current: ProjectSummary; recent: ProjectSummary[] } {
    return {
      current: ProjectContext.summary(this.cwd),
      recent: readRegistry()
        .filter((p) => existsSync(p))
        .map((p) => ProjectContext.summary(p)),
    };
  }

  /** Switches to another Salesforce project (a folder with sfdx-project.json). */
  public select(path: string): ProjectSummary {
    const target = resolve(path.replace(/^~(?=$|\/)/, homedir()));
    if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`Folder not found: ${target}`);
    if (!existsSync(join(target, 'sfdx-project.json')))
      throw new Error(`${target} is not a Salesforce project (no sfdx-project.json).`);
    this.cwd = target;
    this.explicitPipeline = undefined;
    ProjectContext.remember(target);
    return ProjectContext.summary(target);
  }

  public listDir(rel: string): Array<{ name: string; kind: 'file' | 'dir' }> {
    const dir = this.inside(rel);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error('Folder not found.');
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => !SKIPPED.has(e.name) && (e.isFile() || e.isDirectory()))
      .map((e) => ({ name: e.name, kind: e.isDirectory() ? ('dir' as const) : ('file' as const) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  public readFile(rel: string): string {
    const file = this.inside(rel);
    if (!existsSync(file) || !statSync(file).isFile()) throw new Error('File not found.');
    if (statSync(file).size > MAX_FILE) throw new Error('File is larger than 2 MB.');
    return readFileSync(file, 'utf8');
  }

  /** Resolves a project-relative path, refusing anything outside the project or in skipped folders. */
  private inside(rel: string): string {
    const root = realpathSync(this.cwd);
    const target = resolve(root, rel || '.');
    const relPath = relative(root, target);
    if (relPath.startsWith('..') || relPath.split(sep).some((part) => SKIPPED.has(part)))
      throw new Error('Path not available.');
    if (existsSync(target) && relative(root, realpathSync(target)).startsWith('..'))
      throw new Error('Path not available.');
    return target;
  }
}
