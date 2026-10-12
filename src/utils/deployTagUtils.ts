import { execFileSync } from 'node:child_process';
import type { Logger } from './types.js';

/**
 * Prefix for tags that mark a commit as successfully deployed to an org.
 * Full tag format: sf-deploy-success/<branch>/<UTC timestamp>
 */
export const DEPLOY_TAG_PREFIX = 'sf-deploy-success';

export type DeploymentTagInfo = {
  tag: string;
  sha: string;
};

export type CreateDeploymentTagOptions = {
  branch: string;
  commit?: string;
  message?: string;
  push?: boolean;
  remote?: string;
  cwd: string;
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Builds the tag name for a deployment on a branch at a given time.
 */
export function buildDeploymentTagName(branch: string, date: Date = new Date()): string {
  const stamp = date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return `${DEPLOY_TAG_PREFIX}/${branch}/${stamp}`;
}

/**
 * Finds the most recent deployment tag for a branch. Fetches tags from the remote
 * when none are found locally (common in CI where checkouts are shallow).
 */
export function findLatestDeploymentTagInfo(
  branch: string,
  cwd: string,
  logger: Logger,
  remote = 'origin'
): DeploymentTagInfo | undefined {
  const listTags = (): string[] =>
    git(['tag', '--list', `${DEPLOY_TAG_PREFIX}/${branch}/*`, '--sort=-creatordate'], cwd)
      .split('\n')
      .filter((t) => t.length > 0);

  try {
    let tags = listTags();
    if (tags.length === 0) {
      try {
        git(
          [
            'fetch',
            remote,
            `refs/tags/${DEPLOY_TAG_PREFIX}/${branch}/*:refs/tags/${DEPLOY_TAG_PREFIX}/${branch}/*`,
            '--quiet',
          ],
          cwd
        );
        tags = listTags();
      } catch {
        // No remote or no network: rely on local tags only
      }
    }
    if (tags.length === 0) return undefined;

    const tag = tags[0];
    return { tag, sha: git(['rev-list', '-n', '1', tag], cwd) };
  } catch (error) {
    logger.warn(`Could not read deployment tags for branch '${branch}': ${(error as Error).message}`);
    return undefined;
  }
}

/**
 * Returns true if `ancestor` is reachable from `descendant`.
 */
export function isAncestor(ancestor: string, descendant: string, cwd: string): boolean {
  try {
    git(['merge-base', '--is-ancestor', ancestor, descendant], cwd);
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates an annotated deployment tag on the given commit and optionally pushes it.
 */
export function createDeploymentTag(options: CreateDeploymentTagOptions, logger: Logger): DeploymentTagInfo {
  const { branch, cwd, remote = 'origin' } = options;
  const sha = git(['rev-parse', `${options.commit ?? 'HEAD'}^{commit}`], cwd);
  const tag = buildDeploymentTagName(branch);
  const message = options.message ?? `Successful Salesforce deployment of ${branch}`;

  git(['tag', '-a', tag, sha, '-m', message], cwd);
  logger.log(`Created deployment tag ${tag} on ${sha.substring(0, 8)}`);

  if (options.push) {
    try {
      git(['push', remote, `refs/tags/${tag}`], cwd);
      logger.log(`Pushed deployment tag to ${remote}`);
    } catch (error) {
      logger.warn(`Could not push deployment tag to ${remote}: ${(error as Error).message}`);
    }
  }

  return { tag, sha };
}
