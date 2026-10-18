/* eslint-disable camelcase -- fake Chat Completions answer uses the wire format */
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { assist, extractSoql, reduceDebugLog, releaseContext } from '../../src/utils/ai/assist.js';

describe('AI assist', () => {
  it('keeps the telling lines of a long debug log', () => {
    const noise = Array.from({ length: 5000 }, (_, i) => `12:00:00.0 (${i})|HEAP_ALLOCATE|[1]|Bytes:3`);
    const log = [
      ...noise.slice(0, 2500),
      '12:00:01.0 (1)|EXCEPTION_THROWN|[12]|System.NullPointerException',
      ...noise.slice(2500),
    ].join('\n');
    const reduced = reduceDebugLog(log, 20_000);
    expect(reduced.length).to.be.below(20_001);
    expect(reduced).to.include('NullPointerException');
    expect(reduceDebugLog('short')).to.equal('short');
  });

  it('takes the SOQL out of an answer', () => {
    expect(extractSoql('Here:\n```sql\nSELECT Id FROM Account\n```')).to.equal('SELECT Id FROM Account');
    expect(extractSoql('SELECT Id FROM Lead')).to.equal('SELECT Id FROM Lead');
  });

  it('collects the release range from the last deployment tag', () => {
    const repo = mkdtempSync(join(tmpdir(), 'fm-notes-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    try {
      git('init', '-q', '-b', 'main');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 'T');
      writeFileSync(join(repo, 'a.txt'), '1');
      git('add', '.');
      git('commit', '-qm', 'first');
      git('tag', 'sf-deploy-success/main/20260101T000000Z');
      writeFileSync(join(repo, 'b.cls'), 'x');
      git('add', '.');
      git('commit', '-qm', 'add account trigger');
      expect(releaseContext(repo, undefined, 'HEAD').from).to.equal('sf-deploy-success/main/20260101T000000Z');
      git('tag', '-d', 'sf-deploy-success/main/20260101T000000Z');
      const whole = releaseContext(repo);
      expect(whole.from).to.equal('first commit');
      expect(whole.text).to.include('first').and.include('A\ta.txt');
      git('tag', 'sf-deploy-success/main/20260101T000000Z', 'HEAD~1');
      const range = releaseContext(repo);
      expect(range.from).to.equal('sf-deploy-success/main/20260101T000000Z');
      expect(range.text).to.include('add account trigger').and.include('A\tb.cls').and.not.include('first');
      expect(() => releaseContext(repo, 'x; rm -rf /')).to.throw('Invalid git ref');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  describe('with an OpenAI-compatible provider', () => {
    let server: Server;
    let seen: Record<string, unknown> = {};
    const env = { ...process.env };
    before(async () => {
      server = createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          seen = JSON.parse(body) as Record<string, unknown>;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              model: 'fake-1',
              choices: [{ finish_reason: 'stop', message: { content: '```sql\nSELECT Id FROM Account\n```' } }],
            })
          );
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      process.env.FM_AI_PROVIDER = 'openai-compatible';
      process.env.FM_AI_MODEL = 'fake-1';
      process.env.FM_AI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      process.env.FM_AI_API_KEY = 'test-key-123456';
    });
    after(() => {
      server.close();
      process.env = env;
    });

    it('sends one plain question without tools and returns the answer', async () => {
      const answer = await assist(tmpdir(), 'soql', { question: 'all accounts', schema: 'Account: Id, Name' });
      expect(answer).to.include({ model: 'fake-1', provider: 'Custom (OpenAI-compatible)' });
      expect(seen).to.not.have.property('tools');
      const messages = seen.messages as Array<{ role: string; content: string }>;
      expect(messages[0].role).to.equal('system');
      expect(messages[1].content).to.include('Question: all accounts');
      expect(extractSoql(answer.text)).to.equal('SELECT Id FROM Account');
    });

    it('refuses to run without a connected key', async () => {
      const key = process.env.FM_AI_API_KEY;
      delete process.env.FM_AI_API_KEY;
      let error = '';
      await assist(tmpdir(), 'soql', { question: 'x' }).catch((e: Error) => (error = e.message));
      process.env.FM_AI_API_KEY = key;
      expect(error).to.include('No AI connected');
    });

    it('refuses unknown tasks and empty input', async () => {
      let error = '';
      await assist(tmpdir(), 'nope' as 'soql', {}).catch((e: Error) => (error = e.message));
      expect(error).to.include('Unknown');
      await assist(tmpdir(), 'explain-test', { text: ' ' }).catch((e: Error) => (error = e.message));
      expect(error).to.include('Nothing');
    });
  });
});
