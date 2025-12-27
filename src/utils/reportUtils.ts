import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BUNDLE_PATH_REGEX } from './constants.js';
import { analyzeGranularMetadataChanges } from './metadataUtils.js';
import type { Logger } from './types.js';

export type FileChangeStats = {
  changed: string[];
  deleted: string[];
  ignoredChanged: string[];
  ignoredDeleted: string[];
  bundles: {
    changed: Map<string, string[]>; // bundle name -> files
    deleted: Map<string, string[]>; // bundle name -> files
  };
};

export type ManifestStats = {
  changedMetadata: { [type: string]: string[] };
  deletedMetadata: { [type: string]: string[] };
  granularChanges?: {
    customLabels?: {
      added: string[];
      deleted: string[];
    };
    sharingRules?: {
      [objectName: string]: {
        added: string[];
        deleted: string[];
      };
    };
  };
};

/**
 * Formats a list of files with a prefix.
 */
function formatFileList(files: string[], prefix: string): string[] {
  return files.map((file) => `   ${prefix} ${file}`);
}

/**
 * Formats the changed files section.
 */
function formatChangedFilesSection(files: string[]): string[] {
  const lines: string[] = [];
  lines.push(`📝 CHANGED FILES: ${files.length}`);
  if (files.length > 0) {
    lines.push(...formatFileList(files, '✓'));
  }
  lines.push('');
  return lines;
}

/**
 * Formats the deleted files section.
 */
function formatDeletedFilesSection(files: string[]): string[] {
  const lines: string[] = [];
  lines.push(`🗑️  DELETED FILES: ${files.length}`);
  if (files.length > 0) {
    lines.push(...formatFileList(files, '✗'));
  }
  lines.push('');
  return lines;
}

/**
 * Formats the ignored files section.
 */
function formatIgnoredFilesSection(ignoredChanged: string[], ignoredDeleted: string[]): string[] {
  const lines: string[] = [];
  const totalIgnored = ignoredChanged.length + ignoredDeleted.length;

  if (totalIgnored > 0) {
    lines.push(`🚫 IGNORED FILES: ${totalIgnored}`);

    if (ignoredChanged.length > 0) {
      lines.push(`   Changed (ignored): ${ignoredChanged.length}`);
      lines.push(...formatFileList(ignoredChanged, '○'));
    }

    if (ignoredDeleted.length > 0) {
      lines.push(`   Deleted (ignored): ${ignoredDeleted.length}`);
      lines.push(...formatFileList(ignoredDeleted, '○'));
    }

    lines.push('');
  }

  return lines;
}

/**
 * Formats the bundle changes section.
 */
function formatBundleChangesSection(
  changedBundles: Map<string, string[]>,
  deletedBundles: Map<string, string[]>
): string[] {
  const lines: string[] = [];

  if (changedBundles.size === 0 && deletedBundles.size === 0) {
    return lines;
  }

  lines.push('📦 BUNDLE CHANGES:');

  if (changedBundles.size > 0) {
    lines.push(`   Modified Bundles: ${changedBundles.size}`);
    for (const [bundleName, files] of changedBundles.entries()) {
      lines.push(`      • ${bundleName} (${files.length} file${files.length > 1 ? 's' : ''})`);
    }
  }

  if (deletedBundles.size > 0) {
    lines.push(`   Deleted Bundles: ${deletedBundles.size}`);
    for (const [bundleName, files] of deletedBundles.entries()) {
      lines.push(`      • ${bundleName} (${files.length} file${files.length > 1 ? 's' : ''})`);
    }
  }

  lines.push('');
  return lines;
}

/**
 * Formats file changes into a readable report.
 */
export function formatFileChangeReport(stats: FileChangeStats): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('                   FILE CHANGE SUMMARY');
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('');

  lines.push(...formatChangedFilesSection(stats.changed));
  lines.push(...formatDeletedFilesSection(stats.deleted));
  lines.push(...formatIgnoredFilesSection(stats.ignoredChanged, stats.ignoredDeleted));
  lines.push(...formatBundleChangesSection(stats.bundles.changed, stats.bundles.deleted));

  lines.push('═══════════════════════════════════════════════════════════');
  return lines.join('\n');
}

/**
 * Formats a metadata type section with all its members.
 */
function formatMetadataTypeSection(type: string, members: string[], action: 'changed' | 'deleted'): string[] {
  const lines: string[] = [];
  const actionEmoji = action === 'changed' ? '✓' : '✗';

  lines.push(`   ${type}: ${members.length} component${members.length > 1 ? 's' : ''}`);
  members.forEach((member) => lines.push(`      ${actionEmoji} ${member}`));

  return lines;
}

/**
 * Formats metadata changes into a readable report.
 */
export function formatMetadataReport(stats: ManifestStats): string {
  const lines: string[] = [];

  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('                 METADATA CHANGE SUMMARY');
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('');

  // Changed metadata
  const changedTypes = Object.keys(stats.changedMetadata);
  const totalChanged = changedTypes.reduce((sum, type) => sum + stats.changedMetadata[type].length, 0);

  lines.push(`📝 CHANGED/ADDED METADATA: ${totalChanged} components across ${changedTypes.length} types`);
  if (changedTypes.length > 0) {
    for (const type of changedTypes.sort()) {
      const members = stats.changedMetadata[type];
      lines.push(...formatMetadataTypeSection(type, members, 'changed'));
    }
  }
  lines.push('');

  // Deleted metadata
  const deletedTypes = Object.keys(stats.deletedMetadata);
  const totalDeleted = deletedTypes.reduce((sum, type) => sum + stats.deletedMetadata[type].length, 0);

  lines.push(`🗑️  DELETED METADATA: ${totalDeleted} components across ${deletedTypes.length} types`);
  if (deletedTypes.length > 0) {
    for (const type of deletedTypes.sort()) {
      const members = stats.deletedMetadata[type];
      lines.push(...formatMetadataTypeSection(type, members, 'deleted'));
    }
  }
  lines.push('');

  lines.push('═══════════════════════════════════════════════════════════');
  return lines.join('\n');
}

/**
 * Generates the overview table for GitHub Actions summary.
 */
function generateGitHubOverviewTable(fileStats: FileChangeStats, manifestStats: ManifestStats): string[] {
  const lines: string[] = [];

  lines.push('## 📊 Overview');
  lines.push('');
  lines.push('| Metric | Count |');
  lines.push('|--------|-------|');
  lines.push(`| Changed Files | ${fileStats.changed.length} |`);
  lines.push(`| Deleted Files | ${fileStats.deleted.length} |`);
  lines.push(`| Ignored Files | ${fileStats.ignoredChanged.length + fileStats.ignoredDeleted.length} |`);

  const totalChangedMetadata = Object.values(manifestStats.changedMetadata).reduce((sum, arr) => sum + arr.length, 0);
  const totalDeletedMetadata = Object.values(manifestStats.deletedMetadata).reduce((sum, arr) => sum + arr.length, 0);

  lines.push(`| Changed Metadata | ${totalChangedMetadata} |`);
  lines.push(`| Deleted Metadata | ${totalDeletedMetadata} |`);
  lines.push('');

  return lines;
}

/**
 * Generates the bundle changes section for GitHub Actions summary.
 */
function generateGitHubBundleSection(bundles: FileChangeStats['bundles']): string[] {
  const lines: string[] = [];

  if (bundles.changed.size === 0 && bundles.deleted.size === 0) {
    return lines;
  }

  lines.push('## 📦 Bundle Changes');
  lines.push('');

  if (bundles.changed.size > 0) {
    lines.push('### Modified Bundles');
    for (const [bundleName, files] of bundles.changed.entries()) {
      lines.push(`- **${bundleName}** (${files.length} file${files.length > 1 ? 's' : ''})`);
    }
    lines.push('');
  }

  if (bundles.deleted.size > 0) {
    lines.push('### Deleted Bundles');
    for (const [bundleName] of bundles.deleted.entries()) {
      lines.push(`- **${bundleName}**`);
    }
    lines.push('');
  }

  return lines;
}

/**
 * Formats metadata components for GitHub summary (with truncation).
 */
function formatGitHubMetadataComponents(metadata: { [type: string]: string[] }): string[] {
  const lines: string[] = [];

  for (const [type, members] of Object.entries(metadata).sort()) {
    lines.push(`**${type}** (${members.length}):`);
    if (members.length <= 10) {
      members.forEach((member) => lines.push(`- ${member}`));
    } else {
      members.slice(0, 5).forEach((member) => lines.push(`- ${member}`));
      lines.push(`- ... and ${members.length - 5} more`);
    }
    lines.push('');
  }

  return lines;
}

/**
 * Generates the metadata breakdown section for GitHub Actions summary.
 */
function generateGitHubMetadataSection(manifestStats: ManifestStats): string[] {
  const lines: string[] = [];

  lines.push('## 📝 Metadata Changes');
  lines.push('');

  if (Object.keys(manifestStats.changedMetadata).length > 0) {
    lines.push('<details>');
    lines.push('<summary>Changed/Added Components</summary>');
    lines.push('');
    lines.push(...formatGitHubMetadataComponents(manifestStats.changedMetadata));
    lines.push('</details>');
    lines.push('');
  }

  if (Object.keys(manifestStats.deletedMetadata).length > 0) {
    lines.push('<details>');
    lines.push('<summary>Deleted Components</summary>');
    lines.push('');
    lines.push(...formatGitHubMetadataComponents(manifestStats.deletedMetadata));
    lines.push('</details>');
    lines.push('');
  }

  return lines;
}

/**
 * Generates the artifacts section for GitHub Actions summary.
 */
function generateGitHubArtifactsSection(outputDir: string): string[] {
  const lines: string[] = [];

  lines.push('## 📁 Generated Artifacts');
  lines.push('');
  lines.push(`Manifest files have been generated in: \`${outputDir}\``);
  lines.push('');
  lines.push('```');
  lines.push(`${outputDir}/`);
  lines.push('├── Package/');
  lines.push('│   └── package.xml          # Deployment package');
  lines.push('├── Destructive/');
  lines.push('│   ├── destructiveChanges.xml   # Components to delete');
  lines.push('│   └── package.xml              # Empty package for destructive changes');
  lines.push('└── sfdx-project.json        # Updated project configuration');
  lines.push('```');

  return lines;
}

/**
 * Generates a GitHub Actions summary in Markdown format.
 */
export function generateGitHubActionsSummary(
  fileStats: FileChangeStats,
  manifestStats: ManifestStats,
  outputDir: string
): string {
  const lines: string[] = [];

  lines.push('# 🔄 Salesforce Deployment Manifest Summary');
  lines.push('');

  lines.push(...generateGitHubOverviewTable(fileStats, manifestStats));
  lines.push(...generateGitHubBundleSection(fileStats.bundles));
  lines.push(...generateGitHubMetadataSection(manifestStats));
  lines.push(...generateGitHubArtifactsSection(outputDir));

  return lines.join('\n');
}

/**
 * Writes the GitHub Actions summary to the GITHUB_STEP_SUMMARY file.
 */
export function writeGitHubActionsSummary(summary: string): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile) {
    writeFileSync(summaryFile, summary, { flag: 'a' });
  }
}

/**
 * Writes a detailed report file to the output directory.
 */
export function writeDetailedReport(
  outputDir: string,
  fileStats: FileChangeStats,
  manifestStats: ManifestStats
): string {
  const reportPath = resolve(outputDir, 'deployment-report.md');

  const lines: string[] = [];
  lines.push('# Salesforce Deployment Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');

  lines.push('## File Changes');
  lines.push('');
  lines.push('### Changed Files');
  fileStats.changed.forEach((file) => lines.push(`- ${file}`));
  lines.push('');

  lines.push('### Deleted Files');
  fileStats.deleted.forEach((file) => lines.push(`- ${file}`));
  lines.push('');

  if (fileStats.ignoredChanged.length > 0 || fileStats.ignoredDeleted.length > 0) {
    lines.push('### Ignored Files');
    lines.push('');
    if (fileStats.ignoredChanged.length > 0) {
      lines.push('#### Changed (Ignored)');
      fileStats.ignoredChanged.forEach((file) => lines.push(`- ${file}`));
      lines.push('');
    }
    if (fileStats.ignoredDeleted.length > 0) {
      lines.push('#### Deleted (Ignored)');
      fileStats.ignoredDeleted.forEach((file) => lines.push(`- ${file}`));
      lines.push('');
    }
  }

  lines.push('## Metadata Changes');
  lines.push('');

  for (const [type, members] of Object.entries(manifestStats.changedMetadata).sort()) {
    lines.push(`### ${type} (Changed/Added)`);
    members.forEach((member) => lines.push(`- ${member}`));
    lines.push('');
  }

  for (const [type, members] of Object.entries(manifestStats.deletedMetadata).sort()) {
    lines.push(`### ${type} (Deleted)`);
    members.forEach((member) => lines.push(`- ${member}`));
    lines.push('');
  }

  writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}

/**
 * Detects bundle changes from file lists.
 */
export function detectBundleChanges(files: string[]): Map<string, string[]> {
  const bundles = new Map<string, string[]>();

  for (const file of files) {
    const match = file.match(BUNDLE_PATH_REGEX);
    if (match) {
      const bundleType = match[1];
      const bundleName = match[2];
      const fullBundleName = `${bundleType}/${bundleName}`;

      if (!bundles.has(fullBundleName)) {
        bundles.set(fullBundleName, []);
      }
      bundles.get(fullBundleName)!.push(file);
    }
  }

  return bundles;
}

export type DiffResult = {
  outputDir: string;
  manifests: {
    packageXml: string | string[];
    destructiveChangesXml: string;
    emptyDestructivePackageXml: string;
  };
  changedFilesCopied: number;
  sfdxProjectJsonCopied: boolean;
  statistics: {
    totalChanged: number;
    totalDeleted: number;
    totalIgnored: number;
    chunksGenerated: number;
  };
  reports: {
    detailedReport?: string;
    githubSummary?: string;
  };
};

/**
 * Prepares file statistics for reporting with pre-processed bundle information.
 */
function prepareFileStats(
  filtered: {
    changedFiles: string[];
    deletedFiles: string[];
    ignoredChanged: string[];
    ignoredDeleted: string[];
  },
  modifiedBundles: Array<{
    bundleRoot: string;
    bundleName: string;
    changedFiles: string[];
    deletedFiles: string[];
  }> = [],
  deletedBundles: Array<{
    bundleRoot: string;
    bundleName: string;
    changedFiles: string[];
    deletedFiles: string[];
  }> = [],
  invalidBundles: Array<{ bundleRoot: string; bundleName: string; changedFiles: string[]; deletedFiles: string[] }> = []
): FileChangeStats {
  // Build bundle maps from pre-processed bundle information
  const changedBundlesMap = new Map<string, string[]>();
  const deletedBundlesMap = new Map<string, string[]>();

  // Modified bundles go to changed bundles map
  for (const bundle of modifiedBundles) {
    const allFiles = [...bundle.changedFiles, ...bundle.deletedFiles];
    changedBundlesMap.set(bundle.bundleRoot, allFiles);
  }

  // Invalid bundles also go to changed bundles map (will be in ChangedFiles)
  for (const bundle of invalidBundles) {
    const allFiles = [...bundle.changedFiles, ...bundle.deletedFiles];
    changedBundlesMap.set(bundle.bundleRoot, allFiles);
  }

  // Deleted and invalid bundles go to deleted bundles map (will be in destructiveChanges)
  for (const bundle of [...deletedBundles, ...invalidBundles]) {
    const allFiles = [...bundle.changedFiles, ...bundle.deletedFiles];
    deletedBundlesMap.set(bundle.bundleRoot, allFiles);
  }

  return {
    changed: filtered.changedFiles,
    deleted: filtered.deletedFiles,
    ignoredChanged: filtered.ignoredChanged,
    ignoredDeleted: filtered.ignoredDeleted,
    bundles: {
      changed: changedBundlesMap,
      deleted: deletedBundlesMap,
    },
  };
}

/**
 * Prepares manifest statistics with granular metadata analysis.
 */
async function prepareManifestStats(
  deletedMetadataComponents: { [key: string]: Set<string> },
  changedMetadataComponents: { [key: string]: string[] },
  changedFiles: string[],
  refA: string,
  refB: string
): Promise<ManifestStats> {
  const granularChanges = await analyzeGranularMetadataChanges(changedFiles, refA, refB);

  // Update changed metadata with actual label/rule names from granular changes
  const updatedChangedMetadata = { ...changedMetadataComponents };

  // Replace CustomLabels entries with actual label names
  if (granularChanges.customLabels && granularChanges.customLabels.added.length > 0) {
    updatedChangedMetadata.CustomLabels = granularChanges.customLabels.added;
  } else {
    delete updatedChangedMetadata.CustomLabels;
  }

  // Replace SharingRules entries with actual rule names
  if (granularChanges.sharingRules) {
    const allSharingRuleNames: string[] = [];
    for (const [objectName, changes] of Object.entries(granularChanges.sharingRules)) {
      if (changes.added.length > 0) {
        // Prefix with object name for clarity
        allSharingRuleNames.push(...changes.added.map((rule) => `${objectName}.${rule}`));
      }
    }
    if (allSharingRuleNames.length > 0) {
      updatedChangedMetadata.SharingRules = allSharingRuleNames;
    } else {
      delete updatedChangedMetadata.SharingRules;
    }
  } else {
    delete updatedChangedMetadata.SharingRules;
  }

  return {
    changedMetadata: updatedChangedMetadata,
    deletedMetadata: Object.fromEntries(
      Object.entries(deletedMetadataComponents).map(([type, members]) => [type, Array.from(members)])
    ),
    granularChanges: Object.keys(granularChanges).length > 0 ? granularChanges : undefined,
  };
}

/**
 * Builds the DiffResult object.
 */
function buildDiffResult(
  baseOutputDir: string,
  manifests: {
    packageXmlPath: string | string[];
    destructiveChangesXmlPath: string;
    emptyPackageXmlPath: string;
    chunksGenerated: number;
  },
  artifacts: {
    changedFilesCopiedCount: number;
    sfdxProjectJsonCopied: boolean;
  },
  filtered: {
    changedFiles: string[];
    deletedFiles: string[];
    ignoredChanged: string[];
    ignoredDeleted: string[];
  }
): DiffResult {
  return {
    outputDir: baseOutputDir,
    manifests: {
      packageXml: manifests.packageXmlPath,
      destructiveChangesXml: manifests.destructiveChangesXmlPath,
      emptyDestructivePackageXml: manifests.emptyPackageXmlPath,
    },
    changedFilesCopied: artifacts.changedFilesCopiedCount,
    sfdxProjectJsonCopied: artifacts.sfdxProjectJsonCopied,
    statistics: {
      totalChanged: filtered.changedFiles.length,
      totalDeleted: filtered.deletedFiles.length,
      totalIgnored: filtered.ignoredChanged.length + filtered.ignoredDeleted.length,
      chunksGenerated: manifests.chunksGenerated,
    },
    reports: {},
  };
}

/**
 * Outputs summary in JSON format.
 */
function outputJsonSummary(result: DiffResult, baseOutputDir: string, logger: Logger): void {
  const jsonOutput = JSON.stringify(result, null, 2);

  if (jsonOutput.length > 50_000) {
    const jsonPath = resolve(baseOutputDir, 'deployment-summary.json');
    writeFileSync(jsonPath, jsonOutput);
    logger.log(`\n⚠️  Summary too large for console - written to: ${jsonPath}`);
    // eslint-disable-next-line no-param-reassign
    result.reports.detailedReport = jsonPath;
  } else {
    logger.log('\n' + jsonOutput);
  }
}

/**
 * Outputs summary in GitHub Actions format.
 */
function outputGitHubSummary(
  fileStats: FileChangeStats,
  manifestStats: ManifestStats,
  baseOutputDir: string,
  result: DiffResult,
  logger: Logger
): void {
  const summary = generateGitHubActionsSummary(fileStats, manifestStats, baseOutputDir);
  writeGitHubActionsSummary(summary);
  logger.log('\n✓ GitHub Actions summary written to GITHUB_STEP_SUMMARY');
  // eslint-disable-next-line no-param-reassign
  result.reports.githubSummary = process.env.GITHUB_STEP_SUMMARY;
}

/**
 * Outputs summary in console format.
 */
function outputConsoleSummary(
  fileStats: FileChangeStats,
  manifestStats: ManifestStats,
  manifests: {
    packageXmlPath: string | string[];
    destructiveChangesXmlPath: string;
    chunksGenerated: number;
  },
  filtered: {
    changedFiles: string[];
    deletedFiles: string[];
    ignoredChanged: string[];
    ignoredDeleted: string[];
  },
  baseOutputDir: string,
  logger: Logger,
  bundleStats?: {
    modifiedBundles: number;
    modifiedBundleFiles: number;
    deletedBundles: number;
    invalidBundles: number;
    bundleFilesInRemoved: number;
  }
): void {
  logger.log('\n' + formatFileChangeReport(fileStats));
  logger.log('\n' + formatMetadataReport(manifestStats));

  const packageXmlPath = Array.isArray(manifests.packageXmlPath)
    ? manifests.packageXmlPath[0]
    : manifests.packageXmlPath;

  logger.log(
    formatFinalSummary(
      baseOutputDir,
      packageXmlPath,
      manifests.destructiveChangesXmlPath,
      manifests.chunksGenerated,
      filtered.changedFiles.length,
      filtered.deletedFiles.length,
      filtered.ignoredChanged.length + filtered.ignoredDeleted.length,
      bundleStats
    )
  );
}

/**
 * Generates and outputs summary based on the requested format.
 *
 * @param summaryType The type of summary: 'console', 'json', or 'github'
 * @param baseOutputDir The base output directory
 * @param filtered The filtered files
 * @param deletedMetadataComponents The deleted metadata components
 * @param manifests The generated manifests
 * @param artifacts The processed artifacts
 * @param logger Logger with log, warn methods
 * @param granularStats Granular metadata statistics
 * @returns The DiffResult object
 */
export async function generateSummaryOutput(
  summaryType: string,
  baseOutputDir: string,
  filtered: {
    changedFiles: string[];
    deletedFiles: string[];
    ignoredChanged: string[];
    ignoredDeleted: string[];
  },
  deletedMetadataComponents: { [key: string]: Set<string> },
  manifests: {
    packageXmlPath: string | string[];
    destructiveChangesXmlPath: string;
    emptyPackageXmlPath: string;
    chunksGenerated: number;
  },
  artifacts: {
    sourceApiVersion: string;
    changedFilesCopiedCount: number;
    sfdxProjectJsonCopied: boolean;
    changedMetadataComponents: { [key: string]: string[] };
  },
  logger: Logger,
  refA: string,
  refB: string,
  modifiedBundles: Array<{
    bundleRoot: string;
    bundleName: string;
    changedFiles: string[];
    deletedFiles: string[];
  }> = [],
  deletedBundles: Array<{
    bundleRoot: string;
    bundleName: string;
    changedFiles: string[];
    deletedFiles: string[];
  }> = [],
  invalidBundles: Array<{
    bundleRoot: string;
    bundleName: string;
    changedFiles: string[];
    deletedFiles: string[];
    reason?: string;
  }> = []
): Promise<DiffResult> {
  // Prepare data with bundle information
  const fileStats = prepareFileStats(filtered, modifiedBundles, deletedBundles, invalidBundles);
  const manifestStats = await prepareManifestStats(
    deletedMetadataComponents,
    artifacts.changedMetadataComponents,
    filtered.changedFiles,
    refA,
    refB
  );
  const result = buildDiffResult(baseOutputDir, manifests, artifacts, filtered);

  // Calculate bundle statistics for deployment summary
  const bundleStats = {
    modifiedBundles: modifiedBundles.length,
    modifiedBundleFiles: modifiedBundles.reduce((sum, b) => sum + b.changedFiles.length + b.deletedFiles.length, 0),
    deletedBundles: deletedBundles.length,
    invalidBundles: invalidBundles.length,
    bundleFilesInRemoved: modifiedBundles.reduce((sum, b) => sum + b.deletedFiles.length, 0),
  };

  // Output based on summary type
  if (summaryType === 'json') {
    outputJsonSummary(result, baseOutputDir, logger);
  } else if (summaryType === 'github') {
    outputGitHubSummary(fileStats, manifestStats, baseOutputDir, result, logger);
  } else {
    outputConsoleSummary(fileStats, manifestStats, manifests, filtered, baseOutputDir, logger, bundleStats);
  }

  return result;
}

/**
 * Formats the final deployment summary.
 */
export function formatFinalSummary(
  baseOutputDir: string,
  packageXmlPath: string,
  destructiveChangesXmlPath: string,
  chunksGenerated: number,
  changedFilesCount: number,
  deletedFilesCount: number,
  ignoredFilesCount: number,
  bundleStats?: {
    modifiedBundles: number;
    modifiedBundleFiles: number;
    deletedBundles: number;
    invalidBundles: number;
    bundleFilesInRemoved: number;
  }
): string {
  const lines: string[] = [];
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push('                   DEPLOYMENT SUMMARY');
  lines.push('═══════════════════════════════════════════════════════════');
  lines.push(`Output Directory: ${baseOutputDir}`);
  lines.push(`Package Manifest: ${packageXmlPath}`);
  lines.push(`Destructive Changes: ${destructiveChangesXmlPath}`);
  if (chunksGenerated > 0) {
    lines.push(`Chunks Generated: ${chunksGenerated}`);
  }

  // Show bundle statistics if present
  if (
    bundleStats &&
    (bundleStats.modifiedBundles > 0 || bundleStats.deletedBundles > 0 || bundleStats.invalidBundles > 0)
  ) {
    if (bundleStats.modifiedBundles > 0) {
      lines.push(`Modified Bundles: ${bundleStats.modifiedBundles}`);
    }
    if (bundleStats.deletedBundles > 0) {
      lines.push(`Deleted Bundles: ${bundleStats.deletedBundles}`);
    }
    if (bundleStats.invalidBundles > 0) {
      lines.push(`⚠️  Invalid Bundles: ${bundleStats.invalidBundles} (metadata deleted, other files remain)`);
    }
    if (bundleStats.bundleFilesInRemoved > 0) {
      lines.push(`Bundle Files in RemovedFiles: ${bundleStats.bundleFilesInRemoved} (for visibility)`);
    }
  }

  lines.push(`Changed Files Processed: ${changedFilesCount}`);
  lines.push(`Deleted Files Processed: ${deletedFilesCount}`);
  lines.push(`Files Ignored: ${ignoredFilesCount}`);
  lines.push('═══════════════════════════════════════════════════════════');
  return '\n' + lines.join('\n') + '\n';
}
