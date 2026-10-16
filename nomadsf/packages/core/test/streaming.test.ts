import { describe, expect, it } from 'vitest';
import {
  CometdClient,
  SalesforceClient,
  fieldDependencies,
  fillRates,
  withoutNamespace,
  type BayeuxMessage,
  type HttpRequest,
  type StreamEvent,
} from '../src/index.js';

describe('streaming', () => {
  it('handshakes, subscribes with replay, delivers events, re-handshakes and stops', async () => {
    const sent: Array<Record<string, unknown>> = [];
    let connects = 0;
    const events: StreamEvent[] = [];
    const client = new CometdClient(async (messages) => {
      const m = messages[0];
      sent.push(m);
      const channel = String(m.channel);
      if (channel === '/meta/handshake') return [{ channel, successful: true, clientId: `c${sent.length}` }];
      if (channel === '/meta/subscribe') return [{ channel, successful: true }];
      if (channel === '/meta/disconnect') return [{ channel, successful: true }];
      connects++;
      if (connects === 1)
        return [
          { channel: '/event/Order__e', data: { event: { replayId: 7 }, payload: { Status__c: 'New' } } },
          { channel, successful: true },
        ] as BayeuxMessage[];
      if (connects === 2) return [{ channel, successful: false, advice: { reconnect: 'handshake' } }];
      client.stop();
      return [{ channel, successful: true }];
    });
    await client.run('/event/Order__e', -2, (e) => events.push(e));
    expect(sent[1]).toMatchObject({
      channel: '/meta/subscribe',
      subscription: '/event/Order__e',
      ext: { replay: { '/event/Order__e': -2 } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ replayId: 7, payload: { Status__c: 'New' } });
    expect(sent.filter((m) => m.channel === '/meta/handshake')).toHaveLength(2);
    expect(sent.at(-1)?.channel).toBe('/meta/disconnect');
  });

  it('refuses odd channels and failed subscriptions', async () => {
    const client = new CometdClient(async (m) =>
      m[0].channel === '/meta/handshake'
        ? [{ channel: '/meta/handshake', successful: true, clientId: 'c' }]
        : [{ channel: '/meta/subscribe', successful: false, error: '403::Unknown channel' }]
    );
    await expect(client.run('javascript:x', -1, () => undefined)).rejects.toThrow('Unknown channel');
    await expect(client.run('/event/Nope__e', -1, () => undefined)).rejects.toThrow('403');
  });
});

function fake(handler: (soql: string) => unknown) {
  const calls: string[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const soql = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    calls.push(soql);
    return { status: 200, headers: {}, body: JSON.stringify(handler(soql)) };
  }, '62.0');
  return { calls, client };
}
const records = (rows: unknown[], totalSize = rows.length) => ({ totalSize, done: true, records: rows });

describe('field usage', () => {
  it('strips namespaces and __c', () => {
    expect(withoutNamespace('Score__c')).toBe('Score');
    expect(withoutNamespace('ns__Score__c')).toBe('Score');
  });

  it('counts filled values per filterable field', async () => {
    const { calls, client } = fake((soql) => records([], soql.includes('IsActive__c = true') ? 3 : 5));
    const seen: Array<[string, number | undefined]> = [];
    await fillRates(
      client,
      'Account',
      [
        { name: 'IsActive__c', label: '', type: 'boolean', custom: true, filterable: true },
        { name: 'Notes__c', label: '', type: 'textarea', custom: true, filterable: false },
        { name: 'Score__c', label: '', type: 'double', custom: true, filterable: true },
      ],
      10,
      (f) => seen.push([f.name, f.percent])
    );
    expect(seen).toEqual([
      ['IsActive__c', 30],
      ['Score__c', 50],
    ]);
    expect(calls).toHaveLength(2);
  });

  it('lists what references a custom field of a custom object', async () => {
    const { calls, client } = fake((soql) => {
      if (soql.includes('FROM CustomObject')) return records([{ Id: '01I000000000001' }]);
      if (soql.includes('FROM CustomField')) return records([{ Id: '00N000000000001' }]);
      return records([
        { MetadataComponentId: '300', MetadataComponentName: 'Order_Flow', MetadataComponentType: 'Flow' },
      ]);
    });
    expect(await fieldDependencies(client, 'Order__c', 'Score__c')).toEqual([
      { type: 'Flow', name: 'Order_Flow', id: '300' },
    ]);
    expect(calls[1]).toContain("TableEnumOrId = '01I000000000001' AND DeveloperName = 'Score'");
    await expect(fieldDependencies(client, 'Account', 'Name')).rejects.toThrow('custom fields only');
  });
});
