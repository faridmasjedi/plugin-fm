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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages, Connection } from '@salesforce/core';

// Initialize messages
Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'deploy.cancel');

export type CancelResult = {
  jobId: string;
  status: 'canceled' | 'already-completed' | 'not-found' | 'skipped';
  message: string;
};

export default class DeployCancel extends SfCommand<CancelResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'job-id': Flags.string({
      char: 'i',
      summary: messages.getMessage('flags.jobId.summary'),
      description: messages.getMessage('flags.jobId.description'),
      exactlyOne: ['job-id', 'job-id-file'],
    }),
    'job-id-file': Flags.file({
      summary: messages.getMessage('flags.jobIdFile.summary'),
      description: messages.getMessage('flags.jobIdFile.description'),
      exists: true,
      exactlyOne: ['job-id', 'job-id-file'],
    }),
    'target-org': Flags.requiredOrg({
      char: 'o',
      summary: messages.getMessage('flags.targetOrg.summary'),
      description: messages.getMessage('flags.targetOrg.description'),
      required: true,
    }),
    'skip-if-not-found': Flags.boolean({
      summary: messages.getMessage('flags.skipIfNotFound.summary'),
      description: messages.getMessage('flags.skipIfNotFound.description'),
      default: false,
    }),
  };

  public async run(): Promise<CancelResult> {
    const { flags } = await this.parse(DeployCancel);

    // Get job ID from flag or file
    const jobId = this.getJobId(flags);
    if (!jobId) {
      return {
        jobId: 'unknown',
        status: 'skipped',
        message: 'No job ID provided, skipping cancel',
      };
    }

    this.log(messages.getMessage('info.cancelingJob', [jobId]));

    // Get target org
    const targetOrg = flags['target-org'];
    const connection = targetOrg.getConnection(undefined);
    const targetOrgUsername = connection.getUsername() ?? '';

    // Ensure job exists in deploy cache (required for SF CLI in fresh containers)
    this.ensureJobInCache(jobId, targetOrgUsername);

    // Check deployment status first
    const statusResult = await this.checkJobStatus(jobId, connection, flags['skip-if-not-found']);
    if (statusResult) {
      return statusResult;
    }

    // Cancel the deployment using SF CLI
    return this.executeCancelCommand(jobId, targetOrgUsername);
  }

  /**
   * Gets job ID from flags or file
   */
  private getJobId(flags: {
    'job-id'?: string;
    'job-id-file'?: string;
    'skip-if-not-found': boolean;
  }): string | undefined {
    if (flags['job-id']) {
      return flags['job-id'];
    }

    if (flags['job-id-file']) {
      try {
        return readFileSync(flags['job-id-file'], 'utf-8').trim();
      } catch (error) {
        if (flags['skip-if-not-found']) {
          this.log(messages.getMessage('info.jobIdFileNotFound', [flags['job-id-file']]));
          return undefined;
        }
        throw messages.createError('error.cannotReadJobIdFile', [flags['job-id-file'], (error as Error).message]);
      }
    }

    if (flags['skip-if-not-found']) {
      this.log(messages.getMessage('info.noJobId'));
      return undefined;
    }

    throw messages.createError('error.noJobId');
  }

  /**
   * Checks if job is already completed
   */
  private async checkJobStatus(
    jobId: string,
    connection: Connection,
    skipIfNotFound: boolean
  ): Promise<CancelResult | undefined> {
    const { DeploymentService } = await import('../../../utils/deploymentService.js');

    try {
      const progress = await DeploymentService.checkDeploymentStatus(jobId, connection);
      const currentStatus = progress.status;

      // If already completed, don't cancel
      if (currentStatus === 'Succeeded' || currentStatus === 'Failed' || currentStatus === 'Canceled') {
        this.log(messages.getMessage('info.alreadyCompleted', [jobId, currentStatus]));
        return {
          jobId,
          status: 'already-completed',
          message: `Job ${jobId} already completed with status: ${currentStatus}`,
        };
      }
    } catch (error) {
      // Job not found
      if (skipIfNotFound) {
        this.log(messages.getMessage('info.jobNotFound', [jobId]));
        return {
          jobId,
          status: 'not-found',
          message: `Job ${jobId} not found, skipping cancel`,
        };
      }
      throw messages.createError('error.jobNotFound', [jobId, (error as Error).message]);
    }

    return undefined;
  }

  /**
   * Executes the cancel command via SF CLI
   */
  private executeCancelCommand(jobId: string, targetOrgUsername: string): CancelResult {
    try {
      const command = `sf project deploy cancel --job-id ${jobId} --target-org ${targetOrgUsername} --json`;

      this.log(messages.getMessage('info.executingCancel'));

      const output = execSync(command, {
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });

      const result = JSON.parse(output) as { status: number; message?: string };

      if (result.status === 0) {
        this.log(messages.getMessage('info.cancelSuccess', [jobId]));
        return {
          jobId,
          status: 'canceled',
          message: `Successfully canceled job ${jobId}`,
        };
      }

      throw new Error(result.message ?? 'Cancel command failed');
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };

      // Try to parse error output
      if (err.stdout) {
        try {
          const result = JSON.parse(err.stdout) as { message?: string };
          if (result.message?.includes('already') ?? result.message?.includes('completed')) {
            this.log(messages.getMessage('info.alreadyCompleted', [jobId, 'completed']));
            return {
              jobId,
              status: 'already-completed',
              message: `Job ${jobId} already completed`,
            };
          }
        } catch {
          // Fall through to error
        }
      }

      throw messages.createError('error.cancelFailed', [jobId, err.stderr ?? (error as Error).message]);
    }
  }

  /**
   * Ensures the job ID exists in .sf/deploy-cache.json
   * This is required for SF CLI to cancel jobs in fresh containers (CI/CD)
   * Uses empty package.xml and destructive changes from config folder
   */
  private ensureJobInCache(jobId: string, targetOrgUsername: string): void {
    try {
      const sfDir = join(homedir(), '.sf');
      const cacheFile = join(sfDir, 'deploy-cache.json');

      // Create .sf directory if it doesn't exist
      if (!existsSync(sfDir)) {
        mkdirSync(sfDir, { recursive: true });
      }

      let cache: Record<string, unknown> = {};

      // Read existing cache if it exists
      if (existsSync(cacheFile)) {
        try {
          const cacheContent = readFileSync(cacheFile, 'utf-8');
          cache = JSON.parse(cacheContent) as Record<string, unknown>;
        } catch {
          // If cache is corrupted, start fresh
          cache = {};
        }
      }

      // Add or update job entry if it doesn't exist
      if (!cache[jobId]) {
        // Get paths to empty config files
        const configDir = join(process.cwd(), 'config');
        const emptyPackagePath = join(configDir, 'empty-package.xml');
        const emptyDestructivePath = join(configDir, 'empty-destructive.xml');

        cache[jobId] = {
          jobId,
          username: targetOrgUsername,
          // Set expiration to 1 hour from now
          expirationDate: Date.now() + 3_600_000,
          // Include manifest and destructive changes paths
          manifest: emptyPackagePath,
          postDestructiveChanges: emptyDestructivePath,
          // Add timestamp
          createdDate: Date.now(),
        };

        // Write cache back
        writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf-8');

        this.debug(`Created cache entry for job ${jobId} with manifest and destructive changes`);
      } else {
        this.debug(`Job ${jobId} already exists in cache`);
      }
    } catch (error) {
      // If we can't create cache entry, log warning but continue
      // SF CLI might still be able to cancel without cache
      this.debug(`Could not create cache entry: ${(error as Error).message}`);
    }
  }
}
