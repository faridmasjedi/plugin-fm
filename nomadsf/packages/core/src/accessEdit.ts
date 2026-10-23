import type { SalesforceClient } from './client.js';
import { query, type Row } from './query.js';

/** Changing what a permission set or custom profile allows, and which permission sets a group holds. */

const PS_ID = /^0PS\w{12}(\w{3})?$/;
const NAME = /^\w+$/;
const FIELD = /^\w+\.\w+$/;

export type ObjectAccess = {
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
};

/** One change: a user / system permission (api without "Permissions"), an object's access or a field's. */
export type AccessChange =
  | { kind: 'system'; api: string; label?: string; enabled: boolean }
  | { kind: 'object'; object: string; access: ObjectAccess }
  | { kind: 'field'; field: string; read: boolean; edit: boolean };

export const NO_ACCESS: ObjectAccess = {
  read: false,
  create: false,
  edit: false,
  delete: false,
  viewAll: false,
  modifyAll: false,
};

/** What Salesforce requires: Modify all → everything; View all, Create, Edit → Read; Delete → Read and Edit. */
export function normalizeObjectAccess(a: ObjectAccess): ObjectAccess {
  if (a.modifyAll) return { read: true, create: true, edit: true, delete: true, viewAll: true, modifyAll: true };
  const edit = a.edit || a.delete;
  return { ...a, edit, read: a.read || a.create || edit || a.viewAll };
}

export const describeChange = (c: AccessChange): string =>
  c.kind === 'system'
    ? `${c.label ?? c.api}: ${c.enabled ? 'on' : 'off'}`
    : c.kind === 'object'
    ? `${c.object}: ${accessText(c.access) || 'no access'}`
    : `${c.field}: ${c.edit ? 'Read, Edit' : c.read ? 'Read' : 'no access'}`;

export const accessText = (a: ObjectAccess): string =>
  [
    a.read && 'Read',
    a.create && 'Create',
    a.edit && 'Edit',
    a.delete && 'Delete',
    a.viewAll && 'View all',
    a.modifyAll && 'Modify all',
  ]
    .filter(Boolean)
    .join(', ');

/** "Read, Edit, View all" → the flags (as comparisons show them). */
export const accessFromText = (text: string): ObjectAccess => {
  const has = (word: string): boolean => text.split(', ').includes(word);
  return {
    read: has('Read'),
    create: has('Create'),
    edit: has('Edit'),
    delete: has('Delete'),
    viewAll: has('View all'),
    modifyAll: has('Modify all'),
  };
};

export type PermissionSetInfo = {
  id: string;
  /** Standard profiles and standard permission sets cannot be changed. */
  editable: boolean;
  kind: 'Profile' | 'Permission set' | 'Permission set group';
  profileId?: string;
  groupId?: string;
  reason?: string;
};

/** What a PermissionSet record (of a permission set, a profile or a group) is, and whether it can be changed here. */
export async function permissionSetInfo(client: SalesforceClient, permissionSetId: string): Promise<PermissionSetInfo> {
  if (!PS_ID.test(permissionSetId)) throw new Error('Invalid permission set Id.');
  const r: Row =
    (
      await query(
        client,
        `SELECT Id, IsCustom, IsOwnedByProfile, ProfileId, Type, PermissionSetGroupId FROM PermissionSet WHERE Id = '${permissionSetId}'`
      )
    ).rows[0] ?? {};
  if (!r.Id) throw new Error('Permission set not found.');
  if (r.Type === 'Group')
    return {
      id: permissionSetId,
      editable: false,
      kind: 'Permission set group',
      groupId: String(r.PermissionSetGroupId ?? ''),
      reason: "A group's permissions come from its permission sets: change those, or the sets in the group.",
    };
  const kind = r.IsOwnedByProfile === true ? 'Profile' : 'Permission set';
  const custom = r.IsCustom === true;
  return {
    id: permissionSetId,
    editable: custom,
    kind,
    profileId: kind === 'Profile' ? String(r.ProfileId ?? '') : undefined,
    reason: custom ? undefined : `A standard ${kind.toLowerCase()} cannot be changed.`,
  };
}

export type ApplyResult = { applied: number; failures: Array<{ change: string; error: string }> };

const flags = (a: ObjectAccess): Row => ({
  PermissionsRead: a.read,
  PermissionsCreate: a.create,
  PermissionsEdit: a.edit,
  PermissionsDelete: a.delete,
  PermissionsViewAllRecords: a.viewAll,
  PermissionsModifyAllRecords: a.modifyAll,
});
const quoted = (list: string[]): string => list.map((x) => `'${x}'`).join(', ');

/**
 * Applies the changes to a custom permission set or custom profile: user / system permissions on the record (the
 * Profile for a profile), object and field access as ObjectPermissions / FieldPermissions rows (created, changed,
 * or removed when nothing is left). Each failure is reported; the rest still goes through.
 */
export async function applyAccessChanges(
  client: SalesforceClient,
  permissionSetId: string,
  changes: AccessChange[]
): Promise<ApplyResult> {
  const info = await permissionSetInfo(client, permissionSetId);
  if (!info.editable) throw new Error(info.reason ?? 'This cannot be changed.');
  const result: ApplyResult = { applied: 0, failures: [] };
  const attempt = async (change: AccessChange | AccessChange[], run: () => Promise<unknown>): Promise<void> => {
    const list = Array.isArray(change) ? change : [change];
    try {
      await run();
      result.applied += list.length;
    } catch (e) {
      for (const c of list) result.failures.push({ change: describeChange(c), error: (e as Error).message });
    }
  };

  const system = changes.filter((c): c is Extract<AccessChange, { kind: 'system' }> => c.kind === 'system');
  for (const c of system) if (!NAME.test(c.api)) throw new Error(`Invalid permission: ${c.api}`);
  if (system.length) {
    const body = Object.fromEntries(system.map((c) => [`Permissions${c.api}`, c.enabled]));
    await attempt(system, () =>
      info.kind === 'Profile'
        ? client.rest('PATCH', `/sobjects/Profile/${info.profileId}`, body)
        : client.rest('PATCH', `/sobjects/PermissionSet/${permissionSetId}`, body)
    );
  }

  const objects = changes.filter((c): c is Extract<AccessChange, { kind: 'object' }> => c.kind === 'object');
  for (const c of objects) if (!NAME.test(c.object)) throw new Error(`Invalid object: ${c.object}`);
  if (objects.length) {
    const existing = new Map(
      (
        await query(
          client,
          `SELECT Id, SobjectType FROM ObjectPermissions WHERE ParentId = '${permissionSetId}' AND SobjectType IN (${quoted(
            objects.map((c) => c.object)
          )})`
        )
      ).rows.map((r) => [String(r.SobjectType).toLowerCase(), String(r.Id)])
    );
    for (const c of objects) {
      const access = normalizeObjectAccess(c.access);
      const id = existing.get(c.object.toLowerCase());
      // eslint-disable-next-line no-await-in-loop
      await attempt(c, () =>
        !access.read
          ? id
            ? client.rest('DELETE', `/sobjects/ObjectPermissions/${id}`)
            : Promise.resolve()
          : id
          ? client.rest('PATCH', `/sobjects/ObjectPermissions/${id}`, flags(access))
          : client.rest('POST', '/sobjects/ObjectPermissions', {
              ParentId: permissionSetId,
              SobjectType: c.object,
              ...flags(access),
            })
      );
    }
  }

  const fields = changes.filter((c): c is Extract<AccessChange, { kind: 'field' }> => c.kind === 'field');
  for (const c of fields) if (!FIELD.test(c.field)) throw new Error(`Invalid field: ${c.field}`);
  if (fields.length) {
    const existing = new Map(
      (
        await query(
          client,
          `SELECT Id, Field FROM FieldPermissions WHERE ParentId = '${permissionSetId}' AND Field IN (${quoted(
            fields.map((c) => c.field)
          )})`
        )
      ).rows.map((r) => [String(r.Field).toLowerCase(), String(r.Id)])
    );
    for (const c of fields) {
      const read = c.read || c.edit;
      const id = existing.get(c.field.toLowerCase());
      const body = { PermissionsRead: read, PermissionsEdit: c.edit };
      // eslint-disable-next-line no-await-in-loop
      await attempt(c, () =>
        !read
          ? id
            ? client.rest('DELETE', `/sobjects/FieldPermissions/${id}`)
            : Promise.resolve()
          : id
          ? client.rest('PATCH', `/sobjects/FieldPermissions/${id}`, body)
          : client.rest('POST', '/sobjects/FieldPermissions', {
              ParentId: permissionSetId,
              SobjectType: c.field.split('.')[0],
              Field: c.field,
              ...body,
            })
      );
    }
  }
  return result;
}

// ---------- permission set groups ----------

export type GroupMember = { componentId: string; permissionSetId: string; label: string; name: string };

/** The permission sets in a permission set group (and its muting permission set, if any). */
export async function groupPermissionSets(
  client: SalesforceClient,
  groupId: string
): Promise<{ members: GroupMember[]; status: string }> {
  if (!/^0PG\w{12}(\w{3})?$/.test(groupId)) throw new Error('Invalid permission set group Id.');
  const [members, group] = await Promise.all([
    query(
      client,
      `SELECT Id, PermissionSetId, PermissionSet.Label, PermissionSet.Name FROM PermissionSetGroupComponent WHERE PermissionSetGroupId = '${groupId}' ORDER BY PermissionSet.Label`
    ),
    query(client, `SELECT Status FROM PermissionSetGroup WHERE Id = '${groupId}'`),
  ]);
  return {
    members: members.rows.map((r) => ({
      componentId: String(r.Id),
      permissionSetId: String(r.PermissionSetId),
      label: String(r['PermissionSet.Label'] ?? ''),
      name: String(r['PermissionSet.Name'] ?? ''),
    })),
    status: String(group.rows[0]?.Status ?? ''),
  };
}

/** Adds a permission set to a group; Salesforce then recalculates the group. */
export async function addToGroup(client: SalesforceClient, groupId: string, permissionSetId: string): Promise<void> {
  if (!/^0PG\w{12}(\w{3})?$/.test(groupId) || !PS_ID.test(permissionSetId)) throw new Error('Invalid Id.');
  await client.rest('POST', '/sobjects/PermissionSetGroupComponent', {
    PermissionSetGroupId: groupId,
    PermissionSetId: permissionSetId,
  });
}

/** Removes a permission set from a group (by the PermissionSetGroupComponent Id). */
export async function removeFromGroup(client: SalesforceClient, componentId: string): Promise<void> {
  if (!/^\w{15}(\w{3})?$/.test(componentId)) throw new Error('Invalid Id.');
  await client.rest('DELETE', `/sobjects/PermissionSetGroupComponent/${componentId}`);
}
