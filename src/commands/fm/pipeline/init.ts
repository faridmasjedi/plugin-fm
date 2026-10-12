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

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import {
  POST_DEPLOY_SH,
  PRE_DEPLOY_APEX,
  WAVES_TEMPLATE,
  pipelineTemplate,
  trainTemplate,
} from '../../../utils/pipeline/template.js';
import { DEFAULT_RUNS_DIR } from '../../../utils/pipeline/store.js';

Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'pipeline.init');

export type PipelineInitResult = { created: string[]; skipped: string[] };

export default class PipelineInit extends SfCommand<PipelineInitResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.string({
      summary: messages.getMessage('flags.targetOrg.summary'),
      default: 'my-uat',
    }),
    'base-branch': Flags.string({
      char: 'b',
      summary: messages.getMessage('flags.baseBranch.summary'),
      default: 'main',
    }),
    train: Flags.boolean({
      summary: messages.getMessage('flags.train.summary'),
      description: messages.getMessage('flags.train.description'),
      default: false,
    }),
    force: Flags.boolean({
      summary: messages.getMessage('flags.force.summary'),
      default: false,
    }),
  };

  public async run(): Promise<PipelineInitResult> {
    const { flags } = await this.parse(PipelineInit);
    const cwd = process.cwd();
    const result: PipelineInitResult = { created: [], skipped: [] };

    const options = { targetOrg: flags['target-org'], baseBranch: flags['base-branch'] };
    const files: Array<[string, string]> = flags.train
      ? [
          ['.fm/pipeline.yml', trainTemplate(options)],
          ['.fm/waves.yml', WAVES_TEMPLATE],
        ]
      : [
          ['.fm/pipeline.yml', pipelineTemplate(options)],
          ['.fm/scripts/pre-deploy.apex', PRE_DEPLOY_APEX],
          ['.fm/scripts/post-deploy.sh', POST_DEPLOY_SH],
        ];
    for (const [relative, content] of files) {
      const path = resolve(cwd, relative);
      if (existsSync(path) && !flags.force) {
        result.skipped.push(relative);
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      result.created.push(relative);
    }

    // Run history is local state, not source
    const gitignore = resolve(cwd, '.gitignore');
    const ignoreLine = `${DEFAULT_RUNS_DIR}/`;
    const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
    if (!current.split('\n').includes(ignoreLine)) {
      appendFileSync(gitignore, `${current && !current.endsWith('\n') ? '\n' : ''}${ignoreLine}\n`);
      result.created.push(`.gitignore (${ignoreLine})`);
    }

    result.created.forEach((f) => this.log(`  created  ${f}`));
    result.skipped.forEach((f) => this.log(`  exists   ${f} (use --force to overwrite)`));
    this.log(messages.getMessage('info.nextSteps'));
    return result;
  }
}
