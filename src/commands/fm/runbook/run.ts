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

import { basename, resolve } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { PipelineRunner } from '../../../utils/pipeline/runner.js';
import { DEFAULT_RUNS_DIR, RunStore } from '../../../utils/pipeline/store.js';
import type { PipelineConfig, RunState } from '../../../utils/pipeline/types.js';
import { PROVIDER_PRESETS } from '../../../utils/ai/index.js';

Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'runbook.run');

export default class RunbookRun extends SfCommand<RunState> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    file: Flags.file({
      char: 'f',
      summary: messages.getMessage('flags.file.summary'),
      required: true,
      exists: true,
    }),
    'target-org': Flags.requiredOrg({
      char: 'o',
      summary: messages.getMessage('flags.targetOrg.summary'),
      required: true,
    }),
    plan: Flags.boolean({
      summary: messages.getMessage('flags.plan.summary'),
      default: false,
    }),
    approve: Flags.string({
      summary: messages.getMessage('flags.approve.summary'),
      description: messages.getMessage('flags.approve.description'),
      options: ['writes', 'all', 'none'] as const,
      default: 'writes',
    }),
    pr: Flags.boolean({
      summary: messages.getMessage('flags.pr.summary'),
      default: false,
    }),
    'base-branch': Flags.string({
      summary: messages.getMessage('flags.baseBranch.summary'),
    }),
    provider: Flags.string({
      summary: messages.getMessage('flags.provider.summary'),
      options: Object.keys(PROVIDER_PRESETS),
    }),
    model: Flags.string({
      summary: messages.getMessage('flags.model.summary'),
    }),
    'wait-for-approval': Flags.boolean({
      summary: messages.getMessage('flags.waitForApproval.summary'),
      default: false,
    }),
    release: Flags.string({
      summary: messages.getMessage('flags.release.summary'),
    }),
    'runs-dir': Flags.directory({
      summary: messages.getMessage('flags.runsDir.summary'),
      default: DEFAULT_RUNS_DIR,
    }),
  };

  public async run(): Promise<RunState> {
    const { flags } = await this.parse(RunbookRun);
    const cwd = process.cwd();
    const file = resolve(cwd, flags.file);
    const targetOrg = flags['target-org'].getUsername() ?? '';

    // A runbook run is a one-stage pipeline, so it is recorded and shown like any other run
    const config: PipelineConfig = {
      name: `Runbook: ${basename(file)}`,
      stages: [
        {
          id: 'runbook',
          name: `${flags.plan ? 'Plan' : 'Run'} ${basename(file)}`,
          uses: 'ai-runbook',
          run: flags.file,
          with: {
            'target-org': targetOrg,
            mode: flags.plan ? 'plan' : 'execute',
            approve: flags.approve,
            pr: flags.pr,
            base: flags['base-branch'],
            provider: flags.provider,
            model: flags.model,
          },
        },
      ],
    };

    const run = await new PipelineRunner({
      cwd,
      configPath: file,
      config,
      store: new RunStore(cwd, flags['runs-dir']),
      runCommand: (id, argv) => this.config.runCommand(id, argv),
      logger: this,
      interactive: !flags['wait-for-approval'] && Boolean(process.stdin.isTTY) && !process.env.CI,
      waitForApproval: flags['wait-for-approval'],
      stepByStep: false,
      release: flags.release,
      trigger: process.env.CI ? 'ci' : 'local',
      event: 'manual',
    }).execute();

    if (run.status !== 'passed') process.exitCode = 1;
    return run;
  }
}
