import type { SalesforceClient } from './client.js';
import { query, type Row } from './query.js';

/** Everything one user has: permission sets and groups, licenses, groups and queues, OAuth apps, logins. */

const USER_ID = /^005[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/;
const checkUser = (userId: string): void => {
  if (!USER_ID.test(userId)) throw new Error('Invalid user Id.');
};

export type UserAccess = {
  permissionSets: Row[];
  permissionSetGroups: Row[];
  licenses: Row[];
  groups: Row[];
  oauthApps: Row[];
};

/** Public group, queue or personal group (a "Regular" group owned by a user). */
export function groupKind(type: unknown, ownerId: unknown): string {
  if (type === 'Queue') return 'Queue';
  if (type === 'Regular') return String(ownerId ?? '').startsWith('005') ? 'Personal group' : 'Public group';
  return String(type ?? '');
}

export async function userAccess(client: SalesforceClient, userId: string): Promise<UserAccess> {
  checkUser(userId);
  const [assignments, licenses, members, owned, tokens] = await Promise.all([
    query(
      client,
      `SELECT Id, PermissionSetId, PermissionSet.Label, PermissionSet.Name, PermissionSet.IsOwnedByProfile, PermissionSet.Type, PermissionSetGroupId, PermissionSetGroup.MasterLabel, PermissionSetGroup.DeveloperName, ExpirationDate FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`,
      { maxRows: 5000 }
    ),
    query(
      client,
      `SELECT Id, PermissionSetLicense.MasterLabel, PermissionSetLicense.DeveloperName, PermissionSetLicense.Status, PermissionSetLicense.ExpirationDate FROM PermissionSetLicenseAssign WHERE AssigneeId = '${userId}'`,
      { maxRows: 5000 }
    ),
    query(
      client,
      `SELECT Id, GroupId, Group.Name, Group.DeveloperName, Group.Type, Group.OwnerId FROM GroupMember WHERE UserOrGroupId = '${userId}'`,
      { maxRows: 5000 }
    ),
    query(
      client,
      `SELECT Id, Name, DeveloperName, Type, OwnerId FROM Group WHERE Type = 'Regular' AND OwnerId = '${userId}'`,
      {
        maxRows: 5000,
      }
    ),
    query(
      client,
      `SELECT Id, AppName, UseCount, LastUsedDate, CreatedDate FROM OauthToken WHERE UserId = '${userId}' ORDER BY LastUsedDate DESC NULLS LAST`,
      { maxRows: 5000 }
    ).catch(() => ({ rows: [] as Row[] })),
  ]);
  // query() flattens related fields: "PermissionSet.Label"
  const related =
    (prefix: string) =>
    (r: Row): Row =>
      Object.fromEntries(
        Object.entries(r)
          .filter(([k]) => k.startsWith(`${prefix}.`))
          .map(([k, v]) => [k.slice(prefix.length + 1), v])
      );
  const ps = related('PermissionSet');
  const psg = related('PermissionSetGroup');
  const lic = related('PermissionSetLicense');
  const grp = related('Group');

  const groups = new Map<string, Row>();
  for (const m of members.rows) {
    const g = grp(m);
    groups.set(String(m.GroupId), {
      Id: m.GroupId,
      Name: g.Name,
      DeveloperName: g.DeveloperName,
      Kind: groupKind(g.Type, g.OwnerId),
      Member: '✓',
    });
  }
  for (const g of owned.rows) {
    const known = groups.get(String(g.Id));
    if (known) known.Owner = '✓';
    else
      groups.set(String(g.Id), {
        Id: g.Id,
        Name: g.Name,
        DeveloperName: g.DeveloperName,
        Kind: 'Personal group',
        Owner: '✓',
      });
  }

  return {
    permissionSets: assignments.rows
      .filter((r) => !r.PermissionSetGroupId && ps(r).IsOwnedByProfile !== true && ps(r).Type !== 'Group')
      .map((r) => ({
        Id: r.PermissionSetId,
        Label: ps(r).Label,
        Name: ps(r).Name,
        ExpirationDate: r.ExpirationDate ?? '',
      }))
      .sort((a, b) => String(a.Label).localeCompare(String(b.Label))),
    permissionSetGroups: assignments.rows
      .filter((r) => r.PermissionSetGroupId)
      .map((r) => ({
        Id: r.PermissionSetGroupId,
        Label: psg(r).MasterLabel,
        Name: psg(r).DeveloperName,
        ExpirationDate: r.ExpirationDate ?? '',
      }))
      .sort((a, b) => String(a.Label).localeCompare(String(b.Label))),
    licenses: licenses.rows
      .map((r) => ({
        Label: lic(r).MasterLabel,
        Name: lic(r).DeveloperName,
        Status: lic(r).Status ?? '',
        ExpirationDate: lic(r).ExpirationDate ?? '',
      }))
      .sort((a, b) => String(a.Label).localeCompare(String(b.Label))),
    groups: [...groups.values()].sort(
      (a, b) => String(a.Kind).localeCompare(String(b.Kind)) || String(a.Name).localeCompare(String(b.Name))
    ),
    oauthApps: tokens.rows.map((t) => ({
      App: t.AppName,
      Uses: t.UseCount ?? 0,
      LastUsed: t.LastUsedDate ?? '',
      Connected: t.CreatedDate ?? '',
    })),
  };
}

export async function userLogins(client: SalesforceClient, userId: string, limit = 200): Promise<Row[]> {
  checkUser(userId);
  const result = await query(
    client,
    `SELECT LoginTime, LoginType, Status, SourceIp, CountryIso, Application, Browser, Platform, LoginUrl FROM LoginHistory WHERE UserId = '${userId}' ORDER BY LoginTime DESC LIMIT ${Math.max(
      1,
      Math.min(2000, Math.floor(limit))
    )}`
  );
  return result.rows;
}

export type EffectivePermission = { api: string; label: string; grantedBy: string[] };

/**
 * The user & system permissions a user has: every Permissions* checkbox that is on in their
 * profile, permission sets or permission set groups, with what grants it.
 */
export async function effectivePermissions(client: SalesforceClient, userId: string): Promise<EffectivePermission[]> {
  checkUser(userId);
  const assignments = await query(
    client,
    `SELECT PermissionSetId, PermissionSetGroup.MasterLabel FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`,
    { maxRows: 5000 }
  );
  const groupOf = new Map<string, string>();
  for (const a of assignments.rows) {
    const group = a['PermissionSetGroup.MasterLabel'];
    if (group) groupOf.set(String(a.PermissionSetId), String(group));
  }
  const ids = [...new Set(assignments.rows.map((a) => String(a.PermissionSetId)))].filter((id) =>
    /^0PS\w{12}(\w{3})?$/.test(id)
  );
  if (!ids.length) return [];
  const describe = await client.rest<{ fields: Array<{ name: string; label: string; type: string }> }>(
    'GET',
    '/sobjects/PermissionSet/describe'
  );
  const fields = describe.fields.filter((f) => f.type === 'boolean' && f.name.startsWith('Permissions'));
  const granted = new Map<string, EffectivePermission>();
  for (let i = 0; i < fields.length; i += 150) {
    const chunk = fields.slice(i, i + 150);
    // eslint-disable-next-line no-await-in-loop
    const rows = await query(
      client,
      `SELECT Id, Label, IsOwnedByProfile, Profile.Name, ${chunk
        .map((f) => f.name)
        .join(', ')} FROM PermissionSet WHERE Id IN (${ids.map((id) => `'${id}'`).join(',')})`
    );
    for (const row of rows.rows) {
      const source = row.IsOwnedByProfile
        ? `Profile: ${row['Profile.Name'] ?? row.Label}`
        : groupOf.has(String(row.Id))
        ? `Group: ${groupOf.get(String(row.Id))}`
        : String(row.Label);
      for (const f of chunk) {
        if (row[f.name] !== true) continue;
        const api = f.name.replace(/^Permissions/, '');
        const entry = granted.get(api) ?? { api, label: f.label, grantedBy: [] };
        entry.grantedBy.push(source);
        granted.set(api, entry);
      }
    }
  }
  return [...granted.values()].sort((a, b) => a.label.localeCompare(b.label));
}

// ---------- connected apps and OAuth usage ----------

export type OAuthApp = {
  name: string;
  kind: string;
  users: number;
  tokens: number;
  uses: number;
  lastUsed: string;
  created: string;
};

export type ConnectedAppsReport = { apps: OAuthApp[]; tokens: Row[]; notes: string[] };

/** Connected apps, external client apps and every OAuth token (which user uses which app, how much). */
export async function connectedAppsReport(client: SalesforceClient): Promise<ConnectedAppsReport> {
  const notes: string[] = [];
  const optional = (soql: string, what: string) =>
    query(client, soql, { maxRows: 50_000 }).catch((e: Error) => {
      notes.push(`${what}: ${e.message}`);
      return { rows: [] as Row[] };
    });
  const [connected, external, tokens] = await Promise.all([
    optional('SELECT Id, Name, CreatedDate FROM ConnectedApplication ORDER BY Name', 'Connected apps'),
    optional(
      'SELECT Id, MasterLabel, DeveloperName, CreatedDate FROM ExternalClientApplication ORDER BY MasterLabel',
      'External client apps'
    ),
    optional(
      'SELECT Id, AppName, UserId, User.Name, User.Username, User.IsActive, UseCount, LastUsedDate, CreatedDate FROM OauthToken ORDER BY AppName, LastUsedDate DESC NULLS LAST',
      'OAuth tokens'
    ),
  ]);
  const apps = new Map<string, OAuthApp>();
  const app = (name: string, kind: string, created = ''): OAuthApp => {
    const key = name.toLowerCase();
    const known = apps.get(key);
    if (known) {
      if (known.kind === 'OAuth only') known.kind = kind;
      return known;
    }
    const next: OAuthApp = { name, kind, users: 0, tokens: 0, uses: 0, lastUsed: '', created };
    apps.set(key, next);
    return next;
  };
  for (const c of connected.rows) app(String(c.Name), 'Connected app', String(c.CreatedDate ?? ''));
  for (const x of external.rows) app(String(x.MasterLabel), 'External client app', String(x.CreatedDate ?? ''));
  const usersOf = new Map<string, Set<string>>();
  const flat: Row[] = [];
  for (const t of tokens.rows) {
    const name = String(t.AppName ?? '');
    const a = app(name, 'OAuth only');
    a.tokens++;
    a.uses += Number(t.UseCount ?? 0);
    if (String(t.LastUsedDate ?? '') > a.lastUsed) a.lastUsed = String(t.LastUsedDate);
    const users = usersOf.get(name.toLowerCase()) ?? new Set<string>();
    users.add(String(t.UserId));
    usersOf.set(name.toLowerCase(), users);
    flat.push({
      Id: t.Id,
      App: name,
      User: t['User.Name'] ?? '',
      Username: t['User.Username'] ?? '',
      UserId: t.UserId,
      Active: t['User.IsActive'] === false ? 'no' : 'yes',
      Uses: t.UseCount ?? 0,
      LastUsed: t.LastUsedDate ?? '',
      Connected: t.CreatedDate ?? '',
    });
  }
  for (const [key, set] of usersOf) {
    const a = apps.get(key);
    if (a) a.users = set.size;
  }
  return {
    apps: [...apps.values()].sort((a, b) => b.users - a.users || a.name.localeCompare(b.name)),
    tokens: flat,
    notes,
  };
}
