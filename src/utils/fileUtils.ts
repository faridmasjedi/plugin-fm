import { existsSync, mkdirSync, cpSync } from 'node:fs'; // Only keep what's used in this file
import { dirname, resolve } from 'node:path';

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
 * Copies a file from source to destination, ensuring the destination directory exists.
 *
 * @param sourcePath The path to the source file.
 * @param destinationPath The path to the destination file.
 */
export function copyFile(sourcePath: string, destinationPath: string): void {
  ensureDirExists(dirname(destinationPath));
  cpSync(sourcePath, destinationPath, { force: true });
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
