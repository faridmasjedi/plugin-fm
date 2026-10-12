import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Logger } from '../types.js';
import { commandForScript, runProcess } from '../scriptRunner.js';
import { createDeploymentTag, findLatestDeploymentTagInfo } from '../deployTagUtils.js';
import { loadAiConfig, type AiProviderId } from '../ai/index.js';
import { runRunbook, type ApprovalPolicy, type PendingApproval, type RunbookState } from '../runbook/agent.js';
import { interpolate, isTruthy, toArgv, type InterpolationContext } from './config.js';
import type { RunStore } from './store.js';
import { summarizeStage } from './summaries.js';
import type { PipelineConfig, PipelineEvent, RunState, StageConfig, StageState, StageUses } from './types.js';

const FM_COMMANDS: Partial<Record<StageUses, string>> = {
  build: 'fm:build',
  quality: 'fm:quality',
  deploy: 'fm:deploy',
  'check-duplicates': 'fm:check-duplicates',
};

const TERMINAL: Array<StageState['status']> = ['passed', 'failed', 'warning', 'skipped'];

export type RunnerOptions = {
  cwd: string;
  configPath: string;
  config: PipelineConfig;
  store: RunStore;
  /** Runs an fm command in-process and returns its result (oclif Config.runCommand). */
  runCommand: (commandId: string, argv: string[]) => Promise<unknown>;
  logger: Logger;
  /** Ask in the terminal at approval gates. */
  interactive: boolean;
  /** Wait for approval from the dashboard (or `sf fm pipeline approve`) at gates. */
  waitForApproval: boolean;
  /** Treat every stage as manual: confirm before each one. */
  stepByStep: boolean;
  release?: string;
  trigger: RunState['trigger'];
  /** pr, push or manual; stages with `on:` only run for matching events. */
  event: PipelineEvent;
  resume?: RunState;
};

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function gitInfo(cwd: string): Pick<RunState, 'branch' | 'commit' | 'commitMessage' | 'author' | 'ciUrl'> {
  const env = process.env;
  const ciUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  return {
    branch: env.GITHUB_HEAD_REF ?? env.GITHUB_REF_NAME ?? git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    commit: git(['rev-parse', 'HEAD'], cwd),
    commitMessage: git(['log', '-1', '--format=%s'], cwd),
    author: git(['log', '-1', '--format=%an'], cwd),
    ciUrl,
  };
}

function newRunId(commit: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').substring(0, 15);
  return `${stamp}-${commit.substring(0, 7) || 'local'}`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Tees everything written to stdout/stderr while `fn` runs into `sink`
 * so in-process command output also lands in the stage log.
 */
async function captureOutput<T>(sink: (text: string) => void, fn: () => Promise<T>): Promise<T> {
  const out = process.stdout.write.bind(process.stdout);
  const err = process.stderr.write.bind(process.stderr);
  const tee =
    (write: typeof out) =>
    (chunk: unknown, ...rest: unknown[]): boolean => {
      sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
  process.stdout.write = tee(out) as typeof process.stdout.write;
  process.stderr.write = tee(err) as typeof process.stderr.write;
  try {
    return await fn();
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

export class PipelineRunner {
  private run!: RunState;

  public constructor(private readonly options: RunnerOptions) {}

  private get store(): RunStore {
    return this.options.store;
  }

  public async execute(): Promise<RunState> {
    this.run = this.options.resume ? this.prepareResume(this.options.resume) : this.createRun();
    this.save();
    this.options.logger.log(`\n▶ Pipeline "${this.run.pipeline}" · run ${this.run.id} · release ${this.run.release}\n`);

    for (const stageConfig of this.options.config.stages) {
      const stage = this.stageState(stageConfig.id);
      if (TERMINAL.includes(stage.status)) continue;

      if (this.cancelRequested()) return this.finish('canceled');

      // A gate that already has a decision (e.g. approved while paused) is not re-evaluated
      const decided = Boolean(this.store.loadControl(this.run.id).approvals[stage.id]);
      const skipReason = decided ? undefined : this.skipReason(stageConfig);
      if (skipReason) {
        this.updateStage(stage, { status: 'skipped', skipReason });
        this.options.logger.log(`⏭  ${stage.name}: skipped (${skipReason})`);
        continue;
      }

      const gated = stageConfig.uses === 'approval' || Boolean(stageConfig.manual) || this.options.stepByStep;
      if (gated) {
        // eslint-disable-next-line no-await-in-loop
        const gate = await this.passGate(stage);
        if (gate === 'paused') return this.finish('paused');
        if (gate === 'canceled') return this.finish('canceled');
        if (gate === 'rejected') {
          this.updateStage(stage, { status: 'failed', error: 'Rejected', finishedAt: new Date().toISOString() });
          continue;
        }
        if (stageConfig.uses === 'approval') {
          this.updateStage(stage, { status: 'passed', finishedAt: new Date().toISOString() });
          continue;
        }
      }

      // eslint-disable-next-line no-await-in-loop
      await this.executeStage(stageConfig, stage);
    }

    return this.finish(this.hasBlockingFailure() ? 'failed' : 'passed');
  }

  private createRun(): RunState {
    const info = gitInfo(this.options.cwd);
    const id = newRunId(info.commit);
    const context: InterpolationContext = {
      env: { ...process.env, ...this.options.config.env },
      run: { id, branch: info.branch, commit: info.commit },
      stages: {},
    };
    const release =
      this.options.release ??
      (this.options.config.release ? interpolate(this.options.config.release, context) : info.branch);

    return {
      id,
      pipeline: this.options.config.name,
      release: release || info.branch || id,
      configPath: this.options.configPath,
      ...info,
      trigger: this.options.trigger,
      event: this.options.event,
      status: 'running',
      startedAt: new Date().toISOString(),
      stages: this.options.config.stages.map((s) => ({
        id: s.id,
        name: s.name ?? s.id,
        uses: s.uses,
        description: s.description,
        manual: s.uses === 'approval' || Boolean(s.manual),
        status: 'pending',
      })),
    };
  }

  /** Keeps finished stages, resets the rest, and adds stages that were added to the file since. */
  private prepareResume(previous: RunState): RunState {
    const byId = new Map(previous.stages.map((s) => [s.id, s]));
    return {
      ...previous,
      status: 'running',
      finishedAt: undefined,
      stages: this.options.config.stages.map((s) => {
        const old = byId.get(s.id);
        if (old && (old.status === 'passed' || old.status === 'warning' || old.status === 'skipped')) return old;
        return {
          id: s.id,
          name: s.name ?? s.id,
          uses: s.uses,
          description: s.description,
          manual: s.uses === 'approval' || Boolean(s.manual),
          status: 'pending',
        };
      }),
    };
  }

  private stageState(id: string): StageState {
    return this.run.stages.find((s) => s.id === id)!;
  }

  private save(): void {
    this.store.save(this.run);
  }

  private updateStage(stage: StageState, patch: Partial<StageState>): void {
    Object.assign(stage, patch);
    this.save();
  }

  private hasBlockingFailure(): boolean {
    return this.run.stages.some((s) => s.status === 'failed');
  }

  /** Returns why a stage must be skipped (event, `if` outcome, `when` condition), or undefined to run it. */
  private skipReason(stage: StageConfig): string | undefined {
    if (stage.on && !stage.on.includes(this.run.event)) {
      return `runs on ${stage.on.join(', ')}; this run is ${this.run.event}`;
    }

    const failed = this.hasBlockingFailure();
    const condition = stage.if ?? 'success';
    if ((condition === 'success' && failed) || (condition === 'failure' && !failed)) return `if: ${condition}`;

    if (stage.when !== undefined) {
      const conditions = Array.isArray(stage.when) ? (stage.when as unknown[]) : [stage.when];
      for (const expression of conditions) {
        let value: unknown;
        try {
          value = interpolate(expression, this.interpolationContext());
        } catch {
          return `when: ${String(expression)} is not set`;
        }
        if (!isTruthy(value)) return `when: ${String(expression)} is false`;
      }
    }
    return undefined;
  }

  private cancelRequested(): boolean {
    return Boolean(this.store.loadControl(this.run.id).cancel);
  }

  private finish(status: RunState['status']): RunState {
    this.run.status = status;
    if (status !== 'paused') this.run.finishedAt = new Date().toISOString();
    this.save();

    const icon = { passed: '✅', failed: '❌', canceled: '⛔', paused: '⏸', running: '…', 'awaiting-approval': '⏸' }[
      status
    ];
    this.options.logger.log(`\n${icon} Pipeline ${status} · run ${this.run.id}`);
    return this.run;
  }

  private async passGate(stage: StageState): Promise<'approved' | 'rejected' | 'paused' | 'canceled'> {
    const existing = this.store.loadControl(this.run.id).approvals[stage.id];
    if (existing) return this.applyDecision(stage, existing.decision, existing.by);

    this.updateStage(stage, { status: 'awaiting-approval' });
    this.run.status = 'awaiting-approval';
    this.save();
    const label = stage.uses === 'approval' ? stage.name : `Run "${stage.name}"`;
    this.options.logger.log(`⏸  Waiting for approval: ${label}`);

    if (this.options.interactive) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`   ${label}? [Y/n] `)).trim().toLowerCase();
      rl.close();
      const decision = answer === '' || answer === 'y' || answer === 'yes' ? 'approve' : 'reject';
      this.store.updateControl(this.run.id, (c) => {
        c.approvals[stage.id] = { decision, by: process.env.USER ?? 'terminal', at: new Date().toISOString() };
      });
      return this.applyDecision(stage, decision, process.env.USER ?? 'terminal');
    }

    if (this.options.waitForApproval) {
      this.options.logger.log('   Approve it in the dashboard (sf fm dashboard) or with sf fm pipeline approve.');
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const control = this.store.loadControl(this.run.id);
        if (control.cancel) return 'canceled';
        const decision = control.approvals[stage.id];
        if (decision) return this.applyDecision(stage, decision.decision, decision.by);
        // eslint-disable-next-line no-await-in-loop
        await sleep(2000);
      }
    }

    this.options.logger.log(
      `   Paused. Continue with:\n     sf fm pipeline approve --run ${this.run.id} --stage ${stage.id}\n     sf fm pipeline run --resume ${this.run.id}`
    );
    return 'paused';
  }

  private applyDecision(stage: StageState, decision: 'approve' | 'reject', by: string): 'approved' | 'rejected' {
    this.run.status = 'running';
    this.updateStage(stage, { status: 'pending', approvedBy: by });
    this.options.logger.log(`   ${decision === 'approve' ? 'Approved' : 'Rejected'} by ${by}`);
    return decision === 'approve' ? 'approved' : 'rejected';
  }

  private interpolationContext(): InterpolationContext {
    return {
      env: { ...process.env, ...this.options.config.env },
      run: {
        id: this.run.id,
        release: this.run.release,
        branch: this.run.branch,
        commit: this.run.commit,
        event: this.run.event,
      },
      stages: Object.fromEntries(this.run.stages.map((s) => [s.id, { status: s.status, result: s.result }])),
    };
  }

  private async executeStage(config: StageConfig, stage: StageState): Promise<void> {
    const startedAt = new Date();
    this.updateStage(stage, { status: 'running', startedAt: startedAt.toISOString(), error: undefined });
    this.options.logger.log(`\n━━ ${stage.name} (${config.uses}) ━━`);
    const log = (text: string): void => this.store.appendLog(this.run.id, stage.id, text);
    log(`# ${stage.name} — started ${startedAt.toISOString()}\n`);

    let status: StageState['status'] = 'passed';
    let error: string | undefined;
    let rawResult: unknown;

    try {
      ({ rawResult, error } = await this.runStageWork(config, stage, log));
    } catch (e) {
      error = (e as Error).message;
      log(`\nERROR: ${error}\n`);
    }

    if (error) status = config['continue-on-error'] ? 'warning' : 'failed';
    const { metrics, result } = summarizeStage(config.uses, rawResult);
    const finishedAt = new Date();
    this.updateStage(stage, {
      status,
      error,
      metrics,
      result,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    });
    const icon = { passed: '✔', warning: '⚠', failed: '✖' }[status as 'passed' | 'warning' | 'failed'];
    this.options.logger.log(`${icon} ${stage.name}: ${status}${error ? ` — ${error}` : ''}`);
  }

  /** Resolves the stage's values and runs its command, script or shell line. */
  private async runStageWork(
    config: StageConfig,
    stage: StageState,
    log: (text: string) => void
  ): Promise<{ rawResult: unknown; error?: string }> {
    const resolved = interpolate(
      { with: config.with ?? {}, run: config.run, env: config.env ?? {} },
      this.interpolationContext()
    );
    const targetOrg = this.recordStageContext(config, stage, resolved.with);
    const env = {
      ...process.env,
      ...this.options.config.env,
      ...resolved.env,
      FM_RUN_ID: this.run.id,
      FM_RELEASE: this.run.release,
      ...(targetOrg ? { FM_TARGET_ORG: targetOrg } : {}),
    };
    const timeoutMs = config['timeout-minutes'] ? config['timeout-minutes'] * 60_000 : undefined;

    const commandId = FM_COMMANDS[config.uses];
    if (commandId) {
      const rawResult = await captureOutput(log, () => this.options.runCommand(commandId, toArgv(resolved.with)));
      // Commands such as quality report failure via the exit code; the pipeline decides instead
      process.exitCode = undefined;
      const qualityFailed = config.uses === 'quality' && (rawResult as { passed?: boolean })?.passed === false;
      return { rawResult, error: qualityFailed ? 'Quality gate failed' : undefined };
    }

    if (config.uses === 'tag') return { rawResult: this.tagStage(resolved.with, log) };
    if (config.uses === 'ai-runbook') {
      const state = await this.runbookStage(resolved.run!, resolved.with, stage, log);
      const failed = state.status === 'failed';
      return { rawResult: state, error: failed ? state.error ?? 'One or more runbook steps failed' : undefined };
    }

    let rawResult: { exitCode: number } | undefined;
    if (config.uses === 'script') {
      const scriptPath = resolve(this.options.cwd, resolved.run!);
      if (!existsSync(scriptPath)) throw new Error(`Script not found: ${resolved.run!}`);
      const { cmd, args } = commandForScript(scriptPath, targetOrg);
      rawResult = await this.spawnStage(cmd, args, env, false, timeoutMs, log);
    } else if (config.uses === 'shell') {
      rawResult = await this.spawnStage(resolved.run!, [], env, true, timeoutMs, log);
    }
    const exitCode = rawResult?.exitCode;
    return { rawResult, error: exitCode !== undefined && exitCode !== 0 ? `Exited with code ${exitCode}` : undefined };
  }

  /** Records the org (and deploy mode) a stage works on, for the dashboard. */
  private recordStageContext(
    config: StageConfig,
    stage: StageState,
    withFlags: Record<string, unknown>
  ): string | undefined {
    const targetOrg = withFlags['target-org'] as string | undefined;
    if (targetOrg) this.updateStage(stage, { targetOrg });
    if (config.uses === 'deploy') {
      this.updateStage(stage, {
        deployMode: withFlags['check-only'] ? 'validation' : String(withFlags.mode ?? 'validation'),
      });
    }
    return targetOrg;
  }

  /** Tags the deployed commit; reuses the latest tag when the commit is already tagged. */
  private tagStage(withFlags: Record<string, unknown>, log: (text: string) => void): unknown {
    const tagLogger = { log: (m: string): void => log(`${m}\n`), warn: (m: string): void => log(`WARNING: ${m}\n`) };
    const branch = String(withFlags.branch);
    const commitRef = withFlags.commit ? String(withFlags.commit) : 'HEAD';
    const commit = git(['rev-parse', `${commitRef}^{commit}`], this.options.cwd);

    const latest = findLatestDeploymentTagInfo(branch, this.options.cwd, tagLogger);
    if (latest && latest.sha === commit) {
      this.options.logger.log(`${commit.substring(0, 8)} is already tagged as ${latest.tag}`);
      return { ...latest, alreadyTagged: true };
    }
    const tag = createDeploymentTag(
      {
        branch,
        commit: commitRef,
        push: isTruthy(withFlags.push),
        message: `Successful Salesforce deployment of ${branch} (pipeline run ${this.run.id})`,
        cwd: this.options.cwd,
      },
      tagLogger
    );
    this.options.logger.log(`Tagged ${tag.sha.substring(0, 8)} as ${tag.tag}`);
    return tag;
  }

  /** Runs an AI runbook; every gated action becomes an approval on this stage. */
  private async runbookStage(
    runbookPath: string,
    withFlags: Record<string, unknown>,
    stage: StageState,
    log: (text: string) => void
  ): Promise<RunbookState> {
    const ai = loadAiConfig(this.options.cwd, {
      provider: withFlags.provider as AiProviderId | undefined,
      model: withFlags.model as string | undefined,
    });
    return runRunbook({
      cwd: this.options.cwd,
      runbookPath,
      targetOrg: String(withFlags['target-org']),
      mode: withFlags.mode === 'plan' ? 'plan' : 'execute',
      approve: (withFlags.approve as ApprovalPolicy | undefined) ?? 'writes',
      ai,
      pullRequest: { enabled: isTruthy(withFlags.pr), base: withFlags.base ? String(withFlags.base) : undefined },
      requestApproval: (pending) => this.approveAction(stage, pending),
      onUpdate: (state) =>
        this.updateStage(stage, { result: state, metrics: summarizeStage('ai-runbook', state).metrics }),
      log: (text) => {
        log(text);
        process.stdout.write(text);
      },
    });
  }

  /** Waits for a decision on one action inside a stage (terminal, dashboard or CLI). */
  private async approveAction(stage: StageState, pending: PendingApproval): Promise<{ approved: boolean; by: string }> {
    const key = `${stage.id}:${pending.id}`;
    const decided = (): { approved: boolean; by: string } | undefined => {
      const decision = this.store.loadControl(this.run.id).approvals[key];
      return decision ? { approved: decision.decision === 'approve', by: decision.by } : undefined;
    };
    const finish = (result: { approved: boolean; by: string }): { approved: boolean; by: string } => {
      this.run.status = 'running';
      this.updateStage(stage, { status: 'running', pendingAction: undefined });
      return result;
    };

    const existing = decided();
    if (existing) return finish(existing);
    this.run.status = 'awaiting-approval';
    this.updateStage(stage, { status: 'awaiting-approval', pendingAction: { key, ...pending } });
    this.options.logger.log(`\n⏸  Approval needed — ${pending.title}\n${pending.detail.replace(/^/gm, '   │ ')}`);

    if (this.options.interactive) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question(`   ${pending.kind === 'manual' ? 'Done' : 'Run it'}? [Y/n] `))
        .trim()
        .toLowerCase();
      rl.close();
      const approved = answer === '' || answer === 'y' || answer === 'yes';
      const by = process.env.USER ?? 'terminal';
      this.store.updateControl(this.run.id, (c) => {
        c.approvals[key] = { decision: approved ? 'approve' : 'reject', by, at: new Date().toISOString() };
      });
      return finish({ approved, by });
    }
    if (this.options.waitForApproval) {
      this.options.logger.log('   Approve it in the dashboard (sf fm dashboard).');
      // eslint-disable-next-line no-constant-condition
      while (true) {
        if (this.cancelRequested()) return finish({ approved: false, by: 'canceled' });
        const decision = decided();
        if (decision) return finish(decision);
        // eslint-disable-next-line no-await-in-loop
        await sleep(2000);
      }
    }
    throw new Error(
      pending.kind === 'manual'
        ? `The runbook needs a person for a manual step ("${pending.title}"). Run it in a terminal or with --wait-for-approval (dashboard).`
        : 'This AI runbook needs a person to approve actions. Run it in a terminal, with --wait-for-approval (dashboard), or set approve: none.'
    );
  }

  private async spawnStage(
    cmd: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    shell: boolean,
    timeoutMs: number | undefined,
    log: (text: string) => void
  ): Promise<{ exitCode: number }> {
    const res = await runProcess(cmd, args, {
      cwd: this.options.cwd,
      env,
      shell,
      timeoutMs,
      onOutput: (chunk) => {
        log(chunk);
        process.stdout.write(chunk);
      },
    });
    return { exitCode: res.exitCode };
  }
}
