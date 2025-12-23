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

import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages, Connection } from '@salesforce/core';

// Initialize messages
Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'deploy');

export type HookContext = {
  jobId?: string;
  targetOrg: string;
  mode: string;
  manifestDir: string;
};

export type DeploymentMode = 'validation' | 'deployment' | 'quick';
export type TestLevel = 'NoTestRun' | 'RunSpecifiedTests' | 'RunLocalTests' | 'RunAllTestsInOrg' | 'RunRelevantTests';
export type DestructiveMode = 'pre' | 'post' | 'both';

export type DeployStatus = 'Queued' | 'InProgress' | 'Succeeded' | 'Failed' | 'Canceled' | 'Pending';

export type DeployResult = {
  jobId: string;
  status: DeployStatus;
  validationId?: string;
  deployedComponents: number;
  failedComponents: number;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  codeCoverage?: number;
  messages: string[];
  async: boolean;
};

export default class Deploy extends SfCommand<DeployResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    manifest: Flags.directory({
      char: 'm',
      summary: messages.getMessage('flags.manifest.summary'),
      description: messages.getMessage('flags.manifest.description'),
      required: true,
      exists: true,
    }),
    'target-org': Flags.requiredOrg({
      char: 'o',
      summary: messages.getMessage('flags.targetOrg.summary'),
      description: messages.getMessage('flags.targetOrg.description'),
      required: true,
    }),
    mode: Flags.string({
      summary: messages.getMessage('flags.mode.summary'),
      description: messages.getMessage('flags.mode.description'),
      options: ['validation', 'deployment', 'quick'] as const,
      default: 'validation',
    }),
    'test-level': Flags.string({
      char: 'l',
      summary: messages.getMessage('flags.testLevel.summary'),
      description: messages.getMessage('flags.testLevel.description'),
      options: ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg', 'RunRelevantTests'] as const,
      default: 'RunLocalTests',
    }),
    tests: Flags.string({
      char: 't',
      summary: messages.getMessage('flags.tests.summary'),
      description: messages.getMessage('flags.tests.description'),
      multiple: true,
      delimiter: ',',
    }),
    'intelligent-tests': Flags.boolean({
      summary: messages.getMessage('flags.intelligentTests.summary'),
      description: messages.getMessage('flags.intelligentTests.description'),
      default: false,
    }),
    destructive: Flags.string({
      summary: messages.getMessage('flags.destructive.summary'),
      description: messages.getMessage('flags.destructive.description'),
      options: ['pre', 'post', 'both'] as const,
    }),
    'validation-id': Flags.string({
      char: 'i',
      summary: messages.getMessage('flags.validationId.summary'),
      description: messages.getMessage('flags.validationId.description'),
    }),
    'pre-steps': Flags.file({
      summary: messages.getMessage('flags.preSteps.summary'),
      description: messages.getMessage('flags.preSteps.description'),
      exists: true,
    }),
    'post-steps': Flags.file({
      summary: messages.getMessage('flags.postSteps.summary'),
      description: messages.getMessage('flags.postSteps.description'),
      exists: true,
    }),
    wait: Flags.integer({
      char: 'w',
      summary: messages.getMessage('flags.wait.summary'),
      description: messages.getMessage('flags.wait.description'),
      default: 33,
      min: 0,
    }),
    async: Flags.boolean({
      summary: messages.getMessage('flags.async.summary'),
      description: messages.getMessage('flags.async.description'),
      default: false,
    }),
    progress: Flags.boolean({
      char: 'p',
      summary: messages.getMessage('flags.progress.summary'),
      description: messages.getMessage('flags.progress.description'),
      default: false,
    }),
    'check-only': Flags.boolean({
      char: 'c',
      summary: messages.getMessage('flags.checkOnly.summary'),
      description: messages.getMessage('flags.checkOnly.description'),
      default: false,
    }),
    'ignore-warnings': Flags.boolean({
      summary: messages.getMessage('flags.ignoreWarnings.summary'),
      description: messages.getMessage('flags.ignoreWarnings.description'),
      default: false,
    }),
  };

  private static async sleep(ms: number): Promise<void> {
    return new Promise((resolveFn) => setTimeout(resolveFn, ms));
  }

  private static validateFlags(flags: Record<string, unknown>): void {
    // Validate quick deployment requires validation ID
    if (flags.mode === 'quick' && !flags['validation-id']) {
      throw messages.createError('error.validationIdRequired');
    }

    // Validate RunSpecifiedTests requires test classes
    if (flags['test-level'] === 'RunSpecifiedTests' && (!flags.tests || (flags.tests as string[]).length === 0)) {
      throw messages.createError('error.testsRequired');
    }

    // Validate destructive mode has required files
    if (flags.destructive) {
      const manifestDir = flags.manifest as string;
      const destructivePrePath = join(manifestDir, 'destructiveChangesPre.xml');
      const destructivePostPath = join(manifestDir, 'destructiveChanges.xml');

      if (flags.destructive === 'pre' && !existsSync(destructivePrePath)) {
        throw messages.createError('error.destructivePreFileNotFound');
      }

      if (flags.destructive === 'post' && !existsSync(destructivePostPath)) {
        throw messages.createError('error.destructivePostFileNotFound');
      }

      if (flags.destructive === 'both' && (!existsSync(destructivePrePath) || !existsSync(destructivePostPath))) {
        throw messages.createError('error.destructiveBothFilesNotFound');
      }
    }
  }

  public async run(): Promise<DeployResult> {
    const { flags } = await this.parse(Deploy);

    // Validate flags
    Deploy.validateFlags(flags);

    // Determine deployment mode
    const mode = flags['check-only'] ? 'validation' : (flags.mode as DeploymentMode);
    const targetOrg = flags['target-org'].getConnection(undefined);
    const targetOrgUsername = flags['target-org'].getUsername() ?? 'unknown';

    this.log(messages.getMessage('info.startingDeployment', [mode, targetOrgUsername]));

    // Execute pre-deployment hooks
    if (flags['pre-steps']) {
      await this.executePreSteps(flags['pre-steps'], {
        targetOrg: targetOrgUsername,
        mode,
        manifestDir: flags.manifest,
      });
    }

    // Handle intelligent test detection
    let testClasses = flags.tests ?? [];
    if (flags['intelligent-tests']) {
      testClasses = await this.detectIntelligentTests(flags.manifest);
    }

    // Build deployment options
    const deployOptions = {
      manifestDir: flags.manifest,
      targetOrg,
      mode,
      testLevel: flags['test-level'] as TestLevel,
      testClasses,
      destructiveMode: flags.destructive as DestructiveMode | undefined,
      validationId: flags['validation-id'],
      ignoreWarnings: flags['ignore-warnings'],
      waitMinutes: flags.async ? 0 : flags.wait,
    };

    // Start deployment
    const { DeploymentService } = await import('../../utils/deploymentService.js');
    let result = await DeploymentService.startDeployment(deployOptions);

    // Show progress if requested and not async
    if (flags.progress && !flags.async) {
      result = await this.monitorDeploymentWithProgress(result.jobId, targetOrg, flags.wait);
    }

    // Execute post-deployment hooks if deployment succeeded
    if (result.status === 'Succeeded' && flags['post-steps']) {
      await this.executePostSteps(flags['post-steps'], {
        jobId: result.jobId,
        targetOrg: targetOrgUsername,
        mode,
        manifestDir: flags.manifest,
      });
    }

    // Display final results
    this.displayResults(result, mode);

    return result;
  }

  private async detectIntelligentTests(manifestDir: string): Promise<string[]> {
    this.log(messages.getMessage('info.analyzingTests'));

    const { TestDetectionService } = await import('../../utils/testDetection.js');
    const changedFilesPath = resolve(manifestDir, 'ChangedFiles');

    // Find changed Apex files
    const { readdir } = await import('node:fs/promises');
    const changedFiles: string[] = [];

    const findApexFiles = async (dir: string): Promise<void> => {
      try {
        const entries = await readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(dir, entry.name);

          if (entry.isDirectory()) {
            // eslint-disable-next-line no-await-in-loop
            await findApexFiles(fullPath);
          } else if (entry.isFile() && (entry.name.endsWith('.cls') || entry.name.endsWith('.trigger'))) {
            changedFiles.push(fullPath);
          }
        }
      } catch {
        // Skip directories we can't read
      }
    };

    await findApexFiles(changedFilesPath);

    if (changedFiles.length === 0) {
      this.warn(messages.getMessage('warn.noIntelligentTests'));
      return [];
    }

    const result = await TestDetectionService.detectTestsForChanges(changedFiles, process.cwd());

    if (result.testClasses.length > 0) {
      this.log(messages.getMessage('info.foundIntelligentTests', [result.testClasses.length.toString()]));
      this.log(`Test classes: ${result.testClasses.join(', ')}`);
    } else {
      this.warn(messages.getMessage('warn.noIntelligentTests'));
    }

    return result.testClasses;
  }

  private async executePreSteps(scriptPath: string, context: HookContext): Promise<void> {
    this.log(messages.getMessage('info.executingPreSteps', [scriptPath]));

    const { HooksExecutor } = await import('../../utils/hooksExecutor.js');
    const result = HooksExecutor.executePreHook(scriptPath, context, this);

    if (!result.success) {
      throw messages.createError('error.preStepsFailed', [result.exitCode.toString()]);
    }
  }

  private async executePostSteps(scriptPath: string, context: HookContext): Promise<void> {
    this.log(messages.getMessage('info.executingPostSteps', [scriptPath]));

    const { HooksExecutor } = await import('../../utils/hooksExecutor.js');
    const result = HooksExecutor.executePostHook(scriptPath, context, this);

    if (!result.success) {
      this.warn(messages.getMessage('error.postStepsFailed', [result.exitCode.toString()]));
    }
  }

  private async monitorDeploymentWithProgress(
    jobId: string,
    connection: Connection,
    waitMinutes: number
  ): Promise<DeployResult> {
    const { ProgressReporter } = await import('../../utils/progressReporter.js');
    const { DeploymentService } = await import('../../utils/deploymentService.js');

    const reporter = new ProgressReporter();
    const pollInterval = 5000; // 5 seconds
    const maxWaitTime = waitMinutes * 60 * 1000;
    const startTime = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      const progress = await DeploymentService.checkDeploymentStatus(jobId, connection);

      // Display progress
      reporter.displayProgress(progress, this);

      // Check if complete
      if (progress.status === 'Succeeded' || progress.status === 'Failed' || progress.status === 'Canceled') {
        reporter.displayFinalSummary(progress, this);

        return {
          jobId: progress.id,
          status: progress.status,
          validationId: progress.validationId,
          deployedComponents: progress.componentsDeployed,
          failedComponents: progress.errors.length,
          testsRun: progress.testsCompleted,
          testsPassed: progress.testsPassed,
          testsFailed: progress.testsFailed,
          codeCoverage: progress.codeCoverage,
          messages: progress.errors.map((e) => `${e.file}: ${e.message}`),
          async: false,
        };
      }

      // Check timeout
      if (Date.now() - startTime > maxWaitTime) {
        throw new Error(`Deployment monitoring timed out after ${waitMinutes} minutes`);
      }

      // eslint-disable-next-line no-await-in-loop
      await Deploy.sleep(pollInterval);
    }
  }

  private displayResults(result: DeployResult, mode: DeploymentMode): void {
    if (result.async) {
      // For async deployments, output job ID in an easy-to-capture format
      this.log(messages.getMessage('info.deploymentStarted', [result.jobId]));
      this.log(`\nJob ID: ${result.jobId}`);
      this.log(`\nTo check status, run: sf fm deploy status --job-id ${result.jobId} --target-org <org>`);

      // Also output to stderr for easy capture in CI/CD
      // This allows: JOB_ID=$(sf fm deploy --async 2>&1 | grep "^Job ID:" | cut -d: -f2 | tr -d ' ')
      return;
    }

    if (result.status === 'Succeeded') {
      if (mode === 'validation' && result.validationId) {
        this.log(messages.getMessage('info.validationSucceeded', [result.validationId]));
        this.log(`\nValidation ID: ${result.validationId}`);
      } else {
        this.log(messages.getMessage('info.deploymentSucceeded'));
      }
    } else if (result.status === 'Failed') {
      this.error(messages.getMessage('error.deploymentFailed'));
    }
  }
}
