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
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { compareTrees, driftMarkdown, type DriftReport } from '../../utils/drift.js';

Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'drift');

export type DriftResult = DriftReport & { org: string; sourceDirs: string[]; passed: boolean; reportFile?: string };

function sf(args: string[], cwd: string): { result?: Record<string, unknown>; message?: string; status: number } {
  const res = spawnSync('sf', [...args, '--json'], { cwd, encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
  try {
    return JSON.parse(res.stdout || '{}') as { result?: Record<string, unknown>; message?: string; status: number };
  } catch {
    return { status: res.status ?? 1, message: res.stderr || 'The Salesforce CLI failed.' };
  }
}

/** Package directories of sfdx-project.json. */
function packageDirectories(cwd: string): string[] {
  const project = JSON.parse(readFileSync(join(cwd, 'sfdx-project.json'), 'utf8')) as {
    packageDirectories?: Array<{ path: string }>;
  };
  return (project.packageDirectories ?? []).map((d) => d.path);
}

/** Adds `<types><members>*</members><name>T</name></types>` for each type (components made in the org). */
export function addWildcards(packageXml: string, types: string[]): string {
  const extra = types
    .filter((t) => /^\w+$/.test(t))
    .map((t) => `    <types>\n        <members>*</members>\n        <name>${t}</name>\n    </types>\n`)
    .join('');
  return packageXml.replace(/(\s*<version>)/, `\n${extra}$1`);
}

export default class Drift extends SfCommand<DriftResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'target-org': Flags.requiredOrg({ summary: messages.getMessage('flags.targetOrg.summary') }),
    'source-dir': Flags.string({ summary: messages.getMessage('flags.sourceDir.summary'), multiple: true }),
    'include-org-only': Flags.string({
      summary: messages.getMessage('flags.includeOrgOnly.summary'),
      multiple: true,
      delimiter: ',',
    }),
    'output-file': Flags.file({ summary: messages.getMessage('flags.outputFile.summary') }),
    'fail-on-drift': Flags.boolean({ summary: messages.getMessage('flags.failOnDrift.summary'), default: false }),
  };

  public async run(): Promise<DriftResult> {
    const { flags } = await this.parse(Drift);
    const cwd = process.cwd();
    const org = flags['target-org'].getUsername() ?? '';
    const sourceDirs = flags['source-dir'] ?? packageDirectories(cwd);
    const work = mkdtempSync(join(tmpdir(), 'fm-drift-'));
    try {
      this.spinner.start('Building the manifest from the repository');
      const manifest = sf(
        [
          'project',
          'generate',
          'manifest',
          ...sourceDirs.flatMap((d) => ['--source-dir', d]),
          '--output-dir',
          work,
          '--name',
          'package.xml',
        ],
        cwd
      );
      const packageXml = join(work, 'package.xml');
      if (manifest.status !== 0 || !existsSync(packageXml))
        this.error(manifest.message ?? 'Could not build the manifest.');
      if (flags['include-org-only']?.length) {
        writeFileSync(packageXml, addWildcards(readFileSync(packageXml, 'utf8'), flags['include-org-only']));
      }

      this.spinner.start(`Retrieving the same metadata from ${org}`);
      const orgDir = join(work, 'org');
      const retrieve = sf(
        ['project', 'retrieve', 'start', '--manifest', packageXml, '--target-org', org, '--output-dir', orgDir],
        cwd
      );
      if (retrieve.status !== 0) this.error(retrieve.message ?? 'Retrieve failed.');
      this.spinner.stop();

      const report = compareTrees(
        sourceDirs.map((d) => resolve(cwd, d)),
        orgDir,
        cwd
      );
      const markdown = driftMarkdown(report, org);
      this.log(markdown);
      let reportFile: string | undefined;
      if (flags['output-file']) {
        reportFile = resolve(cwd, flags['output-file']);
        writeFileSync(reportFile, markdown);
      }
      if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
      const passed = !(flags['fail-on-drift'] && report.drift);
      if (!passed) process.exitCode = 1;
      return { ...report, org, sourceDirs, passed, reportFile };
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
