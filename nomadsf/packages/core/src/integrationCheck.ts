import type { SalesforceClient } from './client.js';
import { query, type Row } from './query.js';

/**
 * Security › Integration check: why an integration may fail, read from the org — the integration user (active, frozen,
 * locked, API Enabled, password age), its recent logins and Salesforce's reason for each failure, the connected app
 * (who may use it, its tokens), the certificates (expired, expiring) and the outbound endpoints. Read only.
 */

export type CheckLevel = 'ok' | 'warn' | 'bad' | 'info';
export type CheckArea = 'User' | 'Permissions' | 'Logins' | 'Connected app' | 'Certificates' | 'Endpoints';
export type IntegrationFinding = { area: CheckArea; level: CheckLevel; text: string; fix?: string };
export type ConnectedAppPick = { id: string; name: string; adminApproved: boolean };

const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const DAY = 86_400_000;
const daysSince = (iso: unknown, now: number): number | undefined =>
  iso ? Math.floor((now - Date.parse(String(iso))) / DAY) : undefined;
const when = (iso: unknown): string =>
  String(iso ?? '')
    .replace('T', ' ')
    .slice(0, 16);

/** What a failed login's status usually means, and what to do about it. */
const LOGIN_HINTS: Array<[RegExp, string]> = [
  [/invalid password/i, 'The password (or client secret) is wrong, or it changed: update it in the calling system.'],
  [/lockout|locked/i, 'Too many failed logins locked the user: unlock it in Setup › Users, then fix the password.'],
  [/restricted ip|ip restricted|login ip/i, 'The caller’s IP is outside the profile’s Login IP Ranges: add its range.'],
  [
    /activation|security token|identity verification/i,
    'The IP is not trusted: add it to Network Access, or append the security token to the password.',
  ],
  [/inactive|frozen/i, 'The user is inactive or frozen: activate or unfreeze it.'],
  [
    /admin approved|not approved|not authorized/i,
    'The connected app only lets admin-approved users in: add the user’s profile or a permission set to the app.',
  ],
  [
    /invalid client|client credentials|client id/i,
    'The consumer key or secret is wrong: copy them again from the connected app.',
  ],
  [
    /assertion|jwt|certificate|signature/i,
    'The JWT does not match: check the certificate uploaded to the connected app, the audience URL and the user.',
  ],
  [/expired/i, 'Something expired (password, token or certificate): renew it.'],
  [
    /api.*(disabled|not enabled)|api access/i,
    'The user lacks API Enabled: give it in the profile or a permission set.',
  ],
];
export function loginHint(status: string): string | undefined {
  return LOGIN_HINTS.find(([re]) => re.test(status))?.[1];
}

/** Connected apps of the org, for the picker. */
export async function connectedAppPicks(client: SalesforceClient): Promise<ConnectedAppPick[]> {
  return (
    await query(client, 'SELECT Id, Name, OptionsAllowAdminApprovedUsersOnly FROM ConnectedApplication ORDER BY Name', {
      maxRows: 2000,
    })
  ).rows.map((r) => ({
    id: String(r.Id),
    name: String(r.Name ?? ''),
    adminApproved: r.OptionsAllowAdminApprovedUsersOnly === true,
  }));
}

const safe = async (work: Promise<{ rows: Row[] }>): Promise<Row[] | undefined> => {
  try {
    return (await work).rows;
  } catch {
    return undefined;
  }
};

export async function integrationCheck(
  client: SalesforceClient,
  userId: string,
  options: { appId?: string; days?: number; now?: number } = {}
): Promise<IntegrationFinding[]> {
  if (!ID.test(userId) || !userId.startsWith('005')) throw new Error('Choose the integration user.');
  const days = options.days ?? 30;
  const now = options.now ?? Date.now();
  const out: IntegrationFinding[] = [];
  const add = (area: CheckArea, level: CheckLevel, text: string, fix?: string) => out.push({ area, level, text, fix });
  const assigned = `SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`;

  const [user, login, perms, logins, app, tokens, certs, remotes, named] = await Promise.all([
    query(
      client,
      `SELECT Id, Name, Username, IsActive, LastLoginDate, LastPasswordChangeDate, Profile.Name, Profile.UserLicense.Name FROM User WHERE Id = '${userId}'`
    ).then((r) => r.rows[0]),
    safe(query(client, `SELECT IsFrozen, IsPasswordLocked FROM UserLogin WHERE UserId = '${userId}'`)),
    safe(
      query(
        client,
        `SELECT Id, Label, IsOwnedByProfile, Profile.Name, PermissionsApiEnabled, PermissionsApiUserOnly, PermissionsPasswordNeverExpires FROM PermissionSet WHERE Id IN (${assigned})`
      )
    ),
    safe(
      query(
        client,
        `SELECT LoginTime, Status, SourceIp, Application, LoginType, ApiType FROM LoginHistory WHERE UserId = '${userId}' AND LoginTime = LAST_N_DAYS:${days} ORDER BY LoginTime DESC`,
        { maxRows: 500 }
      )
    ),
    options.appId
      ? safe(
          query(
            client,
            `SELECT Id, Name, OptionsAllowAdminApprovedUsersOnly, RefreshTokenValidityPeriod, OptionsRefreshTokenValidityMetric FROM ConnectedApplication WHERE Id = '${options.appId}'`
          )
        ).then((r) => r?.[0])
      : Promise.resolve(undefined),
    safe(
      query(client, `SELECT AppName, LastUsedDate, UseCount, CreatedDate FROM OauthToken WHERE UserId = '${userId}'`)
    ),
    safe(query(client, 'SELECT MasterLabel, DeveloperName, ExpirationDate FROM Certificate', { tooling: true })),
    safe(query(client, 'SELECT SiteName, EndpointUrl, IsActive FROM RemoteProxy', { tooling: true })),
    safe(query(client, 'SELECT MasterLabel, Endpoint FROM NamedCredential')),
  ]);
  if (!user) throw new Error('No such user.');

  // The user
  const name = String(user.Name);
  add(
    'User',
    'info',
    `${name} · ${String(user.Username)} · profile ${String(user['Profile.Name'] ?? '?')} · license ${String(
      user['Profile.UserLicense.Name'] ?? '?'
    )}`
  );
  if (user.IsActive !== true)
    add('User', 'bad', 'The user is inactive: it cannot log in.', 'Activate it in Setup › Users.');
  else add('User', 'ok', 'The user is active.');
  const state = login?.[0];
  if (state?.IsFrozen === true)
    add('User', 'bad', 'The user is frozen: every login fails.', 'Unfreeze it (Org › Licenses, or Setup › Users).');
  if (state?.IsPasswordLocked === true)
    add(
      'User',
      'bad',
      'The user is locked out after failed logins.',
      'Unlock it in Setup › Users, then fix the password the integration sends.'
    );

  // Its permissions
  if (perms) {
    const from = (r: Row): string =>
      r.IsOwnedByProfile ? `profile ${String(r['Profile.Name'] ?? '')}` : `permission set ${String(r.Label ?? '')}`;
    const api = perms.filter((r) => r.PermissionsApiEnabled === true).map(from);
    if (api.length)
      add(
        'Permissions',
        'ok',
        `API Enabled via ${api.slice(0, 3).join(', ')}${api.length > 3 ? ` and ${api.length - 3} more` : ''}.`
      );
    else
      add(
        'Permissions',
        'bad',
        'No API Enabled: the user cannot call the API.',
        'Give API Enabled in its profile or a permission set.'
      );
    if (perms.some((r) => r.PermissionsApiUserOnly === true))
      add(
        'Permissions',
        'info',
        'API Only User: it cannot log in to the Salesforce screens (as an integration user should).'
      );
    const neverExpires = perms.some((r) => r.PermissionsPasswordNeverExpires === true);
    const age = daysSince(user.LastPasswordChangeDate, now);
    if (!neverExpires && age !== undefined && age > 80)
      add(
        'Permissions',
        'warn',
        `The password was changed ${age} days ago and can expire (no “Password Never Expires”).`,
        'Give Password Never Expires to the integration user, or plan the password change with the calling system.'
      );
  }

  // Its logins
  if (!logins) add('Logins', 'info', 'Login history could not be read (it needs Manage Users).');
  else if (!logins.length)
    add(
      'Logins',
      'warn',
      `No logins in the last ${days} days.`,
      'If the integration should run, it never reaches Salesforce: check its URL (login or test.salesforce.com, My Domain) and its schedule.'
    );
  else {
    const ok = logins.find((l) => String(l.Status) === 'Success');
    if (ok)
      add(
        'Logins',
        'ok',
        `Last successful login ${when(ok.LoginTime)} from ${String(ok.SourceIp ?? '?')} (${String(
          ok.Application ?? ok.LoginType ?? ''
        )}).`
      );
    const failed = new Map<string, Row[]>();
    for (const l of logins.filter((x) => String(x.Status) !== 'Success'))
      failed.set(String(l.Status), [...(failed.get(String(l.Status)) ?? []), l]);
    for (const [status, list] of failed) {
      const last = list[0];
      add(
        'Logins',
        ok && Date.parse(String(ok.LoginTime)) > Date.parse(String(last.LoginTime)) ? 'warn' : 'bad',
        `${list.length} failed: “${status}” — last ${when(last.LoginTime)} from ${String(
          last.SourceIp ?? '?'
        )} (${String(last.Application ?? last.LoginType ?? '')}).`,
        loginHint(status)
      );
    }
  }

  // The connected app
  if (app) {
    const appName = String(app.Name);
    if (app.OptionsAllowAdminApprovedUsersOnly === true) {
      const given = await safe(
        query(
          client,
          `SELECT Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name FROM SetupEntityAccess WHERE SetupEntityId = '${String(
            app.Id
          )}' AND ParentId IN (${assigned})`
        )
      );
      if (given?.length)
        add(
          'Connected app',
          'ok',
          `${appName}: admin-approved users only, and ${name} is approved (via ${given
            .map((g) =>
              g['Parent.IsOwnedByProfile']
                ? `profile ${String(g['Parent.Profile.Name'])}`
                : `permission set ${String(g['Parent.Label'])}`
            )
            .join(', ')}).`
        );
      else
        add(
          'Connected app',
          'bad',
          `${appName}: only admin-approved users may use it, and ${name} is not one of them.`,
          'In the app (Setup › Connected Apps › Manage), add the user’s profile or a permission set it has.'
        );
    } else add('Connected app', 'info', `${appName}: all users may self-authorize.`);
    const mine = (tokens ?? []).filter((t) => String(t.AppName) === appName);
    if (mine.length)
      add(
        'Connected app',
        'ok',
        `${mine.length} token(s) of ${name} for ${appName}; last used ${
          when(
            mine
              .map((t) => String(t.LastUsedDate ?? ''))
              .sort()
              .pop()
          ) || 'never'
        }.`
      );
    else
      add(
        'Connected app',
        'info',
        `${name} has no OAuth token for ${appName} (normal for the JWT or client-credentials flow, which keep none).`
      );
    if (app.RefreshTokenValidityPeriod)
      add(
        'Connected app',
        'info',
        `Refresh tokens expire after ${String(app.RefreshTokenValidityPeriod)} ${String(
          app.OptionsRefreshTokenValidityMetric ?? ''
        ).toLowerCase()}.`
      );
  } else if (tokens?.length)
    add(
      'Connected app',
      'info',
      `${name} has OAuth tokens for ${[...new Set(tokens.map((t) => String(t.AppName)))].join(
        ', '
      )}. Choose the app to check it.`
    );

  // Certificates
  if (certs) {
    const expired = certs.filter((c) => c.ExpirationDate && Date.parse(String(c.ExpirationDate)) < now);
    const soon = certs.filter((c) => {
      const t = Date.parse(String(c.ExpirationDate ?? ''));
      return t >= now && t < now + 30 * DAY;
    });
    for (const c of expired)
      add(
        'Certificates',
        'bad',
        `${String(c.MasterLabel)} expired on ${when(c.ExpirationDate).slice(0, 10)}.`,
        'Renew it, and upload the new one wherever the old one is used (connected apps, the other system).'
      );
    for (const c of soon)
      add(
        'Certificates',
        'warn',
        `${String(c.MasterLabel)} expires on ${when(c.ExpirationDate).slice(0, 10)}.`,
        'Renew it before then.'
      );
    if (!certs.length) add('Certificates', 'info', 'No certificates in this org.');
    else if (!expired.length && !soon.length)
      add('Certificates', 'ok', `${certs.length} certificate(s), none expired or expiring within 30 days.`);
  }

  // Outbound endpoints
  for (const r of (remotes ?? []).filter((x) => x.IsActive === false))
    add(
      'Endpoints',
      'warn',
      `Remote site ${String(r.SiteName)} (${String(r.EndpointUrl)}) is inactive: calls to it fail.`,
      'Activate it in Setup › Remote Site Settings.'
    );
  if (remotes || named)
    add(
      'Endpoints',
      'info',
      `${(remotes ?? []).length} remote site(s), ${
        (named ?? []).length
      } named credential(s) for calls out of Salesforce.`
    );
  return out;
}
