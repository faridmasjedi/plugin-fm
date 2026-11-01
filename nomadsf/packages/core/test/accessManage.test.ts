import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  addGroupMembers,
  listGroups,
  apiNameFrom,
  loginSettingsXml,
  setupAccessOf,
  type HttpRequest,
} from '../src/index.js';

const U1 = '005000000000001AAA';
const U2 = '005000000000002AAA';
const GROUP = '00G000000000001AAA';
const PS = '0PS000000000001AAA';

/** A fake org answering queries from a table and recording inserts. */
function fakeOrg(answers: Record<string, unknown[]>) {
  const inserts: unknown[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
    if (r.path.includes('/composite/sobjects') && r.method === 'POST') {
      const records = (JSON.parse(r.body ?? '{}') as { records: unknown[] }).records;
      inserts.push(...records);
      return json(records.map(() => ({ success: true, errors: [] })));
    }
    const soql = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    const key = Object.keys(answers).find((k) => soql.includes(k));
    const records = key ? answers[key] : [];
    return json({ totalSize: records.length, done: true, records });
  }, '62.0');
  return { client, inserts };
}

describe('profile login settings', () => {
  it('writes only IP ranges: login hours and the rest of the profile stay as they are', () => {
    const out = loginSettingsXml({
      ipRanges: [{ start: '10.0.0.1', end: '10.0.0.255', description: 'Office & VPN' }],
    });
    expect(out).not.toContain('userPermissions');
    expect(out).not.toContain('loginHours');
    expect(out).toContain('<description>Office &amp; VPN</description>');
    expect(out).toContain('<startAddress>10.0.0.1</startAddress>');
  });

  it('refuses addresses that are not valid', () => {
    expect(() => loginSettingsXml({ ipRanges: [{ start: '10.0.0.1', end: 'x<y', description: '' }] })).toThrow(
      /Not an IP address/
    );
  });
});

describe('managing access', () => {
  it('suggests an API name from a label', () => {
    expect(apiNameFrom('Sales Ops (EU)')).toBe('Sales_Ops_EU');
    expect(apiNameFrom('2026 Admins')).toBe('X2026_Admins');
  });

  it('adds only the members a group does not have yet', async () => {
    const { client, inserts } = fakeOrg({ 'FROM GroupMember': [{ UserOrGroupId: U1 }] });
    const result = await addGroupMembers(client, GROUP, [U1, U2, U2]);
    expect(result).toEqual({ done: 1, errors: [] });
    expect(inserts).toEqual([{ attributes: { type: 'GroupMember' }, GroupId: GROUP, UserOrGroupId: U2 }]);
  });

  it('names what a permission set gives access to', async () => {
    const { client } = fakeOrg({
      'FROM SetupEntityAccess': [
        { Id: '0J0000000000001AAA', SetupEntityId: '01p000000000001AAA', SetupEntityType: 'ApexClass' },
        { Id: '0J0000000000002AAA', SetupEntityId: '0CP000000000001AAA', SetupEntityType: 'CustomPermission' },
      ],
      'FROM ApexClass': [{ Id: '01p000000000001AAA', Name: 'AccountService', NamespacePrefix: null }],
      'FROM CustomPermission': [
        {
          Id: '0CP000000000001AAA',
          DeveloperName: 'Approve_Refunds',
          MasterLabel: 'Approve refunds',
          NamespacePrefix: 'acme',
        },
      ],
    });
    const rows = await setupAccessOf(client, PS);
    expect(rows.map((r) => [r.kind, r.name, r.label])).toEqual([
      ['ApexClass', 'AccountService', 'AccountService'],
      ['CustomPermission', 'acme__Approve_Refunds', 'Approve refunds'],
    ]);
  });
});

describe('groups and queues', () => {
  it('lists queues whoever owns them, and leaves out personal groups', async () => {
    const { client } = fakeOrg({
      'FROM Group WHERE': [
        {
          Id: '00G000000000001AAA',
          Name: 'Tier 1 Support',
          DeveloperName: 'Tier_1_Support',
          Type: 'Queue',
          OwnerId: U1,
        },
        {
          Id: '00G000000000002AAA',
          Name: 'Support Team',
          DeveloperName: 'Support_Team',
          Type: 'Regular',
          OwnerId: '00D000000000001AAA',
        },
        {
          Id: '00G000000000003AAA',
          Name: 'My favourites',
          DeveloperName: 'My_favourites',
          Type: 'Regular',
          OwnerId: U2,
        },
      ],
    });
    expect((await listGroups(client)).map((g) => `${g.Kind}: ${g.Name}`)).toEqual([
      'Public group: Support Team',
      'Queue: Tier 1 Support',
    ]);
  });
});

describe('apps a permission set gives', () => {
  it('names every app, also those the App Launcher does not show to the running user', async () => {
    const { client } = fakeOrg({
      'FROM SetupEntityAccess': [
        { Id: '0J0000000000001AAA', SetupEntityId: '02u000000000001AAA', SetupEntityType: 'TabSet' },
        { Id: '0J0000000000002AAA', SetupEntityId: '02u000000000002AAA', SetupEntityType: 'TabSet' },
      ],
      'FROM AppMenuItem': [{ ApplicationId: '02u000000000001AAA', Name: 'Sales', Label: 'Sales' }],
      'FROM CustomApplication': [
        { Id: '02u000000000001AAA', DeveloperName: 'Sales', MasterLabel: 'Sales' },
        { Id: '02u000000000002AAA', DeveloperName: 'Hidden_App', MasterLabel: 'Hidden App' },
      ],
    });
    const rows = await setupAccessOf(client, PS);
    expect(rows.map((r) => [r.name, r.label])).toEqual([
      ['Hidden_App', 'Hidden App'],
      ['Sales', 'Sales'],
    ]);
  });
});
