import type { SalesforceClient } from './client.js';
import { searchUsers, type UserMatch } from './access.js';
import { permissionSetKey } from './fieldUsage.js';
import { usersWith, type Difference, type Holder } from './orgHealth.js';
import { query, type Row } from './query.js';
import { connectedAppsReport } from './userAccess.js';

/** Access compared between two orgs: the same user, who has it, every permission set, connected apps. */

// ---------- the same user in two orgs ----------

/** ann@acme.com.uat → ann@acme.com: the username without a sandbox suffix (only when the domain keeps a dot). */
const withoutSuffix = (username: string): string => {
  const cut = username.slice(0, username.lastIndexOf('.'));
  return cut.split('@')[1]?.includes('.') ? cut : username;
};

/**
 * The same person in two orgs: equal usernames, or equal once a sandbox suffix is taken off one or both
 * (ann@acme.com ↔ ann@acme.com.uat ↔ ann@acme.com.dev).
 */
export function sameUsername(a: string, b: string): boolean {
  const [x, y] = [a.toLowerCase(), b.toLowerCase()];
  if (!x.includes('@') || !y.includes('@')) return false;
  const [bx, by] = [withoutSuffix(x), withoutSuffix(y)];
  return x === y || bx === y || x === by || bx === by;
}

const soqlText = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** The user in this org with the same username as one from another org (without or with a sandbox suffix). */
export async function findSameUser(client: SalesforceClient, username: string): Promise<UserMatch | null> {
  const name = username.trim();
  if (!name.includes('@')) return null;
  const base = withoutSuffix(name);
  const exact = [...new Set([name, base])];
  const result = await query(
    client,
    `SELECT Id, Name, Username, Email, Profile.Name, IsActive, LastLoginDate FROM User WHERE Username IN (${exact
      .map((u) => `'${soqlText(u)}'`)
      .join(', ')}) OR Username LIKE '${soqlText(base)}.%' ORDER BY IsActive DESC, Username LIMIT 20`
  );
  const found = result.rows.filter((r) => sameUsername(String(r.Username ?? ''), name));
  // The exact username first, then without a suffix, then with another sandbox's
  const rank = (r: Row): number => [name, base].map((u) => u.toLowerCase()).indexOf(String(r.Username).toLowerCase());
  const best = [...found].sort((x, y) => ((rank(x) + 3) % 3) - ((rank(y) + 3) % 3))[0];
  return best
    ? {
        Id: String(best.Id),
        Name: String(best.Name ?? ''),
        Username: String(best.Username ?? ''),
        Email: String(best.Email ?? ''),
        Profile: String(best['Profile.Name'] ?? ''),
        IsActive: best.IsActive === true,
        LastLoginDate: best.LastLoginDate ? String(best.LastLoginDate) : undefined,
      }
    : null;
}

/**
 * A user looked up in two orgs at once (name, username, email or Id): the matches of both, paired by username.
 * Columns: Name, in (both / both (by name) / only in A / only in B), usernameA, usernameB, activeA, activeB,
 * profileA, profileB, lastLoginA, lastLoginB; idA and idB are the users' Ids.
 */
export async function findUserInBoth(
  clientA: SalesforceClient,
  clientB: SalesforceClient,
  text: string
): Promise<Row[]> {
  const [a, b] = await Promise.all([searchUsers(clientA, text), searchUsers(clientB, text)]);
  const left = new Set(b);
  const out: Row[] = [];
  const row = (x: UserMatch | undefined, y: UserMatch | undefined): Row => ({
    Id: `${x?.Id ?? ''}-${y?.Id ?? ''}`,
    idA: x?.Id ?? '',
    idB: y?.Id ?? '',
    Name: x?.Name ?? y?.Name ?? '',
    in: x && y ? 'both' : x ? 'only in A' : 'only in B',
    usernameA: x?.Username ?? '',
    usernameB: y?.Username ?? '',
    activeA: x ? x.IsActive : '',
    activeB: y ? y.IsActive : '',
    profileA: x?.Profile ?? '',
    profileB: y?.Profile ?? '',
    lastLoginA: x?.LastLoginDate ?? '',
    lastLoginB: y?.LastLoginDate ?? '',
  });
  for (const x of a) {
    const y = [...left].find((u) => sameUsername(u.Username, x.Username));
    if (y) left.delete(y);
    out.push(row(x, y));
  }
  // Searched by name in A, the user may be in B under another name: look them up by username too
  for (const x of out.filter((r) => r.in === 'only in A')) {
    // eslint-disable-next-line no-await-in-loop
    const y = await findSameUser(clientB, String(x.usernameA));
    if (y)
      Object.assign(
        x,
        row(
          a.find((u) => u.Username === x.usernameA),
          y
        )
      );
  }
  // Still apart: the same name in both orgs is most likely the same person (another username, e.g. a scratch org)
  for (const y of left) {
    const x = out.find((r) => r.in === 'only in A' && String(r.Name).toLowerCase() === y.Name.toLowerCase());
    if (x)
      Object.assign(
        x,
        row(
          a.find((u) => u.Id === x.idA),
          y
        ),
        { in: 'both (by name)' }
      );
    else out.push(row(undefined, y));
  }
  const order = { both: 0, 'both (by name)': 1, 'only in A': 2, 'only in B': 3 } as Record<string, number>;
  return out.sort((x, y) => order[String(x.in)] - order[String(y.in)] || String(x.Name).localeCompare(String(y.Name)));
}

// ---------- who has it, in both orgs ----------

/** The same permission set, group, license, role, group or queue in the other org's list (by API name; profiles by name). */
export function sameHolder(list: Holder[], holder: Holder): Holder | undefined {
  const api = (h: Holder): string =>
    (h.kind === 'profile' || h.detail === 'personal group' ? h.label : h.detail || h.label).toLowerCase();
  return list.find((h) => h.kind === holder.kind && api(h) === api(holder));
}

/**
 * Users with it in A, in B, or in both (matched by username). A missing side (not in that org) counts as none.
 * Columns: Name, in (both / only in A / only in B), usernameA, usernameB, activeA, activeB, profileA, profileB.
 */
export async function usersWithInBoth(
  clientA: SalesforceClient,
  holderA: Pick<Holder, 'kind' | 'id'> | undefined,
  clientB: SalesforceClient,
  holderB: Pick<Holder, 'kind' | 'id'> | undefined
): Promise<Row[]> {
  const people = (rows: Row[]): Row[] => rows.filter((r) => r.Username);
  // A side that cannot be read is unknown (null), not empty
  const read = (client: SalesforceClient, holder: Pick<Holder, 'kind' | 'id'> | undefined): Promise<Row[] | null> =>
    holder ? usersWith(client, holder).then(people, () => null) : Promise.resolve([]);
  const [readA, readB] = await Promise.all([read(clientA, holderA), read(clientB, holderB)]);
  if (!readA && !readB) throw new Error('The users could not be read in either org.');
  const a = readA ?? [];
  const b = readB ?? [];
  const unknown = !readA ? 'not read in A' : !readB ? 'not read in B' : '';
  const left = new Set(b);
  const out: Row[] = [];
  for (const x of a) {
    const y = [...left].find((u) => sameUsername(String(u.Username), String(x.Username)));
    if (y) left.delete(y);
    out.push({
      Id: `${String(x.Id)}${y ? `-${String(y.Id)}` : ''}`,
      Name: x.Name,
      in: y ? 'both' : unknown || 'only in A',
      usernameA: x.Username,
      usernameB: y?.Username ?? '',
      activeA: x.IsActive,
      activeB: y ? y.IsActive : '',
      profileA: x['Profile.Name'] ?? '',
      profileB: y?.['Profile.Name'] ?? '',
    });
  }
  for (const y of left)
    out.push({
      Id: String(y.Id),
      Name: y.Name,
      in: unknown || 'only in B',
      usernameA: '',
      usernameB: y.Username,
      activeA: '',
      activeB: y.IsActive,
      profileA: '',
      profileB: y['Profile.Name'] ?? '',
    });
  const order = { 'only in A': 0, 'only in B': 1, both: 2, 'not read in A': 3, 'not read in B': 3 } as Record<
    string,
    number
  >;
  return out.sort((x, y) => order[String(x.in)] - order[String(y.in)] || String(x.Name).localeCompare(String(y.Name)));
}

// ---------- every profile, permission set and group ----------

type Snapshot = {
  /** key (permissionSetKey) → the set */
  sets: Map<string, { id: string; kind: string; label: string; on: Set<string>; objects: Map<string, string> }>;
  /** Permission fields this org has (some depend on licenses and features). */
  fields: Set<string>;
};

const OBJECT_FLAGS: Array<[string, string]> = [
  ['PermissionsRead', 'Read'],
  ['PermissionsCreate', 'Create'],
  ['PermissionsEdit', 'Edit'],
  ['PermissionsDelete', 'Delete'],
  ['PermissionsViewAllRecords', 'View all'],
  ['PermissionsModifyAllRecords', 'Modify all'],
];
const objectAccess = (r: Row): string =>
  OBJECT_FLAGS.filter(([f]) => r[f] === true)
    .map(([, label]) => label)
    .join(', ');

async function snapshot(client: SalesforceClient): Promise<Snapshot> {
  const describe = await client.rest<{ fields: Array<{ name: string; type: string }> }>(
    'GET',
    '/sobjects/PermissionSet/describe'
  );
  const fields = describe.fields
    .filter((f) => f.type === 'boolean' && f.name.startsWith('Permissions'))
    .map((f) => f.name);
  const sets: Snapshot['sets'] = new Map();
  const byId = new Map<string, string>();
  for (let i = 0; i < Math.max(1, fields.length); i += 150) {
    const chunk = fields.slice(i, i + 150);
    // eslint-disable-next-line no-await-in-loop
    const rows = await query(
      client,
      `SELECT Id, Name, NamespacePrefix, Label, Type, IsOwnedByProfile, Profile.Name, PermissionSetGroup.DeveloperName, PermissionSetGroup.MasterLabel${chunk
        .map((f) => `, ${f}`)
        .join('')} FROM PermissionSet`,
      { maxRows: 20_000 }
    );
    for (const r of rows.rows) {
      const key = permissionSetKey(r);
      let set = sets.get(key);
      if (!set) {
        const kind = key.slice(0, key.indexOf(':'));
        const label =
          kind === 'Profile'
            ? String(r['Profile.Name'] ?? '')
            : String((kind === 'Permission set group' ? r['PermissionSetGroup.MasterLabel'] : r.Label) ?? r.Name);
        set = { id: String(r.Id), kind, label, on: new Set(), objects: new Map() };
        sets.set(key, set);
        byId.set(String(r.Id), key);
      }
      for (const f of chunk) if (r[f] === true) set.on.add(f);
    }
  }
  const objects = await query(
    client,
    `SELECT ParentId, SobjectType, ${OBJECT_FLAGS.map(([f]) => f).join(', ')} FROM ObjectPermissions`,
    { maxRows: 500_000 }
  );
  for (const r of objects.rows) {
    const key = byId.get(String(r.ParentId));
    if (key) sets.get(key)?.objects.set(String(r.SobjectType), objectAccess(r));
  }
  return { sets, fields: new Set(fields) };
}

export type AccessOverviewRow = {
  key: string;
  kind: string;
  name: string;
  status: 'only in A' | 'only in B' | 'different' | 'same';
  /** How many system permissions / objects differ. */
  systemPermissions: number | '';
  objectAccess: number | '';
  idA: string;
  idB: string;
};

/**
 * Every profile, permission set and permission set group of two orgs: only in one, or in both with how many system
 * permissions and objects differ. Permissions one org does not have at all (licenses, features) are left out.
 */
export async function accessOverview(
  clientA: SalesforceClient,
  clientB: SalesforceClient
): Promise<AccessOverviewRow[]> {
  const label =
    (side: string) =>
    (e: Error): never => {
      throw new Error(`${side}: profiles and permission sets could not be read — ${e.message}`);
    };
  const [a, b] = await Promise.all([snapshot(clientA).catch(label('A')), snapshot(clientB).catch(label('B'))]);
  const common = [...a.fields].filter((f) => b.fields.has(f));
  const rows: AccessOverviewRow[] = [];
  for (const key of new Set([...a.sets.keys(), ...b.sets.keys()])) {
    const x = a.sets.get(key);
    const y = b.sets.get(key);
    const any = (x ?? y)!;
    if (!x || !y) {
      rows.push({
        key,
        kind: any.kind,
        name: any.label,
        status: x ? 'only in A' : 'only in B',
        systemPermissions: '',
        objectAccess: '',
        idA: x?.id ?? '',
        idB: y?.id ?? '',
      });
      continue;
    }
    const systemPermissions = common.filter((f) => x.on.has(f) !== y.on.has(f)).length;
    const objectAccess = [...new Set([...x.objects.keys(), ...y.objects.keys()])].filter(
      (o) => (x.objects.get(o) ?? '') !== (y.objects.get(o) ?? '')
    ).length;
    rows.push({
      key,
      kind: any.kind,
      name: any.label,
      status: systemPermissions || objectAccess ? 'different' : 'same',
      systemPermissions,
      objectAccess,
      idA: x.id,
      idB: y.id,
    });
  }
  const order = { 'only in A': 0, 'only in B': 1, different: 2, same: 3 };
  const kinds = ['Profile', 'Permission set group', 'Permission set'];
  return rows.sort(
    (x, y) =>
      order[x.status] - order[y.status] || kinds.indexOf(x.kind) - kinds.indexOf(y.kind) || x.name.localeCompare(y.name)
  );
}

// ---------- connected apps ----------

/** Connected app settings worth comparing, when the org's API has them. */
const APP_SETTINGS = [
  'OptionsAllowAdminApprovedUsersOnly',
  'OptionsRefreshTokenValidityMetric',
  'RefreshTokenValidityPeriod',
  'OptionsHasSessionLevelPolicy',
  'OptionsIsInternal',
  'OptionsCodeCredentialGuestEnabled',
  'OptionsFullContentPushNotifications',
  'MobileSessionTimeout',
  'PinLength',
  'StartUrl',
  'MobileStartUrl',
];

type AppSide = {
  report: Awaited<ReturnType<typeof connectedAppsReport>>;
  settings: Map<string, Map<string, string>>;
  access: Map<string, Set<string>>;
  labels: Map<string, string>;
};

async function appSide(client: SalesforceClient): Promise<AppSide> {
  const [report, describe] = await Promise.all([
    connectedAppsReport(client),
    client
      .rest<{ fields: Array<{ name: string; label: string }> }>('GET', '/sobjects/ConnectedApplication/describe')
      .catch(() => ({ fields: [] })),
  ]);
  const have = describe.fields.filter((f) => APP_SETTINGS.includes(f.name));
  const labels = new Map(have.map((f) => [f.name, f.label]));
  const settings = new Map<string, Map<string, string>>();
  const idToName = new Map<string, string>();
  const apps = await query(
    client,
    `SELECT Id, Name${have.map((f) => `, ${f.name}`).join('')} FROM ConnectedApplication`,
    { maxRows: 5000 }
  ).catch(() => ({ rows: [] as Row[] }));
  for (const r of apps.rows) {
    const name = String(r.Name).toLowerCase();
    idToName.set(String(r.Id), name);
    settings.set(name, new Map(have.map((f) => [f.name, r[f.name] == null ? '' : String(r[f.name])])));
  }
  // Who may use each app: the profiles and permission sets it is enabled on
  const access = new Map<string, Set<string>>();
  const grants = await query(
    client,
    "SELECT SetupEntityId, Parent.Name, Parent.NamespacePrefix, Parent.Type, Parent.IsOwnedByProfile, Parent.Profile.Name, Parent.PermissionSetGroup.DeveloperName FROM SetupEntityAccess WHERE SetupEntityType = 'ConnectedApplication'",
    { maxRows: 50_000 }
  ).catch(() => ({ rows: [] as Row[] }));
  for (const g of grants.rows) {
    const name = idToName.get(String(g.SetupEntityId));
    if (!name) continue;
    const parent = Object.fromEntries(
      Object.entries(g)
        .filter(([k]) => k.startsWith('Parent.'))
        .map(([k, v]) => [k.slice(7), v])
    );
    const set = access.get(name) ?? new Set<string>();
    set.add(permissionSetKey(parent).replace(':', ': '));
    access.set(name, set);
  }
  return { report, settings, access, labels };
}

export type AppComparison = {
  name: string;
  status: 'only in A' | 'only in B' | 'different' | 'same' | 'not read in A' | 'not read in B';
  kindA: string;
  kindB: string;
  usersA: number | '';
  usersB: number | '';
  differences: Difference[];
};

/** Connected apps (and OAuth-only apps) of two orgs: which exist where, their users, settings and who may use them. */
export async function compareConnectedApps(
  clientA: SalesforceClient,
  clientB: SalesforceClient
): Promise<{ apps: AppComparison[]; notes: string[] }> {
  const [a, b] = await Promise.all([appSide(clientA), appSide(clientB)]);
  const labels = new Map([...b.labels, ...a.labels]);
  const names = new Map<string, string>();
  for (const app of [...a.report.apps, ...b.report.apps]) names.set(app.name.toLowerCase(), app.name);
  const apps: AppComparison[] = [];
  for (const [key, name] of names) {
    const x = a.report.apps.find((p) => p.name.toLowerCase() === key);
    const y = b.report.apps.find((p) => p.name.toLowerCase() === key);
    const differences: Difference[] = [];
    if (x && y) {
      if (x.kind !== y.kind) differences.push({ area: 'Kind', item: 'Kind', a: x.kind, b: y.kind });
      const sa = a.settings.get(key);
      const sb = b.settings.get(key);
      if (sa && sb)
        for (const [field, label] of labels) {
          const [va, vb] = [sa.get(field), sb.get(field)];
          if (va !== undefined && vb !== undefined && va !== vb)
            differences.push({ area: 'Setting', item: label, a: va || '—', b: vb || '—' });
        }
      const [ga, gb] = [a.access.get(key) ?? new Set<string>(), b.access.get(key) ?? new Set<string>()];
      for (const who of [...new Set([...ga, ...gb])].sort())
        if (ga.has(who) !== gb.has(who))
          differences.push({ area: 'Who may use it', item: who, a: ga.has(who) ? '✓' : '', b: gb.has(who) ? '✓' : '' });
    }
    // An app missing on a side whose lists could not all be read is unknown there, not "only in" the other
    apps.push({
      name,
      status: !y
        ? b.report.notes.length
          ? 'not read in B'
          : 'only in A'
        : !x
        ? a.report.notes.length
          ? 'not read in A'
          : 'only in B'
        : differences.length
        ? 'different'
        : 'same',
      kindA: x?.kind ?? '',
      kindB: y?.kind ?? '',
      usersA: x ? x.users : '',
      usersB: y ? y.users : '',
      differences,
    });
  }
  const order = { 'only in A': 0, 'only in B': 1, different: 2, same: 3, 'not read in A': 4, 'not read in B': 4 };
  return {
    apps: apps.sort((x, y) => order[x.status] - order[y.status] || x.name.localeCompare(y.name)),
    notes: [...a.report.notes.map((n) => `A: ${n}`), ...b.report.notes.map((n) => `B: ${n}`)],
  };
}
