import type { SalesforceClient } from './client.js';
import type { IngestOperation } from './bulk.js';

/**
 * Before a Bulk insert / update / upsert / delete: which columns of the file Salesforce will
 * accept for the operation (createable on insert, updateable on update; formulas never), so
 * columns that would fail every row can be left out up front.
 */

export type FieldRule = {
  name: string;
  label: string;
  type: string;
  createable: boolean;
  updateable: boolean;
  calculated: boolean;
  externalId: boolean;
  idLookup: boolean;
  relationshipName?: string;
};

export async function fieldRules(client: SalesforceClient, sobject: string): Promise<FieldRule[]> {
  if (!/^\w+$/.test(sobject)) throw new Error('Invalid object name.');
  const describe = await client.rest<{ fields: Array<FieldRule & { relationshipName?: string | null }> }>(
    'GET',
    `/sobjects/${sobject}/describe`
  );
  return describe.fields.map((f) => ({
    name: f.name,
    label: f.label,
    type: f.type,
    createable: f.createable,
    updateable: f.updateable,
    calculated: f.calculated,
    externalId: f.externalId,
    idLookup: f.idLookup,
    relationshipName: f.relationshipName ?? undefined,
  }));
}

export type ColumnCheck = {
  column: string;
  /** Salesforce accepts the column for this operation. */
  ok: boolean;
  /** Why not (or a note), for the person. */
  reason?: string;
  /** Field label when the column is a field. */
  label?: string;
};

export type ColumnReport = { columns: ColumnCheck[]; problems: string[] };

/** Checks every column of the file for the operation; `problems` are blocking (e.g. a missing Id). */
export function checkColumns(
  rules: FieldRule[],
  columns: string[],
  operation: IngestOperation,
  externalIdField?: string
): ColumnReport {
  const byName = new Map(rules.map((r) => [r.name.toLowerCase(), r]));
  const relationships = new Map(
    rules.filter((r) => r.relationshipName).map((r) => [r.relationshipName!.toLowerCase(), r])
  );
  const hasId = columns.some((c) => c.toLowerCase() === 'id');
  const problems: string[] = [];
  const deleting = operation === 'delete' || operation === 'hardDelete';

  if ((operation === 'update' || deleting) && !hasId)
    problems.push(`${operation === 'update' ? 'Update' : 'Delete'} needs an Id column.`);
  if (operation === 'upsert') {
    const key = externalIdField?.trim();
    if (!key) problems.push('Upsert needs the external Id field to match on.');
    else if (!columns.some((c) => c.toLowerCase() === key.toLowerCase()))
      problems.push(`The file has no ${key} column to match on.`);
  }

  const checks = columns.map((column): ColumnCheck => {
    const lower = column.toLowerCase();
    if (deleting) {
      return lower === 'id'
        ? { column, ok: true }
        : { column, ok: false, reason: 'Delete uses only the Id column; ignored.' };
    }
    if (lower === 'id') {
      return operation === 'insert'
        ? { column, ok: false, reason: 'Insert creates new records; Ids are not allowed.' }
        : { column, ok: true, reason: 'Matches the records' };
    }
    // Relationship by external Id, e.g. Account.External_Id__c or Owner.Username
    if (column.includes('.')) {
      const [relationship] = column.split('.');
      const lookup = relationships.get(relationship.toLowerCase());
      if (!lookup) return { column, ok: false, reason: `${relationship} is not a relationship of this object.` };
      const allowed =
        operation === 'insert'
          ? lookup.createable
          : operation === 'update'
          ? lookup.updateable
          : lookup.createable || lookup.updateable;
      return allowed
        ? { column, ok: true, label: lookup.label, reason: 'Related record matched by this field' }
        : { column, ok: false, label: lookup.label, reason: `${lookup.label} cannot be set on ${operation}.` };
    }
    const rule = byName.get(lower);
    if (!rule) return { column, ok: false, reason: 'Not a field of this object (check the API name).' };
    const label = rule.label;
    if (operation === 'upsert' && externalIdField && lower === externalIdField.toLowerCase()) {
      return rule.externalId || rule.idLookup
        ? { column, ok: true, label, reason: 'Matches the records' }
        : { column, ok: false, label, reason: `${rule.name} is not an external Id field.` };
    }
    if (rule.calculated)
      return { column, ok: false, label, reason: 'Formula field: Salesforce calculates it and it cannot be set.' };
    // Full names (User, Contact, Lead…) are built from their parts
    const settable =
      operation === 'insert'
        ? rule.createable
        : operation === 'update'
        ? rule.updateable
        : rule.createable || rule.updateable;
    if (lower === 'name' && !settable && byName.has('firstname') && byName.has('lastname')) {
      return {
        column,
        ok: false,
        label,
        reason: 'Full name, built from FirstName and LastName: send those columns instead.',
      };
    }
    if (operation === 'insert' && !rule.createable)
      return { column, ok: false, label, reason: 'Cannot be set on insert.' };
    if (operation === 'update' && !rule.updateable)
      return { column, ok: false, label, reason: 'Cannot be changed on update.' };
    if (operation === 'upsert' && !rule.createable && !rule.updateable)
      return { column, ok: false, label, reason: 'Cannot be set.' };
    if (operation === 'upsert' && !rule.updateable)
      return { column, ok: true, label, reason: 'Set only when a new record is created.' };
    return { column, ok: true, label };
  });

  if (!deleting && !checks.some((c) => c.ok && c.column.toLowerCase() !== 'id'))
    problems.push('No column can be set for this operation.');
  return { columns: checks, problems };
}

/** Bulk API 2.0 CSV value that empties a field (a blank value leaves it unchanged). */
export const BULK_NULL = '#N/A';

/**
 * Update file from edited records: only rows with a change, with Id and the changed columns.
 * A cleared cell becomes #N/A so Salesforce empties the field instead of leaving it as it was.
 */
export function changedRecords(
  editable: string[],
  rows: Array<{ id: number; values: Record<string, string> }>,
  original: Map<number, Record<string, string>>
): { columns: string[]; rows: Array<Record<string, string>>; cells: number } {
  const changedColumns = new Set<string>();
  const out: Array<Record<string, string>> = [];
  let cells = 0;
  for (const row of rows) {
    const before = original.get(row.id) ?? {};
    const changes: Record<string, string> = {};
    for (const column of editable) {
      const now = row.values[column] ?? '';
      if (now === (before[column] ?? '')) continue;
      changes[column] = now === '' ? BULK_NULL : now;
      changedColumns.add(column);
      cells++;
    }
    if (Object.keys(changes).length) {
      if (!row.values.Id) throw new Error('Every record needs its Id to be updated.');
      out.push({ Id: row.values.Id, ...changes });
    }
  }
  return { columns: ['Id', ...editable.filter((c) => changedColumns.has(c))], rows: out, cells };
}
