import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Connection } from '@salesforce/core';
import type { DeploymentMode, TestLevel, DestructiveMode, DeployResult, DeployStatus } from '../commands/fm/deploy.js';

export type DeploymentOptions = {
  manifestDir: string;
  targetOrg: Connection;
  mode: DeploymentMode;
  testLevel: TestLevel;
  testClasses?: string[];
  destructiveMode?: DestructiveMode;
  preDestructivePath?: string;
  postDestructivePath?: string;
  validationId?: string;
  ignoreWarnings: boolean;
  ignoreConflicts: boolean;
  waitMinutes: number;
  hasChanges?: boolean;
};

export type DeploymentProgress = {
  id: string;
  status: DeployStatus;
  progress: number;
  componentsDeployed: number;
  componentsTotal: number;
  testsCompleted: number;
  testsTotal: number;
  testsPassed: number;
  testsFailed: number;
  codeCoverage?: number;
  errors: Array<{ type: string; file: string; message: string; line?: number }>;
  warnings: Array<{ type: string; file: string; message: string; line?: number }>;
  testFailures: Array<{ className: string; methodName: string; message: string; stackTrace?: string }>;
  validationId?: string;
  lastCompletedComponent?: string;
  lastCompletedTest?: string;
  currentTest?: string;
};

/**
 * Service for handling Salesforce deployments and validations.
 */
export class DeploymentService {
  /**
   * Starts a deployment or validation.
   */
  public static async startDeployment(options: DeploymentOptions): Promise<DeployResult> {
    if (options.mode === 'quick') {
      return this.quickDeploy(options);
    }

    const { execSync } = await import('node:child_process');

    // Build SF CLI command
    const targetOrgUsername = options.targetOrg.getUsername();
    const manifestPath = resolve(options.manifestDir, 'Package', 'package.xml');

    // Start with base command
    let command = 'sf project deploy start';

    // Always add manifest (required even for destructive-only deployments with empty package.xml)
    command += ` --manifest "${manifestPath}"`;

    // Add target org
    command += ` --target-org ${targetOrgUsername ?? 'default'}`;

    // Add dry-run flag for validation mode
    if (options.mode === 'validation') {
      command += ' --dry-run';
    }

    // Add test level
    if (options.testLevel && options.testLevel !== 'NoTestRun') {
      command += ` --test-level ${options.testLevel}`;
    }

    // Add specific tests (each test needs its own --tests flag with quotes)
    if (options.testClasses && options.testClasses.length > 0) {
      options.testClasses.forEach((testClass) => {
        command += ` --tests "${testClass}"`;
      });
    }

    // Add ignore warnings
    if (options.ignoreWarnings) {
      command += ' --ignore-warnings';
    }

    // Add destructive changes
    command = this.addDestructiveChangesFlags(command, options.preDestructivePath, options.postDestructivePath);

    // Add wait time (0 for async)
    if (options.waitMinutes === 0) {
      command += ' --async';
    } else {
      command += ` --wait ${options.waitMinutes}`;
    }

    // Add ignore conflicts
    if (options.ignoreConflicts) {
      command += ' --ignore-conflicts';
    }

    // Add JSON output for parsing
    command += ' --json';

    // Log the command being executed
    /* eslint-disable no-console */
    console.log('\nExecuting SF CLI command:');
    console.log(command);
    console.log('');
    /* eslint-enable no-console */

    try {
      const output = execSync(command, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      const result = JSON.parse(output) as Record<string, unknown>;

      return this.parseDeploymentResult(result, options.waitMinutes === 0);
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };

      // Try to parse error output
      if (err.stdout) {
        try {
          const result = JSON.parse(err.stdout) as Record<string, unknown>;
          return this.parseDeploymentResult(result, options.waitMinutes === 0);
        } catch {
          // If parsing fails, show the error
        }
      }

      // Build detailed error message
      let errorMessage = 'Deployment failed';
      if (err.stderr) {
        errorMessage += `:\n${err.stderr}`;
      } else if (err.message) {
        errorMessage += `: ${err.message}`;
      }

      if (err.stdout && !err.stdout.includes('{')) {
        errorMessage += `\nOutput: ${err.stdout}`;
      }

      throw new Error(errorMessage);
    }
  }

  /**
   * Checks deployment status using SF CLI.
   */
  public static async checkDeploymentStatus(jobId: string, connection: Connection): Promise<DeploymentProgress> {
    const { execSync } = await import('node:child_process');
    const targetOrgUsername = connection.getUsername();

    const command = `sf project deploy report --job-id ${jobId} --target-org ${targetOrgUsername ?? 'default'} --json`;

    try {
      const output = execSync(command, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      const cliResult = JSON.parse(output);
      const result = cliResult.result as Record<string, unknown>;

      return this.buildDeploymentProgress(jobId, result);
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };

      // Try to parse error output
      if (err.stdout) {
        try {
          const cliResult = JSON.parse(err.stdout);
          const result = cliResult.result as Record<string, unknown>;

          // Return partial progress even on error
          const progress = this.buildDeploymentProgress(jobId, result);
          progress.errors = [{ type: 'Error', file: 'Unknown', message: err.stderr ?? 'Deployment failed' }];
          return progress;
        } catch {
          // Fall through to error
        }
      }

      throw new Error(`Failed to check deployment status: ${err.stderr ?? (error as Error).message}`);
    }
  }

  /**
   * Reads package.xml from manifest directory.
   */
  public static readPackageXml(manifestDir: string): string {
    const packagePath = resolve(manifestDir, 'Package', 'package.xml');
    if (!existsSync(packagePath)) {
      throw new Error(`package.xml not found at ${packagePath}`);
    }
    return readFileSync(packagePath, 'utf8');
  }

  /**
   * Reads destructive changes XML.
   */
  public static readDestructiveChangesXml(manifestDir: string, mode: DestructiveMode = 'post'): string | null {
    const fileName = mode === 'pre' ? 'destructiveChangesPre.xml' : 'destructiveChanges.xml';
    const destructivePath = resolve(manifestDir, 'Destructive', fileName);

    if (!existsSync(destructivePath)) {
      return null;
    }

    return readFileSync(destructivePath, 'utf8');
  }

  /**
   * Builds a DeploymentProgress object from SF CLI result.
   */
  private static buildDeploymentProgress(jobId: string, result: Record<string, unknown>): DeploymentProgress {
    const progress: DeploymentProgress = {
      id: jobId,
      status: this.mapSfStatusToDeployStatus(result.status as string),
      progress: this.calculateProgress(result),
      componentsDeployed: (result.numberComponentsDeployed as number) || 0,
      componentsTotal: (result.numberComponentsTotal as number) || 0,
      testsCompleted: (result.numberTestsCompleted as number) || 0,
      testsTotal: (result.numberTestsTotal as number) || 0,
      testsPassed: ((result.numberTestsCompleted as number) || 0) - ((result.numberTestErrors as number) || 0),
      testsFailed: (result.numberTestErrors as number) || 0,
      errors: [],
      warnings: [],
      testFailures: [],
    };

    const details = result.details as Record<string, unknown> | undefined;

    // Extract current test
    progress.currentTest = this.extractCurrentTest(result.stateDetail as string | undefined);

    // Parse component failures
    progress.errors = this.parseComponentFailures(details);

    // Parse test results (failures, coverage, warnings, last completed test)
    const testResults = this.parseTestResults(details);
    progress.testFailures = testResults.failures;
    progress.codeCoverage = testResults.coverage;
    progress.warnings = testResults.warnings;
    progress.lastCompletedTest = testResults.lastCompletedTest;

    // Find last completed component
    progress.lastCompletedComponent = this.findLastCompletedComponent(details);

    // Add validation ID if this was a validation
    if (result.checkOnly && result.status === 'Succeeded') {
      progress.validationId = jobId;
    }

    return progress;
  }

  /**
   * Extracts current test from stateDetail.
   */
  private static extractCurrentTest(stateDetail: string | undefined): string | undefined {
    if (stateDetail && stateDetail.startsWith('Running Test: ')) {
      return stateDetail.replace('Running Test: ', '');
    }
    return undefined;
  }

  /**
   * Parses component failures into error objects.
   */
  private static parseComponentFailures(
    details: Record<string, unknown> | undefined
  ): Array<{ type: string; file: string; message: string; line?: number }> {
    if (!details?.componentFailures) return [];

    const failures = Array.isArray(details.componentFailures) ? details.componentFailures : [details.componentFailures];

    return failures.map((f: Record<string, unknown>) => ({
      type: (f.componentType as string) || 'Unknown',
      file: (f.fileName as string) || 'Unknown',
      message: (f.problem as string) || 'Unknown error',
      line: f.lineNumber as number | undefined,
    }));
  }

  /**
   * Parses test results including failures, coverage, warnings, and last completed test.
   */
  private static parseTestResults(details: Record<string, unknown> | undefined): {
    failures: Array<{ className: string; methodName: string; message: string; stackTrace?: string }>;
    coverage?: number;
    warnings: Array<{ type: string; file: string; message: string; line?: number }>;
    lastCompletedTest?: string;
  } {
    if (!details?.runTestResult) {
      return { failures: [], warnings: [] };
    }

    const runTestResult = details.runTestResult as Record<string, unknown>;
    const result: {
      failures: Array<{ className: string; methodName: string; message: string; stackTrace?: string }>;
      coverage?: number;
      warnings: Array<{ type: string; file: string; message: string; line?: number }>;
      lastCompletedTest?: string;
    } = { failures: [], warnings: [] };

    // Calculate code coverage
    const numLocations = runTestResult.numLocations as number;
    const numLocationsNotCovered = runTestResult.numLocationsNotCovered as number;
    if (numLocations > 0) {
      result.coverage = Math.round(((numLocations - numLocationsNotCovered) / numLocations) * 100);
    }

    // Parse test failures
    if (runTestResult.failures) {
      const testFailures = Array.isArray(runTestResult.failures) ? runTestResult.failures : [runTestResult.failures];
      result.failures = testFailures.map((f: Record<string, unknown>) => ({
        className: (f.name as string) || 'Unknown',
        methodName: (f.methodName as string) || 'Unknown',
        message: (f.message as string) || 'Unknown error',
        stackTrace: f.stackTrace as string | undefined,
      }));
    }

    // Parse code coverage warnings
    if (runTestResult.codeCoverageWarnings) {
      const coverageWarnings = Array.isArray(runTestResult.codeCoverageWarnings)
        ? runTestResult.codeCoverageWarnings
        : [runTestResult.codeCoverageWarnings];

      result.warnings = coverageWarnings.map((w: Record<string, unknown>) => ({
        type: 'CodeCoverage',
        file: (w.name as string) || 'Unknown',
        message: (w.message as string) || 'Code coverage warning',
        line: undefined,
      }));
    }

    // Get last completed test
    if (runTestResult.successes) {
      const testSuccesses = Array.isArray(runTestResult.successes)
        ? runTestResult.successes
        : [runTestResult.successes];

      if (testSuccesses.length > 0) {
        const lastTest = testSuccesses[testSuccesses.length - 1] as Record<string, unknown>;
        result.lastCompletedTest = `${lastTest.name as string}.${lastTest.methodName as string}`;
      }
    }

    return result;
  }

  /**
   * Finds the last completed component (skipping package.xml and metadata files).
   */
  private static findLastCompletedComponent(details: Record<string, unknown> | undefined): string | undefined {
    if (!details?.componentSuccesses) return undefined;

    const successes = Array.isArray(details.componentSuccesses)
      ? details.componentSuccesses
      : [details.componentSuccesses];

    // Find the last meaningful component (not package.xml or meta files)
    for (let i = successes.length - 1; i >= 0; i--) {
      const component = successes[i] as Record<string, unknown>;
      const fullName = (component.fullName as string) || '';
      const fileName = (component.fileName as string) || '';

      // Skip package.xml and .xml-meta.xml files
      if (
        fullName !== 'package.xml' &&
        !fileName.includes('package.xml') &&
        !fileName.endsWith('-meta.xml') &&
        fullName.trim() !== ''
      ) {
        return fullName;
      }
    }

    return undefined;
  }

  /**
   * Adds destructive changes flags to the deployment command.
   */
  private static addDestructiveChangesFlags(
    command: string,
    preDestructivePath?: string,
    postDestructivePath?: string
  ): string {
    let updatedCommand = command;

    if (preDestructivePath && existsSync(preDestructivePath)) {
      updatedCommand += ` --pre-destructive-changes "${preDestructivePath}"`;
    }

    if (postDestructivePath && existsSync(postDestructivePath)) {
      updatedCommand += ` --post-destructive-changes "${postDestructivePath}"`;
    }

    return updatedCommand;
  }

  /**
   * Performs a quick deployment from a validation.
   */
  private static async quickDeploy(options: DeploymentOptions): Promise<DeployResult> {
    if (!options.validationId) {
      throw new Error('Validation ID is required for quick deployment');
    }

    const { execSync } = await import('node:child_process');
    const targetOrgUsername = options.targetOrg.getUsername();

    // Build command with async flag if wait time is 0
    let command = `sf project deploy quick --job-id ${options.validationId} --target-org ${
      targetOrgUsername ?? 'default'
    }`;

    if (options.waitMinutes === 0) {
      command += ' --async';
    } else {
      command += ` --wait ${options.waitMinutes}`;
    }

    command += ' --json';

    // Log the command being executed
    /* eslint-disable no-console */
    console.log('\nExecuting SF CLI command:');
    console.log(command);
    console.log('');
    /* eslint-enable no-console */

    try {
      const output = execSync(command, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      const result = JSON.parse(output) as Record<string, unknown>;
      return this.parseDeploymentResult(result, options.waitMinutes === 0);
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };

      if (err.stdout) {
        try {
          const result = JSON.parse(err.stdout) as Record<string, unknown>;
          return this.parseDeploymentResult(result, options.waitMinutes === 0);
        } catch {
          // Fall through
        }
      }

      // Build detailed error message
      let errorMessage = 'Quick deployment failed';
      if (err.stderr) {
        errorMessage += `:\n${err.stderr}`;
      } else if (err.message) {
        errorMessage += `: ${err.message}`;
      }

      throw new Error(errorMessage);
    }
  }

  /**
   * Parses SF CLI deployment result into DeployResult.
   */
  private static parseDeploymentResult(cliResult: Record<string, unknown>, async: boolean): DeployResult {
    const result = cliResult.result as Record<string, unknown> | undefined;

    if (!result) {
      throw new Error('Invalid deployment result from SF CLI');
    }

    const status = result.status as string;
    const deployedComponents = (result.numberComponentsDeployed as number) ?? 0;
    const totalComponents = (result.numberComponentsTotal as number) ?? 0;
    const testsRun = (result.numberTestsCompleted as number) ?? 0;
    const testsFailed = (result.numberTestErrors as number) ?? 0;

    // Get validation ID if this was a validation
    const validationId = result.checkOnly && status === 'Succeeded' ? (result.id as string) : undefined;

    // Calculate code coverage
    let codeCoverage: number | undefined;
    const details = result.details as Record<string, unknown> | undefined;
    if (details?.runTestResult) {
      const testResult = details.runTestResult as Record<string, unknown>;
      const totalLocations = (testResult.numLocations as number) ?? 0;
      const notCovered = (testResult.numLocationsNotCovered as number) ?? 0;
      if (totalLocations > 0) {
        codeCoverage = Math.round(((totalLocations - notCovered) / totalLocations) * 100);
      }
    }

    // Parse error messages
    const messages: string[] = [];
    if (details?.componentFailures) {
      const failures = Array.isArray(details.componentFailures)
        ? details.componentFailures
        : [details.componentFailures];

      failures.forEach((f: Record<string, unknown>) => {
        messages.push(`${f.fileName as string}: ${f.problem as string}`);
      });
    }

    return {
      jobId: result.id as string,
      status: this.mapSfStatusToDeployStatus(status),
      validationId,
      deployedComponents,
      failedComponents: totalComponents - deployedComponents,
      testsRun,
      testsPassed: testsRun - testsFailed,
      testsFailed,
      codeCoverage,
      messages,
      async,
    };
  }

  /**
   * Maps SF CLI status to our DeployStatus type.
   */
  private static mapSfStatusToDeployStatus(sfStatus: string): DeployStatus {
    const statusMap: Record<string, DeployStatus> = {
      Queued: 'Queued',
      Pending: 'Pending',
      InProgress: 'InProgress',
      'In Progress': 'InProgress',
      Succeeded: 'Succeeded',
      Failed: 'Failed',
      SucceededPartial: 'Succeeded',
      Canceled: 'Canceled',
      Canceling: 'Canceled',
    };

    return statusMap[sfStatus] ?? 'Pending';
  }

  /**
   * Calculates deployment progress percentage.
   */
  private static calculateProgress(result: Record<string, unknown>): number {
    const total = (result.numberComponentsTotal as number) || 1;
    const deployed = (result.numberComponentsDeployed as number) || 0;
    return Math.round((deployed / total) * 100);
  }
}
