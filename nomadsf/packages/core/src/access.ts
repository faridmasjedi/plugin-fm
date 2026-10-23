import type { SalesforceClient } from './client.js';
import { query, type QueryResult, type Row } from './query.js';

/** Access: login history, setup audit trail, permission set (group) assignments. */

const days = (n: number): number => Math.max(1, Math.min(180, Math.floor(n)));
const soqlString = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const isId = (value: string, prefix?: string): boolean =>
  /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(value) && (!prefix || value.startsWith(prefix));

export async function loginHistory(client: SalesforceClient, lastDays: number): Promise<QueryResult> {
  const history = await query(
    client,
    `SELECT Id, LoginTime, UserId, LoginType, Status, SourceIp, CountryIso, Application, Browser, Platform, LoginUrl FROM LoginHistory WHERE LoginTime = LAST_N_DAYS:${days(
      lastDays
    )} ORDER BY LoginTime DESC`,
    { maxRows: 50_000 }
  );
  const userIds = [...new Set(history.rows.map((r) => String(r.UserId)))];
  const users = new Map<string, Row>();
  for (let i = 0; i < userIds.length; i += 300) {
    const list = userIds
      .slice(i, i + 300)
      .filter((id) => isId(id))
      .map((id) => `'${id}'`)
      .join(',');
    if (!list) continue;
    // eslint-disable-next-line no-await-in-loop
    const result = await query(client, `SELECT Id, Username, Name FROM User WHERE Id IN (${list})`);
    for (const u of result.rows) users.set(String(u.Id), u);
  }
  const rows = history.rows.map((r) => ({
    LoginTime: r.LoginTime,
    Username: users.get(String(r.UserId))?.Username ?? '',
    Name: users.get(String(r.UserId))?.Name ?? '',
    ...r,
  }));
  return {
    ...history,
    rows,
    columns: ['LoginTime', 'Username', 'Name', ...history.columns.filter((c) => c !== 'LoginTime')],
  };
}

export function auditTrail(client: SalesforceClient, lastDays: number): Promise<QueryResult> {
  return query(
    client,
    `SELECT CreatedDate, CreatedBy.Username, CreatedBy.Name, Action, Section, Display, DelegateUser FROM SetupAuditTrail WHERE CreatedDate = LAST_N_DAYS:${days(
      lastDays
    )} ORDER BY CreatedDate DESC`,
    { maxRows: 50_000 }
  );
}

export type AccessTarget = { kind: 'permset' | 'group'; id: string; label: string; name: string };

export async function listPermissionSets(client: SalesforceClient): Promise<AccessTarget[]> {
  const [groups, sets] = await Promise.all([
    query(client, 'SELECT Id, DeveloperName, MasterLabel FROM PermissionSetGroup ORDER BY MasterLabel', {
      maxRows: 5000,
    }),
    query(
      client,
      "SELECT Id, Name, Label FROM PermissionSet WHERE IsOwnedByProfile = false AND Type != 'Group' ORDER BY Label",
      { maxRows: 10_000 }
    ),
  ]);
  return [
    ...groups.rows.map((g) => ({
      kind: 'group' as const,
      id: String(g.Id),
      name: String(g.DeveloperName),
      label: String(g.MasterLabel),
    })),
    ...sets.rows.map((p) => ({
      kind: 'permset' as const,
      id: String(p.Id),
      name: String(p.Name),
      label: String(p.Label),
    })),
  ];
}

const targetField = (target: Pick<AccessTarget, 'kind' | 'id'>): string => {
  if (!isId(target.id)) throw new Error('Invalid permission set id.');
  return target.kind === 'group' ? 'PermissionSetGroupId' : 'PermissionSetId';
};

export function assignments(client: SalesforceClient, target: Pick<AccessTarget, 'kind' | 'id'>): Promise<QueryResult> {
  return query(
    client,
    `SELECT Id, AssigneeId, Assignee.Username, Assignee.Name, Assignee.Profile.Name, Assignee.IsActive, ExpirationDate FROM PermissionSetAssignment WHERE ${targetField(
      target
    )} = '${target.id}' ORDER BY Assignee.Name`,
    { maxRows: 50_000 }
  );
}

export type UserFilter = { usernames?: string[]; profile?: string; role?: string; publicGroup?: string };

/** Active users by usernames, profile, role or public group (direct members). */
export async function findUsers(client: SalesforceClient, by: UserFilter): Promise<Row[]> {
  let where: string;
  if (by.usernames?.length) where = `Username IN (${by.usernames.map((u) => `'${soqlString(u.trim())}'`).join(',')})`;
  else if (by.profile) where = `Profile.Name = '${soqlString(by.profile)}'`;
  else if (by.role) where = `UserRole.Name = '${soqlString(by.role)}'`;
  else if (by.publicGroup) {
    const g = soqlString(by.publicGroup);
    where = `Id IN (SELECT UserOrGroupId FROM GroupMember WHERE Group.DeveloperName = '${g}' OR Group.Name = '${g}')`;
  } else throw new Error('Choose users by usernames, profile, role or public group.');
  return (
    await query(
      client,
      `SELECT Id, Username, Name, Profile.Name FROM User WHERE IsActive = true AND (${where}) ORDER BY Name`,
      { maxRows: 50_000 }
    )
  ).rows;
}

type CollectionResult = { id?: string; success: boolean; errors: Array<{ message: string }> };

/** Assigns a permission set or group; users who already have it are skipped. */
export async function assignAccess(
  client: SalesforceClient,
  target: Pick<AccessTarget, 'kind' | 'id'>,
  userIds: string[],
  expirationDate?: string
): Promise<{ assigned: number; skipped: number; errors: string[] }> {
  const field = targetField(target);
  const existing = await query(
    client,
    `SELECT AssigneeId FROM PermissionSetAssignment WHERE ${field} = '${target.id}'`,
    { maxRows: 50_000 }
  );
  const have = new Set(existing.rows.map((r) => String(r.AssigneeId)));
  const todo = [...new Set(userIds)].filter((id) => isId(id, '005') && !have.has(id));
  const errors: string[] = [];
  let assigned = 0;
  for (let i = 0; i < todo.length; i += 200) {
    const records = todo.slice(i, i + 200).map((AssigneeId) => ({
      attributes: { type: 'PermissionSetAssignment' },
      AssigneeId,
      [field]: target.id,
      ...(expirationDate ? { ExpirationDate: expirationDate } : {}),
    }));
    // eslint-disable-next-line no-await-in-loop
    const results = await client.rest<CollectionResult[]>('POST', '/composite/sobjects', { allOrNone: false, records });
    for (const r of results) {
      if (r.success) assigned++;
      else errors.push(r.errors.map((e) => e.message).join('; '));
    }
  }
  return { assigned, skipped: userIds.length - todo.length, errors };
}

export async function removeAccess(
  client: SalesforceClient,
  assignmentIds: string[]
): Promise<{ removed: number; errors: string[] }> {
  const ids = assignmentIds.filter((id) => isId(id, '0Pa'));
  const errors: string[] = [];
  let removed = 0;
  for (let i = 0; i < ids.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    const results = await client.rest<CollectionResult[]>(
      'DELETE',
      `/composite/sobjects?ids=${ids.slice(i, i + 200).join(',')}&allOrNone=false`
    );
    for (const r of results) {
      if (r.success) removed++;
      else errors.push(r.errors.map((e) => e.message).join('; '));
    }
  }
  return { removed, errors };
}

export type UserMatch = {
  Id: string;
  Name: string;
  Username: string;
  Email: string;
  Profile: string;
  IsActive: boolean;
  LastLoginDate?: string;
};

const soqlText = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Users by Id, username, email or (part of the) name; at most 50. */
export async function searchUsers(client: SalesforceClient, text: string): Promise<UserMatch[]> {
  const term = text.trim();
  if (!term) return [];
  const where = /^005[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/.test(term)
    ? `Id = '${term}'`
    : `Username LIKE '%${soqlText(term)}%' OR Email LIKE '%${soqlText(term)}%' OR Name LIKE '%${soqlText(term)}%'`;
  const result = await query(
    client,
    `SELECT Id, Name, Username, Email, Profile.Name, IsActive, LastLoginDate FROM User WHERE ${where} ORDER BY IsActive DESC, Name LIMIT 50`
  );
  return result.rows.map((r) => ({
    Id: String(r.Id),
    Name: String(r.Name ?? ''),
    Username: String(r.Username ?? ''),
    Email: String(r.Email ?? ''),
    Profile: String(r['Profile.Name'] ?? ''),
    IsActive: r.IsActive === true,
    LastLoginDate: r.LastLoginDate ? String(r.LastLoginDate) : undefined,
  }));
}

/** Freeze state of a user (UserLogin.IsFrozen). */
export async function userLogin(
  client: SalesforceClient,
  userId: string
): Promise<{ id: string; frozen: boolean } | undefined> {
  if (!/^005\w{12,15}$/.test(userId)) throw new Error('Invalid user Id.');
  const row = (await query(client, `SELECT Id, IsFrozen FROM UserLogin WHERE UserId = '${userId}'`)).rows[0];
  return row ? { id: String(row.Id), frozen: row.IsFrozen === true } : undefined;
}

export async function setFrozen(client: SalesforceClient, userLoginId: string, frozen: boolean): Promise<void> {
  if (!/^\w{15,18}$/.test(userLoginId)) throw new Error('Invalid Id.');
  await client.rest('PATCH', `/sobjects/UserLogin/${userLoginId}`, { IsFrozen: frozen });
}

export async function setActive(client: SalesforceClient, userId: string, active: boolean): Promise<void> {
  if (!/^005\w{12,15}$/.test(userId)) throw new Error('Invalid user Id.');
  await client.rest('PATCH', `/sobjects/User/${userId}`, { IsActive: active });
}
