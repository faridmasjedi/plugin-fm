/*
 * Copyright 2024, Salesforce, Inc.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted permitted that the following conditions are met:
 *
 * 1. Redistributions of code must retain the above copyright notice,
 *    this list of conditions and the following disclaimer.
 *
 * 2. Redistributions in binary form must reproduce the above copyright notice,
 *    this list of conditions and the following disclaimer in the documentation
 *    and/or other materials provided with the distribution.
 *
 * 3. Neither the name of the copyright holder nor the names of its contributors
 *    may be used to endorse or promote products derived from this software without
 *    specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 * ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 * LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 * CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 * SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 * INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 * CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 * ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { DEFAULT_PIPELINE_FILES, loadPipelineConfig } from '../../../utils/pipeline/config.js';
import { PipelineRunner } from '../../../utils/pipeline/runner.js';
import { DEFAULT_RUNS_DIR, RunStore } from '../../../utils/pipeline/store.js';
import {
  PIPELINE_EVENTS,
  type PipelineConfig,
  type PipelineEvent,
  type RunState,
} from '../../../utils/pipeline/types.js';
import { findFirstExisting } from '../../../utils/qualityUtils.js';
import { renderStaticDashboard } from '../../../utils/dashboard/server.js';

Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'pipeline.run');

export default class PipelineRun extends SfCommand<RunState> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    file: Flags.file({
      char: 'f',
      summary: messages.getMessage('flags.file.summary'),
      exists: true,
    }),
    event: Flags.string({
      summary: messages.getMessage('flags.event.summary'),
      description: messages.getMessage('flags.event.description'),
      options: PIPELINE_EVENTS,
    }),
    release: Flags.string({
      summary: messages.getMessage('flags.release.summary'),
    }),
    resume: Flags.string({
      summary: messages.getMessage('flags.resume.summary'),
    }),
    'step-by-step': Flags.boolean({
      summary: messages.getMessage('flags.stepByStep.summary'),
      default: false,
    }),
    'wait-for-approval': Flags.boolean({
      summary: messages.getMessage('flags.waitForApproval.summary'),
      default: false,
    }),
    prompt: Flags.boolean({
      summary: messages.getMessage('flags.prompt.summary'),
      default: true,
      allowNo: true,
    }),
    'dashboard-export': Flags.file({
      summary: messages.getMessage('flags.dashboardExport.summary'),
    }),
    'runs-dir': Flags.directory({
      summary: messages.getMessage('flags.runsDir.summary'),
      default: DEFAULT_RUNS_DIR,
    }),
    trigger: Flags.string({
      summary: 'How the run was started (set by the dashboard).',
      options: ['local', 'ci', 'dashboard'] as const,
      hidden: true,
    }),
  };

  /** Maps the CI event to a pipeline event (GitHub Actions: pull_request -> pr, push -> push). */
  private static detectEvent(): PipelineEvent {
    const name = process.env.GITHUB_EVENT_NAME ?? process.env.FM_EVENT ?? '';
    if (name.startsWith('pull_request') || name === 'pr' || name === 'merge_request_event') return 'pr';
    if (name === 'push') return 'push';
    return 'manual';
  }

  /** Loads the run to resume (if any) and the pipeline file. */
  private static loadRunInputs(
    flags: { resume?: string; file?: string },
    store: RunStore,
    cwd: string
  ): { resume?: RunState; configPath: string; config: PipelineConfig } {
    let resume: RunState | undefined;
    if (flags.resume) {
      resume = flags.resume === 'latest' ? store.latest() : store.load(flags.resume);
      if (!resume) throw messages.createError('error.runNotFound', [flags.resume]);
    }
    const configPath = flags.file
      ? resolve(cwd, flags.file)
      : resume?.configPath ?? findFirstExisting(cwd, DEFAULT_PIPELINE_FILES);
    if (!configPath) throw messages.createError('error.noPipelineFile');
    return { resume, configPath, config: loadPipelineConfig(configPath) };
  }

  public async run(): Promise<RunState> {
    const { flags } = await this.parse(PipelineRun);
    const cwd = process.cwd();
    const store = new RunStore(cwd, flags['runs-dir']);

    const { resume, configPath, config } = PipelineRun.loadRunInputs(flags, store, cwd);

    const isCi = Boolean(process.env.CI);
    const event = resume?.event ?? (flags.event as PipelineEvent | undefined) ?? PipelineRun.detectEvent();
    if (!flags.event && !resume && event === 'manual' && config.stages.some((s) => s.on && !s.on.includes('manual'))) {
      this.warn(messages.getMessage('warn.manualEvent'));
    }
    const runner = new PipelineRunner({
      cwd,
      configPath,
      config,
      store,
      runCommand: (id, argv) => this.config.runCommand(id, argv),
      logger: this,
      interactive: flags.prompt && !flags['wait-for-approval'] && Boolean(process.stdin.isTTY) && !isCi,
      waitForApproval: flags['wait-for-approval'],
      stepByStep: flags['step-by-step'],
      release: flags.release,
      trigger: (flags.trigger as RunState['trigger'] | undefined) ?? (isCi ? 'ci' : 'local'),
      event,
      resume,
    });

    const run = await runner.execute();

    if (flags['dashboard-export']) {
      const out = resolve(cwd, flags['dashboard-export']);
      writeFileSync(out, renderStaticDashboard(store, { pipelineName: config.name, configPath }, cwd));
      this.log(messages.getMessage('info.dashboardExported', [out]));
    }
    if (run.status === 'failed' || run.status === 'canceled') process.exitCode = 1;
    return run;
  }
}
