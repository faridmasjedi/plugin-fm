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
import { updateDeployCacheWaitTime } from '../../utils/deployCacheUtils.js';
import { createDeploymentTag } from '../../utils/deployTagUtils.js';
import type { DeploymentOptions } from '../../utils/deploymentService.js';

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
  deploymentTag?: string;
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
      required: false,
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
    pre: Flags.string({
      summary: messages.getMessage('flags.pre.summary'),
      description: messages.getMessage('flags.pre.description'),
      multiple: true,
      delimiter: ',',
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
      default: 120,
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
    'ignore-conflicts': Flags.boolean({
      summary: messages.getMessage('flags.ignoreConflicts.summary'),
      description: messages.getMessage('flags.ignoreConflicts.description'),
      default: false,
    }),
    'tag-on-success': Flags.string({
      summary: messages.getMessage('flags.tagOnSuccess.summary'),
      description: messages.getMessage('flags.tagOnSuccess.description'),
    }),
    'tag-commit': Flags.string({
      summary: messages.getMessage('flags.tagCommit.summary'),
      default: 'HEAD',
    }),
    'push-tag': Flags.boolean({
      summary: messages.getMessage('flags.pushTag.summary'),
      dependsOn: ['tag-on-success'],
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

    // Validate non-quick deployment requires manifest
    if (flags.mode !== 'quick' && !flags.manifest) {
      throw new Error('--manifest is required for deployment, validation, and deploy modes');
    }

    // Validate RunSpecifiedTests requires test classes
    if (flags['test-level'] === 'RunSpecifiedTests' && (!flags.tests || (flags.tests as string[]).length === 0)) {
      throw messages.createError('error.testsRequired');
    }

    // Validate destructive mode
    if (flags.destructive) {
      const manifestDir = flags.manifest as string;
      const destructivePath = join(manifestDir, 'Destructive', 'destructiveChanges.xml');

      // Check if destructiveChanges.xml exists
      if (!existsSync(destructivePath)) {
        throw messages.createError('error.destructiveFileNotFound');
      }

      // Validate --pre flag usage
      if (flags.destructive === 'both' && (!flags.pre || (flags.pre as string[]).length === 0)) {
        throw messages.createError('error.preFilesRequiredForBoth');
      }

      if (flags.destructive !== 'both' && flags.pre && (flags.pre as string[]).length > 0) {
        throw messages.createError('error.preFilesOnlyForBoth');
      }
    }

    // Validate --pre flag requires --destructive both
    if (flags.pre && (flags.pre as string[]).length > 0 && flags.destructive !== 'both') {
      throw messages.createError('error.preRequiresDestructiveBoth');
    }
  }

  /**
   * Checks if there are changes to deploy in the ChangedFiles directory.
   */
  private static async hasChangesToDeploy(manifestDir: string): Promise<boolean> {
    const { readdirSync, statSync } = await import('node:fs');
    const changedFilesDir = resolve(manifestDir, 'ChangedFiles');

    try {
      const entries = readdirSync(changedFilesDir, { recursive: true });
      return entries.some((entry) => {
        const fullPath = resolve(changedFilesDir, entry.toString());
        return statSync(fullPath).isFile();
      });
    } catch {
      return false;
    }
  }

  /**
   * Builds deployment options from flags and context.
   */
  private static buildDeploymentOptions(
    flags: Record<string, unknown>,
    context: {
      manifestDir: string;
      targetOrg: Connection;
      mode: DeploymentMode;
      testClasses: string[];
      destructivePaths: { preDestructivePath?: string; postDestructivePath?: string };
      hasChanges: boolean;
    }
  ): DeploymentOptions {
    const useAsyncForProgress = flags.progress && !flags.async;
    let testLevel = flags['test-level'] as TestLevel;

    if (context.testClasses.length > 0 && testLevel === 'RunLocalTests') {
      testLevel = 'RunSpecifiedTests';
    }

    return {
      manifestDir: context.manifestDir,
      targetOrg: context.targetOrg,
      mode: context.mode,
      testLevel,
      testClasses: context.testClasses,
      destructiveMode: flags.destructive as DestructiveMode | undefined,
      preDestructivePath: context.destructivePaths.preDestructivePath,
      postDestructivePath: context.destructivePaths.postDestructivePath,
      validationId: flags['validation-id'] as string | undefined,
      ignoreWarnings: flags['ignore-warnings'] as boolean,
      ignoreConflicts: flags['ignore-conflicts'] as boolean,
      waitMinutes: flags.async || useAsyncForProgress ? 0 : (flags.wait as number),
      hasChanges: context.hasChanges,
    };
  }

  // eslint-disable-next-line complexity
  public async run(): Promise<DeployResult> {
    const { flags } = await this.parse(Deploy);
    Deploy.validateFlags(flags);

    const mode = flags['check-only'] ? 'validation' : (flags.mode as DeploymentMode);
    const targetOrg = flags['target-org'].getConnection(undefined);
    const targetOrgUsername = flags['target-org'].getUsername() ?? 'unknown';

    this.log(
      messages.getMessage('info.startingDeployment', [
        mode === 'validation' ? 'validation' : 'deployment',
        targetOrgUsername,
      ])
    );

    // Early return for quick deploy
    if (mode === 'quick') return this.tagIfRequested(await this.handleQuickDeploy(flags, targetOrg), flags, mode);

    const manifestDir = flags.manifest!;

    // Execute pre-deployment hooks
    if (flags['pre-steps']) {
      await this.executePreSteps(flags['pre-steps'], { targetOrg: targetOrgUsername, mode, manifestDir });
    }

    // Detect tests
    const testClasses = flags['intelligent-tests'] ? await this.detectIntelligentTests(manifestDir) : flags.tests ?? [];

    // Process destructive changes
    const destructivePaths = await this.processDestructiveChangesIfNeeded(flags, manifestDir);

    // Check for changes
    const hasChanges = await Deploy.hasChangesToDeploy(manifestDir);
    if (!hasChanges && !flags.destructive) {
      return this.createNoChangesResult();
    }

    // Build and execute deployment
    const deployOptions = Deploy.buildDeploymentOptions(flags, {
      manifestDir,
      targetOrg,
      mode,
      testClasses,
      destructivePaths,
      hasChanges,
    });

    const { DeploymentService } = await import('../../utils/deploymentService.js');
    let result = await DeploymentService.startDeployment(deployOptions);

    // Monitor progress if requested
    const useAsyncForProgress = flags.progress && !flags.async;
    if (useAsyncForProgress) {
      result = await this.monitorAndExecutePostHooks(result, flags, targetOrg, targetOrgUsername, mode, manifestDir);
      return this.tagIfRequested(result, flags, mode);
    }

    // Execute post-hooks and display results
    if (result.status === 'Succeeded' && flags['post-steps']) {
      await this.executePostSteps(flags['post-steps'], {
        jobId: result.jobId,
        targetOrg: targetOrgUsername,
        mode,
        manifestDir,
      });
    }

    this.displayResults(result, mode);
    return this.tagIfRequested(result, flags, mode);
  }

  /**
   * Tags the deployed commit so the next `sf fm build --from-last-successful-deployment`
   * diffs from here. Only real, completed deployments are tagged.
   */
  private tagIfRequested(result: DeployResult, flags: Record<string, unknown>, mode: DeploymentMode): DeployResult {
    const branch = flags['tag-on-success'] as string | undefined;
    if (!branch) return result;

    if (mode === 'validation') {
      this.log('Skipping deployment tag: validations do not change the org.');
      return result;
    }
    if (result.async || result.status !== 'Succeeded') {
      if (result.async) this.warn('Skipping deployment tag: the deployment is still running (async).');
      return result;
    }

    const tagInfo = createDeploymentTag(
      {
        branch,
        commit: flags['tag-commit'] as string,
        push: Boolean(flags['push-tag']),
        message: `Successful Salesforce deployment of ${branch} (job ${result.jobId})`,
        cwd: process.cwd(),
      },
      this
    );
    return { ...result, deploymentTag: tagInfo.tag };
  }

  /**
   * Processes destructive changes if the destructive flag is set.
   */
  private async processDestructiveChangesIfNeeded(
    flags: Record<string, unknown>,
    manifestDir: string
  ): Promise<{ preDestructivePath?: string; postDestructivePath?: string }> {
    if (!flags.destructive) return {};

    const { processDestructiveChanges } = await import('../../utils/deploymentUtils.js');
    const { findSfdxProjectJson } = await import('../../utils/fileUtils.js');
    const { readFileSync } = await import('node:fs');

    const sfdxProjectPath = findSfdxProjectJson(process.cwd());
    let sourceApiVersion = '59.0';

    if (sfdxProjectPath) {
      try {
        const projectJson = JSON.parse(readFileSync(sfdxProjectPath, 'utf-8')) as Record<string, unknown>;
        sourceApiVersion = (projectJson.sourceApiVersion as string) || '59.0';
      } catch {
        // Use default
      }
    }

    return processDestructiveChanges(
      manifestDir,
      flags.destructive as DestructiveMode,
      (flags.pre as string[]) || [],
      sourceApiVersion,
      this
    );
  }

  /**
   * Creates a result object for when there are no changes to deploy.
   */
  private createNoChangesResult(): DeployResult {
    this.log('\n✓ No changes to deploy. Skipping deployment.');
    return {
      jobId: 'N/A',
      status: 'Succeeded',
      deployedComponents: 0,
      failedComponents: 0,
      testsRun: 0,
      testsPassed: 0,
      testsFailed: 0,
      messages: ['No changes detected'],
      async: false,
    };
  }

  /**
   * Monitors deployment progress and executes post-deployment hooks.
   */
  private async monitorAndExecutePostHooks(
    result: DeployResult,
    flags: Record<string, unknown>,
    targetOrg: Connection,
    targetOrgUsername: string,
    mode: DeploymentMode,
    manifestDir: string
  ): Promise<DeployResult> {
    this.log(`\nMonitoring deployment: ${result.jobId}\n`);

    updateDeployCacheWaitTime(result.jobId, flags.wait as number);

    const monitoredResult = await this.monitorDeploymentWithProgress(
      result.jobId,
      targetOrg,
      flags.wait as number,
      mode
    );

    if (monitoredResult.status === 'Succeeded' && flags['post-steps']) {
      await this.executePostSteps(flags['post-steps'] as string, {
        jobId: monitoredResult.jobId,
        targetOrg: targetOrgUsername,
        mode,
        manifestDir,
      });
    }

    return monitoredResult;
  }

  /**
   * Handles quick deploy from a validation ID.
   */
  private async handleQuickDeploy(flags: Record<string, unknown>, targetOrg: Connection): Promise<DeployResult> {
    const validationId = flags['validation-id'] as string;
    const { DeploymentService } = await import('../../utils/deploymentService.js');

    // When progress is requested, we need to use async mode to get job ID and then poll
    const useAsyncForProgress = flags.progress && !flags.async;

    let result = await DeploymentService.startDeployment({
      manifestDir: '', // Not needed for quick deploy
      targetOrg,
      mode: 'quick',
      testLevel: 'NoTestRun',
      validationId,
      ignoreWarnings: flags['ignore-warnings'] as boolean,
      ignoreConflicts: flags['ignore-conflicts'] as boolean,
      waitMinutes: useAsyncForProgress ? 0 : (flags.wait as number),
    });

    // If progress monitoring is requested, monitor the deployment
    if (useAsyncForProgress) {
      this.log(`\nMonitoring deployment: ${result.jobId}\n`);
      result = await this.monitorDeploymentWithProgress(result.jobId, targetOrg, flags.wait as number, 'quick');
      return result;
    }

    this.displayResults(result, 'quick');
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

    // Display hook output
    if (result.stdout) {
      this.log(`\n${result.stdout}`);
    }

    if (result.stderr) {
      this.warn(`\nWarning output from hook:\n${result.stderr}`);
    }

    this.log(`\nPre-deployment hook completed in ${result.duration}ms`);

    if (!result.success) {
      if (result.stderr) {
        this.error(`\nHook error output:\n${result.stderr}`);
      }
      throw messages.createError('error.preStepsFailed', [result.exitCode.toString()]);
    }
  }

  private async executePostSteps(scriptPath: string, context: HookContext): Promise<void> {
    this.log(messages.getMessage('info.executingPostSteps', [scriptPath]));

    const { HooksExecutor } = await import('../../utils/hooksExecutor.js');
    const result = HooksExecutor.executePostHook(scriptPath, context, this);

    // Display hook output
    if (result.stdout) {
      this.log(`\n${result.stdout}`);
    }

    if (result.stderr) {
      this.warn(`\nWarning output from hook:\n${result.stderr}`);
    }

    this.log(`\nPost-deployment hook completed in ${result.duration}ms`);

    if (!result.success) {
      if (result.stderr) {
        this.error(`\nHook error output:\n${result.stderr}`);
      }
      this.warn(messages.getMessage('error.postStepsFailed', [result.exitCode.toString()]));
    }
  }

  private async monitorDeploymentWithProgress(
    jobId: string,
    connection: Connection,
    waitMinutes: number,
    mode: DeploymentMode
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
      reporter.displayProgress(progress, this, mode);

      // Check if complete
      if (progress.status === 'Succeeded' || progress.status === 'Failed' || progress.status === 'Canceled') {
        reporter.displayFinalSummary(progress, this, mode);

        // Combine component errors and test failures into error messages
        const errorMessages: string[] = [
          ...progress.errors.map((e) => `${e.file}: ${e.message}`),
          ...progress.testFailures.map((t) => `Test: ${t.className}.${t.methodName} - ${t.message}`),
        ];

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
          messages: errorMessages,
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

      // Show deployment statistics
      this.log('\n=== Deployment Summary ===');
      this.log(`Components Deployed: ${result.deployedComponents}`);
      this.log(`Tests Run: ${result.testsRun}`);
      this.log(`Tests Passed: ${result.testsPassed}`);
      if (result.codeCoverage !== undefined) {
        this.log(`Code Coverage: ${result.codeCoverage}%`);
      }
    } else if (result.status === 'Failed') {
      // Display detailed failure information
      this.log('\n=== Deployment Failed ===');
      this.log(`Job ID: ${result.jobId}`);
      this.log(
        `Components Deployed: ${result.deployedComponents}/${result.deployedComponents + result.failedComponents}`
      );
      this.log(`Failed Components: ${result.failedComponents}`);
      this.log(`Tests Run: ${result.testsRun}`);
      this.log(`Tests Failed: ${result.testsFailed}`);

      if (result.codeCoverage !== undefined) {
        this.log(`Code Coverage: ${result.codeCoverage}%`);
      }

      // Display all error messages
      if (result.messages.length > 0) {
        this.log('\n=== Errors ===');
        result.messages.forEach((msg, index) => {
          this.log(`${index + 1}. ${msg}`);
        });
      }

      this.error('\n' + messages.getMessage('error.deploymentFailed'));
    }
  }
}
