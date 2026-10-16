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

import { spawnSync } from 'node:child_process';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { planOrgCreate, type OrgCreateStep } from '../../../utils/orgCreate.js';

Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'org.create');

export type OrgCreateResult = {
  alias: string;
  steps: Array<{ id: string; label: string; ok: boolean; message?: string; durationMs: number }>;
  dryRun: boolean;
};

export default class OrgCreate extends SfCommand<OrgCreateResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    type: Flags.string({
      summary: messages.getMessage('flags.type.summary'),
      options: ['scratch', 'sandbox'] as const,
      default: 'scratch',
    }),
    alias: Flags.string({ char: 'a', summary: messages.getMessage('flags.alias.summary'), required: true }),
    'definition-file': Flags.file({ summary: messages.getMessage('flags.definitionFile.summary') }),
    'duration-days': Flags.integer({
      summary: messages.getMessage('flags.durationDays.summary'),
      min: 1,
      max: 30,
      default: 7,
    }),
    'target-dev-hub': Flags.string({ summary: messages.getMessage('flags.targetDevHub.summary') }),
    'target-org': Flags.string({ summary: messages.getMessage('flags.targetOrg.summary') }),
    'sandbox-name': Flags.string({ summary: messages.getMessage('flags.sandboxName.summary') }),
    'license-type': Flags.string({
      summary: messages.getMessage('flags.licenseType.summary'),
      options: ['Developer', 'Developer_Pro', 'Partial', 'Full'] as const,
    }),
    'source-sandbox': Flags.string({ summary: messages.getMessage('flags.sourceSandbox.summary') }),
    'no-deploy': Flags.boolean({ summary: messages.getMessage('flags.noDeploy.summary'), default: false }),
    permset: Flags.string({ summary: messages.getMessage('flags.permset.summary'), multiple: true }),
    'data-plan': Flags.string({ summary: messages.getMessage('flags.dataPlan.summary'), multiple: true }),
    'apex-script': Flags.string({ summary: messages.getMessage('flags.apexScript.summary'), multiple: true }),
    'set-default': Flags.boolean({ summary: messages.getMessage('flags.setDefault.summary'), default: false }),
    open: Flags.boolean({ summary: messages.getMessage('flags.open.summary'), default: false }),
    'dry-run': Flags.boolean({ summary: messages.getMessage('flags.dryRun.summary'), default: false }),
  };

  public async run(): Promise<OrgCreateResult> {
    const { flags } = await this.parse(OrgCreate);
    const steps = planOrgCreate({
      type: flags.type as 'scratch' | 'sandbox',
      alias: flags.alias,
      definitionFile: flags['definition-file'],
      durationDays: flags['duration-days'],
      devHub: flags['target-dev-hub'],
      productionOrg: flags['target-org'],
      sandboxName: flags['sandbox-name'],
      licenseType: flags['license-type'],
      sourceSandbox: flags['source-sandbox'],
      // Sandboxes are copies of production; deploying the project is opt-in there
      deploy: !flags['no-deploy'] && flags.type === 'scratch',
      permsets: flags.permset ?? [],
      dataPlans: flags['data-plan'] ?? [],
      apexScripts: flags['apex-script'] ?? [],
      setDefault: flags['set-default'],
      open: flags.open,
    });

    if (flags['dry-run']) {
      for (const step of steps) this.log(`• ${step.label}\n    sf ${step.args.join(' ')}`);
      return {
        alias: flags.alias,
        steps: steps.map((s) => ({ id: s.id, label: s.label, ok: true, durationMs: 0 })),
        dryRun: true,
      };
    }

    const done: OrgCreateResult['steps'] = [];
    for (const step of steps) {
      const outcome = this.runStep(step);
      done.push(outcome);
      if (!outcome.ok) {
        this.error(`${step.label} failed: ${outcome.message ?? ''}`, { exit: 1 });
      }
    }
    this.log(`\n✅ ${flags.alias} is ready.`);
    return { alias: flags.alias, steps: done, dryRun: false };
  }

  private runStep(step: OrgCreateStep): OrgCreateResult['steps'][number] {
    this.spinner.start(step.label);
    const started = Date.now();
    const res = spawnSync('sf', [...step.args, '--json'], {
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024,
      timeout: ((step.waitMinutes ?? 30) + 5) * 60_000,
    });
    let parsed: { status?: number; message?: string } = {};
    try {
      parsed = JSON.parse(res.stdout || '{}') as typeof parsed;
    } catch {
      parsed = { status: res.status ?? 1, message: res.stderr };
    }
    const ok = res.status === 0 && (parsed.status ?? 0) === 0;
    this.spinner.stop(ok ? 'done' : 'failed');
    return {
      id: step.id,
      label: step.label,
      ok,
      message: ok ? undefined : parsed.message ?? res.stderr,
      durationMs: Date.now() - started,
    };
  }
}
