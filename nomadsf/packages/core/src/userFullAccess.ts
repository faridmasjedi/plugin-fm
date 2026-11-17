import type { SalesforceClient } from './client.js';
import { namesOf } from './accessDetail.js';
import { accessText } from './accessEdit.js';
import { metadataEnvelope } from './metadata.js';
import { query, type Row } from './query.js';
import { SHARING_MODEL } from './sharingTree.js';
import { escapeXml, xmlValue } from './soap.js';

/**
 * Everything one user can do, combined from their profile, permission sets and permission set groups — objects,
 * fields, Apex classes, Visualforce pages, custom permissions, apps, tabs, record types and page layouts — each row
 * saying where it comes from; and, per object, the records they own and the records shared with them (directly,
 * through their groups and queues, through their role).
 */

const USER_ID = /^005\w{12}(\w{3})?$/;
const quoted = (ids: string[]): string => ids.map((id) => `'${id}'`).join(', ');
const short = (id: unknown): string => String(id ?? '').slice(0, 15);

/** One kind of access: its own columns (for the table and the workbook); `note` says why it could not be read. */
export type UserAccessSection = { id: string; title: string; columns: string[]; rows: Row[]; note?: string };

/** Where access comes from: the profile, a permission set, or a permission set group. */
export type AccessHolder = {
  id: string;
  kind: 'profile' | 'permset' | 'group';
  /** "Profile: Sales", "Finance Read", "Group: Support Agents". */
  via: string;
  /** Metadata name (a permission set's, with its namespace) — record types are read by it. */
  name: string;
  profileId?: string;
  groupId?: string;
};

/** The profile, permission sets and permission set groups a user has (each group as its combined permission set). */
export async function accessHolders(client: SalesforceClient, userId: string): Promise<AccessHolder[]> {
  if (!USER_ID.test(userId)) throw new Error('Invalid user Id.');
  const rows = (
    await query(
      client,
      `SELECT PermissionSetId, PermissionSet.Name, PermissionSet.Label, PermissionSet.NamespacePrefix, PermissionSet.IsOwnedByProfile, PermissionSet.ProfileId, PermissionSet.Profile.Name, PermissionSetGroupId, PermissionSetGroup.MasterLabel FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`,
      { maxRows: 5000 }
    )
  ).rows;
  const seen = new Set<string>();
  const out: AccessHolder[] = [];
  for (const r of rows) {
    const id = String(r.PermissionSetId);
    if (seen.has(id)) continue;
    seen.add(id);
    const ns = r['PermissionSet.NamespacePrefix'] ? `${String(r['PermissionSet.NamespacePrefix'])}__` : '';
    const name = `${ns}${String(r['PermissionSet.Name'] ?? '')}`;
    if (r['PermissionSet.IsOwnedByProfile'] === true)
      out.push({
        id,
        kind: 'profile',
        via: `Profile: ${String(r['PermissionSet.Profile.Name'] ?? r['PermissionSet.Label'] ?? '')}`,
        name,
        profileId: String(r['PermissionSet.ProfileId'] ?? ''),
      });
    else if (r.PermissionSetGroupId)
      out.push({
        id,
        kind: 'group',
        via: `Group: ${String(r['PermissionSetGroup.MasterLabel'] ?? '')}`,
        name,
        groupId: String(r.PermissionSetGroupId),
      });
    else out.push({ id, kind: 'permset', via: String(r['PermissionSet.Label'] ?? name), name });
  }
  // The profile first, then permission sets and groups by name
  return out.sort((a, b) => Number(b.kind === 'profile') - Number(a.kind === 'profile') || a.via.localeCompare(b.via));
}

async function part(
  id: string,
  title: string,
  columns: string[],
  read: () => Promise<Row[]>
): Promise<UserAccessSection> {
  try {
    return { id, title, columns, rows: await read() };
  } catch (e) {
    return { id, title, columns, rows: [], note: (e as Error).message };
  }
}

const join = (list: string[]): string => [...new Set(list)].join(' · ');
const byName = (key: string) => (a: Row, b: Row) => String(a[key]).localeCompare(String(b[key]));

/** Record type visibilities of profiles or permission sets, read from the Metadata API (10 at a time). */
async function recordTypeVisibility(
  client: SalesforceClient,
  type: 'Profile' | 'PermissionSet',
  names: string[]
): Promise<Map<string, Array<{ recordType: string; default: boolean }>>> {
  const out = new Map<string, Array<{ recordType: string; default: boolean }>>();
  for (let i = 0; i < names.length; i += 10) {
    const chunk = names.slice(i, i + 10);
    // eslint-disable-next-line no-await-in-loop
    const xml = await client.soap(
      'metadata',
      metadataEnvelope(
        `<met:readMetadata><met:type>${type}</met:type>${chunk
          .map((n) => `<met:fullNames>${escapeXml(n)}</met:fullNames>`)
          .join('')}</met:readMetadata>`
      )
    );
    for (const record of xml.split(/<records[\s>]/).slice(1)) {
      const fullName = xmlValue(record, 'fullName') ?? '';
      const list = (record.match(/<recordTypeVisibilities>[\s\S]*?<\/recordTypeVisibilities>/g) ?? [])
        .filter((b) => xmlValue(b, 'visible') === 'true')
        .map((b) => ({ recordType: xmlValue(b, 'recordType') ?? '', default: xmlValue(b, 'default') === 'true' }));
      out.set(fullName, list);
    }
  }
  return out;
}

/** Everything a user can do, from all their profile, permission sets and groups, each row with its source(s). */
export async function userFullAccess(
  client: SalesforceClient,
  userId: string
): Promise<{ holders: AccessHolder[]; sections: UserAccessSection[] }> {
  const holders = await accessHolders(client, userId);
  const ids = holders.map((h) => h.id);
  const viaOf = new Map(holders.map((h) => [short(h.id), h.via]));
  const via = (parentId: unknown): string => viaOf.get(short(parentId)) ?? String(parentId);
  if (!ids.length) return { holders, sections: [] };
  const profile = holders.find((h) => h.kind === 'profile');

  const objects = part(
    'objects',
    'Objects',
    ['Object', 'Read', 'Create', 'Edit', 'Delete', 'View all', 'Modify all', 'Via'],
    async () => {
      const rows = (
        await query(
          client,
          `SELECT ParentId, SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE ParentId IN (${quoted(
            ids
          )})`,
          { maxRows: 50_000 }
        )
      ).rows;
      const flags: Array<[string, string]> = [
        ['Read', 'PermissionsRead'],
        ['Create', 'PermissionsCreate'],
        ['Edit', 'PermissionsEdit'],
        ['Delete', 'PermissionsDelete'],
        ['View all', 'PermissionsViewAllRecords'],
        ['Modify all', 'PermissionsModifyAllRecords'],
      ];
      const by = new Map<string, Row & { _via: string[] }>();
      for (const r of rows) {
        const object = String(r.SobjectType);
        const row = by.get(object) ?? { Object: object, _via: [] };
        for (const [col, field] of flags) if (r[field] === true) row[col] = '✓';
        const text = accessText({
          read: r.PermissionsRead === true,
          create: r.PermissionsCreate === true,
          edit: r.PermissionsEdit === true,
          delete: r.PermissionsDelete === true,
          viewAll: r.PermissionsViewAllRecords === true,
          modifyAll: r.PermissionsModifyAllRecords === true,
        });
        if (text) row._via.push(`${via(r.ParentId)} (${text})`);
        by.set(object, row);
      }
      return [...by.values()]
        .filter((r) => r.Read)
        .map(({ _via, ...r }) => ({ ...r, Via: join(_via) }))
        .sort(byName('Object'));
    }
  );

  const fields = part('fields', 'Fields', ['Object', 'Field', 'Access', 'Via'], async () => {
    const rows = (
      await query(
        client,
        `SELECT ParentId, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId IN (${quoted(
          ids
        )})`,
        { maxRows: 200_000 }
      )
    ).rows;
    const by = new Map<string, { object: string; field: string; edit: boolean; via: string[] }>();
    for (const r of rows) {
      const name = String(r.Field);
      if (r.PermissionsRead !== true || !/^[^.]+\.[^.]/.test(name)) continue;
      const [object, ...rest] = name.split('.');
      const row = by.get(name) ?? { object, field: rest.join('.'), edit: false, via: [] };
      if (r.PermissionsEdit === true) row.edit = true;
      row.via.push(`${via(r.ParentId)} (${r.PermissionsEdit === true ? 'Edit' : 'Read'})`);
      by.set(name, row);
    }
    return [...by.values()]
      .map((r) => ({ Object: r.object, Field: r.field, Access: r.edit ? 'Read, Edit' : 'Read', Via: join(r.via) }))
      .sort((a, b) => a.Object.localeCompare(b.Object) || a.Field.localeCompare(b.Field));
  });

  // Classes, pages, custom permissions, apps and connected apps: one read of SetupEntityAccess
  const entities = query(
    client,
    `SELECT ParentId, SetupEntityId, SetupEntityType FROM SetupEntityAccess WHERE ParentId IN (${quoted(
      ids
    )}) AND SetupEntityType IN ('ApexClass', 'ApexPage', 'CustomPermission', 'TabSet', 'ConnectedApplication')`,
    { maxRows: 50_000 }
  ).then((r) => r.rows);
  const entityPart = (id: string, title: string, type: string, object: string, field: string, column: string) =>
    part(id, title, [column, 'Via'], async () => {
      const rows = (await entities).filter((r) => r.SetupEntityType === type);
      const entityIds = [...new Set(rows.map((r) => String(r.SetupEntityId)))];
      let names = new Map<string, string>();
      if (entityIds.length && type === 'TabSet') {
        const apps = await query(
          client,
          `SELECT ApplicationId, Label FROM AppMenuItem WHERE ApplicationId IN (${quoted(entityIds)})`
        );
        names = new Map(apps.rows.map((a) => [short(a.ApplicationId), String(a.Label)]));
      } else if (entityIds.length) names = await namesOf(client, object, field, entityIds);
      const by = new Map<string, string[]>();
      for (const r of rows) {
        const name = names.get(short(r.SetupEntityId)) ?? String(r.SetupEntityId);
        by.set(name, [...(by.get(name) ?? []), via(r.ParentId)]);
      }
      return [...by].map(([name, list]) => ({ [column]: name, Via: join(list) })).sort(byName(column));
    });

  const tabs = part('tabs', 'Tabs', ['Tab', 'Visibility', 'Via'], async () => {
    const rows = (
      await query(
        client,
        `SELECT ParentId, Name, Visibility FROM PermissionSetTabSetting WHERE ParentId IN (${quoted(ids)})`,
        { maxRows: 20_000 }
      )
    ).rows;
    // The most visible setting wins: shown by default, then available, then hidden
    const rank = (v: string): number => (/DefaultOn|Visible/.test(v) ? 2 : /DefaultOff|Available/.test(v) ? 1 : 0);
    const by = new Map<string, { best: string; via: string[] }>();
    for (const r of rows) {
      const name = String(r.Name);
      const v = String(r.Visibility ?? '');
      const row = by.get(name) ?? { best: v, via: [] };
      if (rank(v) > rank(row.best)) row.best = v;
      row.via.push(`${via(r.ParentId)} (${v})`);
      by.set(name, row);
    }
    return [...by]
      .map(([Tab, r]) => ({ Tab: Tab.replace(/^standard-/, ''), Visibility: r.best, Via: join(r.via) }))
      .sort(byName('Tab'));
  });

  const recordTypes = part('recordTypes', 'Record types', ['Object', 'Record type', 'Default', 'Via'], async () => {
    const by = new Map<string, { def: boolean; via: string[] }>();
    const add = (recordType: string, def: boolean, from: string) => {
      const row = by.get(recordType) ?? { def: false, via: [] };
      if (def) row.def = true;
      row.via.push(from);
      by.set(recordType, row);
    };
    if (profile?.profileId) {
      const p = await query(client, `SELECT FullName FROM Profile WHERE Id = '${profile.profileId}'`, {
        tooling: true,
      });
      const fullName = String(p.rows[0]?.FullName ?? '');
      if (fullName)
        for (const v of (await recordTypeVisibility(client, 'Profile', [fullName])).get(fullName) ?? [])
          add(v.recordType, v.default, profile.via);
    }
    // A group gives the record types of the permission sets in it
    const groups = holders.filter((h) => h.kind === 'group' && h.groupId);
    const components = groups.length
      ? (
          await query(
            client,
            `SELECT PermissionSetGroupId, PermissionSet.Name, PermissionSet.NamespacePrefix FROM PermissionSetGroupComponent WHERE PermissionSetGroupId IN (${quoted(
              groups.map((g) => g.groupId!)
            )})`,
            { maxRows: 5000 }
          )
        ).rows
      : [];
    const sources = new Map<string, string[]>();
    for (const h of holders.filter((x) => x.kind === 'permset')) sources.set(h.name, [h.via]);
    for (const c of components) {
      const ns = c['PermissionSet.NamespacePrefix'] ? `${String(c['PermissionSet.NamespacePrefix'])}__` : '';
      const name = `${ns}${String(c['PermissionSet.Name'] ?? '')}`;
      const group = groups.find((g) => short(g.groupId) === short(c.PermissionSetGroupId));
      // Muting permission sets give nothing
      if (!name || !group || /muting/i.test(name)) continue;
      sources.set(name, [...(sources.get(name) ?? []), group.via]);
    }
    const read = await recordTypeVisibility(client, 'PermissionSet', [...sources.keys()]);
    for (const [name, list] of read)
      for (const v of list) for (const from of sources.get(name) ?? []) add(v.recordType, v.default, from);
    return [...by]
      .map(([rt, r]) => {
        const [object, ...rest] = rt.split('.');
        return { Object: object, 'Record type': rest.join('.'), Default: r.def ? '✓' : '', Via: join(r.via) };
      })
      .sort((a, b) => a.Object.localeCompare(b.Object) || a['Record type'].localeCompare(b['Record type']));
  });

  const layouts = part('layouts', 'Page layouts', ['Object', 'Record type', 'Layout', 'Via'], async () => {
    if (!profile?.profileId) return [];
    const rows = (
      await query(
        client,
        `SELECT Layout.Name, RecordTypeId, TableEnumOrId FROM ProfileLayout WHERE ProfileId = '${profile.profileId}'`,
        { tooling: true, maxRows: 5000 }
      )
    ).rows;
    const types = [...new Set(rows.map((r) => String(r.RecordTypeId ?? '')).filter(Boolean))];
    const rtNames = types.length ? await namesOf(client, 'RecordType', 'DeveloperName', types) : new Map();
    return rows
      .map((r) => ({
        Object: String(r.TableEnumOrId),
        'Record type': r.RecordTypeId ? rtNames.get(short(r.RecordTypeId)) ?? String(r.RecordTypeId) : '(master)',
        Layout: String(r['Layout.Name'] ?? ''),
        Via: profile.via,
      }))
      .sort((a, b) => a.Object.localeCompare(b.Object) || a['Record type'].localeCompare(b['Record type']));
  });

  const sections = await Promise.all([
    objects,
    fields,
    entityPart('classes', 'Apex classes', 'ApexClass', 'ApexClass', 'Name', 'Class'),
    entityPart('pages', 'Visualforce pages', 'ApexPage', 'ApexPage', 'Name', 'Page'),
    entityPart(
      'customPermissions',
      'Custom permissions',
      'CustomPermission',
      'CustomPermission',
      'DeveloperName',
      'Custom permission'
    ),
    entityPart('apps', 'Apps', 'TabSet', 'AppMenuItem', 'Label', 'App'),
    entityPart(
      'connectedApps',
      'Connected apps',
      'ConnectedApplication',
      'ConnectedApplication',
      'Name',
      'Connected app'
    ),
    tabs,
    recordTypes,
    layouts,
  ]);
  return { holders, sections };
}

// ---------- records shared with the user ----------

const REASON: Record<string, string> = {
  Rule: 'Sharing rule',
  Manual: 'Manual',
  Team: 'Team',
  ImplicitChild: 'Implicit (account child)',
  ImplicitParent: 'Implicit (account parent)',
  Territory: 'Territory',
  TerritoryRule: 'Territory rule',
  TerritoryManual: 'Territory (manual)',
  GuestRule: 'Guest rule',
  RelatedPortalUser: 'Portal user',
  PortalImplicit: 'Portal',
};
/** Defaults where every internal user sees every record: nothing is "shared" there. */
const OPEN = /^(ReadWrite|ReadWriteTransfer|FullAccess|ControlledBy)/;

/** The groups a user is in: directly, through their role (and the roles above), All internal users, and nested. */
async function groupsOf(
  client: SalesforceClient,
  userId: string
): Promise<{ groups: Set<string>; role: Set<string>; notes: string[] }> {
  const notes: string[] = [];
  const groups = new Set<string>();
  const role = new Set<string>();
  const user = (await query(client, `SELECT UserRoleId, UserType FROM User WHERE Id = '${userId}'`)).rows[0] ?? {};
  for (const m of (
    await query(client, `SELECT GroupId FROM GroupMember WHERE UserOrGroupId = '${userId}'`, { maxRows: 5000 })
  ).rows)
    groups.add(short(m.GroupId));
  if (user.UserRoleId) {
    // The role, then each role above it: the "role and subordinates" groups of those include this user
    const chain: string[] = [String(user.UserRoleId)];
    for (let i = 0; i < 30; i++) {
      // eslint-disable-next-line no-await-in-loop
      const p = (await query(client, `SELECT ParentRoleId FROM UserRole WHERE Id = '${chain[chain.length - 1]}'`))
        .rows[0];
      if (!p?.ParentRoleId) break;
      chain.push(String(p.ParentRoleId));
    }
    for (const g of (
      await query(
        client,
        `SELECT Id, Type, RelatedId FROM Group WHERE RelatedId IN (${quoted(
          chain
        )}) AND Type IN ('Role', 'RoleAndSubordinates', 'RoleAndSubordinatesInternal')`,
        { maxRows: 5000 }
      )
    ).rows)
      if (g.Type !== 'Role' || short(g.RelatedId) === short(user.UserRoleId)) role.add(short(g.Id));
  }
  if (user.UserType === 'Standard')
    for (const g of (await query(client, "SELECT Id FROM Group WHERE Type = 'Organization'")).rows)
      groups.add(short(g.Id));
  // Groups that hold those groups (a few levels)
  let next = [...groups, ...role];
  for (let level = 0; level < 4 && next.length; level++) {
    const found: string[] = [];
    for (let i = 0; i < next.length; i += 200) {
      // eslint-disable-next-line no-await-in-loop
      const rows = (
        await query(
          client,
          `SELECT GroupId FROM GroupMember WHERE UserOrGroupId IN (${quoted(next.slice(i, i + 200))})`,
          { maxRows: 5000 }
        ).catch((e: Error) => {
          notes.push(`Nested groups: ${e.message}`);
          return { rows: [] as Row[] };
        })
      ).rows;
      for (const r of rows) {
        const id = short(r.GroupId);
        if (!groups.has(id) && !role.has(id)) {
          groups.add(id);
          found.push(id);
        }
      }
    }
    next = found;
  }
  return { groups, role, notes };
}

/** The share table of an object (AccountShare, Invoice__Share). */
export const shareTable = (object: string): string =>
  object.endsWith('__c') ? object.replace(/__c$/, '__Share') : `${object}Share`;

/**
 * Per object the user can read: its org-wide default, the records they own, and the records shared with them by
 * reason — directly, through their groups and queues, through their role. Counts of shares: a record shared more
 * than one way counts once per way. Managers above in the role hierarchy also see these; that is not listed.
 */
export async function userRecordSharing(
  client: SalesforceClient,
  userId: string,
  objects: Row[]
): Promise<UserAccessSection & { notes: string[] }> {
  if (!USER_ID.test(userId)) throw new Error('Invalid user Id.');
  const columns = [
    'Object',
    'Default',
    'External default',
    'View all',
    'Owned',
    'Shared with them',
    'Through groups & queues',
    'Through role',
    'Reasons',
  ];
  const readable = new Map(objects.map((o) => [String(o.Object), o]));
  const defaults = (
    await query(
      client,
      'SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE IsCustomizable = true AND IsCustomSetting = false AND InternalSharingModel != null',
      { maxRows: 5000 }
    )
  ).rows.filter((d) => readable.has(String(d.QualifiedApiName)));
  const { groups, role, notes } = await groupsOf(client, userId);
  const whoIds = [short(userId), ...groups, ...role];
  const kindOf = (id: string): 'user' | 'group' | 'role' =>
    id === short(userId) ? 'user' : role.has(id) ? 'role' : 'group';

  const rowOf = async (d: Row): Promise<Row> => {
    const object = String(d.QualifiedApiName);
    const internal = String(d.InternalSharingModel ?? '');
    const perms = readable.get(object) ?? {};
    const row: Row = {
      Object: object,
      Default: SHARING_MODEL[internal] ?? internal,
      'External default': SHARING_MODEL[String(d.ExternalSharingModel)] ?? String(d.ExternalSharingModel ?? ''),
      'View all': perms['Modify all'] ? 'Modify all' : perms['View all'] ? 'View all' : '',
    };
    const owned = await query(client, `SELECT COUNT(Id) n FROM ${object} WHERE OwnerId = '${userId}'`).catch(
      () => null
    );
    row.Owned = owned ? Number(owned.rows[0]?.n ?? owned.rows[0]?.expr0 ?? 0) : '';
    if (OPEN.test(internal)) {
      row.Reasons = internal.startsWith('Controlled') ? 'follows its parent record' : 'everyone sees every record';
      return row;
    }
    const counts = { user: 0, group: 0, role: 0 };
    const reasons = new Map<string, number>();
    try {
      for (let i = 0; i < whoIds.length; i += 200) {
        // eslint-disable-next-line no-await-in-loop
        const r = await query(
          client,
          `SELECT UserOrGroupId, RowCause, COUNT(Id) n FROM ${shareTable(object)} WHERE UserOrGroupId IN (${quoted(
            whoIds.slice(i, i + 200)
          )}) AND RowCause != 'Owner' GROUP BY UserOrGroupId, RowCause`,
          { maxRows: 5000 }
        );
        for (const x of r.rows) {
          const n = Number(x.n ?? x.expr0 ?? 0);
          counts[kindOf(short(x.UserOrGroupId))] += n;
          const reason = REASON[String(x.RowCause)] ?? String(x.RowCause);
          reasons.set(reason, (reasons.get(reason) ?? 0) + n);
        }
      }
      row['Shared with them'] = counts.user;
      row['Through groups & queues'] = counts.group;
      row['Through role'] = counts.role;
      row.Reasons = [...reasons].map(([k, n]) => `${k}: ${n}`).join(' · ');
    } catch (e) {
      row.Reasons = `not read: ${(e as Error).message}`;
    }
    return row;
  };

  const rows: Row[] = [];
  const list = defaults.slice(0, 300);
  if (defaults.length > list.length) notes.push(`Only the first ${list.length} objects were counted.`);
  for (let i = 0; i < list.length; i += 6)
    // eslint-disable-next-line no-await-in-loop
    rows.push(...(await Promise.all(list.slice(i, i + 6).map(rowOf))));
  return { id: 'sharing', title: 'Shared records', columns, rows: rows.sort(byName('Object')), notes };
}
