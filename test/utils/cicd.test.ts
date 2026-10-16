import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { findValidation, packageFingerprint, recordValidation } from '../../src/utils/validationStore.js';
import { planRollback, targetWorktree } from '../../src/utils/rollback.js';
import { compareTrees, driftMarkdown, metadataKey, normalize } from '../../src/utils/drift.js';
import { addWildcards } from '../../src/commands/fm/drift.js';
import { planOrgCreate } from '../../src/utils/orgCreate.js';
import { notify, slackPayload, teamsPayload, validateNotify } from '../../src/utils/pipeline/notify.js';
import { loadPipelineConfig } from '../../src/utils/pipeline/config.js';
import type { RunState } from '../../src/utils/pipeline/types.js';

const write = (path: string, content: string): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

describe('CI/CD pack', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fm-cicd-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('fingerprints a package and finds its validation for the same org only', () => {
    write(join(dir, 'pkg/package.xml'), '<Package/>');
    write(join(dir, 'pkg/classes/A.cls'), 'class A {}');
    const fingerprint = packageFingerprint(join(dir, 'pkg'));
    expect(packageFingerprint(join(dir, 'pkg'))).to.equal(fingerprint);
    recordValidation(dir, { orgId: '00D1', fingerprint, validationId: '0Af1' });
    expect(findValidation(dir, '00D1', fingerprint)?.validationId).to.equal('0Af1');
    expect(findValidation(dir, '00D2', fingerprint)).to.equal(undefined);
    write(join(dir, 'pkg/classes/A.cls'), 'class A { }');
    expect(packageFingerprint(join(dir, 'pkg'))).to.not.equal(fingerprint);
  });

  it('plans a rollback to the previous deployment and checks it out', () => {
    const git = (...args: string[]): string => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 'T');
    write(join(dir, 'a.txt'), 'v1');
    git('add', '.');
    git('commit', '-qm', 'v1');
    git('tag', 'sf-deploy-success/main/20260101T000000Z');
    write(join(dir, 'a.txt'), 'v2');
    git('commit', '-qam', 'v2');
    git('tag', 'sf-deploy-success/main/20260102T000000Z');
    const plan = planRollback('main', dir);
    expect(plan.current.tag).to.equal('sf-deploy-success/main/20260102T000000Z');
    expect(plan.target.tag).to.equal('sf-deploy-success/main/20260101T000000Z');
    expect(plan.commits).to.have.length(1);
    const worktree = targetWorktree(plan, dir);
    expect(execFileSync('cat', ['a.txt'], { cwd: worktree.dir, encoding: 'utf8' })).to.equal('v1');
    worktree.cleanup();
    expect(existsSync(worktree.dir)).to.equal(false);
    expect(() => planRollback('main', dir, 'sf-deploy-success/main/20260102T000000Z')).to.throw('already on');
    expect(() => planRollback('nope', dir)).to.throw('No deployment tags');
  });

  it('finds drift by metadata path, ignoring formatting', () => {
    expect(metadataKey('force-app/main/default/classes/A.cls')).to.equal('classes/A.cls');
    expect(metadataKey('README.md')).to.equal(undefined);
    expect(normalize('<a>\r\n  <b>1</b>\n</a>  ', true)).to.equal('<a><b>1</b></a>');
    write(join(dir, 'repo/main/default/classes/A.cls'), 'class A {}\n');
    write(join(dir, 'repo/main/default/classes/B.cls'), 'class B {}');
    write(join(dir, 'repo/main/default/classes/C.cls'), 'class C {}');
    write(join(dir, 'org/x/classes/A.cls'), 'class A {}\r\n');
    write(join(dir, 'org/x/classes/B.cls'), 'class B { /* hotfix */ }');
    write(join(dir, 'org/x/classes/D.cls'), 'class D {}');
    const report = compareTrees([join(dir, 'repo')], join(dir, 'org'));
    expect(report.changed.map((i) => i.key)).to.deep.equal(['classes/B.cls']);
    expect(report.onlyInOrg.map((i) => i.key)).to.deep.equal(['classes/D.cls']);
    expect(report.onlyInRepo.map((i) => i.key)).to.deep.equal(['classes/C.cls']);
    expect(driftMarkdown(report, 'prod')).to.include('Changed in the org (1)');
    expect(addWildcards('<Package>\n  <version>64.0</version>\n</Package>', ['Flow', 'bad type'])).to.match(
      /<members>\*<\/members>\s*<name>Flow<\/name>[\s\S]*<version>/
    );
  });

  it('plans scratch orgs and sandboxes with safe arguments', () => {
    const base = {
      alias: 'feat-x',
      deploy: true,
      permsets: ['App_User'],
      dataPlans: ['data/plan.json'],
      apexScripts: [],
      setDefault: false,
      open: false,
    };
    const scratch = planOrgCreate({ ...base, type: 'scratch' });
    expect(scratch.map((s) => s.id)).to.deep.equal(['create', 'deploy', 'permset:App_User', 'data:data/plan.json']);
    expect(scratch[0].args).to.include.members(['--definition-file', 'config/project-scratch-def.json']);
    const sandbox = planOrgCreate({ ...base, type: 'sandbox', productionOrg: 'prod', deploy: false, alias: 'uat2' });
    expect(sandbox[0].args).to.include.members([
      '--name',
      'uat2',
      '--license-type',
      'Developer',
      '--target-org',
      'prod',
    ]);
    expect(() => planOrgCreate({ ...base, type: 'sandbox' })).to.throw('production org');
    expect(() => planOrgCreate({ ...base, type: 'scratch', permsets: ['x; rm'] })).to.throw('Invalid permission set');
  });

  describe('notifications', () => {
    let server: Server;
    const received: Array<{ path: string; body: Record<string, unknown> }> = [];
    let base = '';
    before(async () => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          received.push({ path: req.url ?? '', body: JSON.parse(body) as Record<string, unknown> });
          res.end('ok');
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => server.close());

    const run = {
      id: 'r1',
      release: '2026.10',
      branch: 'main',
      stages: [{ name: 'Deploy', status: 'failed', error: 'Tests failed' }],
    } as unknown as RunState;

    it('posts to Slack and Teams from environment variables, only for chosen events', async () => {
      const env = { SLACK_HOOK: `${base}/slack`, TEAMS_HOOK: `${base}/teams` };
      const config = {
        slack: 'SLACK_HOOK',
        teams: 'TEAMS_HOOK',
        on: ['failed' as const],
        dashboard: 'https://ci.example/nomadsf',
      };
      await notify(config, 'passed', 'Release train', run, () => undefined, undefined, env);
      expect(received).to.have.length(0);
      await notify(config, 'failed', 'Release train', run, () => undefined, undefined, env);
      const slack = received.find((r) => r.path === '/slack')!.body;
      expect(String(slack.text)).to.include('Release train failed at "Deploy" (Tests failed)').and.include('#run=r1');
      const teams = received.find((r) => r.path === '/teams')!.body as { attachments: Array<{ contentType: string }> };
      expect(teams.attachments[0].contentType).to.equal('application/vnd.microsoft.card.adaptive');
    });

    it('reports a bad webhook without failing the run', async () => {
      const logs: string[] = [];
      await notify({ slack: 'NOPE_HOOK' }, 'failed', 'P', run, (m) => logs.push(m), undefined, {
        NOPE_HOOK: 'http://127.0.0.1:9/x',
      });
      expect(logs[0]).to.include('Slack notification failed');
    });

    it('validates the notify block', () => {
      expect(validateNotify({ slack: 'https://hooks.slack.com/x' })[0]).to.include('NAME of an environment variable');
      expect(validateNotify({ on: ['sometimes'] })[0]).to.include('notify.on');
      expect(slackPayload('hi', 'https://x').text).to.equal('hi\n<https://x|Open the run>');
      expect(teamsPayload('hi')).to.have.property('type', 'message');
      const file = join(dir, 'pipeline.yml');
      writeFileSync(file, 'name: P\nnotify:\n  slack: SLACK_WEBHOOK_URL\nstages:\n  - id: drift\n    uses: drift\n');
      expect(loadPipelineConfig(file).notify).to.deep.equal({ slack: 'SLACK_WEBHOOK_URL' });
    });
  });
});
