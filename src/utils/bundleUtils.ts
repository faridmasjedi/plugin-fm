import { resolve, basename, dirname } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { copyFile, ensureDirExists } from './fileUtils.js';
import type { Logger, LoggerWithError } from './types.js';

/**
 * Bundle types and their metadata file patterns.
 */
const BUNDLE_TYPES = {
  lwc: {
    dirPattern: /\/lwc\/[^/]+$/,
    metadataExtension: '.js-meta.xml',
    requiredFiles: ['.js', '.js-meta.xml'],
    type: 'LightningComponentBundle',
  },
  aura: {
    dirPattern: /\/aura\/[^/]+$/,
    metadataExtension: '.cmp-meta.xml',
    requiredFiles: ['.cmp', '.cmp-meta.xml'],
    type: 'AuraDefinitionBundle',
  },
  experiences: {
    dirPattern: /\/experiences\/[^/]+$/,
    metadataExtension: '.site-meta.xml',
    requiredFiles: ['.site-meta.xml'],
    type: 'ExperienceBundle',
  },
  waveTemplates: {
    dirPattern: /\/waveTemplates\/[^/]+$/,
    metadataExtension: '.wdash-meta.xml',
    requiredFiles: ['.wdash-meta.xml'],
    type: 'WaveTemplateBundle',
  },
} as const;

export type BundleType = keyof typeof BUNDLE_TYPES;

export type BundleStatus = {
  bundleRoot: string;
  bundleName: string;
  type: BundleType;
  status: 'deleted' | 'modified' | 'invalid';
  changedFiles: string[];
  deletedFiles: string[];
  reason?: string;
};

/**
 * Checks if a file path is part of a Salesforce bundle.
 */
export function isBundleFile(filePath: string): boolean {
  for (const bundleType of Object.values(BUNDLE_TYPES)) {
    if (bundleType.dirPattern.test(dirname(filePath))) {
      return true;
    }
  }
  return false;
}

/**
 * Gets the bundle root directory and type for a file.
 * Returns null if the file is not part of a bundle.
 */
export function getBundleInfo(filePath: string): { bundleRoot: string; type: BundleType } | null {
  const dir = dirname(filePath);

  for (const [typeKey, bundleType] of Object.entries(BUNDLE_TYPES)) {
    if (bundleType.dirPattern.test(dir)) {
      return { bundleRoot: dir, type: typeKey as BundleType };
    }
  }
  return null;
}

/**
 * Groups files by their bundle root directory.
 * Separates bundle files from non-bundle files.
 */
export function groupFilesByBundle(
  changedFiles: string[],
  deletedFiles: string[]
): {
  bundleMap: Map<string, { type: BundleType; changed: string[]; deleted: string[] }>;
  nonBundleChangedFiles: string[];
  nonBundleDeletedFiles: string[];
} {
  const bundleMap = new Map<string, { type: BundleType; changed: string[]; deleted: string[] }>();
  const nonBundleChangedFiles: string[] = [];
  const nonBundleDeletedFiles: string[] = [];

  // Process changed files
  for (const file of changedFiles) {
    const info = getBundleInfo(file);
    if (info) {
      if (!bundleMap.has(info.bundleRoot)) {
        bundleMap.set(info.bundleRoot, { type: info.type, changed: [], deleted: [] });
      }
      bundleMap.get(info.bundleRoot)!.changed.push(file);
    } else {
      nonBundleChangedFiles.push(file);
    }
  }

  // Process deleted files
  for (const file of deletedFiles) {
    const info = getBundleInfo(file);
    if (info) {
      if (!bundleMap.has(info.bundleRoot)) {
        bundleMap.set(info.bundleRoot, { type: info.type, changed: [], deleted: [] });
      }
      bundleMap.get(info.bundleRoot)!.deleted.push(file);
    } else {
      nonBundleDeletedFiles.push(file);
    }
  }

  return { bundleMap, nonBundleChangedFiles, nonBundleDeletedFiles };
}

/**
 * Determines the status of a bundle (deleted, modified, or invalid).
 */
export function determineBundleStatus(
  bundleRoot: string,
  type: BundleType,
  changedFiles: string[],
  deletedFiles: string[],
  currentWorkingDir: string
): BundleStatus {
  const bundleType = BUNDLE_TYPES[type];
  const bundleName = basename(bundleRoot);

  // Check if metadata file is deleted
  const metadataFileDeleted = deletedFiles.some((file) => basename(file).endsWith(bundleType.metadataExtension));

  // Check if metadata file exists in working tree
  const bundlePath = resolve(currentWorkingDir, bundleRoot);
  let metadataFileExists = false;

  if (existsSync(bundlePath)) {
    try {
      const files = readdirSync(bundlePath);
      metadataFileExists = files.some((file) => file.endsWith(bundleType.metadataExtension));
    } catch {
      // Directory doesn't exist or can't be read
      metadataFileExists = false;
    }
  }

  // Determine status
  if (metadataFileDeleted || !metadataFileExists) {
    // Metadata file is gone

    // Check if other files still exist in the bundle directory
    let hasOtherFiles = false;
    if (existsSync(bundlePath)) {
      try {
        const files = readdirSync(bundlePath);
        hasOtherFiles = files.length > 0;
      } catch {
        hasOtherFiles = false;
      }
    }

    if (hasOtherFiles) {
      // Invalid: Required metadata file deleted but other files still exist
      // This is an incomplete bundle - should be added to BOTH destructive changes AND package.xml
      // so deployment fails and forces developer to clean up
      return {
        bundleRoot,
        bundleName,
        type,
        status: 'invalid',
        changedFiles,
        deletedFiles,
        reason: `Required metadata file deleted but ${
          hasOtherFiles ? 'other' : ''
        } bundle file(s) still exist in working tree`,
      };
    }

    // Bundle fully deleted (no files remain)
    return {
      bundleRoot,
      bundleName,
      type,
      status: 'deleted',
      changedFiles,
      deletedFiles,
    };
  }

  // Metadata file exists - bundle is modified
  return {
    bundleRoot,
    bundleName,
    type,
    status: 'modified',
    changedFiles,
    deletedFiles,
  };
}

/**
 * Copies an entire bundle directory to the destination.
 * Returns the list of files copied and the count.
 */
export function copyEntireBundle(
  bundleRoot: string,
  currentWorkingDir: string,
  destDir: string
): { copiedFiles: string[]; copiedCount: number } {
  const bundlePath = resolve(currentWorkingDir, bundleRoot);
  const copiedFiles: string[] = [];

  if (!existsSync(bundlePath)) {
    return { copiedFiles, copiedCount: 0 };
  }

  function copyRecursive(sourcePath: string, relativeFromRoot: string): void {
    const stats = statSync(sourcePath);

    if (stats.isDirectory()) {
      const entries = readdirSync(sourcePath);
      for (const entry of entries) {
        const entryPath = resolve(sourcePath, entry);
        const entryRelative = relativeFromRoot ? `${relativeFromRoot}/${entry}` : entry;
        copyRecursive(entryPath, entryRelative);
      }
    } else if (stats.isFile()) {
      const fullRelativePath = `${bundleRoot}/${relativeFromRoot}`;
      const destPath = resolve(destDir, fullRelativePath);
      ensureDirExists(dirname(destPath));
      copyFile(sourcePath, destPath);
      copiedFiles.push(fullRelativePath);
    }
  }

  // Start recursive copy from bundle root
  const entries = readdirSync(bundlePath);
  for (const entry of entries) {
    const entryPath = resolve(bundlePath, entry);
    copyRecursive(entryPath, entry);
  }

  return { copiedFiles, copiedCount: copiedFiles.length };
}

/**
 * Gets the bundle member name for package.xml (the bundle directory name).
 */
export function getBundleMemberName(bundleRoot: string): string {
  return basename(bundleRoot);
}

/**
 * Gets the metadata type name for a bundle type.
 */
export function getBundleMetadataType(type: BundleType): string {
  return BUNDLE_TYPES[type].type;
}

/**
 * Processes all bundles and returns bundle statuses.
 */
export function processBundles(
  changedFiles: string[],
  deletedFiles: string[],
  currentWorkingDir: string,
  logger: LoggerWithError
): {
  bundleStatuses: BundleStatus[];
  nonBundleChangedFiles: string[];
  nonBundleDeletedFiles: string[];
  bundleDeletedFiles: string[]; // Files deleted within modified bundles (for RemovedFiles)
} {
  const { bundleMap, nonBundleChangedFiles, nonBundleDeletedFiles } = groupFilesByBundle(changedFiles, deletedFiles);

  const bundleStatuses: BundleStatus[] = [];
  const bundleDeletedFiles: string[] = []; // Track deleted files within modified bundles

  for (const [bundleRoot, { type, changed, deleted }] of bundleMap.entries()) {
    const status = determineBundleStatus(bundleRoot, type, changed, deleted, currentWorkingDir);
    bundleStatuses.push(status);

    // For modified bundles, track deleted files for RemovedFiles (visibility only)
    if (status.status === 'modified' && deleted.length > 0) {
      bundleDeletedFiles.push(...deleted);
    }

    // Log bundle status
    if (status.status === 'deleted') {
      logger.log(`Bundle deleted: ${status.bundleName} (${status.type}) - ${status.deletedFiles.length} file(s)`);
    } else if (status.status === 'modified') {
      logger.log(
        `Bundle modified: ${status.bundleName} (${status.type}) - ${status.changedFiles.length} changed, ${status.deletedFiles.length} deleted`
      );
    } else if (status.status === 'invalid') {
      logger.warn(
        `⚠️  Invalid bundle state: ${status.bundleName} (${status.type}) - ${status.reason ?? 'Unknown reason'}`
      );
    }
  }

  return { bundleStatuses, nonBundleChangedFiles, nonBundleDeletedFiles, bundleDeletedFiles };
}

/**
 * Copies multiple bundles and returns copy statistics.
 */
export function copyBundles(
  bundles: BundleStatus[],
  currentWorkingDir: string,
  destinationDir: string,
  logger: Logger
): { bundleFilesCopied: number; bundlePaths: string[] } {
  let bundleFilesCopied = 0;
  const bundlePaths: string[] = [];

  for (const bundle of bundles) {
    const { copiedCount } = copyEntireBundle(bundle.bundleRoot, currentWorkingDir, destinationDir);
    bundleFilesCopied += copiedCount;
    bundlePaths.push(bundle.bundleRoot);
    logger.log(`Copied entire bundle: ${bundle.bundleName} (${copiedCount} files)`);
  }

  return { bundleFilesCopied, bundlePaths };
}
