import type { SalesforceClient } from './client.js';
import { deployZip } from './deploy.js';
import { profileMetadata } from './accessMeta.js';
import { packageXml } from './metadata.js';
import { query, type Row } from './query.js';
import { escapeXml, xmlBlocks, xmlValue } from './soap.js';
import { makeZip, toBase64 } from './zip.js';

/**
 * Managing access beyond object, field and system permissions: public groups and queues and their
 * members, permission set licenses, what a permission set or profile gives access to (Apex classes,
 * Visualforce pages, custom permissions, connected apps, apps, tabs), new permission sets and
 * groups, and a profile's login IP ranges.
 */

const ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const idOf = (prefix: string, id: string, what: string): string => {
  if (!ID.test(id) || !id.startsWith(prefix)) throw new Error(`Invalid ${what} Id.`);
  return id;
};
const anyId = (id: string): string => {
  if (!ID.test(id)) throw new Error('Invalid Id.');
  return id;
};

type CollectionResult = { id?: string; success: boolean; errors: Array<{ message: string }> };
export type BatchResult = { done: number; errors: string[] };

const collect = (results: CollectionResult[], into: BatchResult): void => {
  for (const r of results) {
    if (r.success) into.done++;
    else into.errors.push(r.errors.map((e) => e.message).join('; '));
  }
};

/** Inserts records 200 at a time; each failure is reported, the rest still goes in. */
export async function insertMany(client: SalesforceClient, type: string, records: Row[]): Promise<BatchResult> {
  const out: BatchResult = { done: 0, errors: [] };
  for (let i = 0; i < records.length; i += 200) {
    const batch = records.slice(i, i + 200).map((r) => ({ attributes: { type }, ...r }));
    // eslint-disable-next-line no-await-in-loop
    collect(
      await client.rest<CollectionResult[]>('POST', '/composite/sobjects', { allOrNone: false, records: batch }),
      out
    );
  }
  return out;
}

/** Deletes records by Id, 200 at a time. */
export async function deleteByIds(client: SalesforceClient, ids: string[]): Promise<BatchResult> {
  const out: BatchResult = { done: 0, errors: [] };
  const list = ids.map(anyId);
  for (let i = 0; i < list.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    const results = await client.rest<CollectionResult[]>(
      'DELETE',
      `/composite/sobjects?ids=${list.slice(i, i + 200).join(',')}&allOrNone=false`
    );
    collect(results, out);
  }
  return out;
}

// ---------- public groups and queues ----------

export type GroupInfo = {
  Id: string;
  Kind: 'Public group' | 'Queue';
  Name: string;
  DeveloperName: string;
  Members: number;
  /** Queues: the objects whose records it can own. */
  Objects: string;
  Email: string;
};

export async function listGroups(client: SalesforceClient): Promise<GroupInfo[]> {
  const [groups, counts, objects] = await Promise.all([
    query(
      client,
      "SELECT Id, Name, DeveloperName, Type, Email FROM Group WHERE Type IN ('Regular', 'Queue') AND OwnerId NOT IN (SELECT Id FROM User) ORDER BY Type, Name",
      { maxRows: 50_000 }
    ).catch(() =>
      // Some orgs refuse the semi-join on OwnerId: personal groups are dropped below instead
      query(
        client,
        "SELECT Id, Name, DeveloperName, Type, Email, OwnerId FROM Group WHERE Type IN ('Regular', 'Queue')",
        {
          maxRows: 50_000,
        }
      )
    ),
    query(client, 'SELECT GroupId, COUNT(Id) n FROM GroupMember GROUP BY GroupId', { maxRows: 50_000 }).catch(() => ({
      rows: [] as Row[],
    })),
    query(client, 'SELECT QueueId, SobjectType FROM QueueSobject', { maxRows: 50_000 }).catch(() => ({
      rows: [] as Row[],
    })),
  ]);
  const count = new Map(counts.rows.map((r) => [String(r.GroupId), Number(r.n ?? 0)]));
  const queueObjects = new Map<string, string[]>();
  for (const r of objects.rows) {
    const list = queueObjects.get(String(r.QueueId)) ?? [];
    list.push(String(r.SobjectType));
    queueObjects.set(String(r.QueueId), list);
  }
  return groups.rows
    .filter((g) => !String(g.OwnerId ?? '').startsWith('005'))
    .map((g) => ({
      Id: String(g.Id),
      Kind: g.Type === 'Queue' ? ('Queue' as const) : ('Public group' as const),
      Name: String(g.Name ?? ''),
      DeveloperName: String(g.DeveloperName ?? ''),
      Members: count.get(String(g.Id)) ?? 0,
      Objects: (queueObjects.get(String(g.Id)) ?? []).sort().join(', '),
      Email: String(g.Email ?? ''),
    }))
    .sort((a, b) => a.Kind.localeCompare(b.Kind) || a.Name.localeCompare(b.Name));
}

export type GroupMemberRow = { MemberId: string; Kind: string; Name: string; Detail: string; UserOrGroupId: string };

/** Direct members of a group or queue: users, roles (and subordinates), other groups. */
export async function listGroupMembers(client: SalesforceClient, groupId: string): Promise<GroupMemberRow[]> {
  idOf('00G', groupId, 'group');
  const members = await query(client, `SELECT Id, UserOrGroupId FROM GroupMember WHERE GroupId = '${groupId}'`, {
    maxRows: 50_000,
  });
  const userIds = members.rows.map((m) => String(m.UserOrGroupId)).filter((id) => id.startsWith('005'));
  const groupIds = members.rows.map((m) => String(m.UserOrGroupId)).filter((id) => id.startsWith('00G'));
  const inList = (ids: string[]): string => ids.map((id) => `'${anyId(id)}'`).join(',');
  const names = new Map<string, { kind: string; name: string; detail: string }>();
  for (let i = 0; i < userIds.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    const users = await query(
      client,
      `SELECT Id, Name, Username, IsActive FROM User WHERE Id IN (${inList(userIds.slice(i, i + 500))})`,
      { maxRows: 500 }
    );
    for (const u of users.rows)
      names.set(String(u.Id), {
        kind: 'User',
        name: String(u.Name ?? ''),
        detail: `${String(u.Username ?? '')}${u.IsActive === false ? ' · inactive' : ''}`,
      });
  }
  if (groupIds.length) {
    // Roles and their subordinates are groups of type Role / RoleAndSubordinates…, pointing to the role
    const groups = await query(
      client,
      `SELECT Id, Name, DeveloperName, Type, RelatedId FROM Group WHERE Id IN (${inList(groupIds)})`,
      { maxRows: 50_000 }
    );
    const roleIds = groups.rows.map((g) => String(g.RelatedId ?? '')).filter((id) => id.startsWith('00E'));
    const roles = roleIds.length
      ? await query(client, `SELECT Id, Name FROM UserRole WHERE Id IN (${inList(roleIds)})`, { maxRows: 50_000 })
      : { rows: [] as Row[] };
    const roleName = new Map(roles.rows.map((r) => [String(r.Id), String(r.Name ?? '')]));
    for (const g of groups.rows) {
      const type = String(g.Type ?? '');
      const role = roleName.get(String(g.RelatedId ?? ''));
      names.set(String(g.Id), {
        kind:
          type === 'Role'
            ? 'Role'
            : type.startsWith('RoleAndSubordinates')
            ? 'Role and subordinates'
            : type === 'Regular'
            ? 'Public group'
            : type,
        name: role ?? String(g.Name ?? g.DeveloperName ?? ''),
        detail: role ? '' : String(g.DeveloperName ?? ''),
      });
    }
  }
  return members.rows
    .map((m) => {
      const who = names.get(String(m.UserOrGroupId));
      return {
        MemberId: String(m.Id),
        Kind: who?.kind ?? 'Other',
        Name: who?.name ?? String(m.UserOrGroupId),
        Detail: who?.detail ?? '',
        UserOrGroupId: String(m.UserOrGroupId),
      };
    })
    .sort((a, b) => a.Kind.localeCompare(b.Kind) || a.Name.localeCompare(b.Name));
}

/** Adds users (005) or groups (00G, e.g. a role's group) to a group or queue; members already in are skipped. */
export async function addGroupMembers(client: SalesforceClient, groupId: string, ids: string[]): Promise<BatchResult> {
  idOf('00G', groupId, 'group');
  const have = new Set(
    (
      await query(client, `SELECT UserOrGroupId FROM GroupMember WHERE GroupId = '${groupId}'`, { maxRows: 50_000 })
    ).rows.map((r) => String(r.UserOrGroupId).slice(0, 15))
  );
  const todo = [...new Set(ids)].filter((id) => ID.test(id) && !have.has(id.slice(0, 15)));
  return insertMany(
    client,
    'GroupMember',
    todo.map((UserOrGroupId) => ({ GroupId: groupId, UserOrGroupId }))
  );
}

/** Group membership rows (011…) to remove. */
export function removeGroupMembers(client: SalesforceClient, memberIds: string[]): Promise<BatchResult> {
  return deleteByIds(
    client,
    memberIds.map((id) => idOf('011', id, 'group member'))
  );
}

/** Roles, to add "a role" or "a role and its subordinates" to a group: the role's group Ids. */
export async function roleGroups(
  client: SalesforceClient
): Promise<Array<{ role: string; roleGroupId?: string; withSubordinatesGroupId?: string }>> {
  const [roles, groups] = await Promise.all([
    query(client, 'SELECT Id, Name FROM UserRole ORDER BY Name', { maxRows: 50_000 }),
    query(
      client,
      "SELECT Id, Type, RelatedId FROM Group WHERE Type IN ('Role', 'RoleAndSubordinates', 'RoleAndSubordinatesInternal')",
      { maxRows: 50_000 }
    ),
  ]);
  return roles.rows.map((r) => {
    const mine = groups.rows.filter((g) => String(g.RelatedId) === String(r.Id));
    return {
      role: String(r.Name ?? ''),
      roleGroupId: mine.find((g) => g.Type === 'Role')?.Id as string | undefined,
      withSubordinatesGroupId: (
        mine.find((g) => g.Type === 'RoleAndSubordinatesInternal') ?? mine.find((g) => g.Type === 'RoleAndSubordinates')
      )?.Id as string | undefined,
    };
  });
}

// ---------- permission set licenses ----------

export type LicenseInfo = { Id: string; Label: string; Name: string; Used: number; Total: number; Status: string };

export async function listPermissionSetLicenses(client: SalesforceClient): Promise<LicenseInfo[]> {
  const result = await query(
    client,
    'SELECT Id, MasterLabel, DeveloperName, UsedLicenses, TotalLicenses, Status FROM PermissionSetLicense ORDER BY MasterLabel',
    { maxRows: 5000 }
  );
  return result.rows.map((r) => ({
    Id: String(r.Id),
    Label: String(r.MasterLabel ?? ''),
    Name: String(r.DeveloperName ?? ''),
    Used: Number(r.UsedLicenses ?? 0),
    Total: Number(r.TotalLicenses ?? 0),
    Status: String(r.Status ?? ''),
  }));
}

export async function assignLicense(client: SalesforceClient, userId: string, licenseId: string): Promise<void> {
  const result = await insertMany(client, 'PermissionSetLicenseAssign', [
    { AssigneeId: idOf('005', userId, 'user'), PermissionSetLicenseId: idOf('0PL', licenseId, 'license') },
  ]);
  if (result.errors.length) throw new Error(result.errors.join('; '));
}

// ---------- what a permission set or profile gives access to ----------

/** Things a permission set (or a profile's permission set) can give access to through SetupEntityAccess. */
export const SETUP_KINDS = [
  { type: 'ApexClass', label: 'Apex classes', one: 'Apex class', prefix: '01p' },
  { type: 'ApexPage', label: 'Visualforce pages', one: 'Visualforce page', prefix: '066' },
  { type: 'CustomPermission', label: 'Custom permissions', one: 'custom permission', prefix: '0CP' },
  { type: 'ConnectedApplication', label: 'Connected apps', one: 'connected app', prefix: '0H4' },
  { type: 'TabSet', label: 'Apps', one: 'app', prefix: '02u' },
] as const;
export type SetupKind = (typeof SETUP_KINDS)[number]['type'];

export type SetupEntity = { id: string; name: string; label: string; namespace: string };

/** Everything of one kind in the org that access can be given to. */
export async function setupEntities(client: SalesforceClient, kind: SetupKind): Promise<SetupEntity[]> {
  const soql: Record<SetupKind, string> = {
    ApexClass: 'SELECT Id, Name, NamespacePrefix FROM ApexClass ORDER BY NamespacePrefix NULLS FIRST, Name',
    ApexPage: 'SELECT Id, Name, MasterLabel, NamespacePrefix FROM ApexPage ORDER BY NamespacePrefix NULLS FIRST, Name',
    CustomPermission:
      'SELECT Id, DeveloperName, MasterLabel, NamespacePrefix FROM CustomPermission ORDER BY NamespacePrefix NULLS FIRST, DeveloperName',
    ConnectedApplication: 'SELECT Id, Name FROM ConnectedApplication ORDER BY Name',
    TabSet: "SELECT ApplicationId, Name, Label, NamespacePrefix FROM AppMenuItem WHERE Type = 'TabSet' ORDER BY Label",
  };
  const rows = (await query(client, soql[kind], { maxRows: 50_000 })).rows;
  return rows.map((r) => ({
    id: String(kind === 'TabSet' ? r.ApplicationId : r.Id),
    name: String(r.Name ?? r.DeveloperName ?? ''),
    label: String(r.MasterLabel ?? r.Label ?? r.Name ?? r.DeveloperName ?? ''),
    namespace: String(r.NamespacePrefix ?? ''),
  }));
}

export type SetupAccessRow = { accessId: string; entityId: string; kind: SetupKind; name: string; label: string };

/** What a permission set (or profile, by its permission set) gives access to, by kind. */
export async function setupAccessOf(client: SalesforceClient, permissionSetId: string): Promise<SetupAccessRow[]> {
  idOf('0PS', permissionSetId, 'permission set');
  const types = SETUP_KINDS.map((k) => `'${k.type}'`).join(', ');
  const access = await query(
    client,
    `SELECT Id, SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId = '${permissionSetId}' AND SetupEntityType IN (${types})`,
    { maxRows: 50_000 }
  );
  const byKind = new Map<SetupKind, Row[]>();
  for (const r of access.rows) {
    const kind = r.SetupEntityType as SetupKind;
    byKind.set(kind, [...(byKind.get(kind) ?? []), r]);
  }
  const out: SetupAccessRow[] = [];
  for (const [kind, rows] of byKind) {
    // eslint-disable-next-line no-await-in-loop
    const all = await setupEntities(client, kind).catch(() => [] as SetupEntity[]);
    const byId = new Map(all.map((e) => [e.id.slice(0, 15), e]));
    for (const r of rows) {
      const e = byId.get(String(r.SetupEntityId).slice(0, 15));
      out.push({
        accessId: String(r.Id),
        entityId: String(r.SetupEntityId),
        kind,
        name: e ? `${e.namespace ? `${e.namespace}__` : ''}${e.name}` : String(r.SetupEntityId),
        label: e?.label ?? '',
      });
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

export function grantSetupAccess(
  client: SalesforceClient,
  permissionSetId: string,
  entityIds: string[]
): Promise<BatchResult> {
  idOf('0PS', permissionSetId, 'permission set');
  return insertMany(
    client,
    'SetupEntityAccess',
    entityIds.map((SetupEntityId) => ({ ParentId: permissionSetId, SetupEntityId: anyId(SetupEntityId) }))
  );
}

export function revokeSetupAccess(client: SalesforceClient, accessIds: string[]): Promise<BatchResult> {
  return deleteByIds(client, accessIds);
}

/** Who gives a custom permission: permission sets, profiles and groups (by their permission set). */
export function customPermissionHolders(client: SalesforceClient, customPermissionId: string): Promise<Row[]> {
  idOf('0CP', customPermissionId, 'custom permission');
  return setupAccessHolders(client, customPermissionId);
}

/** Who gives access to a custom permission, connected app, Apex class…: permission sets, profiles and groups. */
export async function setupAccessHolders(client: SalesforceClient, entityId: string): Promise<Row[]> {
  const customPermissionId = anyId(entityId);
  const result = await query(
    client,
    `SELECT Id, ParentId, Parent.Label, Parent.Name, Parent.IsOwnedByProfile, Parent.Profile.Name, Parent.Type FROM SetupEntityAccess WHERE SetupEntityId = '${customPermissionId}'`,
    { maxRows: 50_000 }
  );
  return result.rows.map((r) => ({
    AccessId: r.Id,
    PermissionSetId: r.ParentId,
    Kind:
      r['Parent.IsOwnedByProfile'] === true
        ? 'Profile'
        : r['Parent.Type'] === 'Group'
        ? 'Permission set group'
        : 'Permission set',
    Name: r['Parent.IsOwnedByProfile'] === true ? r['Parent.Profile.Name'] : r['Parent.Label'] ?? r['Parent.Name'],
  }));
}

// ---------- tabs (permission sets) ----------

export type TabSetting = { id?: string; tab: string; label: string; visibility: 'Visible' | 'Available' | 'Hidden' };

/** Tab settings of a permission set: Visible (DefaultOn), Available (DefaultOff) or not set (Hidden). */
export async function tabSettingsOf(client: SalesforceClient, permissionSetId: string): Promise<TabSetting[]> {
  idOf('0PS', permissionSetId, 'permission set');
  const [tabs, settings] = await Promise.all([
    query(client, 'SELECT Name, Label FROM TabDefinition ORDER BY Label', { maxRows: 50_000 }),
    query(client, `SELECT Id, Name, Visibility FROM PermissionSetTabSetting WHERE ParentId = '${permissionSetId}'`, {
      maxRows: 50_000,
    }),
  ]);
  const set = new Map(settings.rows.map((s) => [String(s.Name), s]));
  return tabs.rows.map((t) => {
    const s = set.get(String(t.Name));
    return {
      id: s ? String(s.Id) : undefined,
      tab: String(t.Name),
      label: String(t.Label ?? t.Name),
      visibility: !s ? 'Hidden' : s.Visibility === 'DefaultOn' ? 'Visible' : 'Available',
    };
  });
}

export async function setTabSetting(
  client: SalesforceClient,
  permissionSetId: string,
  current: TabSetting,
  visibility: TabSetting['visibility']
): Promise<void> {
  idOf('0PS', permissionSetId, 'permission set');
  if (!/^[\w-]+$/.test(current.tab)) throw new Error('Invalid tab name.');
  const value = visibility === 'Visible' ? 'DefaultOn' : 'DefaultOff';
  if (visibility === 'Hidden') {
    if (!current.id) return;
    const r = await deleteByIds(client, [current.id]);
    if (r.errors.length) throw new Error(r.errors.join('; '));
    return;
  }
  if (current.id)
    await client.rest('PATCH', `/sobjects/PermissionSetTabSetting/${anyId(current.id)}`, { Visibility: value });
  else {
    const r = await insertMany(client, 'PermissionSetTabSetting', [
      { ParentId: permissionSetId, Name: current.tab, Visibility: value },
    ]);
    if (r.errors.length) throw new Error(r.errors.join('; '));
  }
}

// ---------- new permission sets and groups ----------

const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;

export async function createPermissionSet(
  client: SalesforceClient,
  input: { label: string; name: string; description?: string; group?: boolean }
): Promise<string> {
  if (!input.label.trim()) throw new Error('Give it a label.');
  if (!API_NAME.test(input.name) || /__|_$/.test(input.name))
    throw new Error('API name: letters, digits and single underscores, starting with a letter.');
  const record = input.group
    ? { MasterLabel: input.label.trim(), DeveloperName: input.name, Description: input.description ?? '' }
    : { Label: input.label.trim(), Name: input.name, Description: input.description ?? '' };
  const r = await client.rest<{ id: string }>(
    'POST',
    `/sobjects/${input.group ? 'PermissionSetGroup' : 'PermissionSet'}`,
    record
  );
  return r.id;
}

/** A suggested API name from a label: "Sales Ops (EU)" -> Sales_Ops_EU. */
export const apiNameFrom = (label: string): string =>
  label
    .normalize('NFKD')
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^(\d)/, 'X$1')
    .slice(0, 80);

// ---------- a profile's login IP ranges (any profile, standard ones too) ----------

export type IpRange = { start: string; end: string; description: string };
export type ProfileLoginSettings = { fullName: string; ipRanges: IpRange[] };

export function parseLoginSettings(xml: string, fullName: string): ProfileLoginSettings {
  const ipRanges = xmlBlocks(xml, 'loginIpRanges').map((b) => ({
    start: xmlValue(b, 'startAddress') ?? '',
    end: xmlValue(b, 'endAddress') ?? '',
    description: xmlValue(b, 'description') ?? '',
  }));
  return { fullName, ipRanges };
}

/** A profile file with only its login IP ranges (deploying it changes nothing else). */
export function loginSettingsXml(settings: Omit<ProfileLoginSettings, 'fullName'>): string {
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const ipv6 = /^[0-9a-fA-F:]+$/;
  for (const r of settings.ipRanges) {
    if (!(ipv4.test(r.start) || ipv6.test(r.start)) || !(ipv4.test(r.end) || ipv6.test(r.end)))
      throw new Error(`Not an IP address: ${r.start} – ${r.end}`);
  }
  const ranges = settings.ipRanges
    .map(
      (r) =>
        `    <loginIpRanges>\n${
          r.description ? `        <description>${escapeXml(r.description)}</description>\n` : ''
        }        <endAddress>${r.end}</endAddress>\n        <startAddress>${
          r.start
        }</startAddress>\n    </loginIpRanges>\n`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n${ranges}</Profile>\n`;
}

/** A profile's IP ranges, read in one Tooling API call. */
export async function profileLoginSettings(client: SalesforceClient, profileId: string): Promise<ProfileLoginSettings> {
  const { fullName, metadata } = await profileMetadata(client, profileId);
  const ranges = (metadata.loginIpRanges ?? []) as Array<Record<string, unknown>>;
  return {
    fullName,
    ipRanges: ranges.map((r) => ({
      start: String(r.startAddress ?? ''),
      end: String(r.endAddress ?? ''),
      description: String(r.description ?? ''),
    })),
  };
}

/**
 * Deploys only the profile's IP ranges (the rest of the profile, login hours included, is left as
 * it is; the ranges sent replace the old ones).
 */
export async function saveProfileLoginSettings(
  client: SalesforceClient,
  settings: ProfileLoginSettings
): Promise<{ success: boolean; problems: string[] }> {
  const version = await client.version();
  const zip = makeZip([
    { path: 'package.xml', content: packageXml([{ type: 'Profile', fullName: settings.fullName }], version) },
    { path: `profiles/${settings.fullName}.profile`, content: loginSettingsXml(settings) },
  ]);
  // Default: no tests without Apex, and allowed in production (NoTestRun is not)
  const outcome = await deployZip(client, toBase64(zip), { testLevel: 'Default' });
  return {
    success: outcome.success,
    problems: [
      ...outcome.componentFailures.map((f) => f.problem),
      ...(outcome.errorMessage ? [outcome.errorMessage] : []),
    ],
  };
}
