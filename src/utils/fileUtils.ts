import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import type { ComponentSet } from '@salesforce/source-deploy-retrieve';
import { isCustomLabelsFile } from './granularMetadataUtils.js';

/**
 * Ensures a directory exists, creating it if necessary.
 *
 * @param dirPath The path to the directory.
 */
export function ensureDirExists(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Copies a file or directory from source to destination, ensuring the destination directory exists.
 *
 * @param sourcePath The path to the source file or directory.
 * @param destinationPath The path to the destination file or directory.
 */
export function copyFile(sourcePath: string, destinationPath: string): void {
  ensureDirExists(dirname(destinationPath));
  cpSync(sourcePath, destinationPath, { force: true, recursive: true });
}

/**
 * Copies multiple files from a source directory to a destination directory, preserving relative paths.
 *
 * @param files The list of files to copy (relative to repo root).
 * @param sourceRoot The root directory of the repository.
 * @param destinationRoot The root directory where files should be copied to.
 */
export function copyChangedFiles(files: string[], sourceRoot: string, destinationRoot: string): void {
  ensureDirExists(destinationRoot);
  for (const file of files) {
    const sourcePath = resolve(sourceRoot, file);
    const destinationPath = resolve(destinationRoot, file);
    copyFile(sourcePath, destinationPath);
  }
}

/**
 * Finds the sfdx-project.json file by searching upwards from a starting directory.
 *
 * @param startDir The directory to start searching from.
 * @returns The absolute path to sfdx-project.json, or undefined if not found.
 */
export function findSfdxProjectJson(startDir: string): string | undefined {
  let currentDir = resolve(startDir);
  while (currentDir !== resolve(currentDir, '..')) {
    // Stop at root
    const sfdxProjectJsonPath = resolve(currentDir, 'sfdx-project.json');
    if (existsSync(sfdxProjectJsonPath)) {
      return sfdxProjectJsonPath;
    }
    currentDir = resolve(currentDir, '..');
  }
  return undefined;
}

/**
 * Copies component files from a ComponentSet, including both source and metadata files.
 *
 * @param componentSet The ComponentSet containing components to copy
 * @param sourceRoot The root directory of the source files
 * @param destinationRoot The root directory where files should be copied
 * @returns Set of relative file paths that were copied
 */
export function copyComponentSetFiles(
  componentSet: ComponentSet,
  sourceRoot: string,
  destinationRoot: string
): Set<string> {
  const copiedFiles = new Set<string>();
  const components = componentSet.getSourceComponents().toArray();

  for (const component of components) {
    // Copy source file (e.g., .cls, .trigger)
    if (component.content) {
      const relativePath = relative(sourceRoot, component.content);
      // Skip CustomLabels files - they're handled separately as partial files
      // Note: SharingRules are NOT skipped - they're deployed as entire files
      if (!copiedFiles.has(relativePath) && !isCustomLabelsFile(relativePath)) {
        copyFile(component.content, resolve(destinationRoot, relativePath));
        copiedFiles.add(relativePath);
      }
    }

    // Copy metadata file (e.g., .cls-meta.xml, .trigger-meta.xml)
    if (component.xml) {
      const relativePath = relative(sourceRoot, component.xml);
      // Skip CustomLabels files - they're handled separately as partial files
      // Note: SharingRules are NOT skipped - they're deployed as entire files
      if (!copiedFiles.has(relativePath) && !isCustomLabelsFile(relativePath)) {
        copyFile(component.xml, resolve(destinationRoot, relativePath));
        copiedFiles.add(relativePath);
      }
    }
  }

  return copiedFiles;
}
