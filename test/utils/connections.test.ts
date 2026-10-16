import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import {
  connectedProviders,
  describeAiConfig,
  removeConnectedKey,
  resolveApiKey,
  saveConnectedKey,
} from '../../src/utils/ai/index.js';
import { openOrg } from '../../src/utils/dashboard/appApi.js';
import { proxySalesforce } from '../../src/utils/dashboard/studio.js';
import { finishOpenRouterSignIn, openRouterSignInUrl, proxyGitHub } from '../../src/utils/dashboard/connections.js';

describe('AI and GitHub connections', () => {
  let home: string;
  const saved = { home: process.env.NOMADSF_HOME, key: process.env.FM_TEST_KEY };

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'nomadsf-home-'));
    process.env.NOMADSF_HOME = home;
    delete process.env.FM_TEST_KEY;
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    if (saved.home === undefined) delete process.env.NOMADSF_HOME;
    else process.env.NOMADSF_HOME = saved.home;
    if (saved.key !== undefined) process.env.FM_TEST_KEY = saved.key;
  });

  it('keeps connected keys in a private file and lets environment variables win', () => {
    const config = { provider: 'openai' as const, apiKeyEnv: 'FM_TEST_KEY' };
    expect(resolveApiKey(config).source).to.equal('none');

    saveConnectedKey('openai', 'sk-test-1234567890', 'test');
    expect(resolveApiKey(config)).to.deep.equal({ key: 'sk-test-1234567890', source: 'connected' });
    expect(statSync(join(home, 'credentials.json')).mode & 0o777).to.equal(0o600);
    expect(connectedProviders().openai?.via).to.equal('test');
    expect(JSON.stringify(connectedProviders())).not.to.include('sk-test');

    process.env.FM_TEST_KEY = 'from-env';
    expect(resolveApiKey(config)).to.deep.equal({ key: 'from-env', source: 'env' });
    expect(describeAiConfig({ ...config, model: 'm', baseUrl: 'https://x' }).keySource).to.equal('env');

    delete process.env.FM_TEST_KEY;
    removeConnectedKey('openai');
    expect(resolveApiKey(config).source).to.equal('none');
  });

  it('refuses values that are not keys', () => {
    expect(() => saveConnectedKey('openai', 'short', 'test')).to.throw('API key');
    expect(() => saveConnectedKey('openai', 'has a space in it', 'test')).to.throw('API key');
  });

  it('builds an OpenRouter PKCE sign-in and refuses unknown states', async () => {
    const url = new URL(openRouterSignInUrl(7007));
    expect(url.origin).to.equal('https://openrouter.ai');
    expect(url.searchParams.get('code_challenge_method')).to.equal('S256');
    expect(url.searchParams.get('callback_url')).to.match(
      /^http:\/\/localhost:7007\/api\/ai\/callback\/openrouter\?state=/
    );
    let error = '';
    await finishOpenRouterSignIn('not-a-state', 'code').catch((e: Error) => (error = e.message));
    expect(error).to.include('expired');
  });

  it('only proxies read-only GitHub paths', async () => {
    for (const path of ['/user/emails', '/repos/a/b/collaborators', '/repos/a/../b', 'https://evil.example/']) {
      let error = '';
      // eslint-disable-next-line no-await-in-loop
      await proxyGitHub(path).catch((e: Error) => (error = e.message));
      expect(error, path).to.equal('GitHub path not allowed.');
    }
  });

  it('opens org pages only at safe paths', () => {
    for (const path of ['https://evil.example', '/x; rm -rf /', '/a b', 'javascript:alert(1)']) {
      expect(() => openOrg('.', 'my-org', path), path).to.throw('Invalid path');
    }
  });

  it('proxies only API and streaming paths', async () => {
    for (const request of [
      { method: 'GET', path: '/cometd/64.0' },
      { method: 'POST', path: '/cometd/../secur/frontdoor.jsp' },
      { method: 'GET', path: '/secur/frontdoor.jsp' },
    ]) {
      let error = '';
      // eslint-disable-next-line no-await-in-loop
      await proxySalesforce('my-org', request).catch((e: Error) => (error = e.message));
      expect(error, request.path).to.include('Only Salesforce');
    }
  });
});
