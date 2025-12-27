import { writeFileSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { buildSalesforceXml, parseXmlSafe } from './xmlUtils.js';
import { ensureDirExists } from './fileUtils.js';
import { getGitFileContent } from './gitUtils.js';
import type { Logger } from './types.js';

export type CustomLabelElement = {
  fullName: string[];
  language: string[];
  protected: string[];
  shortDescription: string[];
  value: string[];
  categories?: string[];
};

export type SharingRuleElement = {
  [key: string]: unknown;
  fullName: string[];
  accessLevel: string[];
  accountSettings?: unknown[];
  description?: string[];
  label: string[];
  sharedTo: unknown[];
  criteriaItems?: unknown[];
  sharedFrom?: unknown[];
};

/**
 * Parses CustomLabels XML content.
 */
export async function parseCustomLabels(xmlContent: string): Promise<CustomLabelElement[]> {
  const parsed = await parseXmlSafe(xmlContent);
  const customLabels = parsed.CustomLabels as Record<string, unknown> | undefined;
  if (customLabels && Array.isArray(customLabels.labels)) {
    return customLabels.labels as CustomLabelElement[];
  }
  return [];
}

/**
 * Parses SharingRules XML content.
 */
export async function parseSharingRules(
  xmlContent: string
): Promise<{ criteriaRules: SharingRuleElement[]; ownerRules: SharingRuleElement[] }> {
  const parsed = await parseXmlSafe(xmlContent);
  const sharingRules = parsed.SharingRules as Record<string, unknown> | undefined;

  const criteriaRules =
    sharingRules && Array.isArray(sharingRules.sharingCriteriaRules)
      ? (sharingRules.sharingCriteriaRules as SharingRuleElement[])
      : [];
  const ownerRules =
    sharingRules && Array.isArray(sharingRules.sharingOwnerRules)
      ? (sharingRules.sharingOwnerRules as SharingRuleElement[])
      : [];

  return { criteriaRules, ownerRules };
}

/**
 * Generates CustomLabels XML from label elements.
 */
export function generateCustomLabelsXml(labels: CustomLabelElement[]): string {
  const obj = {
    CustomLabels: {
      $: { xmlns: 'http://soap.sforce.com/2006/04/metadata' },
      labels,
    },
  };
  return buildSalesforceXml(obj);
}

/**
 * Generates SharingRules XML from rule elements.
 */
export function generateSharingRulesXml(criteriaRules: SharingRuleElement[], ownerRules: SharingRuleElement[]): string {
  const obj: {
    SharingRules: {
      $: { xmlns: string };
      sharingCriteriaRules?: SharingRuleElement[];
      sharingOwnerRules?: SharingRuleElement[];
    };
  } = {
    SharingRules: {
      $: { xmlns: 'http://soap.sforce.com/2006/04/metadata' },
    },
  };

  if (criteriaRules.length > 0) {
    obj.SharingRules.sharingCriteriaRules = criteriaRules;
  }

  if (ownerRules.length > 0) {
    obj.SharingRules.sharingOwnerRules = ownerRules;
  }

  return buildSalesforceXml(obj);
}

/**
 * Compares two sets of labels and returns changed and deleted labels.
 * Changed includes both new and modified labels.
 */
export function compareCustomLabels(
  labelsA: CustomLabelElement[],
  labelsB: CustomLabelElement[]
): {
  changed: CustomLabelElement[];
  deleted: CustomLabelElement[];
} {
  const mapA = new Map(labelsA.map((l) => [l.fullName[0], l]));
  const mapB = new Map(labelsB.map((l) => [l.fullName[0], l]));

  const changed: CustomLabelElement[] = [];
  const deleted: CustomLabelElement[] = [];

  // Find changed (added or modified)
  for (const [name, labelB] of mapB.entries()) {
    const labelA = mapA.get(name);
    if (!labelA) {
      // New label
      changed.push(labelB);
    } else {
      // Check if content changed
      const contentA = JSON.stringify(labelA);
      const contentB = JSON.stringify(labelB);
      if (contentA !== contentB) {
        // Modified label
        changed.push(labelB);
      }
    }
  }

  // Find deleted
  for (const [name, labelA] of mapA.entries()) {
    if (!mapB.has(name)) {
      deleted.push(labelA);
    }
  }

  return { changed, deleted };
}

/**
 * Compares two sets of sharing rules and returns changed and deleted rules.
 * Changed includes both new and modified rules.
 */
export function compareSharingRules(
  rulesA: { criteriaRules: SharingRuleElement[]; ownerRules: SharingRuleElement[] },
  rulesB: { criteriaRules: SharingRuleElement[]; ownerRules: SharingRuleElement[] }
): {
  changed: { criteriaRules: SharingRuleElement[]; ownerRules: SharingRuleElement[] };
  deleted: { criteriaRules: SharingRuleElement[]; ownerRules: SharingRuleElement[] };
} {
  const compareSingleType = (
    arrayA: SharingRuleElement[],
    arrayB: SharingRuleElement[]
  ): {
    changed: SharingRuleElement[];
    deleted: SharingRuleElement[];
  } => {
    const mapA = new Map(arrayA.map((r) => [r.fullName[0], r]));
    const mapB = new Map(arrayB.map((r) => [r.fullName[0], r]));

    const changed: SharingRuleElement[] = [];
    const deleted: SharingRuleElement[] = [];

    // Find changed (added or modified)
    for (const [name, ruleB] of mapB.entries()) {
      const ruleA = mapA.get(name);
      if (!ruleA) {
        // New rule
        changed.push(ruleB);
      } else {
        // Check if content changed
        const contentA = JSON.stringify(ruleA);
        const contentB = JSON.stringify(ruleB);
        if (contentA !== contentB) {
          // Modified rule
          changed.push(ruleB);
        }
      }
    }

    // Find deleted
    for (const [name, ruleA] of mapA.entries()) {
      if (!mapB.has(name)) {
        deleted.push(ruleA);
      }
    }

    return { changed, deleted };
  };

  const criteriaComparison = compareSingleType(rulesA.criteriaRules, rulesB.criteriaRules);
  const ownerComparison = compareSingleType(rulesA.ownerRules, rulesB.ownerRules);

  return {
    changed: {
      criteriaRules: criteriaComparison.changed,
      ownerRules: ownerComparison.changed,
    },
    deleted: {
      criteriaRules: criteriaComparison.deleted,
      ownerRules: ownerComparison.deleted,
    },
  };
}

/**
 * Processes CustomLabels file and creates partial files for changed and deleted labels.
 */
export async function processCustomLabelsFile(
  filePath: string,
  refA: string,
  refB: string,
  changedFilesDir: string,
  removedFilesDir: string,
  logger: Logger
): Promise<{
  hasChanges: boolean;
  changedCount: number;
  deletedCount: number;
  changedFilePath?: string;
  deletedFilePath?: string;
}> {
  try {
    // Get content from both refs
    const contentA =
      getGitFileContent(refA, filePath) ??
      '<?xml version="1.0" encoding="UTF-8"?><CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata"></CustomLabels>';
    const contentB = getGitFileContent(refB, filePath);

    if (!contentB) {
      logger.warn(`Could not read ${filePath} from ${refB}`);
      return { hasChanges: false, changedCount: 0, deletedCount: 0 };
    }

    const labelsA = await parseCustomLabels(contentA);
    const labelsB = await parseCustomLabels(contentB);

    const { changed, deleted } = compareCustomLabels(labelsA, labelsB);

    let changedFilePath: string | undefined;
    let deletedFilePath: string | undefined;

    // Write changed labels to ChangedFiles
    if (changed.length > 0) {
      const changedXml = generateCustomLabelsXml(changed);
      changedFilePath = resolve(changedFilesDir, 'labels', basename(filePath));
      ensureDirExists(dirname(changedFilePath));
      writeFileSync(changedFilePath, changedXml);
      logger.log(`Created partial CustomLabels in ChangedFiles: ${changed.length} changed`);
    }

    // Write deleted labels to RemovedFiles
    if (deleted.length > 0) {
      const deletedXml = generateCustomLabelsXml(deleted);
      deletedFilePath = resolve(removedFilesDir, 'labels', basename(filePath));
      ensureDirExists(dirname(deletedFilePath));
      writeFileSync(deletedFilePath, deletedXml);
      logger.log(`Created partial CustomLabels in RemovedFiles: ${deleted.length} deleted`);
    }

    return {
      hasChanges: changed.length > 0 || deleted.length > 0,
      changedCount: changed.length,
      deletedCount: deleted.length,
      changedFilePath,
      deletedFilePath,
    };
  } catch (error) {
    logger.warn(`Error processing CustomLabels file ${filePath}: ${(error as Error).message}`);
    return { hasChanges: false, changedCount: 0, deletedCount: 0 };
  }
}

/**
 * Processes SharingRules file.
 * NOTE: Unlike CustomLabels, Salesforce does not support deploying individual SharingRules.
 * This function compares rules for reporting purposes, but returns the entire file path for deployment.
 */
export async function processSharingRulesFile(
  filePath: string,
  refA: string,
  refB: string,
  changedFilesDir: string,
  logger: Logger
): Promise<{
  hasChanges: boolean;
  changedCount: number;
  deletedCount: number;
  changedRuleNames: string[];
  deletedRuleNames: string[];
  entireFilePath?: string;
}> {
  try {
    // Get content from both refs
    const contentA =
      getGitFileContent(refA, filePath) ??
      '<?xml version="1.0" encoding="UTF-8"?><SharingRules xmlns="http://soap.sforce.com/2006/04/metadata"></SharingRules>';
    const contentB = getGitFileContent(refB, filePath);

    if (!contentB) {
      logger.warn(`Could not read ${filePath} from ${refB}`);
      return { hasChanges: false, changedCount: 0, deletedCount: 0, changedRuleNames: [], deletedRuleNames: [] };
    }

    const rulesA = await parseSharingRules(contentA);
    const rulesB = await parseSharingRules(contentB);

    const { changed, deleted } = compareSharingRules(rulesA, rulesB);

    const totalChanged = changed.criteriaRules.length + changed.ownerRules.length;
    const totalDeleted = deleted.criteriaRules.length + deleted.ownerRules.length;

    // Collect rule names for reporting
    const changedRuleNames = [
      ...changed.criteriaRules.map((r) => r.fullName[0]),
      ...changed.ownerRules.map((r) => r.fullName[0]),
    ];
    const deletedRuleNames = [
      ...deleted.criteriaRules.map((r) => r.fullName[0]),
      ...deleted.ownerRules.map((r) => r.fullName[0]),
    ];

    let entireFilePath: string | undefined;

    // If there are any changes, copy the ENTIRE file (not partial)
    // Salesforce requires the complete SharingRules file for deployment
    if (totalChanged > 0) {
      entireFilePath = resolve(changedFilesDir, filePath);
      ensureDirExists(dirname(entireFilePath));
      writeFileSync(entireFilePath, contentB);
      logger.log(`Copied entire SharingRules file (${totalChanged} rules changed): ${basename(filePath)}`);
    }

    // Log warnings for deleted rules - they need manual cleanup
    if (totalDeleted > 0) {
      logger.warn(`⚠️  ${totalDeleted} SharingRule(s) deleted in ${basename(filePath)}:`);
      for (const ruleName of deletedRuleNames) {
        logger.warn(`   - ${ruleName}`);
      }
      logger.warn('   Note: Deleted rules must be removed manually from the org (Setup → Sharing Settings)');
      logger.warn('   Salesforce does not support deleting sharing rules via deployment');
    }

    return {
      hasChanges: totalChanged > 0 || totalDeleted > 0,
      changedCount: totalChanged,
      deletedCount: totalDeleted,
      changedRuleNames,
      deletedRuleNames,
      entireFilePath,
    };
  } catch (error) {
    logger.warn(`Error processing SharingRules file ${filePath}: ${(error as Error).message}`);
    return { hasChanges: false, changedCount: 0, deletedCount: 0, changedRuleNames: [], deletedRuleNames: [] };
  }
}

/**
 * Extracts individual label names from a CustomLabels XML file.
 */
export async function extractCustomLabelNames(filePath: string): Promise<string[]> {
  try {
    const content = await import('node:fs').then((fs) => fs.promises.readFile(filePath, 'utf8'));
    const labels = await parseCustomLabels(content);
    return labels.map((label) => label.fullName[0]);
  } catch {
    return [];
  }
}

/**
 * Extracts individual sharing rule names from a SharingRules XML file.
 */
export async function extractSharingRuleNames(filePath: string): Promise<string[]> {
  try {
    const content = await import('node:fs').then((fs) => fs.promises.readFile(filePath, 'utf8'));
    const rules = await parseSharingRules(content);
    const allRules = [...rules.criteriaRules.map((r) => r.fullName[0]), ...rules.ownerRules.map((r) => r.fullName[0])];
    return allRules;
  } catch {
    return [];
  }
}

/**
 * Checks if a file is a CustomLabels file.
 */
export function isCustomLabelsFile(filePath: string): boolean {
  return filePath.includes('labels/CustomLabels.labels');
}

/**
 * Checks if a file is a SharingRules file.
 */
export function isSharingRulesFile(filePath: string): boolean {
  return filePath.includes('sharingRules/') && filePath.endsWith('.sharingRules-meta.xml');
}

/**
 * Processes multiple granular metadata files in batch.
 */
export async function processGranularMetadataFiles(
  files: string[],
  refA: string,
  refB: string,
  changedFilesDir: string,
  removedFilesDir: string,
  logger: Logger
): Promise<{
  stats: { [key: string]: { changed: number; deleted: number; changedNames?: string[]; deletedNames?: string[] } };
  changedFiles: string[];
  deletedFiles: string[];
  sharingRulesToAdd: string[];
}> {
  const stats: {
    [key: string]: { changed: number; deleted: number; changedNames?: string[]; deletedNames?: string[] };
  } = {};
  const changedFiles: string[] = [];
  const deletedFiles: string[] = [];
  const sharingRulesToAdd: string[] = [];

  await Promise.all(
    files.map(async (file) => {
      if (isCustomLabelsFile(file)) {
        const result = await processCustomLabelsFile(file, refA, refB, changedFilesDir, removedFilesDir, logger);
        if (result.hasChanges) {
          stats[file] = { changed: result.changedCount, deleted: result.deletedCount };
          if (result.changedFilePath) changedFiles.push(result.changedFilePath);
          if (result.deletedFilePath) deletedFiles.push(result.deletedFilePath);
        }
      } else if (isSharingRulesFile(file)) {
        const result = await processSharingRulesFile(file, refA, refB, changedFilesDir, logger);
        if (result.hasChanges) {
          stats[file] = {
            changed: result.changedCount,
            deleted: result.deletedCount,
            changedNames: result.changedRuleNames,
            deletedNames: result.deletedRuleNames,
          };
          if (result.entireFilePath) sharingRulesToAdd.push(file);
        }
      }
    })
  );

  return { stats, changedFiles, deletedFiles, sharingRulesToAdd };
}
