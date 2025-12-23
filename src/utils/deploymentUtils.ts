import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { ensureDirExists, copyChangedFiles, findSfdxProjectJson } from './fileUtils.js';
import { generateChunkedManifests, DEFAULT_CHUNK_CONFIG } from './chunkUtils.js';
import { generateDestructiveChangesXml, generateEmptyPackageXml } from './manifestUtils.js';
import { DEFAULT_API_VERSION } from './constants.js';

export type ProcessedArtifacts = {
  sourceApiVersion: string;
  changedFilesCopiedCount: number;
  sfdxProjectJsonCopied: boolean;
};

export type GeneratedManifests = {
  packageXmlPath: string | string[];
  destructiveChangesXmlPath: string;
  emptyPackageXmlPath: string;
  chunksGenerated: number;
};

/**
 * Reads and parses sfdx-project.json.
 */
function readAndParseSfdxProject(
  sfdxProjectJsonPath: string
): { sourceApiVersion: string; projectJson: Record<string, unknown> } | null {
  try {
    const projectJsonContent = readFileSync(sfdxProjectJsonPath, 'utf8');
    const projectJson = JSON.parse(projectJsonContent) as Record<string, unknown>;
    const sourceApiVersion = (projectJson.sourceApiVersion as string) || DEFAULT_API_VERSION;
    return { sourceApiVersion, projectJson };
  } catch {
    return null;
  }
}

/**
 * Modifies sfdx-project.json for deployment.
 */
function modifySfdxProjectJson(projectJson: Record<string, unknown>): void {
  // eslint-disable-next-line no-param-reassign
  projectJson.packageDirectories = [{ path: 'ChangedFiles', default: true }];
  // eslint-disable-next-line no-param-reassign
  delete projectJson.namespace;
  // eslint-disable-next-line no-param-reassign
  delete projectJson.sfdcLoginUrl;
  // eslint-disable-next-line no-param-reassign
  delete projectJson.signupEmail;
}

/**
 * Writes the modified sfdx-project.json to the output directory.
 */
function writeSfdxProjectJson(projectJson: Record<string, unknown>, baseOutputDir: string): void {
  const modifiedProjectJsonString = JSON.stringify(projectJson, null, 2);
  const destinationPath = resolve(baseOutputDir, 'sfdx-project.json');
  writeFileSync(destinationPath, modifiedProjectJsonString);
}

/**
 * Processes sfdx-project.json and returns version and copy status.
 */
function processSfdxProjectJson(
  currentWorkingDir: string,
  baseOutputDir: string,
  logger: { log: (message: string) => void; warn: (message: string) => void }
): { sourceApiVersion: string; sfdxProjectJsonCopied: boolean } {
  const sfdxProjectJsonPath = findSfdxProjectJson(currentWorkingDir);

  if (!sfdxProjectJsonPath) {
    logger.warn('sfdx-project.json not found in project');
    return { sourceApiVersion: DEFAULT_API_VERSION, sfdxProjectJsonCopied: false };
  }

  const parsed = readAndParseSfdxProject(sfdxProjectJsonPath);
  if (!parsed) {
    logger.warn('Could not read or parse sfdx-project.json');
    return { sourceApiVersion: DEFAULT_API_VERSION, sfdxProjectJsonCopied: false };
  }

  modifySfdxProjectJson(parsed.projectJson);
  writeSfdxProjectJson(parsed.projectJson, baseOutputDir);
  logger.log(`Copied and updated sfdx-project.json to ${resolve(baseOutputDir, 'sfdx-project.json')}`);

  return { sourceApiVersion: parsed.sourceApiVersion, sfdxProjectJsonCopied: true };
}

/**
 * Processes and copies artifacts (changed files and sfdx-project.json).
 */
export function processArtifacts(
  filteredChangedFiles: string[],
  currentWorkingDir: string,
  changedFilesDir: string,
  baseOutputDir: string,
  logger: { log: (message: string) => void; warn: (message: string) => void }
): ProcessedArtifacts {
  copyChangedFiles(filteredChangedFiles, currentWorkingDir, changedFilesDir);
  logger.log(`Copied ${filteredChangedFiles.length} changed files to ${changedFilesDir}`);

  const { sourceApiVersion, sfdxProjectJsonCopied } = processSfdxProjectJson(currentWorkingDir, baseOutputDir, logger);

  return {
    sourceApiVersion,
    changedFilesCopiedCount: filteredChangedFiles.length,
    sfdxProjectJsonCopied,
  };
}

/**
 * Generates package.xml for changed files using sf CLI.
 */
function generatePackageManifestFile(
  packageDir: string,
  changedFilesDir: string,
  baseOutputDir: string,
  logger: { log: (message: string) => void; error: (message: string) => never }
): string {
  const packageXmlPath = resolve(packageDir, 'package.xml');
  try {
    execSync(`sf project generate manifest --source-dir ${changedFilesDir} --output-file ${packageXmlPath}`, {
      cwd: baseOutputDir,
    });
    logger.log(`Generated package manifest: ${packageXmlPath}`);
  } catch (error) {
    logger.error(`Failed to generate manifest using 'sf project generate manifest': ${(error as Error).message}`);
  }
  return packageXmlPath;
}

/**
 * Generates destructive changes manifests.
 */
function generateDestructiveManifestsFiles(
  destructiveDir: string,
  deletedMetadataComponents: { [key: string]: Set<string> },
  sourceApiVersion: string,
  logger: { log: (message: string) => void }
): { destructiveChangesXmlPath: string; chunksGenerated: number } {
  const totalComponents = Object.values(deletedMetadataComponents).reduce((sum, set) => sum + set.size, 0);
  let chunksGenerated = 0;

  if (totalComponents > 0) {
    const destructiveManifests = generateChunkedManifests(
      deletedMetadataComponents,
      destructiveDir,
      sourceApiVersion,
      DEFAULT_CHUNK_CONFIG
    );

    if (destructiveManifests.length > 1) {
      chunksGenerated = destructiveManifests.length - 1;
      logger.log(`Generated ${chunksGenerated} chunked destructive manifests`);
    }
  } else {
    const destructiveChangesXmlContent = generateDestructiveChangesXml({}, sourceApiVersion);
    const destructiveChangesXmlPath = resolve(destructiveDir, 'destructiveChanges.xml');
    writeFileSync(destructiveChangesXmlPath, destructiveChangesXmlContent);
  }

  const destructiveChangesXmlPath = resolve(destructiveDir, 'destructiveChanges.xml');
  logger.log(`Generated destructive changes: ${destructiveChangesXmlPath}`);

  return { destructiveChangesXmlPath, chunksGenerated };
}

/**
 * Generates empty package.xml for destructive changes.
 */
function generateEmptyPackageManifest(
  destructiveDir: string,
  sourceApiVersion: string,
  logger: { log: (message: string) => void }
): string {
  const emptyPackageXmlContent = generateEmptyPackageXml(sourceApiVersion);
  const emptyPackageXmlPath = resolve(destructiveDir, 'package.xml');
  writeFileSync(emptyPackageXmlPath, emptyPackageXmlContent);
  logger.log(`Generated empty package.xml for destructive changes: ${emptyPackageXmlPath}`);
  return emptyPackageXmlPath;
}

/**
 * Generates all manifest files (package.xml, destructiveChanges.xml, etc.).
 */
export function generateManifests(
  packageDir: string,
  destructiveDir: string,
  changedFilesDir: string,
  baseOutputDir: string,
  deletedMetadataComponents: { [key: string]: Set<string> },
  sourceApiVersion: string,
  logger: { log: (message: string) => void; error: (message: string) => never }
): GeneratedManifests {
  const packageXmlPath = generatePackageManifestFile(packageDir, changedFilesDir, baseOutputDir, logger);
  const { destructiveChangesXmlPath, chunksGenerated } = generateDestructiveManifestsFiles(
    destructiveDir,
    deletedMetadataComponents,
    sourceApiVersion,
    logger
  );
  const emptyPackageXmlPath = generateEmptyPackageManifest(destructiveDir, sourceApiVersion, logger);

  return {
    packageXmlPath,
    destructiveChangesXmlPath,
    emptyPackageXmlPath,
    chunksGenerated,
  };
}

/**
 * Creates a Docker image with the deployment artifacts.
 */
export function createDockerImage(
  baseOutputDir: string,
  logger: { log: (message: string) => void; warn: (message: string) => void }
): void {
  logger.log('Creating Docker image...');
  const dockerfilePath = resolve(baseOutputDir, 'Dockerfile');
  const dockerfileContent = `# Salesforce CLI Docker Image
FROM node:lts-alpine

# Set working directory
WORKDIR /app

# Copy sfdx-project.json and changed files
COPY sfdx-project.json ./
COPY ChangedFiles ./ChangedFiles

# Install Salesforce CLI
RUN npm install -g @salesforce/cli

# Default command (can be overridden)
CMD ["sf", "--help"]
`;
  writeFileSync(dockerfilePath, dockerfileContent);
  logger.log(`Created Dockerfile: ${dockerfilePath}`);

  try {
    const imageName = `sf-diff-artifact:${Date.now()}`;
    execSync(`docker build -t ${imageName} .`, { cwd: baseOutputDir, stdio: 'inherit' });
    logger.log(`Built Docker image: ${imageName}`);
  } catch (error) {
    logger.warn(`Failed to build Docker image: ${(error as Error).message}`);
  }
}

/**
 * Prepares output directories for manifest generation.
 */
export function prepareOutputDirectories(
  baseOutputDir: string,
  logger: { log: (message: string) => void }
): { packageDir: string; destructiveDir: string; changedFilesDir: string } {
  const packageDir = resolve(baseOutputDir, 'Package');
  const destructiveDir = resolve(baseOutputDir, 'Destructive');
  const changedFilesDir = resolve(baseOutputDir, 'ChangedFiles');

  ensureDirExists(baseOutputDir);
  ensureDirExists(packageDir);
  ensureDirExists(destructiveDir);
  ensureDirExists(changedFilesDir);

  logger.log(`Created output directories in: ${baseOutputDir}`);

  return { packageDir, destructiveDir, changedFilesDir };
}
