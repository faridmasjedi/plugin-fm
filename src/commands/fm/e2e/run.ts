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

import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { runE2e, type E2eResult } from '../../../utils/e2e.js';

Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'e2e.run');

export default class E2eRun extends SfCommand<E2eResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({
      char: 'o',
      summary: messages.getMessage('flags.targetOrg.summary'),
      required: true,
    }),
    grep: Flags.string({
      char: 'g',
      summary: messages.getMessage('flags.grep.summary'),
    }),
    project: Flags.string({
      summary: messages.getMessage('flags.project.summary'),
    }),
    headed: Flags.boolean({
      summary: messages.getMessage('flags.headed.summary'),
      default: false,
    }),
  };

  public async run(): Promise<E2eResult> {
    const { flags } = await this.parse(E2eRun);
    const org = flags['target-org'].getUsername() ?? '';
    const result = await runE2e({
      cwd: process.cwd(),
      org,
      grep: flags.grep,
      project: flags.project,
      headed: flags.headed,
      onOutput: (chunk) => process.stdout.write(chunk),
    });

    const s = result.stats;
    this.log('');
    this.styledHeader(`End-to-end: ${result.passed ? 'PASSED' : 'FAILED'}`);
    this.log(
      `Passed ${s.passed} · Failed ${s.failed} · Flaky ${s.flaky} · Skipped ${s.skipped} · ${(
        s.durationMs / 1000
      ).toFixed(1)}s`
    );
    this.log(messages.getMessage('info.report', [result.reportDir]));
    if (!result.passed) process.exitCode = 1;
    return result;
  }
}
