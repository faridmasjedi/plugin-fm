import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RunControl, RunState } from './types.js';

export const DEFAULT_RUNS_DIR = '.fm/runs';

/**
 * File-based store for pipeline runs.
 * - <runsDir>/<runId>.json: run state (written by the runner only)
 * - <runsDir>/<runId>.control.json: approvals and cancel requests (written by the dashboard or CLI)
 * - <runsDir>/<runId>/<stageId>.log: stage output
 */
export class RunStore {
  public readonly dir: string;

  public constructor(cwd: string, runsDir = DEFAULT_RUNS_DIR) {
    this.dir = resolve(cwd, runsDir);
  }

  private static writeJsonAtomic(path: string, data: unknown): void {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, path);
  }

  private static readJson<T>(path: string): T | undefined {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return undefined;
    }
  }

  public runPath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  public controlPath(id: string): string {
    return join(this.dir, `${id}.control.json`);
  }

  public logPath(id: string, stageId: string): string {
    return join(this.dir, id, `${stageId}.log`);
  }

  public save(run: RunState): void {
    mkdirSync(this.dir, { recursive: true });
    RunStore.writeJsonAtomic(this.runPath(run.id), run);
  }

  public load(id: string): RunState | undefined {
    return RunStore.readJson<RunState>(this.runPath(id));
  }

  public list(): RunState[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.control.json'))
      .map((f) => RunStore.readJson<RunState>(join(this.dir, f)))
      .filter((r): r is RunState => Boolean(r?.id && r.stages))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  public latest(): RunState | undefined {
    return this.list()[0];
  }

  public loadControl(id: string): RunControl {
    return RunStore.readJson<RunControl>(this.controlPath(id)) ?? { approvals: {} };
  }

  public updateControl(id: string, update: (control: RunControl) => void): RunControl {
    const control = this.loadControl(id);
    update(control);
    mkdirSync(this.dir, { recursive: true });
    RunStore.writeJsonAtomic(this.controlPath(id), control);
    return control;
  }

  public appendLog(id: string, stageId: string, text: string): void {
    mkdirSync(join(this.dir, id), { recursive: true });
    appendFileSync(this.logPath(id, stageId), text);
  }

  public readLog(id: string, stageId: string): string {
    try {
      return readFileSync(this.logPath(id, stageId), 'utf8');
    } catch {
      return '';
    }
  }
}
