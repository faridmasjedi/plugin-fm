import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  buildDeploymentTagName,
  createDeploymentTag,
  findLatestDeploymentTagInfo,
  isAncestor,
} from '../../src/utils/deployTagUtils.js';

const quiet = { log: (): void => {}, warn: (): void => {} };

describe('deployment tags', () => {
  let repo: string;
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const commit = (name: string): string => {
    writeFileSync(join(repo, name), name);
    git('add', '.');
    git('commit', '-q', '-m', name);
    return git('rev-parse', 'HEAD');
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'fm-tags-'));
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('builds sortable tag names', () => {
    expect(buildDeploymentTagName('main', new Date('2026-10-12T09:30:05.123Z'))).to.equal(
      'sf-deploy-success/main/20261012T093005Z'
    );
  });

  it('returns undefined when no tag exists', () => {
    commit('a');
    expect(findLatestDeploymentTagInfo('main', repo, quiet)).to.equal(undefined);
  });

  it('creates a tag and finds it as the latest deployment', () => {
    const first = commit('a');
    const second = commit('b');
    const created = createDeploymentTag({ branch: 'main', commit: first, cwd: repo }, quiet);
    expect(created.sha).to.equal(first);

    const found = findLatestDeploymentTagInfo('main', repo, quiet);
    expect(found).to.deep.equal(created);
    expect(isAncestor(found!.sha, second, repo)).to.equal(true);
    expect(findLatestDeploymentTagInfo('develop', repo, quiet)).to.equal(undefined);
  });
});
