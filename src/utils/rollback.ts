import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEPLOY_TAG_PREFIX } from './deployTagUtils.js';

/**
 * Rollback = deploy the state of an earlier successful deployment. The delta from the current
 * deployment tag to the target tag is built in a temporary worktree of the target: files
 * changed since come back in their old version, files added since are deleted.
 */

export type RollbackPlan = {
  branch: string;
  /** Deployment tag the org is on now (the latest). */
  current: { tag: string; sha: string };
  /** Deployment tag to go back to. */
  target: { tag: string; sha: string };
  commits: string[];
};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Deployment tags of a branch, newest first, with the commit each points at. */
export function deploymentTags(branch: string, cwd: string): Array<{ tag: string; sha: string }> {
  // Tag names end in their UTC time, so name order is time order (creatordate ties within a second)
  return git(['tag', '--list', `${DEPLOY_TAG_PREFIX}/${branch}/*`, '--sort=-refname'], cwd)
    .split('\n')
    .filter(Boolean)
    .map((tag) => ({ tag, sha: git(['rev-list', '-n', '1', tag], cwd) }));
}

export function planRollback(branch: string, cwd: string, to?: string): RollbackPlan {
  if (!/^[\w./-]+$/.test(branch)) throw new Error('Invalid branch name.');
  const tags = deploymentTags(branch, cwd);
  if (tags.length === 0) throw new Error(`No deployment tags for ${branch} (${DEPLOY_TAG_PREFIX}/${branch}/*).`);
  const current = tags[0];
  // Go back to the newest earlier tag that points at a different commit
  const target = to
    ? tags.find((t) => t.tag === to || t.tag.endsWith(`/${to}`))
    : tags.find((t) => t.sha !== current.sha);
  if (!target) {
    throw new Error(
      to ? `Deployment tag ${to} not found for ${branch}.` : `No earlier deployment of ${branch} to go back to.`
    );
  }
  if (target.sha === current.sha) throw new Error(`${target.tag} is the deployment the org is already on.`);
  const commits = git(['log', '--format=%h %s', `${target.sha}..${current.sha}`], cwd)
    .split('\n')
    .filter(Boolean);
  return { branch, current, target, commits };
}

/** Checks out the target in a temporary worktree; call cleanup() when done. */
export function targetWorktree(plan: RollbackPlan, cwd: string): { dir: string; cleanup: () => void } {
  const parent = mkdtempSync(join(tmpdir(), 'fm-rollback-'));
  const dir = join(parent, 'repo');
  git(['worktree', 'add', '--detach', dir, plan.target.sha], cwd);
  return {
    dir,
    cleanup: (): void => {
      try {
        git(['worktree', 'remove', '--force', dir], cwd);
      } catch {
        // removed below; prune drops the stale worktree entry
        git(['worktree', 'prune'], cwd);
      }
      if (existsSync(parent)) rmSync(parent, { recursive: true, force: true });
    },
  };
}
