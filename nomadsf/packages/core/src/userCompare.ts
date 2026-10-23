import type { SalesforceClient } from './client.js';
import type { Difference } from './orgHealth.js';
import { query, type Row } from './query.js';
import { effectivePermissions, userAccess } from './userAccess.js';

/** Two users side by side (the same org or two orgs): details, everything assigned, permissions, last logins. */

const USER_ID = /^005\w{12}(\w{3})?$/;

export type UserDetail = { field: string; a: string; b: string; same: boolean };

/** One thing a user has; idA / idB are the permission sets to compare when both have one (profile, set, group). */
export type UserItem = {
  area: 'Profile' | 'Permission set' | 'Permission set group' | 'License' | 'Group / queue' | 'OAuth app';
  item: string;
  /** "not read in B": A has it, B's could not be read (unknown, not "only in A"). */
  in: 'both' | 'only in A' | 'only in B' | 'not read in A' | 'not read in B';
  a: string;
  b: string;
  idA?: string;
  idB?: string;
};

export type UserComparison = {
  details: UserDetail[];
  items: UserItem[];
  /** User and system permissions from every source (profile, sets, groups) that one has and the other not. */
  permissions: Difference[];
  loginsA: Row[];
  loginsB: Row[];
  /** What could not be read on each side (with the reason). */
  notesA: string[];
  notesB: string[];
};

const DETAILS: Array<[string, string]> = [
  ['Name', 'Name'],
  ['Username', 'Username'],
  ['Email', 'Email'],
  ['Active', 'IsActive'],
  ['Profile', 'Profile.Name'],
  ['Role', 'UserRole.Name'],
  ['User license', 'Profile.UserLicense.Name'],
  ['Title', 'Title'],
  ['Department', 'Department'],
  ['Time zone', 'TimeZoneSidKey'],
  ['Language', 'LanguageLocaleKey'],
  ['Last login', 'LastLoginDate'],
  ['Created', 'CreatedDate'],
];

type Side = {
  user: Row;
  /** null: could not be read (see notes). */
  access: Awaited<ReturnType<typeof userAccess>> | null;
  permissions: Awaited<ReturnType<typeof effectivePermissions>> | null;
  logins: Row[];
  profileSetId: string;
  groupSetIds: Map<string, string>;
  notes: string[];
};

/** One user, part by part: a part that cannot be read (missing permission…) becomes a note, the rest still shows. */
async function side(client: SalesforceClient, userId: string): Promise<Side> {
  if (!USER_ID.test(userId)) throw new Error('Invalid user Id.');
  const notes: string[] = [];
  const part = <T>(what: string, read: Promise<T>, fallback: T): Promise<T> =>
    read.catch((e: Error) => {
      notes.push(`${what}: ${e.message}`);
      return fallback;
    });
  const [user, access, permissions, logins] = await Promise.all([
    part(
      'Details',
      query(client, `SELECT ${DETAILS.map(([, f]) => f).join(', ')}, ProfileId FROM User WHERE Id = '${userId}'`).then(
        (r) => r.rows[0] ?? {}
      ),
      {} as Row
    ),
    part('Permission sets, groups, licenses, groups & queues, OAuth apps', userAccess(client, userId), null),
    part('User & system permissions', effectivePermissions(client, userId), null),
    part(
      'Login history',
      query(
        client,
        `SELECT LoginTime, Status, SourceIp, Application, Browser, Platform, LoginType FROM LoginHistory WHERE UserId = '${userId}' ORDER BY LoginTime DESC LIMIT 10`
      ).then((r) => r.rows),
      [] as Row[]
    ),
  ]);
  // The permission sets behind the profile and the groups (what their access comparison reads)
  const groupIds = (access?.permissionSetGroups ?? []).map((g) => String(g.Id)).filter((id) => /^0PG\w+$/.test(id));
  const [profileSet, groupSets] = await Promise.all([
    user.ProfileId
      ? part<{ rows: Row[] }>(
          'Profile',
          query(client, `SELECT Id FROM PermissionSet WHERE ProfileId = '${String(user.ProfileId)}' LIMIT 1`),
          { rows: [] as Row[] }
        )
      : Promise.resolve({ rows: [] as Row[] }),
    groupIds.length
      ? part<{ rows: Row[] }>(
          'Permission set groups',
          query(
            client,
            `SELECT Id, PermissionSetGroupId FROM PermissionSet WHERE PermissionSetGroupId IN (${groupIds
              .map((id) => `'${id}'`)
              .join(', ')})`
          ),
          { rows: [] as Row[] }
        )
      : Promise.resolve({ rows: [] as Row[] }),
  ]);
  return {
    user,
    access,
    permissions,
    logins,
    profileSetId: String(profileSet.rows[0]?.Id ?? ''),
    groupSetIds: new Map(groupSets.rows.map((r) => [String(r.PermissionSetGroupId), String(r.Id)])),
    notes,
  };
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** Pairs two lists by a key: in both, only in A, only in B. */
function pairUp(
  area: UserItem['area'],
  a: Row[] | null,
  b: Row[] | null,
  key: (r: Row) => string,
  label: (r: Row) => string,
  detail: (r: Row) => string,
  id: (r: Row, s: 'a' | 'b') => string | undefined = () => undefined
): UserItem[] {
  // One side unknown: list the other side's, marked as not compared
  if (!a || !b) {
    const known = a ?? b ?? [];
    return known.map((r) => ({
      area,
      item: label(r),
      in: a ? 'not read in B' : 'not read in A',
      a: a ? detail(r) || '✓' : '?',
      b: b ? detail(r) || '✓' : '?',
      idA: a ? id(r, 'a') : undefined,
      idB: b ? id(r, 'b') : undefined,
    }));
  }
  const mapB = new Map(b.map((r) => [key(r).toLowerCase(), r]));
  const out: UserItem[] = [];
  for (const x of a) {
    const y = mapB.get(key(x).toLowerCase());
    if (y) mapB.delete(key(x).toLowerCase());
    out.push({
      area,
      item: label(x),
      in: y ? 'both' : 'only in A',
      a: detail(x) || '✓',
      b: y ? detail(y) || '✓' : '',
      idA: id(x, 'a'),
      idB: y ? id(y, 'b') : undefined,
    });
  }
  for (const y of mapB.values())
    out.push({ area, item: label(y), in: 'only in B', a: '', b: detail(y) || '✓', idB: id(y, 'b') });
  return out;
}

/** Compares two users — in one org (clientB = client) or in two orgs. */
export async function compareUsersFully(
  client: SalesforceClient,
  userA: string,
  userB: string,
  clientB: SalesforceClient = client
): Promise<UserComparison> {
  const [a, b] = await Promise.all([side(client, userA), side(clientB, userB)]);
  const unreadA = !Object.keys(a.user).length;
  const unreadB = !Object.keys(b.user).length;
  const details = DETAILS.map(([field, f]) => {
    const [x, y] = [unreadA ? '?' : text(a.user[f]), unreadB ? '?' : text(b.user[f])];
    return { field, a: x, b: y, same: unreadA || unreadB || x === y };
  });
  const profileA = text(a.user['Profile.Name']);
  const profileB = text(b.user['Profile.Name']);
  const items: UserItem[] = [
    // The profiles are always compared with each other, also when their names differ
    {
      area: 'Profile',
      item: profileA === profileB ? profileA : `${profileA} ↔ ${profileB}`,
      in: 'both',
      a: profileA,
      b: profileB,
      idA: a.profileSetId || undefined,
      idB: b.profileSetId || undefined,
    },
    ...pairUp(
      'Permission set',
      a.access?.permissionSets ?? null,
      b.access?.permissionSets ?? null,
      (r) => text(r.Name),
      (r) => text(r.Label),
      (r) => (r.ExpirationDate ? `until ${text(r.ExpirationDate)}` : ''),
      (r) => text(r.Id)
    ),
    ...pairUp(
      'Permission set group',
      a.access?.permissionSetGroups ?? null,
      b.access?.permissionSetGroups ?? null,
      (r) => text(r.Name),
      (r) => text(r.Label),
      (r) => (r.ExpirationDate ? `until ${text(r.ExpirationDate)}` : ''),
      (r, s) => (s === 'a' ? a : b).groupSetIds.get(text(r.Id))
    ),
    ...pairUp(
      'License',
      a.access?.licenses ?? null,
      b.access?.licenses ?? null,
      (r) => text(r.Name),
      (r) => text(r.Label),
      (r) => [text(r.Status), r.ExpirationDate ? `until ${text(r.ExpirationDate)}` : ''].filter(Boolean).join(', ')
    ),
    ...pairUp(
      'Group / queue',
      a.access?.groups ?? null,
      b.access?.groups ?? null,
      (r) => `${text(r.Kind)}:${text(r.DeveloperName || r.Name)}`,
      (r) => `${text(r.Kind)}: ${text(r.Name)}`,
      (r) => [r.Member && 'member', r.Owner && 'owner'].filter(Boolean).join(', ')
    ),
    ...pairUp(
      'OAuth app',
      a.access?.oauthApps ?? null,
      b.access?.oauthApps ?? null,
      (r) => text(r.App),
      (r) => text(r.App),
      (r) => `${text(r.Uses)} uses${r.LastUsed ? `, last ${text(r.LastUsed).slice(0, 10)}` : ''}`
    ),
  ];
  // Compared only when both sides could be read
  const onA = new Set((a.permissions ?? []).map((p) => p.label));
  const onB = new Set((b.permissions ?? []).map((p) => p.label));
  const permissions =
    a.permissions && b.permissions
      ? [...new Set([...onA, ...onB])]
          .sort((x, y) => x.localeCompare(y))
          .filter((p) => onA.has(p) !== onB.has(p))
          .map((p) => ({ area: 'System permission', item: p, a: onA.has(p) ? '✓' : '', b: onB.has(p) ? '✓' : '' }))
      : [];
  return { details, items, permissions, loginsA: a.logins, loginsB: b.logins, notesA: a.notes, notesB: b.notes };
}
