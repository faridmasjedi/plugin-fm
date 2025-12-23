import { join } from 'node:path';
import { MetadataResolver } from '@salesforce/source-deploy-retrieve';
import { parseStringPromise } from 'xml2js';
import { getGitFileContent } from './gitUtils.js';
import { BUNDLE_PATH_REGEX } from './constants.js';

/**
 * Parses Git content for both refs.
 */
async function parseGitContent(
  refA: string,
  refB: string,
  filePath: string
): Promise<{ parsedA: Record<string, unknown>; parsedB: Record<string, unknown> } | null> {
  const contentA = getGitFileContent(refA, filePath);
  const contentB = getGitFileContent(refB, filePath);

  if (!contentA && !contentB) return null;

  const parsedA = contentA ? await parseStringPromise(contentA) : {};
  const parsedB = contentB ? await parseStringPromise(contentB) : {};

  return { parsedA: parsedA as Record<string, unknown>, parsedB: parsedB as Record<string, unknown> };
}

/**
 * Extracts metadata elements based on type.
 */
function extractMetadataElements(
  parsed: Record<string, unknown>,
  metadataType: 'CustomLabels' | 'SharingRules'
): Set<string> {
  if (
    metadataType === 'CustomLabels' &&
    parsed.CustomLabels &&
    Array.isArray((parsed.CustomLabels as Record<string, unknown>).labels)
  ) {
    return new Set((parsed.CustomLabels as { labels: Array<{ fullName: string[] }> }).labels.map((l) => l.fullName[0]));
  }
  if (
    metadataType === 'SharingRules' &&
    parsed.SharingRules &&
    Array.isArray((parsed.SharingRules as Record<string, unknown>).sharingCriteriaRules)
  ) {
    return new Set(
      (parsed.SharingRules as { sharingCriteriaRules: Array<{ fullName: string[] }> }).sharingCriteriaRules.map(
        (r) => r.fullName[0]
      )
    );
  }
  return new Set<string>();
}

/**
 * Calculates the difference between two sets of elements.
 */
function calculateElementDiff(elementsA: Set<string>, elementsB: Set<string>): { added: string[]; deleted: string[] } {
  const added = [...elementsB].filter((e) => !elementsA.has(e));
  const deleted = [...elementsA].filter((e) => !elementsB.has(e));
  return { added, deleted };
}

/**
 * Gets granular metadata changes for files like CustomLabels and SharingRules.
 *
 * @param filePath The path to the metadata file.
 * @param refA The starting Git reference.
 * @param refB The ending Git reference.
 * @param metadataType The type of metadata ('CustomLabels' or 'SharingRules').
 * @returns An object with arrays of added and deleted element names.
 */
export async function getGranularMetadataChanges(
  filePath: string,
  refA: string,
  refB: string,
  metadataType: 'CustomLabels' | 'SharingRules'
): Promise<{ added: string[]; deleted: string[] }> {
  const parsed = await parseGitContent(refA, refB, filePath);
  if (!parsed) return { added: [], deleted: [] };

  const elementsA = extractMetadataElements(parsed.parsedA, metadataType);
  const elementsB = extractMetadataElements(parsed.parsedB, metadataType);

  return calculateElementDiff(elementsA, elementsB);
}

/**
 * Helper function to add a component to the metadata components map.
 *
 * @param metadataComponents The metadata components map.
 * @param type The metadata type.
 * @param name The component name.
 */
function addMetadataComponent(metadataComponents: { [key: string]: Set<string> }, type: string, name: string): void {
  if (!metadataComponents[type]) {
    // eslint-disable-next-line no-param-reassign
    metadataComponents[type] = new Set<string>();
  }
  metadataComponents[type].add(name);
}

/**
 * Extracts bundle name from a file path for LWC or Aura bundles.
 * This is used as a fallback when MetadataResolver fails, primarily for deleted files.
 *
 * @param filePath The file path.
 * @param bundleType The bundle directory name ('lwc' or 'aura').
 * @returns The bundle name, or undefined if not found.
 */
function extractBundleName(filePath: string, bundleType: string): string | undefined {
  const pathParts = filePath.split('/');
  const bundleIndex = pathParts.indexOf(bundleType);
  if (bundleIndex !== -1 && pathParts.length > bundleIndex + 1) {
    return pathParts[bundleIndex + 1];
  }
  return undefined;
}

/**
 * Attempts to resolve metadata components using MetadataResolver.
 */
function resolveMetadataComponents(
  filePath: string,
  resolver: MetadataResolver,
  metadataComponents: { [key: string]: Set<string> }
): boolean {
  try {
    const components = resolver.getComponentsFromPath(filePath);
    for (const component of components) {
      addMetadataComponent(metadataComponents, component.type.name, component.fullName);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Handles bundle component fallback when MetadataResolver fails.
 */
function handleBundleFallback(filePath: string, metadataComponents: { [key: string]: Set<string> }): void {
  if (filePath.includes('/lwc/')) {
    const lwcName = extractBundleName(filePath, 'lwc');
    if (lwcName) {
      addMetadataComponent(metadataComponents, 'LightningComponentBundle', lwcName);
    }
  } else if (filePath.includes('/aura/')) {
    const auraName = extractBundleName(filePath, 'aura');
    if (auraName) {
      addMetadataComponent(metadataComponents, 'AuraDefinitionBundle', auraName);
    }
  }
}

/**
 * Maps a list of file paths to Salesforce metadata components.
 * This is primarily used for deleted files to generate destructiveChanges.xml.
 * For changed files, the sf CLI command handles manifest generation.
 *
 * @param filePaths The list of file paths to map.
 * @returns An object where keys are metadata types and values are sets of full names.
 */
export function mapFilesToMetadataComponents(filePaths: string[]): { [key: string]: Set<string> } {
  const metadataComponents: { [key: string]: Set<string> } = {};
  const resolver = new MetadataResolver();

  for (const filePath of filePaths) {
    const resolved = resolveMetadataComponents(filePath, resolver, metadataComponents);
    if (!resolved) {
      handleBundleFallback(filePath, metadataComponents);
    }
  }

  return metadataComponents;
}

/**
 * Extracts bundle information from a file path.
 */
function extractBundleInfo(filePath: string): { type: string; name: string } | null {
  const match = filePath.match(BUNDLE_PATH_REGEX);
  return match ? { type: match[1], name: match[2] } : null;
}

/**
 * Constructs the full bundle directory path.
 */
function getBundleDirPath(filePath: string, bundleType: string, bundleName: string, currentWorkingDir: string): string {
  const bundleRelativePath = filePath.substring(
    0,
    filePath.indexOf(`/${bundleType}/${bundleName}/`) + `/${bundleType}/${bundleName}`.length
  );
  return join(currentWorkingDir, bundleRelativePath);
}

/**
 * Processes deleted files to extract metadata components, handling bundles specially.
 *
 * @param deletedFiles The list of deleted file paths.
 * @param currentWorkingDir The current working directory.
 * @returns An object where keys are metadata types and values are sets of full names.
 */
export function processDeletedFiles(deletedFiles: string[], currentWorkingDir: string): { [key: string]: Set<string> } {
  const deletedBundles = new Set<string>();
  const nonBundleFiles: string[] = [];

  for (const deletedFile of deletedFiles) {
    const bundleInfo = extractBundleInfo(deletedFile);

    if (bundleInfo) {
      const bundleDirPath = getBundleDirPath(deletedFile, bundleInfo.type, bundleInfo.name, currentWorkingDir);
      deletedBundles.add(bundleDirPath);
    } else {
      nonBundleFiles.push(deletedFile);
    }
  }

  return mapFilesToMetadataComponents([...nonBundleFiles, ...deletedBundles]);
}

/**
 * Analyzes files for granular metadata changes (CustomLabels, SharingRules).
 */
export async function analyzeGranularMetadataChanges(
  changedFiles: string[],
  refA: string,
  refB: string
): Promise<{
  customLabels?: { added: string[]; deleted: string[] };
  sharingRules?: { [objectName: string]: { added: string[]; deleted: string[] } };
}> {
  const result: {
    customLabels?: { added: string[]; deleted: string[] };
    sharingRules?: { [objectName: string]: { added: string[]; deleted: string[] } };
  } = {};

  // Process all granular metadata files in parallel
  const promises: Array<Promise<void>> = [];

  for (const file of changedFiles) {
    // Check for CustomLabels
    if (file.includes('labels/CustomLabels.labels')) {
      promises.push(
        getGranularMetadataChanges(file, refA, refB, 'CustomLabels')
          .then((changes) => {
            if (changes.added.length > 0 || changes.deleted.length > 0) {
              result.customLabels = changes;
            }
          })
          .catch(() => {
            // Skip if there's an error parsing
          })
      );
    }

    // Check for SharingRules
    if (file.includes('sharingRules/') && file.endsWith('.sharingRules-meta.xml')) {
      promises.push(
        (async (): Promise<void> => {
          try {
            // Extract object name from file path (e.g., Account.sharingRules-meta.xml -> Account)
            const fileName = file.split('/').pop() ?? '';
            const objectName = fileName.replace('.sharingRules-meta.xml', '');

            const changes = await getGranularMetadataChanges(file, refA, refB, 'SharingRules');
            if (changes.added.length > 0 || changes.deleted.length > 0) {
              if (!result.sharingRules) {
                result.sharingRules = {};
              }
              result.sharingRules[objectName] = changes;
            }
          } catch (error) {
            // Skip if there's an error parsing
          }
        })()
      );
    }
  }

  await Promise.all(promises);
  return result;
}
