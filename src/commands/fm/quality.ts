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

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { getAllChangedAndDeletedFiles, getAllFilesFromWorkingTree, filterIgnoredFiles } from '../../utils/gitUtils.js';
import {
  type EngineRun,
  type QualityEngine,
  type Severity,
  type Violation,
  SEVERITY_LABELS,
  countBySeverity,
  detectEngines,
  filterScannableFiles,
  findCodeAnalyzerConfig,
  findPmdRuleset,
  runQualityEngines,
  toMarkdown,
  toSarif,
} from '../../utils/qualityUtils.js';

Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'quality');

export type QualityResult = {
  passed: boolean;
  refA?: string;
  refB?: string;
  filesScanned: number;
  severityThreshold: number;
  counts: Record<Severity, number>;
  engines: EngineRun[];
  violations: Violation[];
  reports: { json: string; sarif: string; markdown: string };
};

export default class Quality extends SfCommand<QualityResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'ref-a': Flags.string({
      char: 'r',
      summary: messages.getMessage('flags.refA.summary'),
    }),
    'ref-b': Flags.string({
      char: 'R',
      summary: messages.getMessage('flags.refB.summary'),
      default: 'HEAD',
    }),
    all: Flags.boolean({
      char: 'a',
      summary: messages.getMessage('flags.all.summary'),
      default: false,
    }),
    engine: Flags.string({
      char: 'e',
      summary: messages.getMessage('flags.engine.summary'),
      description: messages.getMessage('flags.engine.description'),
      options: ['code-analyzer', 'pmd', 'eslint'] as const,
      multiple: true,
    }),
    'rule-selector': Flags.string({
      summary: messages.getMessage('flags.ruleSelector.summary'),
      multiple: true,
      default: ['Recommended'],
    }),
    'pmd-ruleset': Flags.file({
      summary: messages.getMessage('flags.pmdRuleset.summary'),
      description: messages.getMessage('flags.pmdRuleset.description'),
      exists: true,
    }),
    'config-file': Flags.file({
      summary: messages.getMessage('flags.configFile.summary'),
      exists: true,
    }),
    forceignore: Flags.file({
      char: 'i',
      summary: messages.getMessage('flags.forceignore.summary'),
      default: '.forceignore',
    }),
    'severity-threshold': Flags.integer({
      char: 's',
      summary: messages.getMessage('flags.severityThreshold.summary'),
      description: messages.getMessage('flags.severityThreshold.description'),
      min: 1,
      max: 5,
      default: 2,
    }),
    'warn-only': Flags.boolean({
      summary: messages.getMessage('flags.warnOnly.summary'),
      default: false,
    }),
    'output-dir': Flags.directory({
      char: 'd',
      summary: messages.getMessage('flags.outputDir.summary'),
      default: 'quality-report',
    }),
  };

  private static collectFiles(
    flags: { all: boolean; 'ref-a'?: string; 'ref-b': string; forceignore: string },
    cwd: string,
    logger: { log: (m: string) => void; warn: (m: string) => void }
  ): string[] {
    let files: string[];
    if (flags.all) {
      const tree = getAllFilesFromWorkingTree(cwd, logger);
      files = [...tree.parent, ...[...tree.submodules.values()].flat()];
    } else {
      files = getAllChangedAndDeletedFiles(flags['ref-a']!, flags['ref-b'], cwd, logger).changed;
    }
    return filterScannableFiles(filterIgnoredFiles(files, resolve(cwd, flags.forceignore)), cwd);
  }

  public async run(): Promise<QualityResult> {
    const { flags } = await this.parse(Quality);
    if (!flags.all && !flags['ref-a']) throw messages.createError('error.refOrAllRequired');
    const cwd = process.cwd();
    const quiet = {
      log: (): void => {},
      warn: (m: string): void => {
        this.warn(m);
      },
    };

    const files = Quality.collectFiles(flags, cwd, quiet);
    const outputDir = resolve(cwd, flags['output-dir']);
    mkdirSync(outputDir, { recursive: true });

    const pmdRuleset = flags['pmd-ruleset'] ? resolve(cwd, flags['pmd-ruleset']) : findPmdRuleset(cwd);
    const engines = (flags.engine as QualityEngine[] | undefined) ?? detectEngines(cwd, pmdRuleset);
    if (engines.length === 0) throw messages.createError('error.noEngines');

    let violations: Violation[] = [];
    let runs: EngineRun[] = [];
    if (files.length === 0) {
      this.log(messages.getMessage('info.noFiles'));
    } else {
      this.log(messages.getMessage('info.scanning', [files.length.toString(), engines.join(', ')]));
      ({ violations, runs } = runQualityEngines(
        {
          cwd,
          files,
          engines,
          ruleSelectors: flags['rule-selector'],
          pmdRuleset,
          codeAnalyzerConfig: flags['config-file'] ? resolve(cwd, flags['config-file']) : findCodeAnalyzerConfig(cwd),
          workDir: join(outputDir, '.work'),
        },
        this
      ));
    }

    const threshold = flags['severity-threshold'];
    const blocking = violations.filter((v) => v.severity <= threshold);
    const engineFailed = runs.some((r) => r.status === 'error');
    const passed = blocking.length === 0 && !engineFailed;

    const reports = {
      json: join(outputDir, 'quality.json'),
      sarif: join(outputDir, 'quality.sarif'),
      markdown: join(outputDir, 'quality.md'),
    };
    const result: QualityResult = {
      passed,
      refA: flags.all ? undefined : flags['ref-a'],
      refB: flags.all ? undefined : flags['ref-b'],
      filesScanned: files.length,
      severityThreshold: threshold,
      counts: countBySeverity(violations),
      engines: runs,
      violations,
      reports,
    };
    const markdown = toMarkdown(violations, runs, threshold, passed);
    writeFileSync(reports.json, JSON.stringify(result, null, 2));
    writeFileSync(reports.sarif, JSON.stringify(toSarif(violations, engines), null, 2));
    writeFileSync(reports.markdown, markdown);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);

    this.printSummary(result);

    if (!passed && !flags['warn-only']) {
      process.exitCode = 1;
      this.logToStderr(
        engineFailed
          ? messages.getMessage('error.engineFailed')
          : messages.getMessage('error.thresholdExceeded', [blocking.length.toString(), threshold.toString()])
      );
    }
    return result;
  }

  private printSummary(result: QualityResult): void {
    const c = result.counts;
    this.log('');
    this.styledHeader(`Code quality: ${result.passed ? 'PASSED' : 'FAILED'}`);
    this.log(
      `Critical ${c[1]} · High ${c[2]} · Moderate ${c[3]} · Low ${c[4]} · Info ${c[5]}   (threshold: ${
        result.severityThreshold
      } ${SEVERITY_LABELS[result.severityThreshold as Severity]})`
    );
    if (result.violations.length > 0) {
      this.table({
        data: result.violations.slice(0, 30).map((v) => ({
          severity: SEVERITY_LABELS[v.severity],
          rule: v.rule,
          location: `${v.file}${v.line ? `:${v.line}` : ''}`,
          message: v.message.length > 80 ? `${v.message.substring(0, 77)}...` : v.message,
        })),
      });
      if (result.violations.length > 30) this.log(`…and ${result.violations.length - 30} more.`);
    }
    this.log(`Reports: ${result.reports.markdown}, ${result.reports.sarif}, ${result.reports.json}`);
  }
}
