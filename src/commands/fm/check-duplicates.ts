/*
 * Copyright 2024, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { SfCommand, Flags } from '@salesforce/sf-plugins-core';
import { Messages } from '@salesforce/core';
import { getAllChangedAndDeletedFiles, getAllFilesFromWorkingTree } from '../../utils/gitUtils.js';
import { detectDuplicates } from '../../utils/duplicateDetectionUtils.js';

// Initialize messages
Messages.importMessagesDirectoryFromMetaUrl(import.meta.url);
const messages = Messages.loadMessages('@salesforce/plugin-fm', 'check-duplicates');

export type CheckDuplicatesResult = {
  hasDuplicates: boolean;
  totalDuplicates: number;
  componentDuplicates: Array<{
    type: string;
    name: string;
    context?: string;
    parentFile: string;
    submoduleFile: string;
    submodulePath: string;
    parentFiles?: string[];
    submoduleFiles?: string[];
  }>;
  granularDuplicates: {
    customLabels?: Array<{
      labelName: string;
      parentFile: string;
      submoduleFile: string;
      submodulePath: string;
    }>;
    sharingRules?: Array<{
      objectName: string;
      ruleName: string;
      parentFile: string;
      submoduleFile: string;
      submodulePath: string;
    }>;
  };
};

export default class CheckDuplicates extends SfCommand<CheckDuplicatesResult> {
  public static readonly summary = messages.getMessage('summary');
  public static readonly description = messages.getMessage('description');
  public static readonly examples = messages.getMessages('examples');

  public static readonly flags = {
    from: Flags.string({
      char: 'r',
      summary: messages.getMessage('flags.from.summary'),
      description: messages.getMessage('flags.from.description'),
      required: true,
    }),
    to: Flags.string({
      char: 'R',
      summary: messages.getMessage('flags.to.summary'),
      description: messages.getMessage('flags.to.description'),
      default: 'HEAD',
    }),
    all: Flags.boolean({
      char: 'a',
      summary: messages.getMessage('flags.all.summary'),
      description: messages.getMessage('flags.all.description'),
      default: false,
    }),
  };

  public async run(): Promise<CheckDuplicatesResult> {
    const { flags } = await this.parse(CheckDuplicates);
    const currentWorkingDir = process.cwd();
    const from = flags.from;
    const to = flags.to;
    const checkAll = flags.all;

    // Create logger
    const logger = {
      log: (message: string): void => {
        this.log(message);
      },
      warn: (message: string): void => {
        this.warn(message);
      },
    };

    this.log(messages.getMessage('info.checkingDuplicates', [from, to]));

    // Collect files
    let allFiles: { parent: string[]; submodules: Map<string, string[]> };

    if (checkAll) {
      // Get all files from working tree
      allFiles = getAllFilesFromWorkingTree(currentWorkingDir, logger);
      this.log(
        messages.getMessage('info.checkedAllFiles', [
          allFiles.parent.length.toString(),
          Array.from(allFiles.submodules.values())
            .reduce((sum, files) => sum + files.length, 0)
            .toString(),
        ])
      );
    } else {
      // Get only changed files
      const changes = getAllChangedAndDeletedFiles(from, to, currentWorkingDir, logger);
      const submoduleFilesMap = new Map<string, string[]>();
      const submodulePaths = new Set<string>();

      // Combine changed and deleted files for each submodule
      if (changes.submodules) {
        for (const submodule of changes.submodules) {
          submodulePaths.add(submodule.path);
          const allSubFiles = [...submodule.changedFiles, ...submodule.deletedFiles];
          if (allSubFiles.length > 0) {
            submoduleFilesMap.set(submodule.path, allSubFiles);
          }
        }
      }

      // Filter parent files to exclude submodule files
      const allChangedFiles = [...changes.changed, ...changes.deleted];
      const parentFiles = allChangedFiles.filter((file) => {
        // Check if file starts with any submodule path
        for (const subPath of submodulePaths) {
          if (file.startsWith(subPath + '/') || file === subPath) {
            return false;
          }
        }
        return true;
      });

      allFiles = {
        parent: parentFiles,
        submodules: submoduleFilesMap,
      };

      this.log(
        messages.getMessage('info.checkedChangedFiles', [
          allFiles.parent.length.toString(),
          Array.from(allFiles.submodules.values())
            .reduce((sum, files) => sum + files.length, 0)
            .toString(),
        ])
      );
    }

    // Detect duplicates
    const duplicates = await detectDuplicates(allFiles, currentWorkingDir, logger);

    // Build result
    const result: CheckDuplicatesResult = {
      hasDuplicates: duplicates.hasDuplicates,
      totalDuplicates: duplicates.totalCount,
      componentDuplicates: duplicates.componentDuplicates,
      granularDuplicates: duplicates.granularDuplicates,
    };

    // Output results
    if (result.hasDuplicates) {
      this.log(''); // Empty line
      this.displayDuplicates(result);
      this.error(messages.getMessage('error.duplicatesFound', [result.totalDuplicates.toString()]));
    } else {
      this.log('');
      this.log(messages.getMessage('success.noDuplicates'));
    }

    return result;
  }

  private displayDuplicates(result: CheckDuplicatesResult): void {
    // Display component-level duplicates as a table
    if (result.componentDuplicates.length > 0) {
      this.log(messages.getMessage('output.componentDuplicatesHeader'));
      this.log('');

      // Table header
      this.log('| Type | Component | Parent Files | Submodule Files | Submodule Path |');
      this.log('|------|-----------|--------------|-----------------|----------------|');

      for (const dup of result.componentDuplicates) {
        const parentFiles = dup.parentFiles?.join('<br>') ?? dup.parentFile;
        const submoduleFiles = dup.submoduleFiles?.join('<br>') ?? dup.submoduleFile;

        this.log(`| ${dup.type} | ${dup.name} | ${parentFiles} | ${submoduleFiles} | ${dup.submodulePath} |`);
      }

      this.log('');
    }

    // Display granular metadata duplicates
    const { customLabels, sharingRules } = result.granularDuplicates;

    if (customLabels && customLabels.length > 0) {
      this.log(messages.getMessage('output.customLabelDuplicatesHeader'));
      this.log('');

      // Table header
      this.log('| Label Name | Parent File | Submodule File | Submodule Path |');
      this.log('|------------|-------------|----------------|----------------|');

      for (const dup of customLabels) {
        this.log(`| ${dup.labelName} | ${dup.parentFile} | ${dup.submoduleFile} | ${dup.submodulePath} |`);
      }

      this.log('');
    }

    if (sharingRules && sharingRules.length > 0) {
      this.log(messages.getMessage('output.sharingRuleDuplicatesHeader'));
      this.log('');

      // Table header
      this.log('| Object | Rule Name | Parent File | Submodule File | Submodule Path |');
      this.log('|--------|-----------|-------------|----------------|----------------|');

      for (const dup of sharingRules) {
        this.log(
          `| ${dup.objectName} | ${dup.ruleName} | ${dup.parentFile} | ${dup.submoduleFile} | ${dup.submodulePath} |`
        );
      }

      this.log('');
    }
  }
}
