import { describe, expect, it } from 'vitest';
import {
  aiAssist,
  aiChat,
  aiTest,
  extractSoql,
  openRouterAuthStart,
  openRouterAuthFinish,
  reduceDebugLog,
} from '../src/index.js';

function fakeFetch(reply: (url: string, init: RequestInit) => { status?: number; json: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const out = reply(url, init);
    return new Response(JSON.stringify(out.json), {
      status: out.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { calls, impl };
}
const headers = (init: RequestInit) => init.headers as Record<string, string>;
const body = (init: RequestInit) => JSON.parse(String(init.body)) as Record<string, unknown>;

describe('AI from the browser', () => {
  it('talks to Claude with the Messages API and a direct-browser header', async () => {
    const { calls, impl } = fakeFetch(() => ({
      json: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'OK' }] },
    }));
    expect(await aiTest({ provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-test' }, impl)).toEqual({
      text: 'OK',
      model: 'claude-opus-5-5',
    });
    expect(calls[0].url).toBe('https://api.anthropic.com/v1/messages');
    expect(headers(calls[0].init)).toMatchObject({
      'x-api-key': 'sk-test',
      'anthropic-dangerous-direct-browser-access': 'true',
    });
    expect(body(calls[0].init)).toMatchObject({ system: 'Reply with the single word OK.', max_tokens: 16 });
  });

  it('talks to OpenAI-format providers, Ollama without a key, custom endpoints', async () => {
    const { calls, impl } = fakeFetch(() => ({
      json: { model: 'm', choices: [{ message: { content: '```sql\nSELECT Id FROM Account\n```' } }] },
    }));
    const answer = await aiAssist(
      { provider: 'openai', model: 'gpt-4.1', apiKey: 'k' },
      'soql',
      { question: 'accounts', schema: 'Account: Id' },
      impl
    );
    expect(answer).toMatchObject({ soql: 'SELECT Id FROM Account', provider: 'OpenAI' });
    expect(calls[0].url).toBe('https://api.openai.com/v1/chat/completions');
    expect(headers(calls[0].init).authorization).toBe('Bearer k');
    await aiTest({ provider: 'ollama', model: 'llama3.1' }, impl);
    expect(calls[1].url).toBe('http://localhost:11434/v1/chat/completions');
    expect(headers(calls[1].init).authorization).toBeUndefined();
    await aiTest({ provider: 'custom', model: 'x', baseUrl: 'https://gw.example.com/v1/' }, impl);
    expect(calls[2].url).toBe('https://gw.example.com/v1/chat/completions');
  });

  it('explains clear errors before and after calling', async () => {
    const { impl } = fakeFetch(() => ({ status: 401, json: { error: { message: 'invalid x-api-key' } } }));
    await expect(aiTest({ provider: 'openai', model: 'gpt-4.1' }, impl)).rejects.toThrow(
      'Connect OpenAI with a key first'
    );
    await expect(aiTest({ provider: 'custom', model: 'x' }, impl)).rejects.toThrow('endpoint URL');
    await expect(aiTest({ provider: 'anthropic', model: 'm', apiKey: 'bad' }, impl)).rejects.toThrow(
      'refused the key (401): invalid x-api-key'
    );
    await expect(
      aiChat({ provider: 'openai', model: ' ', apiKey: 'k' }, 's', 'm', { fetchImpl: impl })
    ).rejects.toThrow('Choose a model');
  });

  it('keeps the telling lines of a long log and extracts SOQL', () => {
    const noise = Array.from({ length: 5000 }, (_, i) => `x (${i})|HEAP_ALLOCATE|[1]`);
    const log = [
      ...noise.slice(0, 2500),
      'y|EXCEPTION_THROWN|[3]|System.NullPointerException',
      ...noise.slice(2500),
    ].join('\n');
    expect(reduceDebugLog(log, 20_000)).toContain('NullPointerException');
    expect(extractSoql('SELECT Id FROM Lead')).toBe('SELECT Id FROM Lead');
  });

  it('signs in to OpenRouter with PKCE', async () => {
    const start = await openRouterAuthStart('https://abc.chromiumapp.org/');
    const url = new URL(start.url);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('callback_url')).toBe('https://abc.chromiumapp.org/');
    const { calls, impl } = fakeFetch(() => ({ json: { key: 'sk-or-123' } }));
    expect(await openRouterAuthFinish('code1', start.verifier, impl)).toBe('sk-or-123');
    expect(body(calls[0].init)).toMatchObject({ code: 'code1', code_verifier: start.verifier });
  });
});

describe('more AI tasks', () => {
  it('builds prompts with context and extracts code and REST requests', async () => {
    const { aiTaskPrompt, extractCode, parseRestRequest } = await import('../src/index.js');
    const apex = aiTaskPrompt('write-apex', { question: 'deactivate old users', schema: 'User: Id, IsActive' });
    expect(apex.system).toContain('anonymous Apex');
    expect(apex.message).toContain('Request: deactivate old users');
    expect(aiTaskPrompt('explain-compile', { text: 'class A {', extra: 'Errors: line 1: missing }' }).message).toMatch(
      /^Errors:[\s\S]*class A \{/
    );
    expect(() => aiTaskPrompt('rest-request', {})).toThrow('Say what you want');
    expect(
      aiTaskPrompt('write-class', { question: 'AccountService with a method to close stale opportunities' }).system
    ).toContain('Apex classes');
    expect(extractCode('Here:\n```apex\nSystem.debug(1);\n```\nDone')).toBe('System.debug(1);');
    expect(
      parseRestRequest(
        '```json\n{"method":"post","path":"/services/data/vXX.X/sobjects/Contact","body":{"LastName":"Lee"}}\n```'
      )
    ).toEqual({
      method: 'POST',
      path: '/services/data/vXX.X/sobjects/Contact',
      body: '{\n  "LastName": "Lee"\n}',
    });
    expect(() => parseRestRequest('{"method":"GET","path":"https://evil.example"}')).toThrow('outside /services/');
    expect(() => parseRestRequest('no json here')).toThrow('did not answer');
  });
});
