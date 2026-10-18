import { describe, expect, it } from 'vitest';
import { SalesforceClient, saveApex, type HttpRequest } from '../src/index.js';

function org(state: () => string, lastModified?: string) {
  const calls: HttpRequest[] = [];
  const client = new SalesforceClient(async (r) => {
    calls.push(r);
    const json = (b: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(b) });
    if (r.method === 'POST') return json({ id: r.path.endsWith('MetadataContainer') ? '1dc' : '1dr' });
    if (r.path.includes('/ContainerAsyncRequest/')) return json({ State: state() });
    if (r.path.includes('LastModifiedDate')) return json({ LastModifiedDate: lastModified });
    return { status: 204, headers: {}, body: '' };
  }, '62.0');
  return { calls, client };
}

describe('save status', () => {
  it('asks a fresh URL each time and reports waiting time', async () => {
    let n = 0;
    const { calls, client } = org(() => (++n < 3 ? 'Queued' : 'Completed'));
    const waits: number[] = [];
    expect(
      (
        await saveApex(client, { id: '01p000000000001', kind: 'ApexClass' }, 'x', {
          intervalMs: 5,
          onWait: (s) => waits.push(s),
        })
      ).ok
    ).toBe(true);
    const polls = calls.filter((c) => c.path.includes('/ContainerAsyncRequest/')).map((c) => c.path);
    expect(new Set(polls).size).toBe(polls.length);
    expect(waits).toHaveLength(3);
  });

  it('stops on Invalidated with a clear message', async () => {
    const { client } = org(() => 'Invalidated');
    const result = await saveApex(client, { id: '01p000000000001', kind: 'ApexClass' }, 'x', { intervalMs: 5 });
    expect(result).toMatchObject({ ok: false, state: 'Invalidated' });
    expect(result.problems[0].problem).toContain('save again');
  });

  it('after the time limit, confirms a save that reached the org', async () => {
    const saved = org(() => 'Queued', new Date(Date.now() + 1000).toISOString());
    expect(
      await saveApex(saved.client, { id: '01p000000000001', kind: 'ApexClass' }, 'x', { intervalMs: 5, timeoutMs: 20 })
    ).toMatchObject({ ok: true });
    const old = org(() => 'Queued', '2020-01-01T00:00:00.000Z');
    expect(
      await saveApex(old.client, { id: '01p000000000001', kind: 'ApexClass' }, 'x', { intervalMs: 5, timeoutMs: 20 })
    ).toMatchObject({ ok: false, state: 'Timeout' });
  });
});
