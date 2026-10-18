import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  checkCodeName,
  createCode,
  openCode,
  saveApex,
  saveBundleFile,
  type HttpRequest,
} from '../src/index.js';

function fake(handler: (r: HttpRequest) => { status?: number; json?: unknown }) {
  const calls: HttpRequest[] = [];
  const client = new SalesforceClient(async (r) => {
    calls.push(r);
    const out = handler(r);
    return { status: out.status ?? 200, headers: {}, body: out.json === undefined ? '' : JSON.stringify(out.json) };
  }, '62.0');
  return { calls, client };
}
const records = (rows: unknown[]) => ({ json: { totalSize: rows.length, done: true, records: rows } });
const body = (r: HttpRequest) => JSON.parse(r.body ?? '{}') as Record<string, unknown>;

describe('more code kinds', () => {
  it('opens Aura bundles with file names by definition type, and Visualforce markup', async () => {
    const { client } = fake((r) =>
      r.path.includes('/query')
        ? records([
            { Id: 'a1', DefType: 'COMPONENT', Source: '<aura:component/>' },
            { Id: 'a2', DefType: 'CONTROLLER', Source: '({})' },
          ])
        : { json: { Markup: '<apex:page/>' } }
    );
    const aura = await openCode(client, { id: '0Ab000000000001', kind: 'Aura', name: 'card' });
    expect(aura.map((f) => [f.path, f.language])).toEqual([
      ['aura/card/card.cmp', 'html'],
      ['aura/card/cardController.js', 'javascript'],
    ]);
    const page = await openCode(client, { id: '066000000000001', kind: 'ApexPage', name: 'Hello' });
    expect(page[0]).toMatchObject({ path: 'Hello.page', language: 'html', source: '<apex:page/>' });
  });

  it('saves Visualforce through the container and Aura files one by one', async () => {
    const { calls, client } = fake((r) => {
      if (r.method === 'POST') return { json: { id: r.path.endsWith('MetadataContainer') ? '1dc' : '1dr' } };
      if (r.path.includes('/ContainerAsyncRequest/')) return { json: { State: 'Completed' } };
      return { status: 204 };
    });
    expect(
      (await saveApex(client, { id: '066000000000001', kind: 'ApexPage' }, '<apex:page/>', { intervalMs: 1 })).ok
    ).toBe(true);
    expect(calls.some((c) => c.path.endsWith('/sobjects/ApexPageMember'))).toBe(true);
    await saveBundleFile(client, 'Aura', '0Ad000000000001', '({})');
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      path: '/services/data/v62.0/tooling/sobjects/AuraDefinition/0Ad000000000001',
    });
    await expect(saveApex(client, { id: '0Ab000000000001', kind: 'Aura' }, 'x')).rejects.toThrow('saveBundleFile');
  });

  it('checks names per kind', () => {
    expect(checkCodeName('LWC', 'accountCard')).toBe('accountCard');
    expect(() => checkCodeName('LWC', 'AccountCard')).toThrow('lowercase');
    expect(() => checkCodeName('ApexClass', 'Bad__Name')).toThrow();
    expect(() => checkCodeName('ApexClass', '1Class')).toThrow();
  });

  it('creates an LWC bundle with its js and html files', async () => {
    let n = 0;
    const { calls, client } = fake(() => ({ json: { id: `id${++n}` } }));
    const item = await createCode(client, { kind: 'LWC', name: 'accountCard' });
    expect(item).toEqual({ id: 'id1', name: 'accountCard', kind: 'LWC' });
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path.split('/sobjects/')[1])).toEqual([
      'LightningComponentBundle',
      'LightningComponentResource',
      'LightningComponentResource',
    ]);
    expect(body(posts[0])).toMatchObject({ FullName: 'accountCard', Metadata: { apiVersion: 62, isExposed: true } });
    expect(body(posts[1])).toMatchObject({
      LightningComponentBundleId: 'id1',
      FilePath: 'lwc/accountCard/accountCard.js',
      Format: 'js',
    });
    expect(String(body(posts[1]).Source)).toContain('export default class AccountCard extends LightningElement');
  });

  it('creates triggers on an object, Visualforce pages and Aura bundles', async () => {
    let n = 0;
    const { calls, client } = fake(() => ({ json: { id: `id${++n}` } }));
    await expect(createCode(client, { kind: 'ApexTrigger', name: 'AccountTrigger' })).rejects.toThrow('object');
    await createCode(client, { kind: 'ApexTrigger', name: 'AccountTrigger', sobject: 'Account' });
    expect(body(calls.at(-1)!)).toMatchObject({
      Name: 'AccountTrigger',
      TableEnumOrId: 'Account',
      Body: expect.stringContaining('trigger AccountTrigger on Account (before insert)'),
    });
    await createCode(client, { kind: 'ApexPage', name: 'Hello' });
    expect(body(calls.at(-1)!)).toMatchObject({
      Name: 'Hello',
      MasterLabel: 'Hello',
      Markup: expect.stringContaining('<apex:page>'),
    });
    await createCode(client, { kind: 'Aura', name: 'card' });
    const aura = calls.slice(-3).map((c) => [c.path.split('/sobjects/')[1], body(c).DefType]);
    expect(aura).toEqual([
      ['AuraDefinitionBundle', undefined],
      ['AuraDefinition', 'COMPONENT'],
      ['AuraDefinition', 'CONTROLLER'],
    ]);
  });
});
