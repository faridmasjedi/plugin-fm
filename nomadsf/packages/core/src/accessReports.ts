import type { SalesforceClient } from './client.js';
import { query, type Row } from './query.js';

/** Org-wide access: every user with what they have, and who can use one object or field. */

/** Powerful permissions shown as columns (from the profile, permission sets and groups together). */
export const POWER_PERMISSIONS: Array<[string, string]> = [
  ['ModifyAllData', 'Modify All Data'],
  ['ViewAllData', 'View All Data'],
  ['ManageUsers', 'Manage Users'],
  ['AuthorApex', 'Author Apex'],
  ['CustomizeApplication', 'Customize Application'],
  ['ApiEnabled', 'API Enabled'],
  ['ExportReport', 'Export Reports'],
];

const quoted = (ids: string[]): string => ids.map((id) => `'${id}'`).join(', ');
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/** The permission fields this org has (some depend on licenses and features). */
async function permissionFieldsOf(client: SalesforceClient, wanted: string[]): Promise<string[]> {
  const describe = await client.rest<{ fields: Array<{ name: string }> }>('GET', '/sobjects/PermissionSet/describe');
  const have = new Set(describe.fields.map((f) => f.name));
  return wanted.map((w) => `Permissions${w}`).filter((f) => have.has(f));
}

/**
 * Every user (active ones, or all) with profile, role, license, permission sets, permission set groups, permission
 * set licenses, last login, and a ✓ per powerful permission they get from any source.
 */
export async function usersAccessMap(client: SalesforceClient, { activeOnly = true } = {}): Promise<Row[]> {
  const fields = await permissionFieldsOf(
    client,
    POWER_PERMISSIONS.map(([p]) => p)
  );
  const active = activeOnly ? ' WHERE IsActive = true' : '';
  const [users, assignments, licenses] = await Promise.all([
    query(
      client,
      `SELECT Id, Name, Username, IsActive, UserType, Profile.Name, Profile.UserLicense.Name, UserRole.Name, LastLoginDate FROM User${active} ORDER BY Name`,
      { maxRows: 50_000 }
    ),
    query(
      client,
      `SELECT AssigneeId, PermissionSet.Label, PermissionSet.IsOwnedByProfile, PermissionSet.Type, PermissionSetGroup.MasterLabel${fields
        .map((f) => `, PermissionSet.${f}`)
        .join('')} FROM PermissionSetAssignment${activeOnly ? ' WHERE Assignee.IsActive = true' : ''}`,
      { maxRows: 200_000 }
    ),
    query(
      client,
      `SELECT AssigneeId, PermissionSetLicense.MasterLabel FROM PermissionSetLicenseAssign${
        activeOnly ? ' WHERE Assignee.IsActive = true' : ''
      }`,
      { maxRows: 200_000 }
    ).catch(() => ({ rows: [] as Row[] })),
  ]);
  type Acc = { sets: Set<string>; groups: Set<string>; licenses: Set<string>; power: Set<string> };
  const of = new Map<string, Acc>();
  const acc = (id: string): Acc => {
    let a = of.get(id);
    if (!a) {
      a = { sets: new Set(), groups: new Set(), licenses: new Set(), power: new Set() };
      of.set(id, a);
    }
    return a;
  };
  for (const r of assignments.rows) {
    const a = acc(String(r.AssigneeId));
    if (r['PermissionSetGroup.MasterLabel']) a.groups.add(text(r['PermissionSetGroup.MasterLabel']));
    else if (r['PermissionSet.IsOwnedByProfile'] !== true && r['PermissionSet.Type'] !== 'Group')
      a.sets.add(text(r['PermissionSet.Label']));
    for (const f of fields) if (r[`PermissionSet.${f}`] === true) a.power.add(f.replace(/^Permissions/, ''));
  }
  for (const r of licenses.rows) acc(String(r.AssigneeId)).licenses.add(text(r['PermissionSetLicense.MasterLabel']));
  const sorted = (s?: Set<string>): string => [...(s ?? [])].sort().join(', ');
  return users.rows.map((u) => {
    const a = of.get(String(u.Id));
    const row: Row = {
      Id: u.Id,
      Name: u.Name,
      Username: u.Username,
      Active: u.IsActive,
      Type: u.UserType ?? '',
      Profile: u['Profile.Name'] ?? '',
      License: u['Profile.UserLicense.Name'] ?? '',
      Role: u['UserRole.Name'] ?? '',
      PermissionSets: sorted(a?.sets),
      Groups: sorted(a?.groups),
      PermissionSetLicenses: sorted(a?.licenses),
      LastLogin: u.LastLoginDate ?? '',
    };
    for (const [p, label] of POWER_PERMISSIONS) row[label] = a?.power.has(p) ? '✓' : '';
    return row;
  });
}

export type ObjectAccessUser = Row;

/**
 * Who can use an object (and a field): each user with read / create / edit / delete / view all / modify all, the
 * field's read / edit, and through what (profile, permission set or group; View All Data / Modify All Data).
 */
export async function whoCanAccess(
  client: SalesforceClient,
  sobject: string,
  field?: string
): Promise<{ rows: Row[]; notes: string[] }> {
  if (!/^\w+$/.test(sobject)) throw new Error('Invalid object.');
  if (field && !/^\w+$/.test(field)) throw new Error('Invalid field.');
  const notes: string[] = [];
  const [objects, fieldRows, power] = await Promise.all([
    query(
      client,
      `SELECT ParentId, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name, Parent.Type, Parent.PermissionSetGroup.MasterLabel, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE SobjectType = '${sobject}'`,
      { maxRows: 50_000 }
    ),
    field
      ? query(
          client,
          `SELECT ParentId, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE Field = '${sobject}.${field}'`,
          { maxRows: 50_000 }
        )
      : Promise.resolve({ rows: [] as Row[] }),
    // View All Data / Modify All Data reach every object
    permissionFieldsOf(client, ['ViewAllData', 'ModifyAllData']).then((f) =>
      f.length
        ? query(
            client,
            `SELECT Id, Label, IsOwnedByProfile, Profile.Name, Type, PermissionSetGroup.MasterLabel, ${f.join(
              ', '
            )} FROM PermissionSet WHERE ${f.map((x) => `${x} = true`).join(' OR ')}`,
            { maxRows: 10_000 }
          )
        : { rows: [] as Row[] }
    ),
  ]);
  const nameOf = (r: Row, prefix: string): string =>
    r[`${prefix}IsOwnedByProfile`] === true
      ? `Profile: ${text(r[`${prefix}Profile.Name`])}`
      : r[`${prefix}Type`] === 'Group'
      ? `Group: ${text(r[`${prefix}PermissionSetGroup.MasterLabel`] ?? r[`${prefix}Label`])}`
      : `Permission set: ${text(r[`${prefix}Label`])}`;
  type Grant = {
    source: string;
    read: boolean;
    create: boolean;
    edit: boolean;
    del: boolean;
    viewAll: boolean;
    modifyAll: boolean;
  };
  const grants = new Map<string, Grant>();
  for (const r of objects.rows)
    grants.set(String(r.ParentId), {
      source: nameOf(r, 'Parent.'),
      read: r.PermissionsRead === true,
      create: r.PermissionsCreate === true,
      edit: r.PermissionsEdit === true,
      del: r.PermissionsDelete === true,
      viewAll: r.PermissionsViewAllRecords === true,
      modifyAll: r.PermissionsModifyAllRecords === true,
    });
  for (const r of power.rows) {
    const modify = r.PermissionsModifyAllData === true;
    const known = grants.get(String(r.Id));
    const all: Grant = {
      source: `${nameOf(r, '')} (${modify ? 'Modify All Data' : 'View All Data'})`,
      read: true,
      create: modify || Boolean(known?.create),
      edit: modify || Boolean(known?.edit),
      del: modify || Boolean(known?.del),
      viewAll: true,
      modifyAll: modify || Boolean(known?.modifyAll),
    };
    grants.set(String(r.Id), all);
  }
  const fieldGrant = new Map(
    fieldRows.rows.map((r) => [
      String(r.ParentId),
      { read: r.PermissionsRead === true, edit: r.PermissionsEdit === true },
    ])
  );
  const parents = [...new Set([...grants.keys(), ...fieldGrant.keys()])];
  // Their users (assignments), in pages of 200 holders
  type UserAccessSum = { user: Row; sources: string[]; g: Omit<Grant, 'source'>; fr: boolean; fe: boolean };
  const byUser = new Map<string, UserAccessSum>();
  for (let i = 0; i < parents.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    const page = await query(
      client,
      `SELECT AssigneeId, Assignee.Name, Assignee.Username, Assignee.Profile.Name, PermissionSetId FROM PermissionSetAssignment WHERE Assignee.IsActive = true AND PermissionSetId IN (${quoted(
        parents.slice(i, i + 200)
      )})`,
      { maxRows: 200_000 }
    );
    for (const a of page.rows) {
      const id = String(a.AssigneeId);
      const g = grants.get(String(a.PermissionSetId));
      const f = fieldGrant.get(String(a.PermissionSetId));
      const u =
        byUser.get(id) ??
        ({
          user: {
            Name: a['Assignee.Name'],
            Username: a['Assignee.Username'],
            Profile: a['Assignee.Profile.Name'] ?? '',
          },
          sources: [],
          g: { read: false, create: false, edit: false, del: false, viewAll: false, modifyAll: false },
          fr: false,
          fe: false,
        } satisfies UserAccessSum);
      if (g && (g.read || g.edit || g.viewAll)) {
        u.sources.push(g.source);
        u.g = {
          read: u.g.read || g.read,
          create: u.g.create || g.create,
          edit: u.g.edit || g.edit,
          del: u.g.del || g.del,
          viewAll: u.g.viewAll || g.viewAll,
          modifyAll: u.g.modifyAll || g.modifyAll,
        };
      }
      if (f) {
        u.fr = u.fr || f.read || f.edit;
        u.fe = u.fe || f.edit;
      }
      // View All Data / Modify All Data read and edit every field
      if (g?.source.includes('All Data')) {
        u.fr = true;
        u.fe = u.fe || g.source.includes('Modify All Data');
      }
      byUser.set(id, u);
    }
  }
  const yes = (v: boolean): string => (v ? '✓' : '');
  const rows = [...byUser.entries()]
    .filter(([, u]) => u.g.read || u.fr)
    .map(([id, u]) => ({
      Id: id,
      Name: u.user.Name,
      Username: u.user.Username,
      Profile: u.user.Profile,
      Read: yes(u.g.read),
      Create: yes(u.g.create),
      Edit: yes(u.g.edit),
      Delete: yes(u.g.del),
      ViewAll: yes(u.g.viewAll),
      ModifyAll: yes(u.g.modifyAll),
      ...(field ? { FieldRead: yes(u.fr && u.g.read), FieldEdit: yes(u.fe && u.g.edit) } : {}),
      Through: [...new Set(u.sources)].join('; '),
    }))
    .sort((a, b) => String(a.Name).localeCompare(String(b.Name)));
  notes.push('Object and field permissions only: which records each user sees also depends on sharing.');
  return { rows, notes };
}
