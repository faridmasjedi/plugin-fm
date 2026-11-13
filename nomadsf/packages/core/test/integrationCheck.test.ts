import { describe, expect, it } from 'vitest';
import { integrationCheck, loginHint, type SalesforceClient } from '../src/index.js';

const NOW = Date.parse('2026-11-13T00:00:00Z');
/** An integration user: active but locked, no API Enabled, failed logins, an admin-approved app it is not given. */
const answers: Array<[RegExp, Array<Record<string, unknown>>]> = [
  [/FROM UserLogin/, [{ IsFrozen: false, IsPasswordLocked: true }]],
  [
    /FROM User WHERE/,
    [
      {
        Id: '005A',
        Name: 'ERP Integration',
        Username: 'erp@x.com',
        IsActive: true,
        LastPasswordChangeDate: '2026-06-01T00:00:00Z',
        'Profile.Name': 'Integration',
      },
    ],
  ],
  [/FROM PermissionSet WHERE/, [{ Label: 'Basic', IsOwnedByProfile: false, PermissionsApiEnabled: false }]],
  [
    /FROM LoginHistory/,
    [
      { LoginTime: '2026-11-12T10:00:00Z', Status: 'Invalid Password', SourceIp: '1.2.3.4', Application: 'ERP' },
      { LoginTime: '2026-11-12T09:00:00Z', Status: 'Invalid Password', SourceIp: '1.2.3.4', Application: 'ERP' },
      { LoginTime: '2026-11-01T09:00:00Z', Status: 'Success', SourceIp: '1.2.3.4', Application: 'ERP' },
    ],
  ],
  [/FROM ConnectedApplication/, [{ Id: '0H4A', Name: 'ERP', OptionsAllowAdminApprovedUsersOnly: true }]],
  [/FROM SetupEntityAccess/, []],
  [/FROM OauthToken/, []],
  [
    /FROM Certificate/,
    [
      { MasterLabel: 'erp_jwt', ExpirationDate: '2026-11-20T00:00:00Z' },
      { MasterLabel: 'old', ExpirationDate: '2025-01-01T00:00:00Z' },
    ],
  ],
  [/FROM RemoteProxy/, [{ SiteName: 'ERP_API', EndpointUrl: 'https://erp.example.com', IsActive: false }]],
  [/FROM NamedCredential/, []],
];
const answer = async (_m: string, path: string) => {
  const soql = decodeURIComponent(path.replace(/^.*\?q=/, '').replace(/\+/g, ' '));
  const records = (answers.find(([re]) => re.test(soql))?.[1] ?? []).map((r) => ({ attributes: {}, ...r }));
  return { done: true, totalSize: records.length, records };
};
const client = {
  rest: answer,
  tooling: answer,
  version: async () => '62.0',
} as unknown as SalesforceClient;

describe('integration check', () => {
  it('finds what blocks the integration, each with what to do', async () => {
    const found = await integrationCheck(client, '005000000000001AAA', { appId: '0H4000000000001AAA', now: NOW });
    const bad = found.filter((f) => f.level === 'bad').map((f) => f.text);
    expect(bad).toEqual(
      expect.arrayContaining([
        expect.stringContaining('locked out'),
        expect.stringContaining('No API Enabled'),
        expect.stringContaining('2 failed: “Invalid Password”'),
        expect.stringContaining('is not one of them'),
        expect.stringContaining('old expired'),
      ])
    );
    expect(found.find((f) => /erp_jwt expires/.test(f.text))?.level).toBe('warn');
    expect(found.find((f) => /ERP_API/.test(f.text))?.level).toBe('warn');
    expect(found.find((f) => /changed \d+ days ago/.test(f.text))?.level).toBe('warn');
    expect(found.find((f) => /Invalid Password/.test(f.text))?.fix).toMatch(/password/);
  });
  it('explains login failures', () => {
    expect(loginHint('Failed: Restricted IP')).toMatch(/Login IP Ranges/);
    expect(loginHint('User is not admin approved to access this app')).toMatch(/admin-approved/);
    expect(loginHint('Success')).toBeUndefined();
  });
});
