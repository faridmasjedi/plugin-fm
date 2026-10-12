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

import { userInfo } from 'node:os';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { DEFAULT_RUNS_DIR, RunStore } from '../../../utils/pipeline/store.js';
import type { ApprovalDecision } from '../../../utils/pipeline/types.js';

Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'pipeline.approve');

export type PipelineApproveResult = ApprovalDecision & { runId: string; stageId: string };

export default class PipelineApprove extends SfCommand<PipelineApproveResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    run: Flags.string({
      summary: messages.getMessage('flags.run.summary'),
      default: 'latest',
    }),
    stage: Flags.string({
      summary: messages.getMessage('flags.stage.summary'),
    }),
    reject: Flags.boolean({
      summary: messages.getMessage('flags.reject.summary'),
      default: false,
    }),
    'runs-dir': Flags.directory({
      summary: messages.getMessage('flags.runsDir.summary'),
      default: DEFAULT_RUNS_DIR,
    }),
  };

  public async run(): Promise<PipelineApproveResult> {
    const { flags } = await this.parse(PipelineApprove);
    const store = new RunStore(process.cwd(), flags['runs-dir']);
    const run = flags.run === 'latest' ? store.latest() : store.load(flags.run);
    if (!run) throw messages.createError('error.runNotFound', [flags.run]);

    const stageId = flags.stage ?? run.stages.find((s) => s.status === 'awaiting-approval')?.id;
    if (!stageId || !run.stages.some((s) => s.id === stageId)) {
      throw messages.createError('error.noStage', [run.id]);
    }

    const decision: ApprovalDecision = {
      decision: flags.reject ? 'reject' : 'approve',
      by: process.env.GITHUB_ACTOR ?? userInfo().username,
      at: new Date().toISOString(),
    };
    store.updateControl(run.id, (c) => {
      c.approvals[stageId] = decision;
    });

    this.log(messages.getMessage(flags.reject ? 'info.rejected' : 'info.approved', [stageId, run.id]));
    if (run.status === 'paused') this.log(messages.getMessage('info.resumeHint', [run.id]));
    return { ...decision, runId: run.id, stageId };
  }
}
