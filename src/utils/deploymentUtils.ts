import { resolve, relative } from 'node:path';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { ensureDirExists, copyFile, findSfdxProjectJson } from './fileUtils.js';
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
 * Extracts sourceApiVersion from sfdx-project.json (without copying to artifact).
 * The artifact is meant to be used from the repository where sfdx-project.json already exists.
 */
function getSourceApiVersion(
  currentWorkingDir: string,
  logger: { log: (message: string) => void; warn: (message: string) => void }
): string {
  const sfdxProjectJsonPath = findSfdxProjectJson(currentWorkingDir);

  if (!sfdxProjectJsonPath) {
    logger.warn('sfdx-project.json not found in project');
    return DEFAULT_API_VERSION;
  }

  const parsed = readAndParseSfdxProject(sfdxProjectJsonPath);
  if (!parsed) {
    logger.warn('Could not read or parse sfdx-project.json');
    return DEFAULT_API_VERSION;
  }

  return parsed.sourceApiVersion;
}

/**
 * Creates a ComponentSet from changed files and copies all resolved metadata files.
 * This includes both source files and their metadata files (e.g., .cls and .cls-meta.xml).
 */
function createComponentSetAndCopyFiles(
  filteredChangedFiles: string[],
  currentWorkingDir: string,
  changedFilesDir: string,
  logger: { log: (message: string) => void; warn: (message: string) => void }
): { componentSet: ComponentSet; copiedFileCount: number } {
  // Convert relative file paths to absolute paths
  const absoluteFilePaths = filteredChangedFiles.map((file) => resolve(currentWorkingDir, file));

  // Create ComponentSet from the changed files using the correct API
  // This resolves the files to metadata components and includes all related files
  const componentSet = ComponentSet.fromSource({
    fsPaths: absoluteFilePaths,
  });

  // Get all source components from the ComponentSet
  const allSourceComponents = componentSet.getSourceComponents().toArray();
  const copiedFiles = new Set<string>();

  // Copy all files for each component (both source and metadata files)
  for (const component of allSourceComponents) {
    // Copy the source file (e.g., .cls, .trigger, etc.)
    if (component.content) {
      const absolutePath = component.content;
      const relativePath = relative(currentWorkingDir, absolutePath);

      if (!copiedFiles.has(relativePath)) {
        const destinationPath = resolve(changedFilesDir, relativePath);
        copyFile(absolutePath, destinationPath);
        copiedFiles.add(relativePath);
      }
    }

    // Copy the metadata file (e.g., .cls-meta.xml, .trigger-meta.xml, etc.)
    if (component.xml) {
      const absolutePath = component.xml;
      const relativePath = relative(currentWorkingDir, absolutePath);

      if (!copiedFiles.has(relativePath)) {
        const destinationPath = resolve(changedFilesDir, relativePath);
        copyFile(absolutePath, destinationPath);
        copiedFiles.add(relativePath);
      }
    }
  }

  logger.log(`Copied ${copiedFiles.size} files (including metadata files) to ${changedFilesDir}`);

  return { componentSet, copiedFileCount: copiedFiles.size };
}

/**
 * Extracts metadata components from ComponentSet organized by type.
 */
function extractMetadataComponents(componentSet: ComponentSet): { [key: string]: string[] } {
  const metadata: { [key: string]: string[] } = {};

  const components = componentSet.getSourceComponents().toArray();

  for (const component of components) {
    const typeName = component.type.name;
    const memberName = component.fullName;

    if (!metadata[typeName]) {
      metadata[typeName] = [];
    }

    metadata[typeName].push(memberName);
  }

  return metadata;
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
): ProcessedArtifacts & { componentSet: ComponentSet; changedMetadataComponents: { [key: string]: string[] } } {
  const { componentSet, copiedFileCount } = createComponentSetAndCopyFiles(
    filteredChangedFiles,
    currentWorkingDir,
    changedFilesDir,
    logger
  );

  const sourceApiVersion = getSourceApiVersion(currentWorkingDir, logger);

  const changedMetadataComponents = extractMetadataComponents(componentSet);

  return {
    sourceApiVersion,
    changedFilesCopiedCount: copiedFileCount,
    sfdxProjectJsonCopied: false, // No longer copying sfdx-project.json to artifact
    componentSet,
    changedMetadataComponents,
  };
}

/**
 * Processes deleted files: copies them from git history and creates ComponentSet for manifest generation.
 * This allows SF CLI to properly detect metadata types from deleted files.
 */
export function processDeletedFiles(
  deletedFiles: string[],
  refA: string,
  currentWorkingDir: string,
  removedFilesDir: string,
  logger: { log: (message: string) => void; warn: (message: string) => void }
): { deletedMetadataComponents: { [key: string]: Set<string> }; copiedCount: number } {
  let copiedCount = 0;
  const copiedFilePaths: string[] = [];

  // First, copy deleted files from git history to RemovedFiles directory
  for (const file of deletedFiles) {
    try {
      // Extract file content from git history (refA)
      const fileContent = execSync(`git show ${refA}:${file}`, {
        cwd: currentWorkingDir,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large files
      });

      // Write to RemovedFiles directory
      const destinationPath = resolve(removedFilesDir, file);
      const destinationDir = resolve(destinationPath, '..');
      ensureDirExists(destinationDir);
      writeFileSync(destinationPath, fileContent);
      copiedFilePaths.push(destinationPath);
      copiedCount++;
    } catch (error) {
      // Skip files that can't be extracted (binary files, etc.)
      logger.warn(`Could not copy deleted file ${file}: ${(error as Error).message}`);
    }
  }

  if (copiedCount > 0) {
    logger.log(`Copied ${copiedCount} deleted files to ${removedFilesDir}`);
  }

  // Now create ComponentSet from the copied files to detect metadata types
  const deletedMetadataComponents: { [key: string]: Set<string> } = {};

  if (copiedFilePaths.length > 0) {
    try {
      const componentSet = ComponentSet.fromSource({
        fsPaths: copiedFilePaths,
      });

      const components = componentSet.getSourceComponents().toArray();
      for (const component of components) {
        const typeName = component.type.name;
        const memberName = component.fullName;

        if (!deletedMetadataComponents[typeName]) {
          deletedMetadataComponents[typeName] = new Set();
        }

        deletedMetadataComponents[typeName].add(memberName);
      }

      logger.log(`Detected ${components.length} metadata components from deleted files`);
    } catch (error) {
      logger.warn(`Could not create ComponentSet from deleted files: ${(error as Error).message}`);
      // Log full error for debugging
      // eslint-disable-next-line no-console
      console.error('Full error:', error);
    }
  }

  return { deletedMetadataComponents, copiedCount };
}

/**
 * Generates package.xml for changed files using ComponentSet.
 * This resolves the changed files from their original location and generates
 * the manifest before copying, ensuring all metadata files are included.
 */
async function generatePackageManifestFile(
  packageDir: string,
  componentSet: ComponentSet,
  logger: { log: (message: string) => void; error: (message: string) => never }
): Promise<string> {
  const packageXmlPath = resolve(packageDir, 'package.xml');
  try {
    const manifest = await componentSet.getPackageXml();
    writeFileSync(packageXmlPath, manifest);
    logger.log(`Generated package manifest: ${packageXmlPath}`);
  } catch (error) {
    logger.error(`Failed to generate manifest using ComponentSet: ${(error as Error).message}`);
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

  // Generate destructiveChanges.xml with the deleted components
  const destructiveChangesXmlContent = generateDestructiveChangesXml(deletedMetadataComponents, sourceApiVersion);
  const destructiveChangesXmlPath = resolve(destructiveDir, 'destructiveChanges.xml');
  writeFileSync(destructiveChangesXmlPath, destructiveChangesXmlContent);

  // If we have a large number of components, also generate chunked manifests for reference
  if (totalComponents > DEFAULT_CHUNK_CONFIG.maxComponentsPerChunk) {
    const destructiveManifests = generateChunkedManifests(
      deletedMetadataComponents,
      destructiveDir,
      sourceApiVersion,
      DEFAULT_CHUNK_CONFIG
    );

    if (destructiveManifests.length > 1) {
      chunksGenerated = destructiveManifests.length - 1;
      logger.log(`Generated ${chunksGenerated} chunked destructive manifests for large changeset`);
    }
  }

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
export async function generateManifests(
  packageDir: string,
  destructiveDir: string,
  componentSet: ComponentSet,
  deletedMetadataComponents: { [key: string]: Set<string> },
  sourceApiVersion: string,
  logger: { log: (message: string) => void; error: (message: string) => never }
): Promise<GeneratedManifests> {
  const packageXmlPath = await generatePackageManifestFile(packageDir, componentSet, logger);
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
 * Note: Ignore files should already be copied to the artifact directory by the build command.
 */
export function createDockerImage(
  baseOutputDir: string,
  logger: { log: (message: string) => void; warn: (message: string) => void }
): void {
  logger.log('Creating Docker image...');

  // Check which ignore files exist in the artifact directory
  const ignoreFiles: string[] = [];
  const possibleIgnoreFiles = ['.forceignore', 'custom.ignorefile'];

  for (const ignoreFile of possibleIgnoreFiles) {
    const ignoreFilePath = resolve(baseOutputDir, ignoreFile);
    if (existsSync(ignoreFilePath)) {
      ignoreFiles.push(ignoreFile);
    }
  }

  // Build Dockerfile content with optional ignore files
  const ignoreFileCopies = ignoreFiles.map((file) => `COPY ${file} ./`).join('\n');

  const dockerfilePath = resolve(baseOutputDir, 'Dockerfile');
  const dockerfileContent = `# Salesforce Deployment Docker Image
FROM node:lts-alpine

# Install coreutils for GNU env (needed for SF CLI shebang with -S option)
RUN apk add --no-cache coreutils

# Set working directory
WORKDIR /app

# Copy all deployment artifacts
COPY sfdx-project.json ./
COPY ChangedFiles ./ChangedFiles
COPY Package ./Package
COPY Destructive ./Destructive
${ignoreFileCopies ? ignoreFileCopies + '\n' : ''}
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
): { packageDir: string; destructiveDir: string; changedFilesDir: string; removedFilesDir: string } {
  const packageDir = resolve(baseOutputDir, 'Package');
  const destructiveDir = resolve(baseOutputDir, 'Destructive');
  const changedFilesDir = resolve(baseOutputDir, 'ChangedFiles');
  const removedFilesDir = resolve(baseOutputDir, 'RemovedFiles');

  ensureDirExists(baseOutputDir);
  ensureDirExists(packageDir);
  ensureDirExists(destructiveDir);
  ensureDirExists(changedFilesDir);
  ensureDirExists(removedFilesDir);

  logger.log(`Created output directories in: ${baseOutputDir}`);

  return { packageDir, destructiveDir, changedFilesDir, removedFilesDir };
}

/**
 * Parses destructiveChanges.xml and extracts metadata components.
 */
export async function parseDestructiveChangesXml(xmlContent: string): Promise<{ [key: string]: Set<string> }> {
  const xml2js = await import('xml2js');
  const parser = new xml2js.Parser();
  const metadataComponents: { [key: string]: Set<string> } = {};

  await new Promise<void>((resolveFn, reject) => {
    parser.parseString(xmlContent, (err: Error | null, result: Record<string, unknown>) => {
      if (err) {
        reject(err);
        return;
      }

      const pkg = result.Package as Record<string, unknown> | undefined;
      if (pkg?.types) {
        const types = Array.isArray(pkg.types) ? pkg.types : [pkg.types];

        for (const type of types) {
          const typeObj = type as Record<string, unknown>;
          const typeName = (typeObj.name as string[])?.[0];
          if (!typeName) continue;

          const members = typeObj.members;
          if (members) {
            const memberArray = Array.isArray(members) ? members : [members];
            metadataComponents[typeName] = new Set(
              memberArray.map((m: string[] | string) => (Array.isArray(m) ? m[0] : m))
            );
          }
        }
      }

      resolveFn();
    });
  });

  return metadataComponents;
}

/**
 * Processes destructive changes based on mode and pre-files list.
 * Returns paths to the generated destructive XML files.
 */
export async function processDestructiveChanges(
  manifestDir: string,
  destructiveMode: 'pre' | 'post' | 'both',
  preFiles: string[],
  sourceApiVersion: string,
  logger: { log: (message: string) => void }
): Promise<{ preDestructivePath?: string; postDestructivePath?: string }> {
  const destructiveDir = resolve(manifestDir, 'Destructive');
  const destructiveChangesPath = resolve(destructiveDir, 'destructiveChanges.xml');

  // Read and parse existing destructiveChanges.xml
  const xmlContent = readFileSync(destructiveChangesPath, 'utf-8');
  const allMetadata = await parseDestructiveChangesXml(xmlContent);

  if (destructiveMode === 'pre') {
    // Rename to destructiveChangesPre.xml
    const preDestructivePath = resolve(destructiveDir, 'destructiveChangesPre.xml');
    const preXml = generateDestructiveChangesXml(allMetadata, sourceApiVersion);
    writeFileSync(preDestructivePath, preXml);
    logger.log(`Generated pre-destructive changes: ${preDestructivePath}`);
    return { preDestructivePath };
  }

  if (destructiveMode === 'post') {
    // Keep as destructiveChanges.xml (already exists)
    logger.log(`Using post-destructive changes: ${destructiveChangesPath}`);
    return { postDestructivePath: destructiveChangesPath };
  }

  // destructiveMode === 'both'
  // Split metadata based on preFiles
  const preMetadata: { [key: string]: Set<string> } = {};
  const postMetadata: { [key: string]: Set<string> } = {};

  // Build a map of file paths to metadata for quick lookup
  const fileToMetadata = buildFileToMetadataMap(allMetadata);

  // Normalize preFiles paths for comparison
  const normalizedPreFiles = new Set(preFiles.map((f) => f.replace(/\\/g, '/')));

  // Split metadata
  for (const [type, members] of Object.entries(allMetadata)) {
    for (const member of members) {
      const matchingFile = findMatchingFile(type, member, fileToMetadata, normalizedPreFiles);

      if (matchingFile) {
        if (!preMetadata[type]) preMetadata[type] = new Set();
        preMetadata[type].add(member);
      } else {
        if (!postMetadata[type]) postMetadata[type] = new Set();
        postMetadata[type].add(member);
      }
    }
  }

  // Generate both XML files
  const preDestructivePath = resolve(destructiveDir, 'destructiveChangesPre.xml');
  const postDestructivePath = resolve(destructiveDir, 'destructiveChanges.xml');

  const preXml = generateDestructiveChangesXml(preMetadata, sourceApiVersion);
  const postXml = generateDestructiveChangesXml(postMetadata, sourceApiVersion);

  writeFileSync(preDestructivePath, preXml);
  writeFileSync(postDestructivePath, postXml);

  logger.log(`Generated pre-destructive changes: ${preDestructivePath}`);
  logger.log(`Generated post-destructive changes: ${postDestructivePath}`);

  return { preDestructivePath, postDestructivePath };
}

/**
 * Builds a map from metadata to potential file paths.
 */
function buildFileToMetadataMap(metadata: {
  [key: string]: Set<string>;
}): Map<string, { type: string; member: string }> {
  const map = new Map<string, { type: string; member: string }>();

  for (const [type, members] of Object.entries(metadata)) {
    for (const member of members) {
      // Create a normalized key from type and member
      const key = `${type}/${member}`.toLowerCase();
      map.set(key, { type, member });
    }
  }

  return map;
}

/**
 * Finds if a file path matches a metadata component.
 */
function findMatchingFile(
  _type: string,
  member: string,
  _fileToMetadata: Map<string, { type: string; member: string }>,
  normalizedPreFiles: Set<string>
): boolean {
  // Check if any pre-file contains the metadata type and member name
  for (const filePath of normalizedPreFiles) {
    const lowerPath = filePath.toLowerCase();
    const lowerMember = member.toLowerCase();

    // Check if the file path contains the member name
    if (lowerPath.includes(lowerMember)) {
      return true;
    }
  }

  return false;
}
