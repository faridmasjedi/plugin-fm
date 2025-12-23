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

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';

// Initialize messages
Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'deploy.status');

export type DeploymentStatus = {
  id: string;
  status: 'Queued' | 'InProgress' | 'Succeeded' | 'Failed' | 'Canceled' | 'Pending';
  progress: number;
  componentsDeployed: number;
  componentsTotal: number;
  testsCompleted: number;
  testsTotal: number;
  testsPassed: number;
  testsFailed: number;
  codeCoverage?: number;
  startTime: string;
  completedTime?: string;
  duration?: string;
  errors: Array<{ type: string; file: string; message: string }>;
  warnings: Array<{ type: string; file: string; message: string }>;
  validationId?: string;
};

export default class DeployStatus extends SfCommand<DeploymentStatus> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'job-id': Flags.string({
      char: 'i',
      summary: messages.getMessage('flags.jobId.summary'),
      description: messages.getMessage('flags.jobId.description'),
      required: true,
    }),
    'target-org': Flags.requiredOrg({
      char: 'o',
      summary: messages.getMessage('flags.targetOrg.summary'),
      description: messages.getMessage('flags.targetOrg.description'),
      required: true,
    }),
    watch: Flags.boolean({
      char: 'w',
      summary: messages.getMessage('flags.watch.summary'),
      description: messages.getMessage('flags.watch.description'),
      default: false,
    }),
    interval: Flags.integer({
      summary: messages.getMessage('flags.interval.summary'),
      description: messages.getMessage('flags.interval.description'),
      default: 15,
      min: 5,
    }),
    timeout: Flags.integer({
      summary: messages.getMessage('flags.timeout.summary'),
      description: messages.getMessage('flags.timeout.description'),
      default: 60,
      min: 1,
    }),
  };

  private static async sleep(ms: number): Promise<void> {
    return new Promise((resolveFn) => setTimeout(resolveFn, ms));
  }

  public async run(): Promise<DeploymentStatus> {
    const { flags } = await this.parse(DeployStatus);

    // Try to extend cache timeout (optional, fails gracefully in CI/CD)
    // This helps with local development and interactive usage
    this.extendDeployCacheTimeout(flags['job-id'], flags.timeout);

    this.log(messages.getMessage('info.checkingStatus'));

    if (flags.watch) {
      return this.watchDeployment(flags);
    } else {
      return this.checkStatusOnce(flags);
    }
  }

  /**
   * Extends the timeout in .sf/deploy-cache.json for the given job ID.
   * This keeps the job "alive" in the cache so it doesn't expire after 33 minutes.
   *
   * NOTE: This is optional and fails gracefully. In CI/CD environments where
   * .sf/deploy-cache.json doesn't exist, this is a no-op and we rely on --job-id.
   */
  private extendDeployCacheTimeout(jobId: string, timeoutMinutes: number): void {
    try {
      const sfDir = join(homedir(), '.sf');
      const cacheFile = join(sfDir, 'deploy-cache.json');

      if (!existsSync(cacheFile)) {
        // Cache file doesn't exist (common in CI/CD)
        // This is fine - we'll use the explicit --job-id flag
        return;
      }

      // Read the cache file
      const cacheContent = readFileSync(cacheFile, 'utf-8');
      const cache = JSON.parse(cacheContent) as Record<string, unknown>;

      // Find the job entry
      if (cache[jobId]) {
        // Update the expiration time
        const jobEntry = cache[jobId] as Record<string, unknown>;

        // Get current expiration time format (check if it's in milliseconds or minutes)
        const currentExpiration = jobEntry.expirationDate as number;
        const isMilliseconds = currentExpiration > 10_000_000_000; // If > this, it's milliseconds

        let newExpirationTime: number;
        if (isMilliseconds) {
          // Cache stores milliseconds
          newExpirationTime = Date.now() + timeoutMinutes * 60 * 1000;
        } else {
          // Cache stores minutes (or seconds)
          // Assume it's minutes based on user feedback
          const currentTimeInMinutes = Math.floor(Date.now() / (60 * 1000));
          newExpirationTime = currentTimeInMinutes + timeoutMinutes;
        }

        // Update the expirationDate field (SF CLI uses this)
        jobEntry.expirationDate = newExpirationTime;

        // Also update completedDate if it exists (keeps it fresh)
        if (jobEntry.completedDate) {
          if (isMilliseconds) {
            jobEntry.completedDate = Date.now();
          } else {
            jobEntry.completedDate = Math.floor(Date.now() / (60 * 1000));
          }
        }

        // Write back to the cache file
        cache[jobId] = jobEntry;
        writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf-8');

        // Only log success in verbose mode (don't clutter CI/CD output)
        this.debug(`Extended cache timeout for job ${jobId} to ${timeoutMinutes} minutes`);
      }
    } catch (error) {
      // Fail silently - cache extension is optional
      // In CI/CD, this is expected to fail and we rely on explicit --job-id
      this.debug(`Could not extend deploy cache (this is normal in CI/CD): ${(error as Error).message}`);
    }
  }

  private async checkStatusOnce(flags: Record<string, unknown>): Promise<DeploymentStatus> {
    const { DeploymentService } = await import('../../../utils/deploymentService.js');
    const targetOrg = flags['target-org'] as { getConnection: (version?: string) => { getUsername: () => string } };
    const connection = targetOrg.getConnection(undefined);

    // Use DeploymentService to check status (without --wait, returns immediately)
    const progress = await DeploymentService.checkDeploymentStatus(
      flags['job-id'] as string,
      connection as unknown as import('@salesforce/core').Connection
    );

    // Convert to DeploymentStatus format
    const status: DeploymentStatus = {
      id: progress.id,
      status: progress.status,
      progress: progress.progress,
      componentsDeployed: progress.componentsDeployed,
      componentsTotal: progress.componentsTotal,
      testsCompleted: progress.testsCompleted,
      testsTotal: progress.testsTotal,
      testsPassed: progress.testsPassed,
      testsFailed: progress.testsFailed,
      codeCoverage: progress.codeCoverage,
      startTime: new Date().toISOString(),
      errors: progress.errors,
      warnings: progress.warnings,
      validationId: progress.validationId,
    };

    this.displayStatus(status);
    return status;
  }

  private async watchDeployment(flags: Record<string, unknown>): Promise<DeploymentStatus> {
    const jobId = flags['job-id'] as string;
    const interval = (flags.interval as number) * 1000;
    const timeout = (flags.timeout as number) * 60 * 1000;
    const startTime = Date.now();

    this.log(messages.getMessage('info.watchingDeployment', [jobId]));
    this.log(messages.getMessage('info.pollingStatus', [(flags.interval as number).toString()]));

    let status: DeploymentStatus;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      status = await this.checkStatusOnce(flags);

      if (status.status === 'Succeeded' || status.status === 'Failed' || status.status === 'Canceled') {
        this.log('\n' + messages.getMessage('info.deploymentComplete', [status.status]));
        break;
      }

      if (Date.now() - startTime > timeout) {
        throw messages.createError('error.timeout', [flags.timeout as string]);
      }

      // eslint-disable-next-line no-await-in-loop
      await DeployStatus.sleep(interval);
    }

    return status;
  }

  private displayStatus(status: DeploymentStatus): void {
    const lines: string[] = [];

    lines.push('═══════════════════════════════════════════════════════════');
    lines.push(`           DEPLOYMENT STATUS: ${status.status}`);
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push('');
    lines.push(`Job ID: ${status.id}`);
    lines.push(`Progress: ${status.progress}%`);
    lines.push(`Components: ${status.componentsDeployed}/${status.componentsTotal} deployed`);
    lines.push(`Tests: ${status.testsPassed}/${status.testsCompleted} passed`);

    if (status.codeCoverage !== undefined) {
      lines.push(`Code Coverage: ${status.codeCoverage}%`);
    }

    if (status.duration) {
      lines.push(`Duration: ${status.duration}`);
    }

    if (status.errors.length > 0) {
      lines.push('');
      lines.push('❌ ERRORS:');
      status.errors.forEach((error) => {
        lines.push(`   ${error.file}: ${error.message}`);
      });
    }

    if (status.warnings.length > 0) {
      lines.push('');
      lines.push('⚠️  WARNINGS:');
      status.warnings.forEach((warning) => {
        lines.push(`   ${warning.file}: ${warning.message}`);
      });
    }

    lines.push('═══════════════════════════════════════════════════════════');

    this.log('\n' + lines.join('\n'));
  }
}
