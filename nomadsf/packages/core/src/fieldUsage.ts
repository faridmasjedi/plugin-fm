import type { SalesforceClient } from './client.js';
import { query } from './query.js';

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
  filled?: number;
  percent?: number;
};

type RawField = { name: string; label: string; type: string; custom: boolean; filterable: boolean };

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
      .map((f) => ({ name: f.name, label: f.label, type: f.type, custom: f.custom, filterable: f.filterable }))
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
