/* eslint-disable camelcase -- the mock server speaks the Chat Completions wire format */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { loadAiConfig, AiConfigError } from '../../src/utils/ai/index.js';
import { confinePath, sfCommandKind } from '../../src/utils/runbook/tools.js';
import { runRunbook, type PendingApproval } from '../../src/utils/runbook/agent.js';

describe('AI config', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('defaults to Claude Opus', () => {
    delete process.env.FM_AI_PROVIDER;
    delete process.env.FM_AI_MODEL;
    const config = loadAiConfig(mkdtempSync(join(tmpdir(), 'fm-ai-')));
    expect(config).to.include({ provider: 'anthropic', model: 'claude-opus-5-5', apiKeyEnv: 'ANTHROPIC_API_KEY' });
  });

  it('requires a model for providers without a default', () => {
    process.env.FM_AI_PROVIDER = 'openai';
    delete process.env.FM_AI_MODEL;
    expect(() => loadAiConfig(mkdtempSync(join(tmpdir(), 'fm-ai-')))).to.throw(AiConfigError, /Set the model/);
  });

  it('reads .fm/ai.yml and lets the environment override it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-ai-'));
    execFileSync('mkdir', ['-p', join(dir, '.fm')]);
    writeFileSync(join(dir, '.fm/ai.yml'), 'provider: ollama\nmodel: llama-local\n');
    delete process.env.FM_AI_PROVIDER;
    process.env.FM_AI_MODEL = 'other-model';
    expect(loadAiConfig(dir)).to.include({
      provider: 'ollama',
      model: 'other-model',
      baseUrl: 'http://localhost:11434/v1',
    });
  });
});

describe('runbook tools', () => {
  it('keeps paths inside the repository', () => {
    expect(confinePath('/repo', 'force-app/a.cls')).to.equal('/repo/force-app/a.cls');
    expect(() => confinePath('/repo', '../etc/passwd')).to.throw(/outside/);
    expect(() => confinePath('/repo', '/etc/passwd')).to.throw(/outside/);
    expect(() => confinePath('/repo', '.git/config')).to.throw(/outside/);
  });

  it('classifies allowlisted sf commands', () => {
    expect(sfCommandKind(['data', 'query', '--query', 'x'])).to.equal('read');
    expect(sfCommandKind(['org', 'assign', 'permset', '--name', 'X'])).to.equal('org');
    expect(sfCommandKind(['project', 'retrieve', 'start'])).to.equal('local');
    expect(sfCommandKind(['org', 'display'])).to.equal(undefined);
    expect(sfCommandKind(['org', 'delete', 'scratch'])).to.equal(undefined);
  });
});

describe('runbook agent (scripted OpenAI-compatible model)', () => {
  let server: Server;
  let repo: string;
  const call = (id: string, name: string, args: unknown): unknown => ({
    id,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  });
  const script = [
    { tool_calls: [call('a', 'report_plan', { steps: ['Write note', 'Fix data'] })] },
    {
      tool_calls: [
        call('b', 'write_file', { path: 'docs/note.md', content: 'hello', purpose: 'note' }),
        call('c', 'update_step', { index: 1, status: 'done' }),
      ],
    },
    { tool_calls: [call('d', 'run_apex', { purpose: 'fix', code: 'update new List<Case>();' })] },
    { tool_calls: [call('e', 'update_step', { index: 2, status: 'skipped', note: 'rejected' })] },
    { content: 'All done.' },
  ];
  const requests: Array<{ tools: unknown[]; messages: Array<{ role: string; content?: string }> }> = [];

  before((done) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { tools: unknown[]; messages: Array<{ role: string; content?: string }> };
        requests.push(parsed);
        const step = script[parsed.messages.filter((m) => m.role === 'assistant').length];
        res.end(
          JSON.stringify({
            model: 'mock',
            choices: [
              {
                finish_reason: step.tool_calls ? 'tool_calls' : 'stop',
                message: { content: step.content ?? null, tool_calls: step.tool_calls },
              },
            ],
          })
        );
      });
    }).listen(0, '127.0.0.1', done);
    repo = mkdtempSync(join(tmpdir(), 'fm-rb-'));
    writeFileSync(join(repo, 'runbook.md'), '1. Write note\n2. Fix data\n');
  });
  after(() => {
    server.close();
    rmSync(repo, { recursive: true, force: true });
  });

  it('runs the plan, writes files, and never runs a rejected action', async () => {
    const port = (server.address() as { port: number }).port;
    const approvals: PendingApproval[] = [];
    const state = await runRunbook({
      cwd: repo,
      runbookPath: 'runbook.md',
      targetOrg: 'test-org',
      mode: 'execute',
      approve: 'writes',
      ai: { provider: 'ollama', model: 'mock', baseUrl: `http://127.0.0.1:${port}/v1` },
      requestApproval: (pending) => {
        approvals.push(pending);
        return Promise.resolve({ approved: false, by: 'reviewer' });
      },
      onUpdate: () => {},
      log: () => {},
    });

    expect(state.status).to.equal('completed');
    expect(state.steps.map((s) => s.status)).to.deep.equal(['done', 'skipped']);
    expect(readFileSync(join(repo, 'docs/note.md'), 'utf8')).to.equal('hello');
    expect(state.changedFiles).to.deep.equal(['docs/note.md']);
    // write_file is a repo change (no approval under "writes"); run_apex changes the org
    expect(approvals.map((a) => a.kind)).to.deep.equal(['org']);
    expect(approvals[0].detail).to.contain('update new List<Case>()');
    expect(state.actions.find((a) => a.tool === 'run_apex')?.status).to.equal('rejected');
    expect(state.summary).to.equal('All done.');
    // The rejection is reported back to the model as a failed tool result
    const toolMessages = requests[3].messages.filter((m) => m.role === 'tool');
    expect(toolMessages.at(-1)?.content).to.match(/rejected/);
  });

  it('only offers read-only tools in plan mode', async () => {
    requests.length = 0;
    const port = (server.address() as { port: number }).port;
    await runRunbook({
      cwd: repo,
      runbookPath: 'runbook.md',
      targetOrg: 'test-org',
      mode: 'plan',
      approve: 'writes',
      ai: { provider: 'ollama', model: 'mock', baseUrl: `http://127.0.0.1:${port}/v1` },
      requestApproval: () => Promise.resolve({ approved: true, by: 'x' }),
      onUpdate: () => {},
      log: () => {},
    });
    const names = (requests[0].tools as Array<{ function: { name: string } }>).map((t) => t.function.name);
    expect(names).to.not.include.members(['run_apex', 'write_file', 'request_manual_step']);
    expect(names).to.include('soql_query');
    expect(existsSync(join(repo, 'docs/note.md'))).to.equal(true);
  });
});
