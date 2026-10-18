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

describe('field access', () => {
  const holders = [
    {
      Id: '0PS000000000001AAA',
      Label: 'x',
      Type: 'Profile',
      IsOwnedByProfile: true,
      Profile: { Name: 'Standard User', UserLicense: { Name: 'Salesforce' } },
    },
    {
      Id: '0PS000000000002AAA',
      Label: 'x',
      Type: 'Profile',
      IsOwnedByProfile: true,
      Profile: { Name: 'System Administrator', UserLicense: { Name: 'Salesforce' } },
    },
    {
      Id: '0PS000000000003AAA',
      Label: 'x',
      Type: 'Profile',
      IsOwnedByProfile: true,
      Profile: { Name: 'Web', UserLicense: { Name: 'Guest' } },
    },
    {
      Id: '0PS000000000004AAA',
      Label: 'x',
      Type: 'Profile',
      IsOwnedByProfile: true,
      Profile: { Name: 'Web', UserLicense: { Name: 'Partner' } },
    },
    { Id: '0PS000000000005AAA', Label: 'Sales Ops', Type: 'Regular', IsOwnedByProfile: false },
    { Id: '0PS000000000006AAA', Label: 'Marketing', Type: 'Regular', IsOwnedByProfile: false },
    {
      Id: '0PS000000000007AAA',
      Label: 'grp',
      Type: 'Group',
      IsOwnedByProfile: false,
      PermissionSetGroup: { MasterLabel: 'Support Team' },
    },
  ];

  it('covers profiles, permission sets and groups, with and without access', async () => {
    const { fieldAccess } = await import('../src/index.js');
    const { calls, client } = fake((soql) =>
      soql.includes('FieldPermissions')
        ? records([
            { ParentId: '0PS000000000002AAA', PermissionsRead: true, PermissionsEdit: true },
            { ParentId: '0PS000000000003AAA', PermissionsRead: true, PermissionsEdit: false },
            { ParentId: '0PS000000000005AAA', PermissionsRead: true, PermissionsEdit: false },
            { ParentId: '0PS000000000007AAA', PermissionsRead: true, PermissionsEdit: true },
          ])
        : records(holders)
    );
    expect(await fieldAccess(client, 'Account', 'Active__c')).toEqual([
      { kind: 'Permission set group', name: 'Support Team', access: 'Read & edit' },
      { kind: 'Profile', name: 'System Administrator', access: 'Read & edit' },
      { kind: 'Permission set', name: 'Sales Ops', access: 'Read only' },
      { kind: 'Profile', name: 'Web (Guest)', access: 'Read only' },
      { kind: 'Permission set', name: 'Marketing', access: 'No access' },
      { kind: 'Profile', name: 'Standard User', access: 'No access' },
      { kind: 'Profile', name: 'Web (Partner)', access: 'No access' },
    ]);
    expect(calls[0]).toContain("Field = 'Account.Active__c'");
  });

  it('reads object, field and system permissions of one holder', async () => {
    const {
      objectAccessOf,
      fieldAccessOf,
      systemPermissionsOf,
      SalesforceClient: Client,
    } = await import('../src/index.js');
    const objects = fake(() =>
      records([
        { SobjectType: 'Account', PermissionsRead: true, PermissionsEdit: true, PermissionsModifyAllRecords: false },
      ])
    );
    expect((await objectAccessOf(objects.client, '0PS000000000002AAA'))[0]).toMatchObject({
      object: 'Account',
      read: true,
      edit: true,
      create: false,
    });
    const fields = fake(() =>
      records([{ SobjectType: 'Account', Field: 'Account.Active__c', PermissionsRead: true, PermissionsEdit: false }])
    );
    expect(await fieldAccessOf(fields.client, '0PS000000000002AAA', 'Account')).toEqual([
      { object: 'Account', field: 'Active__c', read: true, edit: false },
    ]);
    expect(fields.calls[0]).toContain("AND SobjectType = 'Account'");
    await expect(objectAccessOf(objects.client, '005000000000001')).rejects.toThrow('permission set');
    const queries: string[] = [];
    const sys = new Client(async (r) => {
      if (r.path.endsWith('/describe'))
        return {
          status: 200,
          headers: {},
          body: JSON.stringify({
            fields: [
              { name: 'PermissionsApiEnabled', label: 'API Enabled', type: 'boolean' },
              { name: 'PermissionsModifyAllData', label: 'Modify All Data', type: 'boolean' },
              { name: 'Label', label: 'Label', type: 'string' },
            ],
          }),
        };
      queries.push(decodeURIComponent(r.path));
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          totalSize: 1,
          done: true,
          records: [{ PermissionsApiEnabled: true, PermissionsModifyAllData: false }],
        }),
      };
    }, '62.0');
    expect(await systemPermissionsOf(sys, '0PS000000000002AAA')).toEqual([
      { api: 'ApiEnabled', label: 'API Enabled', enabled: true },
      { api: 'ModifyAllData', label: 'Modify All Data', enabled: false },
    ]);
    expect(queries).toHaveLength(1);
  });
});
