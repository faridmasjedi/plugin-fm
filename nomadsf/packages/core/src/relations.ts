import type { SalesforceClient } from './client.js';
import { sobjectForId } from './inspector.js';
import { describeGlobal, query, type Row } from './query.js';

/**
 * What is around a record: the records its lookups point to (one level, the next on request) and
 * the relationships pointing to it — listed from the describe, their records read only when asked.
 */

export type RecordLookup = {
  field: string;
  label: string;
  object: string;
  id: string;
  name: string;
};

export type ChildRelation = {
  object: string;
  objectLabel: string;
  /** The lookup on the child that points to the record. */
  field: string;
  /** History, feed, sharing, Created by / Last modified by: hidden unless asked for. */
  system: boolean;
  /** A user's permission sets, licenses and groups: listed first on a user. */
  access: boolean;
};

type Described = {
  name: string;
  nameField: string;
  fields: Array<{ name: string; label: string; type: string; referenceTo: string[] }>;
  childRelationships: Array<{ childSObject: string; field: string }>;
};

const ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const AUDIT = /^(CreatedById|LastModifiedById|InsertedById)$/;
const SYSTEM_OBJECT =
  /(History\d*|Feed|Share|ChangeEvent|__hd|__Tag)$|^(ProcessInstance|EntitySubscription|TopicAssignment|FeedComment|FeedItem|ContentDocumentLink|AttachedContentDocument|CombinedAttachment|NoteAndAttachment|RecordAction|FlowRecordRelation)$/;
const ACCESS = ['PermissionSetAssignment', 'PermissionSetLicenseAssign', 'GroupMember'];

const describes = new WeakMap<SalesforceClient, Map<string, Promise<Described>>>();
function describe(client: SalesforceClient, object: string): Promise<Described> {
  let cache = describes.get(client);
  if (!cache) describes.set(client, (cache = new Map()));
  let d = cache.get(object);
  if (!d) {
    if (!/^\w+$/.test(object)) return Promise.reject(new Error('Invalid object name.'));
    type Raw = {
      name: string;
      fields: Array<{ name: string; label: string; type: string; referenceTo?: string[]; nameField?: boolean }>;
      childRelationships?: Array<{ childSObject: string; field: string }>;
    };
    d = client.rest<Raw>('GET', `/sobjects/${object}/describe`).then((r) => ({
      name: r.name,
      nameField: r.fields.find((f) => f.nameField)?.name ?? 'Id',
      fields: r.fields.map((f) => ({ ...f, referenceTo: f.referenceTo ?? [] })),
      childRelationships: r.childRelationships ?? [],
    }));
    d.catch(() => cache!.delete(object));
    cache.set(object, d);
  }
  return d;
}

/** The records a record's lookups point to, with their names (Created by / Last modified by aside). */
export async function recordLookups(client: SalesforceClient, object: string, id: string): Promise<RecordLookup[]> {
  if (!ID.test(id)) throw new Error('Invalid record Id.');
  const d = await describe(client, object);
  const lookups = d.fields.filter((f) => f.type === 'reference' && f.referenceTo.length && !AUDIT.test(f.name));
  if (!lookups.length) return [];
  const row: Row =
    (await query(client, `SELECT ${lookups.map((f) => f.name).join(', ')} FROM ${object} WHERE Id = '${id}'`))
      .rows[0] ?? {};
  const found = lookups.filter((f) => typeof row[f.name] === 'string' && ID.test(String(row[f.name])));
  return Promise.all(
    found.map(async (f) => {
      const pid = String(row[f.name]);
      const target =
        f.referenceTo.length === 1 ? f.referenceTo[0] : await sobjectForId(client, pid).catch(() => f.referenceTo[0]);
      let name = '';
      try {
        const nameField = (await describe(client, target)).nameField;
        name = String(
          (await query(client, `SELECT ${nameField} FROM ${target} WHERE Id = '${pid}'`)).rows[0]?.[nameField] ?? ''
        );
      } catch {
        // Not readable for this user: shown with its Id
      }
      return { field: f.name, label: f.label, object: target, id: pid, name };
    })
  );
}

/** The relationships pointing to records of an object (nothing is counted: records are read on Show). */
export async function childRelations(client: SalesforceClient, object: string): Promise<ChildRelation[]> {
  const [d, objects] = await Promise.all([describe(client, object), describeGlobal(client)]);
  const labels = new Map(objects.map((o) => [o.name, o.label]));
  return d.childRelationships
    .filter(
      (r, i, all) =>
        labels.has(r.childSObject) &&
        all.findIndex((x) => x.childSObject === r.childSObject && x.field === r.field) === i
    )
    .map((r) => ({
      object: r.childSObject,
      objectLabel: labels.get(r.childSObject) ?? r.childSObject,
      field: r.field,
      system: AUDIT.test(r.field) || SYSTEM_OBJECT.test(r.childSObject),
      access: object === 'User' && ACCESS.includes(r.childSObject),
    }))
    .sort((a, b) => Number(b.access) - Number(a.access) || a.objectLabel.trim().localeCompare(b.objectLabel.trim()));
}

/** What tells a record apart where the object has no name: a user's access by what it gives. */
const NAMES: Record<string, { fields: string; where?: string; name: (r: Row) => string }> = {
  PermissionSetAssignment: {
    fields: 'PermissionSet.Label, PermissionSetGroup.MasterLabel, ExpirationDate',
    // The profile's own permission set is the profile, not an assignment to copy
    where: 'PermissionSet.IsOwnedByProfile = false',
    name: (r) =>
      r['PermissionSetGroup.MasterLabel']
        ? `Permission set group: ${String(r['PermissionSetGroup.MasterLabel'])}`
        : `Permission set: ${String(r['PermissionSet.Label'] ?? '')}`,
  },
  PermissionSetLicenseAssign: {
    fields: 'PermissionSetLicense.MasterLabel',
    name: (r) => `License: ${String(r['PermissionSetLicense.MasterLabel'] ?? '')}`,
  },
  GroupMember: {
    fields: 'Group.Name, Group.Type',
    name: (r) => `${r['Group.Type'] === 'Queue' ? 'Queue' : 'Group'}: ${String(r['Group.Name'] ?? '')}`,
  },
};

/** The SOQL for the records of one relationship (Show, and Query). */
export async function childrenSoql(
  client: SalesforceClient,
  relation: Pick<ChildRelation, 'object' | 'field'>,
  id: string,
  limit = 200
): Promise<string> {
  if (!ID.test(id)) throw new Error('Invalid record Id.');
  const special = NAMES[relation.object];
  const d = await describe(client, relation.object);
  const order = d.fields.some((f) => f.name === 'CreatedDate') ? ' ORDER BY CreatedDate DESC' : '';
  const select = special
    ? ['Id', special.fields]
    : [...new Set(['Id', d.nameField, ...(order ? ['CreatedDate'] : [])])];
  const where = `${relation.field} = '${id}'${special?.where ? ` AND ${special.where}` : ''}`;
  return `SELECT ${select.join(', ')} FROM ${relation.object} WHERE ${where}${order} LIMIT ${limit}`;
}

/** The records of one relationship (newest first), each with a name to show and keep in a basket. */
export async function childRecords(
  client: SalesforceClient,
  relation: Pick<ChildRelation, 'object' | 'field'>,
  id: string,
  limit = 200
): Promise<Array<{ id: string; name: string; row: Row }>> {
  const rows = (await query(client, await childrenSoql(client, relation, id, limit))).rows;
  const nameField = (await describe(client, relation.object)).nameField;
  const special = NAMES[relation.object];
  return rows.map((r) => ({
    id: String(r.Id),
    name: special ? special.name(r) : String(r[nameField] ?? r.Id),
    row: r,
  }));
}

/**
 * How many records point to the record through each relationship (system ones aside), a few
 * queries at a time; relationships without records are left out.
 */
export async function relationCounts(
  client: SalesforceClient,
  object: string,
  id: string,
  onProgress?: (done: number, total: number) => void
): Promise<Array<ChildRelation & { count: number }>> {
  if (!ID.test(id)) throw new Error('Invalid record Id.');
  const relations = (await childRelations(client, object)).filter((r) => !r.system);
  const out: Array<ChildRelation & { count: number }> = [];
  let done = 0;
  for (let i = 0; i < relations.length; i += 10)
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      relations.slice(i, i + 10).map(async (r) => {
        try {
          const n = (await query(client, `SELECT COUNT() FROM ${r.object} WHERE ${r.field} = '${id}'`)).totalSize;
          if (n > 0) out.push({ ...r, count: n });
        } catch {
          // Some objects cannot be filtered this way (or are not visible to the user)
        } finally {
          onProgress?.(++done, relations.length);
        }
      })
    );
  return out.sort((a, b) => a.objectLabel.trim().localeCompare(b.objectLabel.trim()) || a.field.localeCompare(b.field));
}
