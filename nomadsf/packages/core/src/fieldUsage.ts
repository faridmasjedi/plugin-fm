import type { SalesforceClient } from './client.js';
import { query, type Row } from './query.js';

/**
 * Field usage before you change or delete a field: how many records fill it, and which
 * components (layouts, flows, Apex, reports…) reference it.
 */

export type FieldInfo = {
  name: string;
  label: string;
  type: string;
  custom: boolean;
  filterable: boolean;
  /** Field-level security applies (false: always visible, e.g. Id, Name, required fields). */
  permissionable?: boolean;
  filled?: number;
  percent?: number;
};

type RawField = {
  name: string;
  label: string;
  type: string;
  custom: boolean;
  filterable: boolean;
  permissionable?: boolean;
};

export async function objectFields(
  client: SalesforceClient,
  sobject: string
): Promise<{ fields: FieldInfo[]; total: number }> {
  if (!/^\w+$/.test(sobject)) throw new Error('Invalid object name.');
  const [describe, count] = await Promise.all([
    client.rest<{ fields: RawField[] }>('GET', `/sobjects/${sobject}/describe`),
    query(client, `SELECT COUNT() FROM ${sobject}`),
  ]);
  return {
    total: count.totalSize,
    fields: describe.fields
      .map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        custom: f.custom,
        filterable: f.filterable,
        permissionable: f.permissionable,
      }))
      .sort((a, b) => Number(b.custom) - Number(a.custom) || a.name.localeCompare(b.name)),
  };
}

const BOOLEAN = new Set(['boolean']);

/** Records with a value per field (one COUNT() per field; booleans count `true`). */
export async function fillRates(
  client: SalesforceClient,
  sobject: string,
  fields: FieldInfo[],
  total: number,
  onField: (field: FieldInfo) => void,
  signal?: AbortSignal
): Promise<void> {
  for (const field of fields) {
    if (signal?.aborted) return;
    if (!field.filterable) continue;
    const condition = BOOLEAN.has(field.type) ? `${field.name} = true` : `${field.name} != null`;
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await query(client, `SELECT COUNT() FROM ${sobject} WHERE ${condition}`);
      const filled = result.totalSize;
      onField({ ...field, filled, percent: total ? Math.round((filled / total) * 1000) / 10 : 0 });
    } catch {
      // some fields cannot be filtered this way (e.g. encrypted); leave them empty
    }
  }
}

/** Tooling DeveloperName: no __c and no namespace prefix (ns__Field__c -> Field). */
export function withoutNamespace(apiName: string): string {
  const base = apiName.replace(/__c$/, '');
  return base.includes('__') ? base.split('__').slice(1).join('__') : base;
}

export type FieldDependency = { type: string; name: string; id: string };

/** Components that reference a custom field (Tooling MetadataComponentDependency). */
export async function fieldDependencies(
  client: SalesforceClient,
  sobject: string,
  field: string
): Promise<FieldDependency[]> {
  if (!/^\w+$/.test(sobject) || !/^\w+__c$/.test(field)) {
    throw new Error('Dependencies can be listed for custom fields only.');
  }
  const developerName = withoutNamespace(field);
  // Custom objects are referenced by their Id in TableEnumOrId; standard objects by name
  let table = sobject;
  if (sobject.endsWith('__c')) {
    const objects = await query(
      client,
      `SELECT Id FROM CustomObject WHERE DeveloperName = '${withoutNamespace(sobject)}'`,
      { tooling: true }
    );
    table = String(objects.rows[0]?.Id ?? sobject);
  }
  const fields = await query(
    client,
    `SELECT Id FROM CustomField WHERE TableEnumOrId = '${table}' AND DeveloperName = '${developerName}'`,
    { tooling: true }
  );
  const id = fields.rows[0]?.Id;
  if (!id) throw new Error(`${sobject}.${field} not found in the Tooling API.`);
  const result = await query(
    client,
    `SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentId = '${String(
      id
    )}'`,
    { tooling: true, maxRows: 2000 }
  );
  return result.rows
    .map((r) => ({
      type: String(r.MetadataComponentType),
      name: String(r.MetadataComponentName),
      id: String(r.MetadataComponentId),
    }))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
}

export type FieldAccess = {
  kind: 'Profile' | 'Permission set' | 'Permission set group';
  name: string;
  access: 'Read & edit' | 'Read only' | 'No access';
};

/**
 * Who can see / edit a field: every profile, permission set and permission set group (also those
 * without access), from FieldPermissions. Fields without field-level security are visible to all.
 */
export async function fieldAccess(client: SalesforceClient, sobject: string, field: string): Promise<FieldAccess[]> {
  if (!/^\w+$/.test(sobject) || !/^\w+$/.test(field)) throw new Error('Invalid object or field.');
  const [perms, holders] = await Promise.all([
    query(
      client,
      `SELECT ParentId, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE SobjectType = '${sobject}' AND Field = '${sobject}.${field}'`,
      { maxRows: 10_000 }
    ),
    permissionHolders(client),
  ]);
  const level = new Map<string, FieldAccess['access']>();
  for (const r of perms.rows) {
    level.set(
      String(r.ParentId).slice(0, 15),
      r.PermissionsEdit === true ? 'Read & edit' : r.PermissionsRead === true ? 'Read only' : 'No access'
    );
  }
  const order = { 'Read & edit': 0, 'Read only': 1, 'No access': 2 };
  return holders
    .map((h) => ({ kind: h.kind, name: h.name, access: level.get(h.id.slice(0, 15)) ?? ('No access' as const) }))
    .sort((a, b) => order[a.access] - order[b.access] || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

/** The same in every org: the profile's name, the group's or permission set's API name (with its namespace). */
export type PermissionHolder = { id: string; kind: FieldAccess['kind']; name: string; api?: string };

/** A PermissionSet row (with Name, NamespacePrefix, Type, IsOwnedByProfile, Profile.Name, PermissionSetGroup.DeveloperName) → its key across orgs. */
export const permissionSetKey = (r: Row): string =>
  r.IsOwnedByProfile === true
    ? `Profile:${String(r['Profile.Name'] ?? '')}`
    : r.Type === 'Group'
    ? `Permission set group:${String(r['PermissionSetGroup.DeveloperName'] ?? r.Name ?? '')}`
    : `Permission set:${r.NamespacePrefix ? `${String(r.NamespacePrefix)}__` : ''}${String(r.Name ?? '')}`;

/**
 * Every profile, permission set and permission set group, by the PermissionSet record that holds
 * its permissions (a profile's own one; a group's calculated one). Repeated names get the licence,
 * then the end of the Id, so they can be told apart.
 */
export async function permissionHolders(client: SalesforceClient): Promise<PermissionHolder[]> {
  const result = await query(
    client,
    'SELECT Id, Name, NamespacePrefix, Label, Type, IsOwnedByProfile, Profile.Name, Profile.UserLicense.Name, PermissionSetGroup.MasterLabel, PermissionSetGroup.DeveloperName FROM PermissionSet ORDER BY Label',
    { maxRows: 10_000 }
  );
  const rows = result.rows.map((r) => {
    const profile = r.IsOwnedByProfile === true;
    const group = r.Type === 'Group';
    return {
      id: String(r.Id),
      kind: (profile ? 'Profile' : group ? 'Permission set group' : 'Permission set') as PermissionHolder['kind'],
      name: String(
        (profile ? r['Profile.Name'] : group ? r['PermissionSetGroup.MasterLabel'] ?? r.Label : r.Label) ?? ''
      ),
      licence: profile ? String(r['Profile.UserLicense.Name'] ?? '') : '',
      api: permissionSetKey(r),
    };
  });
  return rows.map((r) => {
    const same = rows.filter((x) => x.kind === r.kind && x.name === r.name);
    if (same.length < 2) return { id: r.id, kind: r.kind, name: r.name, api: r.api };
    const sameLicence = same.filter((x) => x.licence === r.licence).length > 1;
    const suffix = r.licence && !sameLicence ? r.licence : `${r.licence ? `${r.licence}, ` : ''}…${r.id.slice(9, 15)}`;
    return { id: r.id, kind: r.kind, name: `${r.name} (${suffix})`, api: r.api };
  });
}

const PS_ID = /^0PS\w{12}(\w{3})?$/;

export type ObjectAccessRow = {
  object: string;
  read: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  viewAll: boolean;
  modifyAll: boolean;
};

export async function objectAccessOf(client: SalesforceClient, permissionSetId: string): Promise<ObjectAccessRow[]> {
  if (!PS_ID.test(permissionSetId)) throw new Error('Invalid permission set Id.');
  const result = await query(
    client,
    `SELECT SobjectType, PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords FROM ObjectPermissions WHERE ParentId = '${permissionSetId}' ORDER BY SobjectType`,
    { maxRows: 10_000 }
  );
  return result.rows.map((r) => ({
    object: String(r.SobjectType),
    read: r.PermissionsRead === true,
    create: r.PermissionsCreate === true,
    edit: r.PermissionsEdit === true,
    delete: r.PermissionsDelete === true,
    viewAll: r.PermissionsViewAllRecords === true,
    modifyAll: r.PermissionsModifyAllRecords === true,
  }));
}

export type FieldAccessRow = { object: string; field: string; read: boolean; edit: boolean };

export async function fieldAccessOf(
  client: SalesforceClient,
  permissionSetId: string,
  sobject?: string
): Promise<FieldAccessRow[]> {
  if (!PS_ID.test(permissionSetId)) throw new Error('Invalid permission set Id.');
  if (sobject && !/^\w+$/.test(sobject)) throw new Error('Invalid object.');
  const result = await query(
    client,
    `SELECT SobjectType, Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE ParentId = '${permissionSetId}'${
      sobject ? ` AND SobjectType = '${sobject}'` : ''
    } ORDER BY SobjectType, Field`,
    { maxRows: 50_000 }
  );
  return result.rows.map((r) => ({
    object: String(r.SobjectType),
    field: String(r.Field).split('.').slice(1).join('.'),
    read: r.PermissionsRead === true,
    edit: r.PermissionsEdit === true,
  }));
}

export type SystemPermission = { api: string; label: string; enabled: boolean };

/** User & system permissions (the Permissions* checkboxes of the permission set), in chunks to keep URLs short. */
export async function systemPermissionsOf(
  client: SalesforceClient,
  permissionSetId: string
): Promise<SystemPermission[]> {
  if (!PS_ID.test(permissionSetId)) throw new Error('Invalid permission set Id.');
  const describe = await client.rest<{ fields: Array<{ name: string; label: string; type: string }> }>(
    'GET',
    '/sobjects/PermissionSet/describe'
  );
  const fields = describe.fields.filter((f) => f.type === 'boolean' && f.name.startsWith('Permissions'));
  const out: SystemPermission[] = [];
  for (let i = 0; i < fields.length; i += 150) {
    const chunk = fields.slice(i, i + 150);
    // eslint-disable-next-line no-await-in-loop
    const row =
      (
        await query(
          client,
          `SELECT ${chunk.map((f) => f.name).join(', ')} FROM PermissionSet WHERE Id = '${permissionSetId}'`
        )
      ).rows[0] ?? {};
    for (const f of chunk)
      out.push({ api: f.name.replace(/^Permissions/, ''), label: f.label, enabled: row[f.name] === true });
  }
  return out.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.label.localeCompare(b.label));
}
