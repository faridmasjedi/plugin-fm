import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  addGroupMembers,
  apiNameFrom,
  loginSettingsXml,
  parseLoginSettings,
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
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <custom>true</custom>
    <loginHours>
        <mondayEnd>1080</mondayEnd>
        <mondayStart>480</mondayStart>
    </loginHours>
    <loginIpRanges>
        <description>Office &amp; VPN</description>
        <endAddress>10.0.0.255</endAddress>
        <startAddress>10.0.0.1</startAddress>
    </loginIpRanges>
    <userPermissions><enabled>true</enabled><name>ApiEnabled</name></userPermissions>
</Profile>`;

  it('reads IP ranges and login hours from a retrieved profile', () => {
    expect(parseLoginSettings(xml, 'Sales')).toEqual({
      fullName: 'Sales',
      ipRanges: [{ start: '10.0.0.1', end: '10.0.0.255', description: 'Office & VPN' }],
      hours: { monday: { start: 480, end: 1080 } },
    });
  });

  it('writes only IP ranges and login hours, and reads back the same', () => {
    const settings = parseLoginSettings(xml, 'Sales');
    const out = loginSettingsXml(settings);
    expect(out).not.toContain('userPermissions');
    expect(out).toContain('<description>Office &amp; VPN</description>');
    expect(parseLoginSettings(out, 'Sales')).toEqual(settings);
  });

  it('refuses addresses and hours that are not valid', () => {
    expect(() =>
      loginSettingsXml({ ipRanges: [{ start: '10.0.0.1', end: 'x<y', description: '' }], hours: {} })
    ).toThrow(/Not an IP address/);
    expect(() => loginSettingsXml({ ipRanges: [], hours: { friday: { start: 600, end: 500 } } })).toThrow(/friday/);
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
