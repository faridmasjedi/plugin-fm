import type { SalesforceClient } from './client.js';
import { query, type Row } from './query.js';

/**
 * Access › Assign in bulk: several permission sets, permission set groups, public groups and queues, given to (or taken
 * from) several users in one go — a line per user and item, saying what happened.
 */

export type BulkKind = 'Permission set' | 'Permission set group' | 'Public group' | 'Queue';
export type BulkItem = { kind: BulkKind; id: string; label: string };
export type BulkResult = 'added' | 'already had it' | 'removed' | 'did not have it' | 'failed';
export type BulkLine = {
  user: string;
  userId: string;
  item: string;
  kind: BulkKind;
  result: BulkResult;
  error?: string;
};

const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const k15 = (id: string): string => id.slice(0, 15);
const inList = (ids: string[]): string => ids.map((id) => `'${id}'`).join(',');

type CollectionResult = { id?: string; success: boolean; errors: Array<{ message: string }> };

/** Everything that can be given in bulk, for the picker: permission sets, their groups, public groups and queues. */
export async function bulkItems(client: SalesforceClient): Promise<BulkItem[]> {
  const [sets, psgs, groups] = await Promise.all([
    query(
      client,
      "SELECT Id, Label FROM PermissionSet WHERE IsOwnedByProfile = false AND Type != 'Group' ORDER BY Label",
      { maxRows: 10_000 }
    ),
    query(client, 'SELECT Id, MasterLabel FROM PermissionSetGroup ORDER BY MasterLabel', { maxRows: 5000 }),
    query(client, "SELECT Id, Name, Type, OwnerId FROM Group WHERE Type IN ('Regular', 'Queue') ORDER BY Name", {
      maxRows: 20_000,
    }),
  ]);
  return [
    ...sets.rows.map((r) => ({ kind: 'Permission set' as const, id: String(r.Id), label: String(r.Label ?? '') })),
    ...psgs.rows.map((r) => ({
      kind: 'Permission set group' as const,
      id: String(r.Id),
      label: String(r.MasterLabel ?? ''),
    })),
    // A public group owned by a user is a personal group: not offered
    ...groups.rows
      .filter((g) => g.Type === 'Queue' || !String(g.OwnerId ?? '').startsWith('005'))
      .map((g) => ({
        kind: g.Type === 'Queue' ? ('Queue' as const) : ('Public group' as const),
        id: String(g.Id),
        label: String(g.Name ?? ''),
      })),
  ];
}

const USER_FIELDS = 'Id, Name, Username, Email, Profile.Name, UserRole.Name, IsActive';

/** Active users matching a SOQL condition on User (e.g. Profile.Name LIKE '%Sales%'). */
export async function usersWhere(client: SalesforceClient, where: string): Promise<Row[]> {
  const condition = where.trim().replace(/^where\s+/i, '');
  if (!condition) throw new Error("Write a condition, e.g. Profile.Name = 'Standard User'.");
  return (
    await query(client, `SELECT ${USER_FIELDS} FROM User WHERE IsActive = true AND (${condition}) ORDER BY Name`, {
      maxRows: 5000,
    })
  ).rows;
}

/** Active users by a column of Ids, usernames or e-mails (a CSV or Excel file). */
export async function usersByValues(
  client: SalesforceClient,
  column: 'Id' | 'Username' | 'Email',
  values: string[]
): Promise<Row[]> {
  const clean = [...new Set(values.map((v) => v.trim()).filter(Boolean))];
  const rows: Row[] = [];
  for (let i = 0; i < clean.length; i += 300) {
    const list = clean
      .slice(i, i + 300)
      .map((v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`)
      .join(',');
    // eslint-disable-next-line no-await-in-loop
    rows.push(
      ...(
        await query(client, `SELECT ${USER_FIELDS} FROM User WHERE IsActive = true AND ${column} IN (${list})`, {
          maxRows: 5000,
        })
      ).rows
    );
  }
  return rows;
}

async function insertEach(client: SalesforceClient, type: string, records: Row[]): Promise<CollectionResult[]> {
  const out: CollectionResult[] = [];
  for (let i = 0; i < records.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    const res = await client.rest<CollectionResult[]>('POST', '/composite/sobjects', {
      allOrNone: false,
      records: records.slice(i, i + 200).map((r) => ({ attributes: { type }, ...r })),
    });
    out.push(...res);
  }
  return out;
}

async function deleteEach(client: SalesforceClient, ids: string[]): Promise<CollectionResult[]> {
  const out: CollectionResult[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    const res = await client.rest<CollectionResult[]>(
      'DELETE',
      `/composite/sobjects?ids=${ids.slice(i, i + 200).join(',')}&allOrNone=false`
    );
    out.push(...res);
  }
  return out;
}

const message = (r: CollectionResult): string => r.errors.map((e) => e.message).join('; ') || 'failed';

/**
 * Gives (add) or takes back (remove) every item from every user. Permission sets and their groups go through
 * PermissionSetAssignment (an expiry date is possible), public groups and queues through GroupMember. Users who already
 * have it, or never had it, are reported and left alone.
 */
export async function bulkAccess(
  client: SalesforceClient,
  items: BulkItem[],
  users: Array<{ id: string; name: string }>,
  action: 'add' | 'remove',
  expires?: string
): Promise<BulkLine[]> {
  const people = users.filter((u) => ID.test(u.id) && u.id.startsWith('005'));
  if (!people.length) throw new Error('Choose at least one user.');
  if (!items.length) throw new Error('Choose at least one permission set, group or queue.');
  const name = new Map(people.map((u) => [k15(u.id), u.name]));
  const userIds = inList(people.map((u) => u.id));
  const lines: BulkLine[] = [];
  const line = (userId: string, item: BulkItem, result: BulkResult, error?: string): void => {
    lines.push({ user: name.get(k15(userId)) ?? userId, userId, item: item.label, kind: item.kind, result, error });
  };

  // Permission sets and permission set groups
  const access = items.filter((i) => i.kind === 'Permission set' || i.kind === 'Permission set group');
  if (access.length) {
    const sets = access.filter((i) => i.kind === 'Permission set').map((i) => i.id);
    const groups = access.filter((i) => i.kind === 'Permission set group').map((i) => i.id);
    const where = [
      sets.length ? `PermissionSetId IN (${inList(sets)})` : '',
      groups.length ? `PermissionSetGroupId IN (${inList(groups)})` : '',
    ]
      .filter(Boolean)
      .join(' OR ');
    const existing = (
      await query(
        client,
        `SELECT Id, AssigneeId, PermissionSetId, PermissionSetGroupId FROM PermissionSetAssignment WHERE AssigneeId IN (${userIds}) AND (${where})`,
        { maxRows: 50_000 }
      )
    ).rows;
    const has = new Map<string, string>();
    for (const r of existing) {
      const target = String(r.PermissionSetGroupId ?? '') || String(r.PermissionSetId ?? '');
      has.set(`${k15(String(r.AssigneeId))}:${k15(target)}`, String(r.Id));
    }
    const todo: Array<{ user: string; item: BulkItem; id?: string }> = [];
    for (const item of access)
      for (const u of people) {
        const id = has.get(`${k15(u.id)}:${k15(item.id)}`);
        if (action === 'add' ? id : !id) line(u.id, item, action === 'add' ? 'already had it' : 'did not have it');
        else todo.push({ user: u.id, item, id });
      }
    if (action === 'add') {
      const res = await insertEach(
        client,
        'PermissionSetAssignment',
        todo.map((t) => ({
          AssigneeId: t.user,
          ...(t.item.kind === 'Permission set group'
            ? { PermissionSetGroupId: t.item.id }
            : { PermissionSetId: t.item.id }),
          ...(expires ? { ExpirationDate: expires } : {}),
        }))
      );
      todo.forEach((t, n) =>
        line(
          t.user,
          t.item,
          res[n]?.success ? 'added' : 'failed',
          res[n]?.success ? undefined : message(res[n] ?? { success: false, errors: [] })
        )
      );
    } else {
      const res = await deleteEach(
        client,
        todo.map((t) => t.id!)
      );
      todo.forEach((t, n) =>
        line(
          t.user,
          t.item,
          res[n]?.success ? 'removed' : 'failed',
          res[n]?.success ? undefined : message(res[n] ?? { success: false, errors: [] })
        )
      );
    }
  }

  // Public groups and queues
  const groupItems = items.filter((i) => i.kind === 'Public group' || i.kind === 'Queue');
  if (groupItems.length) {
    const existing = (
      await query(
        client,
        `SELECT Id, GroupId, UserOrGroupId FROM GroupMember WHERE UserOrGroupId IN (${userIds}) AND GroupId IN (${inList(
          groupItems.map((g) => g.id)
        )})`,
        { maxRows: 50_000 }
      )
    ).rows;
    const has = new Map(
      existing.map((r) => [`${k15(String(r.UserOrGroupId))}:${k15(String(r.GroupId))}`, String(r.Id)])
    );
    const todo: Array<{ user: string; item: BulkItem; id?: string }> = [];
    for (const item of groupItems)
      for (const u of people) {
        const id = has.get(`${k15(u.id)}:${k15(item.id)}`);
        if (action === 'add' ? id : !id) line(u.id, item, action === 'add' ? 'already had it' : 'did not have it');
        else todo.push({ user: u.id, item, id });
      }
    const res =
      action === 'add'
        ? await insertEach(
            client,
            'GroupMember',
            todo.map((t) => ({ GroupId: t.item.id, UserOrGroupId: t.user }))
          )
        : await deleteEach(
            client,
            todo.map((t) => t.id!)
          );
    todo.forEach((t, n) =>
      line(
        t.user,
        t.item,
        res[n]?.success ? (action === 'add' ? 'added' : 'removed') : 'failed',
        res[n]?.success ? undefined : message(res[n] ?? { success: false, errors: [] })
      )
    );
  }
  return lines.sort((a, b) => a.user.localeCompare(b.user) || a.item.localeCompare(b.item));
}
