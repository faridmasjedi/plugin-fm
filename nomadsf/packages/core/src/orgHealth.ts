import type { SalesforceClient } from './client.js';
import { query, type Row } from './query.js';
import { effectivePermissions, userAccess } from './userAccess.js';
import { objectAccessOf, systemPermissionsOf } from './fieldUsage.js';

/** Who has a permission set, group, license, profile, role or group; comparisons; security and license reports. */

const ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const checkId = (id: string): void => {
  if (!ID.test(id)) throw new Error('Invalid Id.');
};

// ---------- who has it ----------

export type HolderKind = 'permset' | 'group' | 'license' | 'profile' | 'role' | 'publicGroup' | 'queue';
export type Holder = { kind: HolderKind; id: string; label: string; detail?: string };

export const HOLDER_KINDS: Array<[HolderKind, string]> = [
  ['permset', 'Permission set'],
  ['group', 'Permission set group'],
  ['license', 'Permission set license'],
  ['profile', 'Profile'],
  ['role', 'Role'],
  ['publicGroup', 'Public group'],
  ['queue', 'Queue'],
];

/** Everything of one kind that users can have. */
export async function holdersOf(client: SalesforceClient, kind: HolderKind): Promise<Holder[]> {
  const list = async (soql: string, map: (r: Row) => Holder): Promise<Holder[]> =>
    (await query(client, soql, { maxRows: 10_000 })).rows.map(map);
  switch (kind) {
    case 'permset':
      return list(
        "SELECT Id, Label, Name FROM PermissionSet WHERE IsOwnedByProfile = false AND Type != 'Group' ORDER BY Label",
        (r) => ({ kind, id: String(r.Id), label: String(r.Label), detail: String(r.Name) })
      );
    case 'group':
      return list('SELECT Id, MasterLabel, DeveloperName FROM PermissionSetGroup ORDER BY MasterLabel', (r) => ({
        kind,
        id: String(r.Id),
        label: String(r.MasterLabel),
        detail: String(r.DeveloperName),
      }));
    case 'license':
      return list('SELECT Id, MasterLabel, DeveloperName FROM PermissionSetLicense ORDER BY MasterLabel', (r) => ({
        kind,
        id: String(r.Id),
        label: String(r.MasterLabel),
        detail: String(r.DeveloperName),
      }));
    case 'profile':
      return list('SELECT Id, Name, UserLicense.Name FROM Profile ORDER BY Name', (r) => ({
        kind,
        id: String(r.Id),
        label: String(r.Name),
        detail: String(r['UserLicense.Name'] ?? ''),
      }));
    case 'role':
      return list('SELECT Id, Name, DeveloperName FROM UserRole ORDER BY Name', (r) => ({
        kind,
        id: String(r.Id),
        label: String(r.Name),
        detail: String(r.DeveloperName ?? ''),
      }));
    case 'publicGroup':
    case 'queue':
      return list(
        `SELECT Id, Name, DeveloperName, OwnerId FROM Group WHERE Type = '${
          kind === 'queue' ? 'Queue' : 'Regular'
        }' ORDER BY Name`,
        (r) => ({
          kind,
          id: String(r.Id),
          label: String(r.Name),
          detail:
            kind === 'publicGroup' && String(r.OwnerId).startsWith('005')
              ? 'personal group'
              : String(r.DeveloperName ?? ''),
        })
      );
  }
}

const USER_FIELDS = 'Id, Name, Username, Email, IsActive, Profile.Name, UserRole.Name, LastLoginDate';
const userColumns = (prefix = ''): string =>
  USER_FIELDS.split(', ')
    .map((f) => `${prefix}${f}`)
    .join(', ');
const unprefix = (row: Row, prefix: string): Row =>
  Object.fromEntries(Object.entries(row).map(([k, v]) => [k.startsWith(prefix) ? k.slice(prefix.length) : k, v]));

/** The users who have it (direct assignments and memberships). */
export async function usersWith(client: SalesforceClient, holder: Pick<Holder, 'kind' | 'id'>): Promise<Row[]> {
  checkId(holder.id);
  const rows = async (soql: string, prefix: string, extra: (r: Row) => Row = () => ({})): Promise<Row[]> =>
    (await query(client, soql, { maxRows: 50_000 })).rows.map((r) => ({ ...unprefix(r, prefix), ...extra(r) }));
  switch (holder.kind) {
    case 'permset':
    case 'group':
      return rows(
        `SELECT ${userColumns('Assignee.')}, ExpirationDate FROM PermissionSetAssignment WHERE ${
          holder.kind === 'group' ? 'PermissionSetGroupId' : 'PermissionSetId'
        } = '${holder.id}' ORDER BY Assignee.Name`,
        'Assignee.',
        (r) => ({ ExpirationDate: r.ExpirationDate ?? '' })
      );
    case 'license':
      return rows(
        `SELECT ${userColumns('Assignee.')} FROM PermissionSetLicenseAssign WHERE PermissionSetLicenseId = '${
          holder.id
        }' ORDER BY Assignee.Name`,
        'Assignee.'
      );
    case 'profile':
      return rows(`SELECT ${USER_FIELDS} FROM User WHERE ProfileId = '${holder.id}' ORDER BY Name`, '');
    case 'role':
      return rows(`SELECT ${USER_FIELDS} FROM User WHERE UserRoleId = '${holder.id}' ORDER BY Name`, '');
    case 'publicGroup':
    case 'queue': {
      const members = await query(client, `SELECT UserOrGroupId FROM GroupMember WHERE GroupId = '${holder.id}'`, {
        maxRows: 50_000,
      });
      const ids = members.rows.map((m) => String(m.UserOrGroupId)).filter((id) => id.startsWith('005'));
      const out: Row[] = [];
      for (let i = 0; i < ids.length; i += 200) {
        // eslint-disable-next-line no-await-in-loop
        const page = await query(
          client,
          `SELECT ${USER_FIELDS} FROM User WHERE Id IN (${ids
            .slice(i, i + 200)
            .map((id) => `'${id}'`)
            .join(',')}) ORDER BY Name`
        );
        out.push(...page.rows);
      }
      const nested = members.rows.length - ids.length;
      return nested
        ? [...out, { Name: `+ ${nested} group(s) or role(s) as members`, Username: '', IsActive: '' }]
        : out;
    }
  }
}

// ---------- comparisons ----------

export type Difference = { area: string; item: string; a: string; b: string };

const diffSets = (area: string, a: string[], b: string[]): Difference[] => {
  const sa = new Set(a);
  const sb = new Set(b);
  return [...new Set([...a, ...b])]
    .sort((x, y) => x.localeCompare(y))
    .filter((x) => sa.has(x) !== sb.has(x))
    .map((item) => ({ area, item, a: sa.has(item) ? '✓' : '', b: sb.has(item) ? '✓' : '' }));
};

/** What one user has that the other does not: permission sets, groups, licenses, groups & queues, permissions. */
export async function compareUsers(client: SalesforceClient, a: string, b: string): Promise<Difference[]> {
  const [ua, ub, pa, pb] = await Promise.all([
    userAccess(client, a),
    userAccess(client, b),
    effectivePermissions(client, a),
    effectivePermissions(client, b),
  ]);
  const label = (rows: Row[]): string[] => rows.map((r) => String(r.Label ?? r.Name));
  return [
    ...diffSets('Permission set group', label(ua.permissionSetGroups), label(ub.permissionSetGroups)),
    ...diffSets('Permission set', label(ua.permissionSets), label(ub.permissionSets)),
    ...diffSets('License', label(ua.licenses), label(ub.licenses)),
    ...diffSets(
      'Group / queue',
      ua.groups.map((g) => `${g.Kind}: ${g.Name}`),
      ub.groups.map((g) => `${g.Kind}: ${g.Name}`)
    ),
    ...diffSets(
      'System permission',
      pa.map((p) => p.label),
      pb.map((p) => p.label)
    ),
  ];
}

/** What one profile / permission set / group allows that the other does not: system permissions and object access. */
export async function comparePermissionSets(client: SalesforceClient, a: string, b: string): Promise<Difference[]> {
  const [sa, sb, oa, ob] = await Promise.all([
    systemPermissionsOf(client, a),
    systemPermissionsOf(client, b),
    objectAccessOf(client, a),
    objectAccessOf(client, b),
  ]);
  const on = (list: typeof sa): string[] => list.filter((p) => p.enabled).map((p) => p.label);
  const access = (o: (typeof oa)[number]): string =>
    [
      o.read && 'Read',
      o.create && 'Create',
      o.edit && 'Edit',
      o.delete && 'Delete',
      o.viewAll && 'View all',
      o.modifyAll && 'Modify all',
    ]
      .filter(Boolean)
      .join(', ');
  const objects = [...new Set([...oa, ...ob].map((o) => o.object))].sort();
  const objectDiffs: Difference[] = [];
  for (const object of objects) {
    const x = oa.find((o) => o.object === object);
    const y = ob.find((o) => o.object === object);
    const ax = x ? access(x) : '';
    const by = y ? access(y) : '';
    if (ax !== by) objectDiffs.push({ area: 'Object access', item: object, a: ax || '—', b: by || '—' });
  }
  return [...diffSets('System permission', on(sa), on(sb)), ...objectDiffs];
}

// ---------- security ----------

export const RISKY_PERMISSIONS: Array<[string, string]> = [
  ['ModifyAllData', 'Modify All Data'],
  ['ViewAllData', 'View All Data'],
  ['ManageUsers', 'Manage Users'],
  ['AuthorApex', 'Author Apex'],
  ['CustomizeApplication', 'Customize Application'],
  ['ApiEnabled', 'API Enabled'],
];

export type SecurityReport = {
  score?: number;
  risks: Row[];
  powerUsers: Row[];
  dormant: Row[];
  unusedPermissionSets: Row[];
  staleTokens: Row[];
  inactiveWithLicenses: Row[];
  notes: string[];
};

/** Risky access in one report: Health Check, who has powerful permissions, dormant users, unused grants. */
export async function securityReport(client: SalesforceClient, dormantDays = 90): Promise<SecurityReport> {
  const days = Math.max(1, Math.min(365, Math.floor(dormantDays)));
  const notes: string[] = [];
  const optional = async (what: string, soql: string, tooling = false): Promise<Row[]> => {
    try {
      return (await query(client, soql, { maxRows: 50_000, tooling })).rows;
    } catch (e) {
      notes.push(`${what}: ${(e as Error).message}`);
      return [];
    }
  };
  const [score, risks, dormant, unused, tokens, licensed, ...power] = await Promise.all([
    optional('Health Check score', 'SELECT Score FROM SecurityHealthCheck', true),
    optional(
      'Health Check risks',
      "SELECT RiskType, Setting, SettingGroup, OrgValue, StandardValue FROM SecurityHealthCheckRisks WHERE RiskType IN ('HIGH_RISK', 'MEDIUM_RISK') ORDER BY RiskType",
      true
    ),
    optional(
      'Dormant users',
      `SELECT Id, Name, Username, Profile.Name, LastLoginDate, CreatedDate FROM User WHERE IsActive = true AND UserType = 'Standard' AND (LastLoginDate < LAST_N_DAYS:${days} OR LastLoginDate = null) ORDER BY LastLoginDate NULLS FIRST`
    ),
    optional(
      'Permission sets',
      "SELECT Id, Label, Name, CreatedDate, LastModifiedDate FROM PermissionSet WHERE IsOwnedByProfile = false AND Type = 'Regular' AND NamespacePrefix = null AND Id NOT IN (SELECT PermissionSetId FROM PermissionSetAssignment) ORDER BY Label"
    ),
    optional(
      'OAuth tokens',
      `SELECT Id, AppName, User.Name, User.Username, UseCount, LastUsedDate FROM OauthToken WHERE LastUsedDate < LAST_N_DAYS:${days} OR LastUsedDate = null ORDER BY LastUsedDate NULLS FIRST`
    ),
    optional(
      'Licenses of inactive users',
      'SELECT Id, Assignee.Name, Assignee.Username, PermissionSetLicense.MasterLabel FROM PermissionSetLicenseAssign WHERE Assignee.IsActive = false ORDER BY Assignee.Name'
    ),
    ...RISKY_PERMISSIONS.map(([api, label]) =>
      optional(
        label,
        `SELECT Assignee.Id, Assignee.Name, Assignee.Username, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.Profile.Name, PermissionSetGroup.MasterLabel FROM PermissionSetAssignment WHERE PermissionSet.Permissions${api} = true AND Assignee.IsActive = true ORDER BY Assignee.Name`
      )
    ),
  ]);
  const users = new Map<string, Row>();
  power.forEach((rows, i) => {
    const label = RISKY_PERMISSIONS[i][1];
    for (const r of rows) {
      const key = String(r['Assignee.Id']);
      const from = r['PermissionSet.IsOwnedByProfile']
        ? `Profile: ${r['PermissionSet.Profile.Name']}`
        : r['PermissionSetGroup.MasterLabel']
        ? `Group: ${r['PermissionSetGroup.MasterLabel']}`
        : String(r['PermissionSet.Label']);
      const u = users.get(key) ?? {
        Name: r['Assignee.Name'],
        Username: r['Assignee.Username'],
        permissions: new Set<string>(),
        from: new Set<string>(),
      };
      (u.permissions as Set<string>).add(label);
      (u.from as Set<string>).add(from);
      users.set(key, u);
    }
  });
  return {
    score: score[0] ? Number(score[0].Score) : undefined,
    risks,
    powerUsers: [...users.values()]
      .map((u) => ({
        Name: u.Name,
        Username: u.Username,
        Permissions: [...(u.permissions as Set<string>)].join(', '),
        Count: (u.permissions as Set<string>).size,
        GrantedBy: [...(u.from as Set<string>)].join(' · '),
      }))
      .sort((a, b) => b.Count - a.Count || String(a.Name).localeCompare(String(b.Name))),
    dormant,
    unusedPermissionSets: unused,
    staleTokens: tokens,
    inactiveWithLicenses: licensed,
    notes,
  };
}

// ---------- licenses ----------

export type LicenseRow = {
  kind: 'User license' | 'Permission set license';
  id: string;
  name: string;
  status: string;
  used: number;
  total: number;
  percent: number;
  expires: string;
};

export async function licenseReport(client: SalesforceClient): Promise<LicenseRow[]> {
  const [users, sets] = await Promise.all([
    query(
      client,
      'SELECT Id, Name, Status, TotalLicenses, UsedLicenses FROM UserLicense WHERE TotalLicenses > 0 ORDER BY Name',
      {
        maxRows: 1000,
      }
    ),
    query(
      client,
      'SELECT Id, MasterLabel, Status, TotalLicenses, UsedLicenses, ExpirationDate FROM PermissionSetLicense WHERE TotalLicenses > 0 ORDER BY MasterLabel',
      { maxRows: 1000 }
    ),
  ]);
  const row = (kind: LicenseRow['kind'], r: Row, name: unknown): LicenseRow => {
    const used = Number(r.UsedLicenses ?? 0);
    const total = Number(r.TotalLicenses ?? 0);
    return {
      kind,
      id: String(r.Id),
      name: String(name),
      status: String(r.Status ?? ''),
      used,
      total,
      percent: total ? Math.round((used / total) * 1000) / 10 : 0,
      expires: String(r.ExpirationDate ?? ''),
    };
  };
  return [
    ...users.rows.map((r) => row('User license', r, r.Name)),
    ...sets.rows.map((r) => row('Permission set license', r, r.MasterLabel)),
  ];
}

/** The users of a user license (through their profile) or of a permission set license. */
export async function licenseUsers(client: SalesforceClient, license: Pick<LicenseRow, 'kind' | 'id'>): Promise<Row[]> {
  checkId(license.id);
  if (license.kind === 'Permission set license') return usersWith(client, { kind: 'license', id: license.id });
  return (
    await query(
      client,
      `SELECT ${USER_FIELDS} FROM User WHERE IsActive = true AND Profile.UserLicenseId = '${license.id}' ORDER BY Name`,
      { maxRows: 50_000 }
    )
  ).rows;
}
