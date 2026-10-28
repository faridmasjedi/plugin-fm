import type { SalesforceClient } from './client.js';
import { findSameUser, sameUsername } from './accessCompare.js';
import { parseCsv, toCsv } from './csv.js';
import { query, type Row } from './query.js';

/**
 * A user "all together" in one CSV (Section, Name, Value): their fields, lookups by name (profile,
 * role, manager…), permission sets and groups, licenses, public groups and queues. Kept from one
 * org, compared with any other (names, not Ids), and applied to make the user the same again.
 */

const ID = /^005[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/;
const soqlText = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export type SnapshotSection =
  | 'info'
  | 'field'
  | 'lookup'
  | 'permissionSet'
  | 'permissionSetGroup'
  | 'license'
  | 'group';
export type SnapshotLine = { Section: SnapshotSection; Name: string; Value: string };

/** Fields that describe the user, not their history: no system, audit or login fields. */
const SKIP =
  /^(Id|LastLoginDate|LastPasswordChangeDate|CreatedDate|CreatedById|LastModifiedDate|LastModifiedById|SystemModstamp|LastViewedDate|LastReferencedDate|FullPhotoUrl|SmallPhotoUrl|MediumPhotoUrl|BannerPhotoUrl|SmallBannerPhotoUrl|MediumBannerPhotoUrl|OfflineTrialExpirationDate|OfflinePdaTrialExpirationDate|NumberOfFailedLogins|SuAccessExpirationDate|SuOrgAdminExpirationDate|ForecastEnabled|UserPermissions.*|OutOfOfficeMessage)$/;

type FieldInfo = { name: string; type: string; updateable: boolean; createable: boolean; referenceTo: string[] };

async function userFields(client: SalesforceClient): Promise<FieldInfo[]> {
  const d = await client.rest<{ fields: FieldInfo[] }>('GET', '/sobjects/User/describe');
  return d.fields.filter(
    (f) =>
      !SKIP.test(f.name) &&
      !['address', 'location', 'base64'].includes(f.type) &&
      (f.updateable || f.name === 'Username' || f.name === 'Name')
  );
}

/** How a record is named in a snapshot: users by username, everything else by Name. */
const nameFieldOf = (sobject: string): string =>
  sobject === 'User' ? 'Username' : sobject === 'Group' ? 'DeveloperName' : 'Name';

const psKey = (r: Row, prefix = 'PermissionSet.'): string =>
  `${r[`${prefix}NamespacePrefix`] ? `${String(r[`${prefix}NamespacePrefix`])}__` : ''}${String(
    r[`${prefix}Name`] ?? ''
  )}`;

/** Everything about a user, as snapshot lines. */
export async function takeUserSnapshot(
  client: SalesforceClient,
  userId: string,
  orgLabel = ''
): Promise<SnapshotLine[]> {
  if (!ID.test(userId)) throw new Error('Invalid user Id.');
  const fields = await userFields(client);
  const user: Row =
    (await query(client, `SELECT ${fields.map((f) => f.name).join(', ')} FROM User WHERE Id = '${userId}'`)).rows[0] ??
    {};
  if (!user.Username) throw new Error('User not found.');
  const lines: SnapshotLine[] = [
    { Section: 'info', Name: 'org', Value: orgLabel },
    { Section: 'info', Name: 'taken', Value: new Date().toISOString() },
    { Section: 'info', Name: 'user', Value: String(user.Username) },
  ];
  for (const f of fields.filter((x) => !x.referenceTo.length)) {
    const v = user[f.name];
    lines.push({ Section: 'field', Name: f.name, Value: v === null || v === undefined ? '' : String(v) });
  }
  // Lookups by the name of what they point to: ProfileId → "System Administrator", ManagerId → a username
  for (const f of fields.filter((x) => x.referenceTo.length)) {
    const id = String(user[f.name] ?? '');
    let value = '';
    if (id) {
      const target = f.referenceTo.length === 1 ? f.referenceTo[0] : id.startsWith('005') ? 'User' : f.referenceTo[0];
      const nameField = nameFieldOf(target);
      // eslint-disable-next-line no-await-in-loop
      const row = (
        await query(client, `SELECT ${nameField} FROM ${target} WHERE Id = '${id}'`).catch(() => ({
          rows: [] as Row[],
        }))
      ).rows[0];
      value = row ? String(row[nameField] ?? '') : '';
    }
    lines.push({ Section: 'lookup', Name: f.name, Value: value });
  }
  const [assignments, licenses, groups] = await Promise.all([
    query(
      client,
      `SELECT PermissionSet.Name, PermissionSet.NamespacePrefix, PermissionSet.IsOwnedByProfile, PermissionSet.Type, PermissionSetGroup.DeveloperName, PermissionSetGroupId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}'`,
      { maxRows: 5000 }
    ),
    query(
      client,
      `SELECT PermissionSetLicense.DeveloperName FROM PermissionSetLicenseAssign WHERE AssigneeId = '${userId}'`,
      {
        maxRows: 5000,
      }
    ),
    query(client, `SELECT Group.DeveloperName, Group.Type FROM GroupMember WHERE UserOrGroupId = '${userId}'`, {
      maxRows: 5000,
    }),
  ]);
  for (const a of assignments.rows) {
    if (a.PermissionSetGroupId)
      lines.push({ Section: 'permissionSetGroup', Name: String(a['PermissionSetGroup.DeveloperName']), Value: '' });
    else if (a['PermissionSet.IsOwnedByProfile'] !== true && a['PermissionSet.Type'] !== 'Group')
      lines.push({ Section: 'permissionSet', Name: psKey(a), Value: '' });
  }
  for (const l of licenses.rows)
    lines.push({ Section: 'license', Name: String(l['PermissionSetLicense.DeveloperName']), Value: '' });
  for (const g of groups.rows)
    if (g['Group.Type'] === 'Regular' || g['Group.Type'] === 'Queue')
      lines.push({
        Section: 'group',
        Name: String(g['Group.DeveloperName']),
        Value: g['Group.Type'] === 'Queue' ? 'Queue' : 'Public group',
      });
  return lines;
}

export const snapshotCsv = (lines: SnapshotLine[]): string => toCsv(['Section', 'Name', 'Value'], lines);

/** A snapshot CSV back to lines (also after it was edited in Excel). */
export function parseSnapshot(text: string): SnapshotLine[] {
  // parseCsv drops a byte-order mark; rows come keyed by column
  const table = parseCsv(text);
  if (!table.columns.includes('Section') || !table.columns.includes('Name'))
    throw new Error('Not a user snapshot: the CSV needs Section, Name and Value columns.');
  const sections = new Set<SnapshotSection>([
    'info',
    'field',
    'lookup',
    'permissionSet',
    'permissionSetGroup',
    'license',
    'group',
  ]);
  return table.rows
    .map((r) => ({ Section: r.Section as SnapshotSection, Name: r.Name ?? '', Value: r.Value ?? '' }))
    .filter((l) => sections.has(l.Section) && l.Name);
}

// ---------- compare and apply ----------

export type SnapshotDifference = {
  key: string;
  section: SnapshotSection;
  name: string;
  /** In the snapshot / in the org now. */
  snapshot: string;
  org: string;
  /** What applying does: set the field, assign, remove… */
  action: string;
  /** Only in the org (applying removes it, when asked to). */
  extra?: boolean;
};

const same = (a: string, b: string): boolean => {
  if (a === b) return true;
  // Booleans and numbers as Excel may have rewritten them
  if (/^(true|false)$/i.test(a) && /^(true|false)$/i.test(b)) return a.toLowerCase() === b.toLowerCase();
  if (a !== '' && b !== '' && !Number.isNaN(Number(a)) && !Number.isNaN(Number(b))) return Number(a) === Number(b);
  return false;
};

/**
 * The differences between a snapshot and a user now. Username, and lookups to users, match with
 * or without a sandbox suffix. Fields the org cannot change are left out.
 */
export function diffSnapshot(snapshot: SnapshotLine[], now: SnapshotLine[]): SnapshotDifference[] {
  const nowOf = (section: SnapshotSection, name: string) => now.find((l) => l.Section === section && l.Name === name);
  const out: SnapshotDifference[] = [];
  for (const l of snapshot) {
    if (l.Section === 'info') continue;
    const key = `${l.Section}:${l.Name}`;
    if (l.Section === 'field' || l.Section === 'lookup') {
      const n = nowOf(l.Section, l.Name);
      if (!n) continue;
      const users = l.Value.includes('@') && n.Value.includes('@');
      if (same(l.Value, n.Value) || (users && sameUsername(l.Value, n.Value))) continue;
      out.push({
        key,
        section: l.Section,
        name: l.Name,
        snapshot: l.Value,
        org: n.Value,
        action: l.Section === 'field' ? 'set the field' : 'point it to the snapshot’s record',
      });
    } else if (!nowOf(l.Section, l.Name)) {
      out.push({
        key,
        section: l.Section,
        name: l.Name,
        snapshot: '✓',
        org: '',
        action: l.Section === 'group' ? `add to the ${l.Value.toLowerCase() || 'group'}` : 'assign',
      });
    }
  }
  for (const n of now) {
    if (['info', 'field', 'lookup'].includes(n.Section)) continue;
    if (!snapshot.some((l) => l.Section === n.Section && l.Name === n.Name))
      out.push({
        key: `${n.Section}:${n.Name}`,
        section: n.Section,
        name: n.Name,
        snapshot: '',
        org: '✓',
        action: 'remove',
        extra: true,
      });
  }
  const order: SnapshotSection[] = ['field', 'lookup', 'permissionSet', 'permissionSetGroup', 'license', 'group'];
  return out.sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || a.name.localeCompare(b.name));
}

/** The user in an org who is the snapshot's user (same username, sandbox suffix or not). */
export async function snapshotUser(client: SalesforceClient, snapshot: SnapshotLine[]): Promise<string | null> {
  const username = snapshot.find((l) => l.Section === 'info' && l.Name === 'user')?.Value ?? '';
  return (await findSameUser(client, username))?.Id ?? null;
}

export type ApplyOutcome = { done: string[]; failed: Array<{ item: string; error: string }> };

/** Makes the user match the snapshot for the differences chosen (names are looked up in this org). */
export async function applySnapshot(
  client: SalesforceClient,
  userId: string,
  differences: SnapshotDifference[]
): Promise<ApplyOutcome> {
  if (!ID.test(userId)) throw new Error('Invalid user Id.');
  const out: ApplyOutcome = { done: [], failed: [] };
  const attempt = async (item: string, action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
      out.done.push(item);
    } catch (e) {
      out.failed.push({ item, error: (e as Error).message });
    }
  };
  const one = async (soql: string, what: string): Promise<string> => {
    const row = (await query(client, soql)).rows[0];
    if (!row) throw new Error(`${what} is not in this org.`);
    return String(row.Id);
  };
  const fields = await userFields(client);
  const patch: Row = {};
  for (const d of differences.filter((x) => x.section === 'field' || x.section === 'lookup')) {
    const f = fields.find((x) => x.name === d.name);
    if (!f?.updateable) {
      out.failed.push({ item: d.name, error: 'cannot be changed' });
      continue;
    }
    if (d.section === 'field') {
      patch[d.name] =
        d.snapshot === ''
          ? null
          : f.type === 'boolean'
          ? /^true$/i.test(d.snapshot)
          : ['double', 'int', 'currency', 'percent'].includes(f.type)
          ? Number(d.snapshot)
          : d.snapshot;
      continue;
    }
    if (!d.snapshot) {
      patch[d.name] = null;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await attempt(`${d.name} → ${d.snapshot}`, async () => {
      const target = f.referenceTo.includes('User') && d.snapshot.includes('@') ? 'User' : f.referenceTo[0];
      if (target === 'User') {
        const user = await findSameUser(client, d.snapshot);
        if (!user) throw new Error(`no user ${d.snapshot} in this org`);
        patch[d.name] = user.Id;
      } else
        patch[d.name] = await one(
          `SELECT Id FROM ${target} WHERE ${nameFieldOf(target)} = '${soqlText(d.snapshot)}' LIMIT 1`,
          `${target} ${d.snapshot}`
        );
    });
  }
  if (Object.keys(patch).length)
    await attempt(`fields: ${Object.keys(patch).join(', ')}`, () =>
      client.rest('PATCH', `/sobjects/User/${userId}`, patch)
    );

  // ns__Name: permission set names cannot hold "__", so it marks a namespace
  const psName = (key: string): string => {
    const at = key.indexOf('__');
    return at > 0
      ? `Name = '${soqlText(key.slice(at + 2))}' AND NamespacePrefix = '${soqlText(key.slice(0, at))}'`
      : `Name = '${soqlText(key)}' AND NamespacePrefix = null`;
  };
  for (const d of differences.filter((x) => !['field', 'lookup'].includes(x.section))) {
    const item = `${d.extra ? 'remove' : 'add'} ${d.section} ${d.name}`;
    // eslint-disable-next-line no-await-in-loop
    await attempt(item, async () => {
      if (d.section === 'permissionSet' || d.section === 'permissionSetGroup') {
        const where =
          d.section === 'permissionSet'
            ? `PermissionSetId IN (SELECT Id FROM PermissionSet WHERE ${psName(d.name)})`
            : `PermissionSetGroup.DeveloperName = '${soqlText(d.name)}'`;
        if (d.extra) {
          const id = await one(
            `SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${userId}' AND ${where}`,
            d.name
          );
          return client.rest('DELETE', `/sobjects/PermissionSetAssignment/${id}`);
        }
        const target =
          d.section === 'permissionSet'
            ? {
                PermissionSetId: await one(
                  `SELECT Id FROM PermissionSet WHERE ${psName(d.name)}`,
                  `Permission set ${d.name}`
                ),
              }
            : {
                PermissionSetGroupId: await one(
                  `SELECT Id FROM PermissionSetGroup WHERE DeveloperName = '${soqlText(d.name)}'`,
                  `Permission set group ${d.name}`
                ),
              };
        return client.rest('POST', '/sobjects/PermissionSetAssignment', { AssigneeId: userId, ...target });
      }
      if (d.section === 'license') {
        if (d.extra) {
          const id = await one(
            `SELECT Id FROM PermissionSetLicenseAssign WHERE AssigneeId = '${userId}' AND PermissionSetLicense.DeveloperName = '${soqlText(
              d.name
            )}'`,
            d.name
          );
          return client.rest('DELETE', `/sobjects/PermissionSetLicenseAssign/${id}`);
        }
        const license = await one(
          `SELECT Id FROM PermissionSetLicense WHERE DeveloperName = '${soqlText(d.name)}'`,
          `License ${d.name}`
        );
        return client.rest('POST', '/sobjects/PermissionSetLicenseAssign', {
          AssigneeId: userId,
          PermissionSetLicenseId: license,
        });
      }
      // Public groups and queues
      if (d.extra) {
        const id = await one(
          `SELECT Id FROM GroupMember WHERE UserOrGroupId = '${userId}' AND Group.DeveloperName = '${soqlText(
            d.name
          )}'`,
          d.name
        );
        return client.rest('DELETE', `/sobjects/GroupMember/${id}`);
      }
      const group = await one(
        `SELECT Id FROM Group WHERE DeveloperName = '${soqlText(d.name)}' AND Type IN ('Regular', 'Queue')`,
        `Group ${d.name}`
      );
      return client.rest('POST', '/sobjects/GroupMember', { GroupId: group, UserOrGroupId: userId });
    });
  }
  return out;
}
