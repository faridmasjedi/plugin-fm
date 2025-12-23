import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ignore from 'ignore';
import { EMPTY_TREE_SHA } from './constants.js';

// Custom type for logging (to avoid `any` type in utility functions)
type CommandLogger = {
  warn: (message: string) => void;
};

/**
 * Executes a function in a different directory, then returns to original directory.
 */
function withDirectory<T>(dir: string, fn: () => T): T {
  const originalDir = process.cwd();
  try {
    process.chdir(dir);
    return fn();
  } finally {
    process.chdir(originalDir);
  }
}

/**
 * Processes a single git diff line and returns changed/deleted files.
 */
function processGitDiffLine(line: string, basePath: string = ''): { changed: string[]; deleted: string[] } {
  const parts = line.split('\t');
  const status = parts[0];
  const changed: string[] = [];
  const deleted: string[] = [];

  if (status.startsWith('R')) {
    // Renamed file: has old path and new path
    const oldPath = parts[1];
    const newPath = parts[2];
    const oldFileName = oldPath.split('/').pop();
    const newFileName = newPath.split('/').pop();

    if (oldFileName === newFileName) {
      // Same filename, just moved - treat as changed
      changed.push(basePath ? resolve(basePath, newPath) : newPath);
    } else {
      // Different filename - treat as delete old + add new
      deleted.push(basePath ? resolve(basePath, oldPath) : oldPath);
      changed.push(basePath ? resolve(basePath, newPath) : newPath);
    }
  } else if (status.startsWith('D')) {
    // Deleted file
    deleted.push(basePath ? resolve(basePath, parts[1]) : parts[1]);
  } else {
    // Added (A) or Modified (M)
    changed.push(basePath ? resolve(basePath, parts[1]) : parts[1]);
  }

  return { changed, deleted };
}

/**
 * Gets a list of changed and deleted files between two Git references.
 * Handles renamed files (R status) by checking if the filename changed.
 *
 * @param refA The starting Git reference.
 * @param refB The ending Git reference.
 * @param currentDir The directory to run git commands in.
 * @returns An object containing arrays of changed files and deleted files.
 */
export function getChangedAndDeletedFiles(
  refA: string,
  refB: string,
  currentDir: string
): { changed: string[]; deleted: string[] } {
  return withDirectory(currentDir, () => {
    const changedFiles: string[] = [];
    const deletedFiles: string[] = [];

    const gitDiffCommand = `git diff --name-status ${refA} ${refB}`;
    const stdout = execSync(gitDiffCommand, { encoding: 'utf8' }).trim();
    const lines = stdout.split('\n').filter((f: string) => f.length > 0);

    for (const line of lines) {
      const result = processGitDiffLine(line);
      changedFiles.push(...result.changed);
      deletedFiles.push(...result.deleted);
    }

    return { changed: changedFiles, deleted: deletedFiles };
  });
}

/**
 * Filters a list of files based on .forceignore rules and additional ignore patterns.
 *
 * @param files The list of files to filter.
 * @param forceignorePath The path to the .forceignore file.
 * @param additionalPatterns Optional array of additional ignore patterns (e.g., from --ignore flag).
 * @param additionalIgnoreFile Optional path to an additional ignore file (e.g., from --ignore-file flag).
 * @returns The list of files after filtering.
 */
export function filterIgnoredFiles(
  files: string[],
  forceignorePath: string,
  additionalPatterns?: string[],
  additionalIgnoreFile?: string
): string[] {
  const ignoreInstance = ignore();

  // Add patterns from .forceignore
  if (existsSync(forceignorePath)) {
    const forceignoreContent = readFileSync(forceignorePath, 'utf8');
    ignoreInstance.add(forceignoreContent);
  }

  // Add additional patterns from --ignore flag
  if (additionalPatterns && additionalPatterns.length > 0) {
    ignoreInstance.add(additionalPatterns);
  }

  // Add patterns from additional ignore file (--ignore-file flag)
  if (additionalIgnoreFile && existsSync(additionalIgnoreFile)) {
    const additionalIgnoreContent = readFileSync(additionalIgnoreFile, 'utf8');
    ignoreInstance.add(additionalIgnoreContent);
  }

  return files.filter((file) => !ignoreInstance.ignores(file));
}

/**
 * Finds the latest deployment tag for a given branch.
 *
 * @param baseBranch The name of the base branch.
 * @param currentDir The directory to run git commands in.
 * @param command The command logger for warnings.
 * @returns The commit SHA of the latest deployment tag, or undefined if not found.
 */
export function findLatestDeploymentTag(
  baseBranch: string,
  currentDir: string,
  command: CommandLogger
): string | undefined {
  return withDirectory(currentDir, () => {
    try {
      // List all tags matching the pattern for the baseBranch, sorted by creation date (newest first)
      const allTags = execSync(`git tag --list 'sf-deploy-success/${baseBranch}/*' --sort=-creatordate`, {
        encoding: 'utf8',
      }).trim();
      const tagLines = allTags.split('\n').filter((tag: string) => tag.length > 0);

      if (tagLines.length > 0) {
        const latestTag = tagLines[0];
        // Get the commit hash that the tag points to
        return execSync(`git rev-list -n 1 ${latestTag}`, { encoding: 'utf8' }).trim();
      }
      return undefined;
    } catch (error) {
      command.warn(`Could not find latest deployment tag for branch ${baseBranch}: ${(error as Error).message}`);
      return undefined;
    }
  });
}

/**
 * Gets the commit SHA for a submodule at a specific ref.
 */
function getSubmoduleCommit(ref: string, submodulePath: string): string {
  try {
    return execSync(`git ls-tree ${ref} ${submodulePath}`, { encoding: 'utf8' }).split(/\s+/)[2].trim();
  } catch (e) {
    return EMPTY_TREE_SHA; // Submodule doesn't exist at this ref
  }
}

/**
 * Gets changes in a single submodule between two commits.
 */
function getSubmoduleChanges(
  submodulePath: string,
  oldCommit: string,
  newCommit: string,
  mainRepoDir: string
): { changed: string[]; deleted: string[] } {
  const submoduleDir = resolve(mainRepoDir, submodulePath);

  return withDirectory(submoduleDir, () => {
    const changedFiles: string[] = [];
    const deletedFiles: string[] = [];

    const gitDiffCommand = `git diff --name-status ${oldCommit} ${newCommit}`;
    const stdout = execSync(gitDiffCommand, { encoding: 'utf8' }).trim();
    const lines = stdout.split('\n').filter((f: string) => f.length > 0);

    for (const line of lines) {
      const result = processGitDiffLine(line, submodulePath);
      changedFiles.push(...result.changed);
      deletedFiles.push(...result.deleted);
    }

    return { changed: changedFiles, deleted: deletedFiles };
  });
}

/**
 * Gets changed and deleted files from submodules between two Git references.
 *
 * @param refA The starting Git reference.
 * @param refB The ending Git reference.
 * @param currentDir The directory to run git commands in.
 * @param command The command logger for warnings.
 * @returns An object containing arrays of changed files and deleted files from submodules.
 */
export function getChangedSubmoduleFiles(
  refA: string,
  refB: string,
  currentDir: string,
  command: CommandLogger
): { changed: string[]; deleted: string[] } {
  return withDirectory(currentDir, () => {
    try {
      // Check if there are any submodules
      const submoduleStatus = execSync('git submodule status', { encoding: 'utf8' }).trim();
      if (submoduleStatus === '') {
        return { changed: [], deleted: [] }; // No submodules found
      }

      const changedFiles: string[] = [];
      const deletedFiles: string[] = [];
      const submodules = submoduleStatus.split('\n').map((line) => line.trim().split(' ')[1]);

      for (const submodulePath of submodules) {
        const oldCommit = getSubmoduleCommit(refA, submodulePath);
        const newCommit = getSubmoduleCommit(refB, submodulePath);

        if (oldCommit !== newCommit) {
          const changes = getSubmoduleChanges(submodulePath, oldCommit, newCommit, currentDir);
          changedFiles.push(...changes.changed);
          deletedFiles.push(...changes.deleted);
        }
      }

      return { changed: changedFiles, deleted: deletedFiles };
    } catch (error) {
      command.warn(`Error processing submodules: ${(error as Error).message}`);
      return { changed: [], deleted: [] };
    }
  });
}

/**
 * Gets the content of a file at a specific git reference.
 *
 * @param ref The git reference (commit, branch, tag).
 * @param filePath The path to the file.
 * @returns The file content as a string, or empty string if file doesn't exist at that ref.
 */
export function getGitFileContent(ref: string, filePath: string): string {
  try {
    return execSync(`git show ${ref}:${filePath}`, { encoding: 'utf8' });
  } catch (e) {
    return ''; // Return empty string if file does not exist at that ref
  }
}

/**
 * Gets all changed and deleted files including submodules.
 *
 * @param refA The starting Git reference.
 * @param refB The ending Git reference.
 * @param currentDir The directory to run git commands in.
 * @param command The command logger for warnings and info.
 * @returns An object containing arrays of changed files and deleted files.
 */
export function getAllChangedAndDeletedFiles(
  refA: string,
  refB: string,
  currentDir: string,
  command: CommandLogger & { log: (message: string) => void }
): { changed: string[]; deleted: string[] } {
  // Get changed and deleted files from main repository
  const result = getChangedAndDeletedFiles(refA, refB, currentDir);

  // Get changed and deleted files from submodules
  const submoduleChanges = getChangedSubmoduleFiles(refA, refB, currentDir, command);
  result.changed.push(...submoduleChanges.changed);
  result.deleted.push(...submoduleChanges.deleted);

  return result;
}

/**
 * Filters files using forceignore and returns filtered and ignored files.
 *
 * @param files Object containing changed and deleted files.
 * @param forceignorePath The path to the .forceignore file.
 * @param additionalPatterns Optional array of additional ignore patterns (e.g., from --ignore flag).
 * @param additionalIgnoreFile Optional path to an additional ignore file (e.g., from --ignore-file flag).
 * @returns Object containing filtered and ignored files.
 */
export function filterFilesWithIgnored(
  files: { changed: string[]; deleted: string[] },
  forceignorePath: string,
  additionalPatterns?: string[],
  additionalIgnoreFile?: string
): {
  changedFiles: string[];
  deletedFiles: string[];
  ignoredChanged: string[];
  ignoredDeleted: string[];
} {
  const changedFiles = filterIgnoredFiles(files.changed, forceignorePath, additionalPatterns, additionalIgnoreFile);
  const deletedFiles = filterIgnoredFiles(files.deleted, forceignorePath, additionalPatterns, additionalIgnoreFile);
  const ignoredChanged = files.changed.filter((f) => !changedFiles.includes(f));
  const ignoredDeleted = files.deleted.filter((f) => !deletedFiles.includes(f));

  return { changedFiles, deletedFiles, ignoredChanged, ignoredDeleted };
}
