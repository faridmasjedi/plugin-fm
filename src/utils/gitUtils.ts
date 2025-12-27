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
function processGitDiffLine(
  line: string,
  basePath: string = ''
): { changed: string[]; deleted: string[]; renamed: Map<string, string> } {
  const parts = line.split('\t');
  const status = parts[0];
  const changed: string[] = [];
  const deleted: string[] = [];
  const renamed = new Map<string, string>();

  if (status.startsWith('R')) {
    // Renamed file: treat as delete (old path) + add (new path)
    // Track the old filename and path for rename detection
    const oldPath = parts[1];
    const newPath = parts[2];
    const oldFilename = oldPath.split('/').pop() ?? oldPath;
    const fullOldPath = basePath ? resolve(basePath, oldPath) : oldPath;
    const fullNewPath = basePath ? resolve(basePath, newPath) : newPath;

    deleted.push(fullOldPath);
    changed.push(fullNewPath);

    // Store renamed: filename -> old path
    renamed.set(oldFilename, fullOldPath);
  } else if (status.startsWith('D')) {
    // Deleted file
    deleted.push(basePath ? resolve(basePath, parts[1]) : parts[1]);
  } else {
    // Added (A) or Modified (M)
    changed.push(basePath ? resolve(basePath, parts[1]) : parts[1]);
  }

  return { changed, deleted, renamed };
}

/**
 * Gets a list of changed and deleted files between two Git references.
 * Treats renamed files as delete + add operations.
 *
 * @param refA The starting Git reference.
 * @param refB The ending Git reference.
 * @param currentDir The directory to run git commands in.
 * @returns An object containing arrays of changed files, deleted files, and renamed file map.
 */
export function getChangedAndDeletedFiles(
  refA: string,
  refB: string,
  currentDir: string
): { changed: string[]; deleted: string[]; renamed: Map<string, string> } {
  return withDirectory(currentDir, () => {
    const changedFiles: string[] = [];
    const deletedFiles: string[] = [];
    const renamedMap = new Map<string, string>();

    const gitDiffCommand = `git diff --name-status ${refA} ${refB}`;
    const stdout = execSync(gitDiffCommand, { encoding: 'utf8' }).trim();
    const lines = stdout.split('\n').filter((f: string) => f.length > 0);

    // Process all git diff lines
    for (const line of lines) {
      const result = processGitDiffLine(line);
      changedFiles.push(...result.changed);
      deletedFiles.push(...result.deleted);

      // Merge renamed map
      for (const [filename, oldPath] of result.renamed.entries()) {
        renamedMap.set(filename, oldPath);
      }
    }

    return { changed: changedFiles, deleted: deletedFiles, renamed: renamedMap };
  });
}

/**
 * Filters a list of files based on .forceignore rules and additional ignore patterns.
 *
 * @param files The list of files to filter.
 * @param forceignorePath The path to the .forceignore file.
 * @param additionalPatterns Optional array of additional ignore patterns (e.g., from --ignore flag).
 * @returns The list of files after filtering.
 */
export function filterIgnoredFiles(files: string[], forceignorePath: string, additionalPatterns?: string[]): string[] {
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
 * Treats renamed files as delete + add operations.
 */
function getSubmoduleChanges(
  submodulePath: string,
  oldCommit: string,
  newCommit: string,
  mainRepoDir: string
): { changed: string[]; deleted: string[]; renamed: Map<string, string> } {
  const submoduleDir = resolve(mainRepoDir, submodulePath);

  return withDirectory(submoduleDir, () => {
    const changedFiles: string[] = [];
    const deletedFiles: string[] = [];
    const renamedMap = new Map<string, string>();

    const gitDiffCommand = `git diff --name-status ${oldCommit} ${newCommit}`;
    const stdout = execSync(gitDiffCommand, { encoding: 'utf8' }).trim();
    const lines = stdout.split('\n').filter((f: string) => f.length > 0);

    for (const line of lines) {
      const result = processGitDiffLine(line, submodulePath);
      changedFiles.push(...result.changed);
      deletedFiles.push(...result.deleted);

      // Merge renamed map
      for (const [filename, oldPath] of result.renamed.entries()) {
        renamedMap.set(filename, oldPath);
      }
    }

    return { changed: changedFiles, deleted: deletedFiles, renamed: renamedMap };
  });
}

/**
 * Gets changed and deleted files from submodules between two Git references.
 *
 * @param refA The starting Git reference.
 * @param refB The ending Git reference.
 * @param currentDir The directory to run git commands in.
 * @param command The command logger for warnings.
 * @returns An object containing arrays of changed files, deleted files, and renamed map from submodules.
 */
export function getChangedSubmoduleFiles(
  refA: string,
  refB: string,
  currentDir: string,
  command: CommandLogger
): { changed: string[]; deleted: string[]; renamed: Map<string, string> } {
  return withDirectory(currentDir, () => {
    try {
      // Check if there are any submodules
      const submoduleStatus = execSync('git submodule status', { encoding: 'utf8' }).trim();
      if (submoduleStatus === '') {
        return { changed: [], deleted: [], renamed: new Map() }; // No submodules found
      }

      const changedFiles: string[] = [];
      const deletedFiles: string[] = [];
      const renamedMap = new Map<string, string>();
      const submodules = submoduleStatus.split('\n').map((line) => line.trim().split(' ')[1]);

      for (const submodulePath of submodules) {
        const oldCommit = getSubmoduleCommit(refA, submodulePath);
        const newCommit = getSubmoduleCommit(refB, submodulePath);

        if (oldCommit !== newCommit) {
          const changes = getSubmoduleChanges(submodulePath, oldCommit, newCommit, currentDir);
          changedFiles.push(...changes.changed);
          deletedFiles.push(...changes.deleted);

          // Merge renamed map
          for (const [filename, oldPath] of changes.renamed.entries()) {
            renamedMap.set(filename, oldPath);
          }
        }
      }

      return { changed: changedFiles, deleted: deletedFiles, renamed: renamedMap };
    } catch (error) {
      command.warn(`Error processing submodules: ${(error as Error).message}`);
      return { changed: [], deleted: [], renamed: new Map() };
    }
  });
}

/**
 * Gets the content of a file at a specific git reference.
 *
 * @param ref The git reference (commit, branch, tag).
 * @param filePath The path to the file.
 * @returns The file content as a string, or null if file doesn't exist at that ref.
 */
export function getGitFileContent(ref: string, filePath: string): string | null {
  try {
    return execSync(`git show ${ref}:${filePath}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return null; // Return null if file does not exist at that ref
  }
}

/**
 * Gets package directories from sfdx-project.json
 */
function getPackageDirectories(projectDir: string): string[] {
  try {
    const sfdxProjectPath = resolve(projectDir, 'sfdx-project.json');
    if (!existsSync(sfdxProjectPath)) {
      return [];
    }
    const content = readFileSync(sfdxProjectPath, 'utf8');
    const project = JSON.parse(content) as { packageDirectories?: Array<{ path: string }> };
    return project.packageDirectories?.map((d) => d.path) ?? [];
  } catch {
    return [];
  }
}

/**
 * Filters files to only include those within package directories
 */
function filterByPackageDirectories(files: string[], packageDirs: string[]): string[] {
  if (packageDirs.length === 0) {
    return files; // No filtering if no package directories defined
  }

  return files.filter((file) => {
    // Normalize path separators
    const normalizedFile = file.replace(/\\/g, '/');
    return packageDirs.some((dir) => {
      const normalizedDir = dir.replace(/\\/g, '/');
      return normalizedFile.startsWith(normalizedDir + '/') || normalizedFile === normalizedDir;
    });
  });
}

/**
 * Gets all changed and deleted files including submodules.
 * Filters files to only include those within package directories from sfdx-project.json.
 *
 * @param refA The starting Git reference.
 * @param refB The ending Git reference.
 * @param currentDir The directory to run git commands in.
 * @param command The command logger for warnings and info.
 * @returns An object containing arrays of changed files, deleted files, and renamed map.
 */
export function getAllChangedAndDeletedFiles(
  refA: string,
  refB: string,
  currentDir: string,
  command: CommandLogger & { log: (message: string) => void }
): { changed: string[]; deleted: string[]; renamed: Map<string, string> } {
  // Get changed and deleted files from main repository
  const result = getChangedAndDeletedFiles(refA, refB, currentDir);

  // Get changed and deleted files from submodules
  const submoduleChanges = getChangedSubmoduleFiles(refA, refB, currentDir, command);
  result.changed.push(...submoduleChanges.changed);
  result.deleted.push(...submoduleChanges.deleted);

  // Merge renamed maps from submodules
  for (const [filename, oldPath] of submoduleChanges.renamed.entries()) {
    result.renamed.set(filename, oldPath);
  }

  // Filter by package directories
  const packageDirs = getPackageDirectories(currentDir);
  if (packageDirs.length > 0) {
    result.changed = filterByPackageDirectories(result.changed, packageDirs);
    result.deleted = filterByPackageDirectories(result.deleted, packageDirs);

    // Filter renamed map
    const filteredRenamed = new Map<string, string>();
    for (const [filename, oldPath] of result.renamed.entries()) {
      // Check if the new path (in changed) is still present after filtering
      if (result.changed.some((f) => f.endsWith(filename))) {
        filteredRenamed.set(filename, oldPath);
      }
    }
    result.renamed = filteredRenamed;
  }

  return result;
}

/**
 * Filters files using forceignore and returns filtered and ignored files.
 * Optionally checks for renamed files and warns if they are not ignored.
 *
 * @param files Object containing changed and deleted files.
 * @param forceignorePath The path to the .forceignore file.
 * @param additionalPatterns Optional array of additional ignore patterns (e.g., from --ignore flag).
 * @param renamed Optional map of renamed files (filename -> old path) to check after filtering.
 * @returns Object containing filtered and ignored files.
 */
export function filterFilesWithIgnored(
  files: { changed: string[]; deleted: string[] },
  forceignorePath: string,
  additionalPatterns?: string[],
  renamed?: Map<string, string>
): {
  changedFiles: string[];
  deletedFiles: string[];
  ignoredChanged: string[];
  ignoredDeleted: string[];
} {
  const changedFiles = filterIgnoredFiles(files.changed, forceignorePath, additionalPatterns);
  const deletedFiles = filterIgnoredFiles(files.deleted, forceignorePath, additionalPatterns);
  const ignoredChanged = files.changed.filter((f) => !changedFiles.includes(f));
  const ignoredDeleted = files.deleted.filter((f) => !deletedFiles.includes(f));

  // Check for renamed files that are NOT ignored
  if (renamed && renamed.size > 0) {
    const confirmedRenames: Array<{ filename: string; oldPath: string; newPath: string }> = [];

    for (const [filename, oldPath] of renamed.entries()) {
      // Only warn if the old path is NOT ignored
      if (!ignoredDeleted.includes(oldPath)) {
        // Check if this filename appears in any changed file path
        const matchingPath = changedFiles.find((path) => path.includes(filename));

        if (matchingPath) {
          confirmedRenames.push({ filename, oldPath, newPath: matchingPath });
        }
      }
    }

    // Warn user about potential renamed/moved files
    if (confirmedRenames.length > 0) {
      /* eslint-disable no-console */
      console.log('\n⚠️  Warning: Detected files with same name in both changed and deleted lists:');
      console.log('These might be renamed or moved files. If they are, consider adding the old paths');
      console.log('to your forceignore file to exclude them from destructive changes.\n');

      for (const { filename, oldPath, newPath } of confirmedRenames) {
        console.log(`  ${filename}:`);
        console.log(`    Deleted: ${oldPath}`);
        console.log(`    Changed: ${newPath}`);
      }
      console.log('');
      /* eslint-enable no-console */
    }
  }

  return { changedFiles, deletedFiles, ignoredChanged, ignoredDeleted };
}
