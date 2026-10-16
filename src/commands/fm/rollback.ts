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

import { join } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import type { DiffResult } from '../../utils/reportUtils.js';
import { planRollback, targetWorktree, type RollbackPlan } from '../../utils/rollback.js';

Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'rollback');

export type RollbackResult = RollbackPlan & {
  mode: 'validation' | 'deployment';
  changed: number;
  deleted: number;
  deploy?: unknown;
};

export default class Rollback extends SfCommand<RollbackResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({ summary: messages.getMessage('flags.targetOrg.summary') }),
    branch: Flags.string({ summary: messages.getMessage('flags.branch.summary'), required: true }),
    to: Flags.string({ summary: messages.getMessage('flags.to.summary') }),
    'dry-run': Flags.boolean({ summary: messages.getMessage('flags.dryRun.summary'), default: false }),
    'test-level': Flags.string({
      summary: messages.getMessage('flags.testLevel.summary'),
      options: ['NoTestRun', 'RunLocalTests', 'RunAllTestsInOrg'] as const,
      default: 'RunLocalTests',
    }),
    'no-prompt': Flags.boolean({ summary: messages.getMessage('flags.noPrompt.summary'), default: false }),
  };

  public async run(): Promise<RollbackResult> {
    const { flags } = await this.parse(Rollback);
    const cwd = process.cwd();
    const plan = planRollback(flags.branch, cwd, flags.to);
    const mode = flags['dry-run'] ? 'validation' : 'deployment';
    const org = flags['target-org'].getUsername() ?? '';

    this.log(`Org is on   ${plan.current.tag} (${plan.current.sha.slice(0, 7)})`);
    this.log(`Rolling to  ${plan.target.tag} (${plan.target.sha.slice(0, 7)})`);
    this.log(`Undoing ${plan.commits.length} commit(s):\n${plan.commits.map((c) => `  ${c}`).join('\n')}`);

    if (mode === 'deployment' && !flags['no-prompt']) {
      const ok = await this.confirm({ message: `Deploy this rollback to ${org}?` });
      if (!ok) this.error('Rollback canceled.');
    }

    const worktree = targetWorktree(plan, cwd);
    const out = join(worktree.dir, '..', 'rollback-package');
    try {
      // Delta current -> target, built where the files are in their target version
      process.chdir(worktree.dir);
      const build = await this.config.runCommand<DiffResult>('fm:build', [
        '--ref-a',
        plan.current.sha,
        '--ref-b',
        plan.target.sha,
        '--output-dir',
        out,
      ]);
      const changed = build.statistics.totalChanged;
      const deleted = build.statistics.totalDeleted;
      if (changed + deleted === 0) {
        this.log('Nothing to roll back: no metadata differs between the two deployments.');
        return { ...plan, mode, changed, deleted };
      }

      const args = ['--manifest', out, '--target-org', org, '--mode', mode, '--test-level', flags['test-level']];
      if (deleted > 0) args.push('--destructive', 'post');
      // The next delta build should start from the version the org is now on
      if (mode === 'deployment') args.push('--tag-on-success', plan.branch, '--tag-commit', plan.target.sha);
      const deploy = await this.config.runCommand('fm:deploy', args);
      return { ...plan, mode, changed, deleted, deploy };
    } finally {
      process.chdir(cwd);
      worktree.cleanup();
    }
  }
}
