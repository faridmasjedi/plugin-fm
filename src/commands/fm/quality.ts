/*
 * Copyright 2024, Salesforce, Inc.
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
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

import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';

Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'quality');

export type QualityCheckResult = {
  check: string;
  status: 'pass' | 'fail' | 'warning' | 'skipped';
  errors: number;
  warnings: number;
  details?: string[];
};

export type QualityResult = {
  baseSha: string;
  headSha: string;
  filesChanged: number;
  checks: QualityCheckResult[];
  totalErrors: number;
  totalWarnings: number;
  passed: boolean;
};

export default class Quality extends SfCommand<QualityResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'base-sha': Flags.string({
      char: 'b',
      summary: messages.getMessage('flags.baseSha.summary'),
      description: messages.getMessage('flags.baseSha.description'),
      required: true,
    }),
    'head-sha': Flags.string({
      summary: messages.getMessage('flags.headSha.summary'),
      description: messages.getMessage('flags.headSha.description'),
      required: true,
    }),
    'pmd-ruleset': Flags.file({
      summary: messages.getMessage('flags.pmdRuleset.summary'),
      description: messages.getMessage('flags.pmdRuleset.description'),
    }),
    'skip-eslint': Flags.boolean({
      summary: messages.getMessage('flags.skipEslint.summary'),
      description: messages.getMessage('flags.skipEslint.description'),
      default: false,
    }),
    'skip-xml-lint': Flags.boolean({
      summary: messages.getMessage('flags.skipXmlLint.summary'),
      description: messages.getMessage('flags.skipXmlLint.description'),
      default: false,
    }),
    'skip-pmd': Flags.boolean({
      summary: messages.getMessage('flags.skipPmd.summary'),
      description: messages.getMessage('flags.skipPmd.description'),
      default: false,
    }),
    'skip-tests': Flags.boolean({
      summary: messages.getMessage('flags.skipTests.summary'),
      description: messages.getMessage('flags.skipTests.description'),
      default: false,
    }),
    'fail-on-warnings': Flags.boolean({
      summary: messages.getMessage('flags.failOnWarnings.summary'),
      description: messages.getMessage('flags.failOnWarnings.description'),
      default: false,
    }),
  };

  private static verifyGitRepo(): void {
    try {
      execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
    } catch {
      throw messages.createError('error.noGitRepo');
    }
  }

  private static getChangedFiles(baseSha: string, headSha: string): string[] {
    try {
      const output = execSync(`git diff --name-only ${baseSha}...${headSha}`, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      return output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
    } catch (error) {
      throw messages.createError('error.gitDiffFailed', [(error as Error).message]);
    }
  }

  private static categorizeFiles(files: string[]): {
    jsTs: string[];
    xml: string[];
    tests: string[];
    all: string[];
  } {
    const jsTs: string[] = [];
    const xml: string[] = [];
    const tests: string[] = [];

    for (const file of files) {
      // JavaScript/TypeScript files
      if (file.match(/\.(js|ts|jsx|tsx)$/i)) {
        jsTs.push(file);
        // Test files
        if (file.match(/\.(test|spec)\.(js|ts|jsx|tsx)$/i)) {
          tests.push(file);
        }
      }
      // XML files
      if (file.match(/\.xml$/i)) {
        xml.push(file);
      }
    }

    return { jsTs, xml, tests, all: files };
  }

  private static findPmdRuleset(customRuleset?: string): string | undefined {
    if (customRuleset && existsSync(customRuleset)) {
      return resolve(customRuleset);
    }

    // Check default locations
    const defaultLocations = ['.pmd/ruleset.xml', 'pmd-ruleset.xml', '.pmd/pmd-ruleset.xml'];

    for (const location of defaultLocations) {
      const path = resolve(process.cwd(), location);
      if (existsSync(path)) {
        return path;
      }
    }

    return undefined;
  }

  private static getStatusEmoji(status: string): string {
    switch (status) {
      case 'pass':
        return '✅';
      case 'fail':
        return '❌';
      case 'warning':
        return '⚠️';
      case 'skipped':
        return '⏭️';
      default:
        return '◯';
    }
  }

  /**
   * Creates a QualityCheckResult object.
   */
  private static createCheckResult(
    check: string,
    status: 'pass' | 'fail' | 'warning' | 'skipped',
    errors: number,
    warnings: number,
    details?: string[]
  ): QualityCheckResult {
    return { check, status, errors, warnings, details };
  }

  /**
   * Parses output lines and counts issues containing specific keywords.
   */
  private static parseOutputForIssues(
    output: string,
    errorKeyword: string,
    warningKeyword?: string
  ): { errors: number; warnings: number; details: string[] } {
    const lines = output.split('\n');
    let errors = 0;
    let warnings = 0;
    const details: string[] = [];

    for (const line of lines) {
      if (line.includes(errorKeyword)) {
        errors++;
        details.push(line);
      } else if (warningKeyword && line.includes(warningKeyword)) {
        warnings++;
        details.push(line);
      }
    }

    return { errors, warnings, details };
  }

  /**
   * Parses PMD output and extracts violations.
   */
  private static parsePmdOutput(output: string): { count: number; details: string[] } {
    const lines = output.split('\n');
    const details: string[] = [];

    for (const line of lines) {
      if (line.trim() && !line.startsWith('PMD ') && !line.startsWith('Running ')) {
        details.push(line);
      }
    }

    return { count: details.length, details };
  }

  /**
   * Parses test output and extracts failures.
   */
  private static parseTestOutput(output: string): { count: number; details: string[] } {
    const lines = output.split('\n');
    let failures = 0;
    const details: string[] = [];

    for (const line of lines) {
      if (line.includes('failing') || line.includes('failed')) {
        const match = line.match(/(\d+)\s+(failing|failed)/);
        if (match) {
          failures = parseInt(match[1], 10);
        }
        details.push(line);
      }
    }

    return { count: failures, details };
  }

  public async run(): Promise<QualityResult> {
    const { flags } = await this.parse(Quality);

    // Verify we're in a Git repository
    Quality.verifyGitRepo();

    // Get changed files
    this.log(messages.getMessage('info.analyzingChanges', [flags['base-sha'], flags['head-sha']]));
    const changedFiles = Quality.getChangedFiles(flags['base-sha'], flags['head-sha']);

    if (changedFiles.length === 0) {
      this.log(messages.getMessage('info.noChangedFiles'));
      return {
        baseSha: flags['base-sha'],
        headSha: flags['head-sha'],
        filesChanged: 0,
        checks: [],
        totalErrors: 0,
        totalWarnings: 0,
        passed: true,
      };
    }

    this.log(messages.getMessage('info.foundChangedFiles', [changedFiles.length.toString()]));

    // Categorize changed files
    const filesByType = Quality.categorizeFiles(changedFiles);

    // Run quality checks
    const checks: QualityCheckResult[] = [];

    // ESLint
    if (!flags['skip-eslint'] && filesByType.jsTs.length > 0) {
      checks.push(this.runEslint(filesByType.jsTs));
    } else if (flags['skip-eslint']) {
      this.log(messages.getMessage('info.skippingCheck', ['ESLint', 'eslint']));
    }

    // XML Lint
    if (!flags['skip-xml-lint'] && filesByType.xml.length > 0) {
      checks.push(this.runXmlLint(filesByType.xml));
    } else if (flags['skip-xml-lint']) {
      this.log(messages.getMessage('info.skippingCheck', ['XML', 'xml-lint']));
    }

    // PMD
    if (!flags['skip-pmd']) {
      const pmdRuleset = Quality.findPmdRuleset(flags['pmd-ruleset']);
      if (pmdRuleset) {
        checks.push(this.runPmd(changedFiles, pmdRuleset));
      } else {
        this.log(messages.getMessage('info.noPmdRuleset'));
      }
    } else {
      this.log(messages.getMessage('info.skippingCheck', ['PMD', 'pmd']));
    }

    // Tests
    if (!flags['skip-tests'] && filesByType.tests.length > 0) {
      checks.push(this.runTests());
    } else if (flags['skip-tests']) {
      this.log(messages.getMessage('info.skippingCheck', ['tests', 'tests']));
    }

    // Calculate totals
    const totalErrors = checks.reduce((sum, check) => sum + check.errors, 0);
    const totalWarnings = checks.reduce((sum, check) => sum + check.warnings, 0);
    const passed = totalErrors === 0 && (!flags['fail-on-warnings'] || totalWarnings === 0);

    // Display results
    this.displayResults(checks, totalErrors, totalWarnings, passed);

    const result: QualityResult = {
      baseSha: flags['base-sha'],
      headSha: flags['head-sha'],
      filesChanged: changedFiles.length,
      checks,
      totalErrors,
      totalWarnings,
      passed,
    };

    // Throw error if checks failed
    if (!passed) {
      if (totalErrors > 0) {
        throw messages.createError('error.checksFailedWithErrors', [totalErrors.toString()]);
      } else {
        throw messages.createError('error.checksFailedWithWarnings', [totalWarnings.toString()]);
      }
    }

    return result;
  }

  private runEslint(files: string[]): QualityCheckResult {
    this.log(messages.getMessage('info.runningEslint', [files.length.toString()]));

    try {
      execSync(`npx eslint ${files.join(' ')}`, { encoding: 'utf8', stdio: 'pipe' });
      return Quality.createCheckResult('ESLint', 'pass', 0, 0);
    } catch (error) {
      const output = (error as { stdout?: string }).stdout ?? '';
      const { errors, warnings, details } = Quality.parseOutputForIssues(output, 'error', 'warning');

      return Quality.createCheckResult(
        'ESLint',
        errors > 0 ? 'fail' : 'warning',
        errors,
        warnings,
        details.slice(0, 20)
      );
    }
  }

  private runXmlLint(files: string[]): QualityCheckResult {
    this.log(messages.getMessage('info.runningXmlLint', [files.length.toString()]));

    const errors: string[] = [];

    for (const file of files) {
      if (!existsSync(file)) continue;

      try {
        execSync(`xmllint --noout "${file}"`, { encoding: 'utf8', stdio: 'pipe' });
      } catch (error) {
        errors.push(`${file}: ${(error as Error).message}`);
      }
    }

    return Quality.createCheckResult(
      'XML Lint',
      errors.length > 0 ? 'fail' : 'pass',
      errors.length,
      0,
      errors.slice(0, 20)
    );
  }

  private runPmd(files: string[], ruleset: string): QualityCheckResult {
    this.log(messages.getMessage('info.runningPmd'));

    // Check if PMD is available
    try {
      execSync('pmd --version', { stdio: 'pipe' });
    } catch {
      return Quality.createCheckResult('PMD', 'skipped', 0, 0, ['PMD not installed, skipping checks']);
    }

    try {
      const fileList = files.join(',');
      execSync(`pmd check --dir "${fileList}" --rulesets "${ruleset}" --format text --fail-on-violation true`, {
        encoding: 'utf8',
        stdio: 'pipe',
      });

      return Quality.createCheckResult('PMD', 'pass', 0, 0);
    } catch (error) {
      const output = (error as { stdout?: string }).stdout ?? '';
      const violations = Quality.parsePmdOutput(output);

      return Quality.createCheckResult('PMD', 'fail', violations.count, 0, violations.details.slice(0, 20));
    }
  }

  private runTests(): QualityCheckResult {
    this.log(messages.getMessage('info.runningTests'));

    try {
      execSync('npm run test:only', { encoding: 'utf8', stdio: 'pipe' });
      return Quality.createCheckResult('Tests', 'pass', 0, 0);
    } catch (error) {
      const output = (error as { stdout?: string }).stdout ?? '';
      const testFailures = Quality.parseTestOutput(output);

      return Quality.createCheckResult('Tests', 'fail', testFailures.count, 0, testFailures.details.slice(0, 20));
    }
  }

  private displayResults(
    checks: QualityCheckResult[],
    totalErrors: number,
    totalWarnings: number,
    passed: boolean
  ): void {
    this.log('\n' + '='.repeat(60));
    this.log('Quality Check Results');
    this.log('='.repeat(60) + '\n');

    for (const check of checks) {
      const status = Quality.getStatusEmoji(check.status);
      this.log(`${status} ${check.check}: ${check.status.toUpperCase()}`);

      if (check.errors > 0) {
        this.log(`   Errors: ${check.errors}`);
      }

      if (check.warnings > 0) {
        this.log(`   Warnings: ${check.warnings}`);
      }

      if (check.details && check.details.length > 0) {
        this.log('   Details:');
        for (const detail of check.details.slice(0, 5)) {
          this.log(`     ${detail}`);
        }
        if (check.details.length > 5) {
          this.log(`     ... and ${check.details.length - 5} more`);
        }
      }

      this.log('');
    }

    this.log('='.repeat(60));
    this.log(`Total Errors: ${totalErrors}`);
    this.log(`Total Warnings: ${totalWarnings}`);
    this.log('='.repeat(60) + '\n');

    if (passed) {
      this.log(messages.getMessage('info.allChecksPass'));
    } else if (totalErrors > 0) {
      this.log(messages.getMessage('info.checksFailedWithErrors', [totalErrors.toString()]));
    } else {
      this.log(messages.getMessage('info.checksFailedWithWarnings', [totalWarnings.toString()]));
    }
  }
}
