import type { SalesforceClient } from './client.js';
import { sobjectForId } from './inspector.js';
import { describeGlobal, query, type Row } from './query.js';

/**
 * A record with everything around it: the records its lookups point to, and theirs (parents,
 * grandparents…), and the records that point to it (children), counted per relationship.
 */

export type ParentNode = {
  /** The lookup on the record below (AccountId, OwnerId…). */
  field: string;
  fieldLabel: string;
  object: string;
  id: string;
  name: string;
  /** Already shown higher in the tree (a loop, or the same user twice): not followed again. */
  repeated?: boolean;
  parents: ParentNode[];
};

export type ChildRelation = {
  object: string;
  /** The lookup on the child that points to the record. */
  field: string;
  /** The relationship name (Contacts); lookups like OwnerId have none on the parent's side. */
  relationship: string;
  count: number;
  /** History, feed, sharing, Created by / Last modified by: hidden unless asked for. */
  system: boolean;
};

type Described = {
  name: string;
  label: string;
  nameField: string;
  fields: Array<{ name: string; label: string; type: string; referenceTo: string[]; relationshipName?: string | null }>;
  childRelationships: Array<{ childSObject: string; field: string; relationshipName?: string | null }>;
};

const ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const AUDIT = new Set(['CreatedById', 'LastModifiedById']);
const SYSTEM_OBJECT =
  /(History\d*|Feed|Share|ChangeEvent|__hd|__Tag)$|^(ProcessInstance|ProcessInstanceHistory|EntitySubscription|TopicAssignment|FeedComment|FeedItem|ContentDocumentLink|AttachedContentDocument|CombinedAttachment|NoteAndAttachment|RecordAction|CollaborationGroupRecord|FlowRecordRelation|UserEmailPreferredPerson)$/;

const describes = new WeakMap<SalesforceClient, Map<string, Promise<Described>>>();
function describe(client: SalesforceClient, object: string): Promise<Described> {
  let cache = describes.get(client);
  if (!cache) describes.set(client, (cache = new Map()));
  let d = cache.get(object);
  if (!d) {
    if (!/^\w+$/.test(object)) return Promise.reject(new Error('Invalid object name.'));
    d = client
      .rest<Described & { fields: Array<{ nameField?: boolean }> }>('GET', `/sobjects/${object}/describe`)
      .then((r) => ({
        name: r.name,
        label: r.label,
        nameField: (r.fields as Array<{ name: string; nameField?: boolean }>).find((f) => f.nameField)?.name ?? 'Id',
        fields: r.fields.map((f) => ({ ...f, referenceTo: f.referenceTo ?? [] })),
        childRelationships: r.childRelationships ?? [],
      }));
    d.catch(() => cache!.delete(object));
    cache.set(object, d);
  }
  return d;
}

/** The name field of an object (Name, CaseNumber, Subject…; Id when it has none). */
export async function nameFieldOf(client: SalesforceClient, object: string): Promise<string> {
  return (await describe(client, object)).nameField;
}

/** Runs the tasks a few at a time (many relationships, one query each). */
async function inBatches<T, R>(items: T[], size: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size)
    // eslint-disable-next-line no-await-in-loop
    out.push(...(await Promise.all(items.slice(i, i + size).map(task))));
  return out;
}

/**
 * The records a record's lookups point to, and theirs, `depth` levels up. Created by / Last
 * modified by only with `audit`; a record already in the tree is shown but not followed again.
 */
export async function recordParents(
  client: SalesforceClient,
  object: string,
  id: string,
  options: { depth?: number; audit?: boolean } = {}
): Promise<{ name: string; parents: ParentNode[] }> {
  if (!ID.test(id)) throw new Error('Invalid record Id.');
  const depth = options.depth ?? 3;
  const seen = new Set<string>([id.slice(0, 15)]);

  const read = async (
    obj: string,
    recordId: string,
    level: number
  ): Promise<{ name: string; parents: ParentNode[] }> => {
    const d = await describe(client, obj);
    const lookups = d.fields.filter(
      (f) => f.type === 'reference' && f.referenceTo.length && (options.audit || !AUDIT.has(f.name))
    );
    const select = [...new Set([d.nameField, ...(level < depth ? lookups.map((f) => f.name) : [])])];
    const row: Row =
      (await query(client, `SELECT ${select.join(', ')} FROM ${obj} WHERE Id = '${recordId}'`)).rows[0] ?? {};
    const name = String(row[d.nameField] ?? '');
    if (level >= depth) return { name, parents: [] };
    const found = lookups.filter((f) => typeof row[f.name] === 'string' && ID.test(String(row[f.name])));
    const parents = await Promise.all(
      found.map(async (f): Promise<ParentNode | null> => {
        const pid = String(row[f.name]);
        const target =
          f.referenceTo.length === 1 ? f.referenceTo[0] : await sobjectForId(client, pid).catch(() => f.referenceTo[0]);
        const node: ParentNode = { field: f.name, fieldLabel: f.label, object: target, id: pid, name: '', parents: [] };
        if (seen.has(pid.slice(0, 15))) return { ...node, repeated: true };
        seen.add(pid.slice(0, 15));
        try {
          const up = await read(target, pid, level + 1);
          return { ...node, name: up.name, parents: up.parents };
        } catch {
          // Not readable for this user (or not queryable): shown with its Id only
          return node;
        }
      })
    );
    return { name, parents: parents.filter((p): p is ParentNode => p !== null) };
  };
  return read(object, id, 0);
}

const isSystem = (r: { childSObject: string; field: string }): boolean =>
  AUDIT.has(r.field) || r.field === 'InsertedById' || SYSTEM_OBJECT.test(r.childSObject);

/**
 * Every relationship pointing to the record, with how many records point to it through each. System
 * relations (history, feed, sharing, Created by…: thousands on a user) only with `system`.
 */
export async function recordChildren(
  client: SalesforceClient,
  object: string,
  id: string,
  options: { system?: boolean; onProgress?: (done: number, total: number) => void } = {}
): Promise<ChildRelation[]> {
  if (!ID.test(id)) throw new Error('Invalid record Id.');
  const [d, queryable] = await Promise.all([
    describe(client, object),
    describeGlobal(client).then((list) => new Set(list.map((o) => o.name))),
  ]);
  const relations = d.childRelationships.filter(
    (r, i, all) =>
      queryable.has(r.childSObject) &&
      (options.system || !isSystem(r)) &&
      all.findIndex((x) => x.childSObject === r.childSObject && x.field === r.field) === i
  );
  let done = 0;
  const counted = await inBatches(relations, 10, async (r): Promise<ChildRelation | null> => {
    try {
      const result = await query(client, `SELECT COUNT() FROM ${r.childSObject} WHERE ${r.field} = '${id}'`);
      return {
        object: r.childSObject,
        field: r.field,
        relationship: r.relationshipName ?? '',
        count: result.totalSize,
        system: isSystem(r),
      };
    } catch {
      // Some objects cannot be filtered this way (or are not visible to the user)
      return null;
    } finally {
      options.onProgress?.(++done, relations.length);
    }
  });
  return counted
    .filter((c): c is ChildRelation => c !== null)
    .sort((a, b) => b.count - a.count || a.object.localeCompare(b.object));
}

/** The SOQL for the children of one relationship (Query, the list under a relationship). */
export async function childrenSoql(
  client: SalesforceClient,
  relation: Pick<ChildRelation, 'object' | 'field'>,
  id: string,
  limit = 200
): Promise<string> {
  if (!ID.test(id)) throw new Error('Invalid record Id.');
  const d = await describe(client, relation.object);
  const order = d.fields.some((f) => f.name === 'CreatedDate') ? ' ORDER BY CreatedDate DESC' : '';
  const select = [...new Set(['Id', d.nameField, ...(order ? ['CreatedDate'] : [])])];
  return `SELECT ${select.join(', ')} FROM ${relation.object} WHERE ${relation.field} = '${id}'${order} LIMIT ${limit}`;
}

/** The records of one relationship (newest first). */
export async function childRecords(
  client: SalesforceClient,
  relation: Pick<ChildRelation, 'object' | 'field'>,
  id: string,
  limit = 200
): Promise<Row[]> {
  return (await query(client, await childrenSoql(client, relation, id, limit))).rows;
}

/** The parents tree as rows (a sheet, a table): level, the path of lookups, the record. */
export function flattenParents(nodes: ParentNode[], level = 1, path = ''): Row[] {
  return nodes.flatMap((n) => {
    const here = path ? `${path}.${n.field}` : n.field;
    return [
      { Level: level, Path: here, Object: n.object, Id: n.id, Name: n.repeated ? '(shown above)' : n.name },
      ...flattenParents(n.parents, level + 1, here),
    ];
  });
}
