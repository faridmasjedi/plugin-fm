import type { SalesforceClient } from './client.js';
import { describeGlobal, query, type Row } from './query.js';

/** Field history of a record, and an object's schema: fields, relationships, record types. */

const NAME = /^\w+$/;
const ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

type DescribeField = {
  name: string;
  label: string;
  type: string;
  length?: number;
  precision?: number;
  scale?: number;
  nillable?: boolean;
  createable?: boolean;
  updateable?: boolean;
  defaultedOnCreate?: boolean;
  unique?: boolean;
  externalId?: boolean;
  calculated?: boolean;
  calculatedFormula?: string | null;
  custom?: boolean;
  referenceTo?: string[];
  relationshipName?: string | null;
  inlineHelpText?: string | null;
  picklistValues?: Array<{ value: string; label: string; active: boolean; defaultValue?: boolean }>;
};
type Describe = {
  name: string;
  label: string;
  labelPlural?: string;
  keyPrefix?: string | null;
  custom?: boolean;
  createable?: boolean;
  updateable?: boolean;
  deletable?: boolean;
  queryable?: boolean;
  fields: DescribeField[];
  childRelationships?: Array<{
    childSObject: string;
    field: string;
    relationshipName?: string | null;
    cascadeDelete?: boolean;
  }>;
  recordTypeInfos?: Array<{
    name: string;
    developerName?: string;
    active?: boolean;
    defaultRecordTypeMapping?: boolean;
    master?: boolean;
    recordTypeId?: string;
  }>;
};

const describe = (client: SalesforceClient, name: string): Promise<Describe> => {
  if (!NAME.test(name)) throw new Error('Invalid object name.');
  return client.rest<Describe>('GET', `/sobjects/${name}/describe`);
};

// ---------- record history ----------

/** The history object of an object (AccountHistory, OpportunityFieldHistory, Invoice__History) and its parent field. */
export async function historyObjectOf(
  client: SalesforceClient,
  sobject: string
): Promise<{ object: string; parentField: string } | undefined> {
  if (!NAME.test(sobject)) throw new Error('Invalid object name.');
  const names = new Set((await describeGlobal(client)).map((s) => s.name.toLowerCase()));
  const candidates = sobject.endsWith('__c')
    ? [`${sobject.slice(0, -3)}__History`]
    : [`${sobject}History`, `${sobject}FieldHistory`];
  const object = candidates.find((c) => names.has(c.toLowerCase()));
  if (!object) return undefined;
  const fields = (await describe(client, object)).fields;
  const parent =
    fields.find((f) => f.name !== 'CreatedById' && (f.referenceTo ?? []).includes(sobject))?.name ??
    fields.find((f) => f.name === 'ParentId')?.name;
  return parent ? { object, parentField: parent } : undefined;
}

export type HistoryEntry = { when: string; field: string; from: string; to: string; by: string };

/** Field changes of one record, newest first (needs field history tracking on the object). */
export async function recordHistory(
  client: SalesforceClient,
  sobject: string,
  recordId: string
): Promise<{ object?: string; entries: HistoryEntry[] }> {
  if (!ID.test(recordId)) throw new Error('Invalid record Id.');
  const history = await historyObjectOf(client, sobject);
  if (!history) return { entries: [] };
  const result = await query(
    client,
    `SELECT Field, OldValue, NewValue, CreatedDate, CreatedBy.Name FROM ${history.object} WHERE ${history.parentField} = '${recordId}' ORDER BY CreatedDate DESC LIMIT 500`
  );
  const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
  return {
    object: history.object,
    entries: result.rows.map((r: Row) => ({
      when: text(r.CreatedDate),
      field: text(r.Field),
      from: text(r.OldValue),
      to: text(r.NewValue),
      by: text(r['CreatedBy.Name']),
    })),
  };
}

// ---------- schema ----------

export type SchemaField = {
  name: string;
  label: string;
  type: string;
  length: string;
  required: boolean;
  unique: boolean;
  externalId: boolean;
  formula: string;
  custom: boolean;
  referenceTo: string;
  relationship: string;
  helpText: string;
  picklist: string[];
};

export type SchemaInfo = {
  name: string;
  label: string;
  labelPlural: string;
  keyPrefix: string;
  custom: boolean;
  access: string;
  fields: SchemaField[];
  parents: Array<{ field: string; to: string; relationship: string }>;
  children: Array<{ object: string; field: string; relationship: string; cascadeDelete: boolean }>;
  recordTypes: Array<{ name: string; developerName: string; active: boolean; isDefault: boolean }>;
};

export async function objectSchema(client: SalesforceClient, name: string): Promise<SchemaInfo> {
  const d = await describe(client, name);
  const size = (f: DescribeField): string =>
    f.type === 'double' || f.type === 'currency' || f.type === 'percent'
      ? f.precision
        ? `${f.precision},${f.scale ?? 0}`
        : ''
      : f.length
      ? String(f.length)
      : '';
  const fields = d.fields
    .map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      length: size(f),
      required: f.nillable === false && f.createable !== false && !f.defaultedOnCreate && f.type !== 'boolean',
      unique: Boolean(f.unique),
      externalId: Boolean(f.externalId),
      formula: f.calculated ? f.calculatedFormula ?? '(formula)' : '',
      custom: Boolean(f.custom),
      referenceTo: (f.referenceTo ?? []).join(', '),
      relationship: f.relationshipName ?? '',
      helpText: f.inlineHelpText ?? '',
      picklist: (f.picklistValues ?? []).filter((p) => p.active).map((p) => p.value),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return {
    name: d.name,
    label: d.label,
    labelPlural: d.labelPlural ?? '',
    keyPrefix: d.keyPrefix ?? '',
    custom: Boolean(d.custom),
    access: [d.queryable && 'read', d.createable && 'create', d.updateable && 'edit', d.deletable && 'delete']
      .filter(Boolean)
      .join(', '),
    fields,
    parents: d.fields
      .filter((f) => f.type === 'reference' && (f.referenceTo ?? []).length)
      .map((f) => ({ field: f.name, to: (f.referenceTo ?? []).join(', '), relationship: f.relationshipName ?? '' })),
    children: (d.childRelationships ?? [])
      .filter((c) => c.relationshipName)
      .map((c) => ({
        object: c.childSObject,
        field: c.field,
        relationship: c.relationshipName ?? '',
        cascadeDelete: Boolean(c.cascadeDelete),
      })),
    recordTypes: (d.recordTypeInfos ?? [])
      .filter((r) => !r.master)
      .map((r) => ({
        name: r.name,
        developerName: r.developerName ?? '',
        active: r.active !== false,
        isDefault: Boolean(r.defaultRecordTypeMapping),
      })),
  };
}
