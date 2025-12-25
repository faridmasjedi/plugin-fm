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

import { resolve } from 'node:path';
import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { getAllChangedAndDeletedFiles, filterFilesWithIgnored } from '../../utils/gitUtils.js';
import {
  processArtifacts,
  generateManifests,
  createDockerImage,
  prepareOutputDirectories,
  processDeletedFiles,
} from '../../utils/deploymentUtils.js';
import { type DiffResult, generateSummaryOutput } from '../../utils/reportUtils.js';

// Initialize messages
Messages.importMessagesDirectoryFromMetaUrl(new URL('../../../messages', import.meta.url).toString());
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'build');

export default class Build extends SfCommand<DiffResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    'ref-a': Flags.string({
      char: 'r',
      summary: messages.getMessage('flags.refA.summary'),
      description: messages.getMessage('flags.refA.description'),
      required: true,
    }),
    'ref-b': Flags.string({
      char: 'R',
      summary: messages.getMessage('flags.refB.summary'),
      description: messages.getMessage('flags.refB.description'),
      default: 'HEAD',
    }),
    'output-dir': Flags.directory({
      char: 'd',
      summary: messages.getMessage('flags.outputDir.summary'),
      description: messages.getMessage('flags.outputDir.description'),
      default: 'manifest',
      exists: false,
    }),
    forceignore: Flags.file({
      char: 'i',
      summary: messages.getMessage('flags.forceignore.summary'),
      description: messages.getMessage('flags.forceignore.description'),
      default: '.forceignore',
      exists: true,
    }),
    ignore: Flags.string({
      summary: messages.getMessage('flags.ignore.summary'),
      description: messages.getMessage('flags.ignore.description'),
      multiple: true,
      delimiter: ',',
    }),
    'create-docker-image': Flags.boolean({
      summary: messages.getMessage('flags.createDockerImage.summary'),
      description: messages.getMessage('flags.createDockerImage.description'),
      default: false,
    }),
    summary: Flags.string({
      char: 's',
      summary: 'Generate deployment summary',
      description: 'Output format for deployment summary: "console" (default), "json", or "github" for GitHub Actions',
      options: ['console', 'json', 'github'] as const,
      default: 'console',
    }),
  };

  public async run(): Promise<DiffResult> {
    const { flags } = await this.parse(Build);
    const currentWorkingDir = process.cwd();
    const refA = flags['ref-a'];
    const refB = flags['ref-b'];

    // Create a logger that suppresses output when JSON mode is requested
    const isJsonOutput = flags.summary === 'json';
    const logger = {
      log: (message: string): void => {
        if (!isJsonOutput) this.log(message);
      },
      warn: (message: string): void => {
        if (!isJsonOutput) this.warn(message);
      },
      error: (message: string): never => this.error(message),
    };

    logger.log(messages.getMessage('info.generatingManifest', [refA, refB]));

    // Get all changed and deleted files (including submodules)
    const changedAndDeleted = getAllChangedAndDeletedFiles(refA, refB, currentWorkingDir, logger);

    // Log additional ignore patterns if provided
    if (flags.ignore && flags.ignore.length > 0) {
      logger.log(messages.getMessage('info.usingAdditionalIgnorePatterns', [flags.ignore.length.toString()]));
    }

    // Filter ignored files (including additional patterns)
    const filtered = filterFilesWithIgnored(
      changedAndDeleted,
      flags.forceignore,
      flags.ignore,
      changedAndDeleted.renamed
    );

    // Prepare output directories
    const baseOutputDir = resolve(currentWorkingDir, flags['output-dir']);
    const { packageDir, destructiveDir, changedFilesDir, removedFilesDir } = prepareOutputDirectories(
      baseOutputDir,
      logger
    );

    // Note: We no longer copy .forceignore or sfdx-project.json to the artifact
    // The artifact is meant to be used from the repository directory where these files already exist

    // Process artifacts (always copy files) - now includes ComponentSet creation
    const artifacts = processArtifacts(
      filtered.changedFiles,
      currentWorkingDir,
      changedFilesDir,
      baseOutputDir,
      logger
    );

    // Process deleted files: copy to RemovedFiles and detect metadata types using ComponentSet
    const { deletedMetadataComponents } = processDeletedFiles(
      filtered.deletedFiles,
      refA,
      currentWorkingDir,
      removedFilesDir,
      logger
    );

    // Generate all manifests with chunking using ComponentSet
    const manifests = await generateManifests(
      packageDir,
      destructiveDir,
      artifacts.componentSet,
      deletedMetadataComponents,
      artifacts.sourceApiVersion,
      logger
    );

    // Create Docker image if requested
    if (flags['create-docker-image']) {
      createDockerImage(baseOutputDir, logger);
    }

    // Generate and output summary
    const result = await generateSummaryOutput(
      flags.summary,
      baseOutputDir,
      filtered,
      deletedMetadataComponents,
      manifests,
      artifacts,
      logger,
      refA,
      refB
    );

    // When JSON mode is requested, output the result directly (bypassing the logger suppression)
    if (isJsonOutput) {
      this.log(JSON.stringify(result, null, 2));
    }

    return result;
  }
}
