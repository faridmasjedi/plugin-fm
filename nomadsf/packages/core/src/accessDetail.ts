import type { SalesforceClient } from './client.js';
import { xmlValue } from './soap.js';
import { metadataEnvelope } from './metadata.js';
import { accessText } from './accessEdit.js';
import { query, type Row } from './query.js';

/**
 * Everything a profile, permission set or group allows, section by section (object, field and system
 * permissions, Apex classes, Visualforce pages, apps, custom permissions, connected apps, tabs, record types,
 * page layouts), and what is shared with a user, their groups and their role.
 */

const PS_ID = /^0PS\w{12}(\w{3})?$/;
const USER_ID = /^005\w{12}(\w{3})?$/;

export type AccessRow = { key: string; item: string; value: string };
/** One kind of access; `note` says why it could not be read (missing permission, not in this org…). */
export type AccessSection = { title: string; rows: AccessRow[]; note?: string };

const quoted = (ids: string[]): string => ids.map((id) => `'${id}'`).join(', ');

async function section(title: string, read: () => Promise<AccessRow[]>): Promise<AccessSection> {
  try {
    const rows = await read();
    return { title, rows: rows.sort((a, b) => a.item.localeCompare(b.item)) };
  } catch (e) {
    return { title, rows: [], note: (e as Error).message };
  }
}

/** Names of Ids of one object (Id → label). */
async function namesOf(
  client: SalesforceClient,
  object: string,
  field: string,
  ids: string[]
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await query(
      client,
      `SELECT Id, ${field} FROM ${object} WHERE Id IN (${quoted(ids.slice(i, i + 200))})`
    );
    for (const r of rows.rows) out.set(String(r.Id).slice(0, 15), String(r[field] ?? ''));
  }
  return out;
}

/** Record type visibility from the Metadata API (profiles and permission sets keep it only there). */
async function recordTypes(
  client: SalesforceClient,
  type: 'Profile' | 'PermissionSet',
  fullName: string
): Promise<AccessRow[]> {
  const xml = await client.soap(
    'metadata',
    metadataEnvelope(
      `<met:readMetadata><met:type>${type}</met:type><met:fullNames>${fullName
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')}</met:fullNames></met:readMetadata>`
    )
  );
  const blocks = xml.match(/<recordTypeVisibilities>[\s\S]*?<\/recordTypeVisibilities>/g) ?? [];
  return blocks
    .map((b) => ({
      name: xmlValue(b, 'recordType') ?? '',
      visible: xmlValue(b, 'visible') === 'true',
      def: xmlValue(b, 'default') === 'true',
    }))
    .filter((r) => r.visible)
    .map((r) => ({ key: r.name, item: r.name, value: r.def ? 'visible, default' : 'visible' }));
}

/** Everything one profile, permission set or permission set group (its PermissionSet record) allows. */
export async function holderAccess(client: SalesforceClient, permissionSetId: string): Promise<AccessSection[]> {
  if (!PS_ID.test(permissionSetId)) throw new Error('Invalid permission set Id.');
  const set: Row =
    (
      await query(
        client,
        `SELECT Id, Name, NamespacePrefix, IsOwnedByProfile, ProfileId, Type FROM PermissionSet WHERE Id = '${permissionSetId}'`
      )
    ).rows[0] ?? {};
  const isProfile = set.IsOwnedByProfile === true;
  const describe = await client.rest<{ fields: Array<{ name: string; label: string; type: string }> }>(
    'GET',
    '/sobjects/PermissionSet/describe'
  );
  const permissionFields = describe.fields.filter((f) => f.type === 'boolean' && f.name.startsWith('Permissions'));

  const entities = async (type: string, object: string, field: string): Promise<AccessRow[]> => {
    const rows = await query(
      client,
      `SELECT SetupEntityId FROM SetupEntityAccess WHERE ParentId = '${permissionSetId}' AND SetupEntityType = '${type}'`,
      { maxRows: 10_000 }
    );
    const ids = rows.rows.map((r) => String(r.SetupEntityId));
    const names = ids.length ? await namesOf(client, object, field, ids) : new Map<string, string>();
    return ids.map((id) => {
      const name = names.get(id.slice(0, 15)) ?? id;
      return { key: name, item: name, value: '✓' };
    });
  };

  const sections = await Promise.all([
    section('Object access', async () =>
      (
        await query(
          client,
          `SELECT SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE ParentId = '${permissionSetId}'`,
          { maxRows: 10_000 }
        )
      ).rows.map((r) => ({
        key: String(r.SobjectType),
        item: String(r.SobjectType),
        value: accessText({
          read: r.PermissionsRead === true,
          create: r.PermissionsCreate === true,
          edit: r.PermissionsEdit === true,
          delete: r.PermissionsDelete === true,
          viewAll: r.PermissionsViewAllRecords === true,
          modifyAll: r.PermissionsModifyAllRecords === true,
        }),
      }))
    ),
    section('Field access', async () =>
      (
        await query(
          client,
          `SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = '${permissionSetId}'`,
          { maxRows: 50_000 }
        )
      ).rows
        .filter((r) => r.PermissionsRead === true)
        .map((r) => ({
          key: String(r.Field),
          item: String(r.Field),
          value: r.PermissionsEdit === true ? 'Read, Edit' : 'Read',
        }))
    ),
    section('User & system permissions', async () => {
      const out: AccessRow[] = [];
      for (let i = 0; i < permissionFields.length; i += 150) {
        const chunk = permissionFields.slice(i, i + 150);
        // eslint-disable-next-line no-await-in-loop
        const row =
          (
            await query(
              client,
              `SELECT ${chunk.map((f) => f.name).join(', ')} FROM PermissionSet WHERE Id = '${permissionSetId}'`
            )
          ).rows[0] ?? {};
        for (const f of chunk) if (row[f.name] === true) out.push({ key: f.name, item: f.label, value: '✓' });
      }
      return out;
    }),
    section('Apex classes', () => entities('ApexClass', 'ApexClass', 'Name')),
    section('Visualforce pages', () => entities('ApexPage', 'ApexPage', 'Name')),
    section('Apps', async () => {
      const rows = await query(
        client,
        `SELECT SetupEntityId FROM SetupEntityAccess WHERE ParentId = '${permissionSetId}' AND SetupEntityType = 'TabSet'`
      );
      const ids = rows.rows.map((r) => String(r.SetupEntityId));
      if (!ids.length) return [];
      const apps = await query(
        client,
        `SELECT ApplicationId, Label FROM AppMenuItem WHERE ApplicationId IN (${quoted(ids)})`
      );
      const names = new Map(apps.rows.map((r) => [String(r.ApplicationId).slice(0, 15), String(r.Label)]));
      return ids.map((id) => {
        const name = names.get(id.slice(0, 15)) ?? id;
        return { key: name, item: name, value: '✓' };
      });
    }),
    section('Custom permissions', () => entities('CustomPermission', 'CustomPermission', 'DeveloperName')),
    section('Connected apps', () => entities('ConnectedApplication', 'ConnectedApplication', 'Name')),
    section('Tab settings', async () =>
      (
        await query(
          client,
          `SELECT Name, Visibility FROM PermissionSetTabSetting WHERE ParentId = '${permissionSetId}'`,
          {
            maxRows: 5000,
          }
        )
      ).rows.map((r) => ({ key: String(r.Name), item: String(r.Name), value: String(r.Visibility ?? '') }))
    ),
    set.Type === 'Group'
      ? Promise.resolve<AccessSection>({
          title: 'Record types',
          rows: [],
          note: 'Comes from the permission sets in the group.',
        })
      : section('Record types', async () => {
          if (!isProfile)
            return recordTypes(
              client,
              'PermissionSet',
              `${set.NamespacePrefix ? `${String(set.NamespacePrefix)}__` : ''}${String(set.Name)}`
            );
          const profile = await query(client, `SELECT FullName FROM Profile WHERE Id = '${String(set.ProfileId)}'`, {
            tooling: true,
          });
          return recordTypes(client, 'Profile', String(profile.rows[0]?.FullName ?? ''));
        }),
    ...(isProfile
      ? [
          section('Page layouts', async () => {
            const rows = await query(
              client,
              `SELECT Layout.Name, RecordTypeId, TableEnumOrId FROM ProfileLayout WHERE ProfileId = '${String(
                set.ProfileId
              )}'`,
              { tooling: true, maxRows: 5000 }
            );
            const types = rows.rows.map((r) => String(r.RecordTypeId ?? '')).filter(Boolean);
            const recordTypeNames = types.length
              ? await namesOf(client, 'RecordType', 'Name', [...new Set(types)])
              : new Map();
            return rows.rows.map((r) => {
              const rt = r.RecordTypeId
                ? recordTypeNames.get(String(r.RecordTypeId).slice(0, 15)) ?? String(r.RecordTypeId)
                : '';
              const item = `${String(r.TableEnumOrId)}${rt ? ` · ${rt}` : ''}`;
              return { key: item, item, value: String(r['Layout.Name'] ?? '') };
            });
          }),
        ]
      : []),
  ]);
  return sections;
}

export type MergedSection = {
  title: string;
  rows: Array<{ key: string; item: string; a: string; b: string; differs: boolean }>;
  noteA?: string;
  noteB?: string;
};

/** Two holders' sections side by side (either may be missing: only one user has it). */
export function mergeAccess(a: AccessSection[] | undefined, b: AccessSection[] | undefined): MergedSection[] {
  const titles = [...new Set([...(a ?? []).map((s) => s.title), ...(b ?? []).map((s) => s.title)])];
  return titles.map((title) => {
    const x = a?.find((s) => s.title === title);
    const y = b?.find((s) => s.title === title);
    const byKey = new Map<string, { key: string; item: string; a: string; b: string }>();
    for (const r of x?.rows ?? []) byKey.set(r.key.toLowerCase(), { key: r.key, item: r.item, a: r.value, b: '' });
    for (const r of y?.rows ?? []) {
      const k = r.key.toLowerCase();
      byKey.set(k, { ...(byKey.get(k) ?? { key: r.key, item: r.item, a: '' }), b: r.value });
    }
    return {
      title,
      rows: [...byKey.values()]
        .map((r) => ({ ...r, differs: r.a !== r.b }))
        .sort((p, q) => p.item.localeCompare(q.item)),
      noteA: x?.note,
      noteB: y?.note,
    };
  });
}

// ---------- sharing ----------

const SHARE_TABLES: Array<[string, string]> = [
  ['Account', 'AccountShare'],
  ['Opportunity', 'OpportunityShare'],
  ['Case', 'CaseShare'],
  ['Contact', 'ContactShare'],
  ['Lead', 'LeadShare'],
];

/** Records shared with these users / groups, per object and reason (owner, manual, sharing rule, team…). */
async function sharesWith(client: SalesforceClient, ids: string[]): Promise<{ rows: Row[]; notes: string[] }> {
  const rows: Row[] = [];
  const notes: string[] = [];
  if (!ids.length) return { rows, notes };
  await Promise.all(
    SHARE_TABLES.map(async ([object, table]) => {
      try {
        const r = await query(
          client,
          `SELECT RowCause, COUNT(Id) records FROM ${table} WHERE UserOrGroupId IN (${quoted(ids)}) GROUP BY RowCause`
        );
        for (const x of r.rows) rows.push({ object, reason: x.RowCause, records: x.records ?? x.expr0 ?? 0 });
      } catch (e) {
        notes.push(`${object}: ${(e as Error).message}`);
      }
    })
  );
  return {
    rows: rows.sort(
      (a, b) => String(a.object).localeCompare(String(b.object)) || String(a.reason).localeCompare(String(b.reason))
    ),
    notes,
  };
}

export type UserSharing = {
  /** The role, its managers up the hierarchy and its access settings. */
  role: { name: string; path: string; settings: Row } | null;
  /** Records shared with the role (role and role-and-subordinates groups). */
  roleShares: Row[];
  /** Records shared with the user directly (owner, manual, team, rule…). */
  userShares: Row[];
  /** Records shared with the public groups and queues the user is in. */
  groupShares: Row[];
  /** Queues the user is in and the objects each handles. */
  queues: Row[];
  notes: string[];
};

/** What is shared with a user: directly, through their groups and queues, and through their role. */
export async function userSharing(client: SalesforceClient, userId: string): Promise<UserSharing> {
  if (!USER_ID.test(userId)) throw new Error('Invalid user Id.');
  const user: Row = (await query(client, `SELECT UserRoleId FROM User WHERE Id = '${userId}'`)).rows[0] ?? {};
  const members = await query(
    client,
    `SELECT GroupId, Group.Name, Group.Type FROM GroupMember WHERE UserOrGroupId = '${userId}'`,
    { maxRows: 5000 }
  );
  const groupIds = members.rows.map((m) => String(m.GroupId));
  const queueIds = members.rows.filter((m) => m['Group.Type'] === 'Queue').map((m) => String(m.GroupId));
  const notes: string[] = [];

  let role: UserSharing['role'] = null;
  let roleGroupIds: string[] = [];
  if (user.UserRoleId) {
    const roleId = String(user.UserRoleId);
    const r: Row =
      (
        await query(
          client,
          `SELECT Id, Name, ParentRoleId, OpportunityAccessForAccountOwner, CaseAccessForAccountOwner, ContactAccessForAccountOwner, MayForecastManagerShare FROM UserRole WHERE Id = '${roleId}'`
        )
      ).rows[0] ?? {};
    // Up the hierarchy (at most 20 levels)
    const path = [String(r.Name ?? '')];
    let parent = r.ParentRoleId ? String(r.ParentRoleId) : '';
    for (let i = 0; parent && i < 20; i++) {
      // eslint-disable-next-line no-await-in-loop
      const p: Row =
        (await query(client, `SELECT Name, ParentRoleId FROM UserRole WHERE Id = '${parent}'`)).rows[0] ?? {};
      path.unshift(String(p.Name ?? parent));
      parent = p.ParentRoleId ? String(p.ParentRoleId) : '';
    }
    role = {
      name: String(r.Name ?? ''),
      path: path.join(' › '),
      settings: {
        'Opportunity access (accounts they own)': r.OpportunityAccessForAccountOwner ?? '',
        'Case access (accounts they own)': r.CaseAccessForAccountOwner ?? '',
        'Contact access (accounts they own)': r.ContactAccessForAccountOwner ?? '',
        'May share forecasts':
          r.MayForecastManagerShare === true ? 'yes' : r.MayForecastManagerShare === false ? 'no' : '',
      },
    };
    roleGroupIds = (
      await query(client, `SELECT Id FROM Group WHERE RelatedId = '${roleId}'`).catch(() => ({ rows: [] as Row[] }))
    ).rows.map((g) => String(g.Id));
  }

  const [userShares, groupShares, roleShares, queueObjects] = await Promise.all([
    sharesWith(client, [userId]),
    sharesWith(client, groupIds),
    sharesWith(client, roleGroupIds),
    queueIds.length
      ? query(
          client,
          `SELECT QueueId, Queue.Name, SobjectType FROM QueueSobject WHERE QueueId IN (${quoted(queueIds)})`
        ).catch((e: Error) => {
          notes.push(`Queues: ${e.message}`);
          return { rows: [] as Row[] };
        })
      : Promise.resolve({ rows: [] as Row[] }),
  ]);
  const queues = members.rows
    .filter((m) => m['Group.Type'] === 'Queue')
    .map((m) => ({
      queue: m['Group.Name'],
      objects: queueObjects.rows
        .filter((q) => String(q.QueueId) === String(m.GroupId))
        .map((q) => String(q.SobjectType))
        .sort()
        .join(', '),
    }));
  notes.push(...userShares.notes, ...groupShares.notes, ...roleShares.notes);
  return {
    role,
    roleShares: roleShares.rows,
    userShares: userShares.rows,
    groupShares: groupShares.rows,
    queues,
    notes: [...new Set(notes)],
  };
}

/** Two lists of share counts side by side (object · reason → A, B). */
export function mergeShares(a: Row[], b: Row[]): Row[] {
  const map = new Map<string, Row>();
  for (const r of a)
    map.set(`${String(r.object)}|${String(r.reason)}`, { object: r.object, reason: r.reason, a: r.records, b: '' });
  for (const r of b) {
    const k = `${String(r.object)}|${String(r.reason)}`;
    map.set(k, { ...(map.get(k) ?? { object: r.object, reason: r.reason, a: '' }), b: r.records });
  }
  return [...map.values()].sort(
    (x, y) => String(x.object).localeCompare(String(y.object)) || String(x.reason).localeCompare(String(y.reason))
  );
}
