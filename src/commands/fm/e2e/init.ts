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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { FIXTURES_TS, PLAYWRIGHT_CONFIG, SMOKE_SPEC_TS } from '../../../utils/e2e.js';

Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'e2e.init');

export type E2eInitResult = { created: string[]; skipped: string[] };

export default class E2eInit extends SfCommand<E2eInitResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    force: Flags.boolean({
      summary: messages.getMessage('flags.force.summary'),
      default: false,
    }),
  };

  public async run(): Promise<E2eInitResult> {
    const { flags } = await this.parse(E2eInit);
    const result: E2eInitResult = { created: [], skipped: [] };
    const files: Array<[string, string]> = [
      ['playwright.config.ts', PLAYWRIGHT_CONFIG],
      ['tests/e2e/fixtures.ts', FIXTURES_TS],
      ['tests/e2e/smoke.spec.ts', SMOKE_SPEC_TS],
    ];
    for (const [relative, content] of files) {
      const path = resolve(process.cwd(), relative);
      if (existsSync(path) && !flags.force) {
        result.skipped.push(relative);
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      result.created.push(relative);
    }
    result.created.forEach((f) => this.log(`  created  ${f}`));
    result.skipped.forEach((f) => this.log(`  exists   ${f} (use --force to overwrite)`));
    this.log(messages.getMessage('info.nextSteps'));
    return result;
  }
}
