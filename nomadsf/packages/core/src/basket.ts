import type { SalesforceClient } from './client.js';
import { deployFiles } from './accessMeta.js';
import { describeData } from './backup.js';
import { retrieveZip } from './metadata.js';
import { query, type Row } from './query.js';
import {
  applySnapshot,
  createUserFromSnapshot,
  diffSnapshot,
  snapshotUser,
  suggestUsername,
  takeUserSnapshot,
  type ApplyOutcome,
  type SnapshotLine,
} from './snapshot.js';
import type { FileTable, Sheet } from './workbook.js';
import { fromBase64, readZip } from './zip.js';

/**
 * A basket: exactly the records someone picked (a record, some of its children, a user and some of
 * their permission sets…), to copy to another org or keep in a workbook and load again. Users go
 * with only the access that was picked; permission sets and groups missing in the target are made
 * from their metadata.
 */

export type BasketItem = { object: string; id: string; name: string };

/** A user's access, picked as records under the user: copied with the user, by name. */
export const USER_ACCESS = ['PermissionSetAssignment', 'PermissionSetLicenseAssign', 'GroupMember'];
/** Copied as a user (found by username or created), not as a record. */
export const isUserPart = (object: string): boolean => object === 'User' || USER_ACCESS.includes(object);

/** A user to copy: their fields and lookups by name, and only the access that was picked. */
export type UserCopy = { username: string; lines: SnapshotLine[] };
/** A permission set or group as a Metadata API file (to create it where it is missing). */
export type AccessFile = { type: 'PermissionSet' | 'PermissionSetGroup'; name: string; xml: string };

const ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const quoted = (ids: string[]): string => ids.map((id) => `'${id}'`).join(', ');

/** The record objects of a basket as Migrate objects: exactly these Ids, nothing related. */
export function basketObjects(items: BasketItem[]): Array<{ name: string; where: string }> {
  const byObject = new Map<string, string[]>();
  for (const i of items.filter((x) => !isUserPart(x.object) && ID.test(x.id)))
    byObject.set(i.object, [...(byObject.get(i.object) ?? []), i.id]);
  return [...byObject].map(([name, ids]) => ({ name, where: `Id IN (${quoted([...new Set(ids)])})` }));
}

const chunks = <T>(list: T[], size: number): T[][] =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/** Every field of the basket's records, per object (users and their access aside). */
export async function basketRecords(client: SalesforceClient, items: BasketItem[]): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {};
  for (const o of basketObjects(items)) {
    /* eslint-disable no-await-in-loop */
    const fields = (await describeData(client, o.name))
      .filter((f) => !['address', 'location', 'base64'].includes(f.type))
      .map((f) => f.name);
    const ids = items.filter((i) => i.object === o.name).map((i) => i.id);
    out[o.name] = [];
    for (const part of chunks([...new Set(ids)], 200))
      out[o.name].push(
        ...(
          await query(client, `SELECT ${fields.join(', ')} FROM ${o.name} WHERE Id IN (${quoted(part)})`, {
            maxRows: 50_000,
          })
        ).rows
      );
    /* eslint-enable no-await-in-loop */
  }
  return out;
}

/**
 * The basket's users, each with only the access picked under them (permission set assignments,
 * licenses, group memberships). Access picked without its user brings the user too.
 */
export async function basketUsers(client: SalesforceClient, items: BasketItem[], orgLabel = ''): Promise<UserCopy[]> {
  const access = items.filter((i) => USER_ACCESS.includes(i.object) && ID.test(i.id));
  const picked: Array<{ user: string; line: SnapshotLine }> = [];
  const byObject = (object: string): string[] => access.filter((a) => a.object === object).map((a) => a.id);
  const read = async (object: string, fields: string): Promise<Row[]> =>
    byObject(object).length
      ? (await query(client, `SELECT ${fields} FROM ${object} WHERE Id IN (${quoted(byObject(object))})`)).rows
      : [];
  const [assignments, licenses, members] = await Promise.all([
    read(
      'PermissionSetAssignment',
      'AssigneeId, PermissionSetGroupId, PermissionSetGroup.DeveloperName, PermissionSet.Name, PermissionSet.NamespacePrefix'
    ),
    read('PermissionSetLicenseAssign', 'AssigneeId, PermissionSetLicense.DeveloperName'),
    read('GroupMember', 'UserOrGroupId, Group.DeveloperName, Group.Type'),
  ]);
  for (const a of assignments)
    picked.push({
      user: String(a.AssigneeId),
      line: a.PermissionSetGroupId
        ? { Section: 'permissionSetGroup', Name: String(a['PermissionSetGroup.DeveloperName']), Value: '' }
        : {
            Section: 'permissionSet',
            Name: `${
              a['PermissionSet.NamespacePrefix'] ? `${String(a['PermissionSet.NamespacePrefix'])}__` : ''
            }${String(a['PermissionSet.Name'])}`,
            Value: '',
          },
    });
  for (const l of licenses)
    picked.push({
      user: String(l.AssigneeId),
      line: { Section: 'license', Name: String(l['PermissionSetLicense.DeveloperName']), Value: '' },
    });
  for (const m of members.filter((x) => String(x.UserOrGroupId).startsWith('005')))
    picked.push({
      user: String(m.UserOrGroupId),
      line: {
        Section: 'group',
        Name: String(m['Group.DeveloperName']),
        Value: m['Group.Type'] === 'Queue' ? 'Queue' : 'Public group',
      },
    });
  const k15 = (id: string): string => id.slice(0, 15);
  const userIds = [
    ...new Set([...items.filter((i) => i.object === 'User').map((i) => k15(i.id)), ...picked.map((p) => k15(p.user))]),
  ];
  const out: UserCopy[] = [];
  for (const id of userIds) {
    const full =
      items.find((i) => i.object === 'User' && k15(i.id) === id)?.id ?? picked.find((p) => k15(p.user) === id)!.user;
    // eslint-disable-next-line no-await-in-loop
    const snapshot = await takeUserSnapshot(client, full, orgLabel);
    out.push({
      username: snapshot.find((l) => l.Section === 'info' && l.Name === 'user')?.Value ?? '',
      lines: [
        ...snapshot.filter((l) => ['info', 'field', 'lookup'].includes(l.Section)),
        ...picked.filter((p) => k15(p.user) === id).map((p) => p.line),
      ],
    });
  }
  return out;
}

/**
 * The permission sets and groups the users are given, to make where they are missing. Managed ones
 * (namespace__Name, Salesforce's force__… too) come with their package and are left out.
 */
export function accessNames(users: UserCopy[]): { permissionSets: string[]; groups: string[] } {
  const of = (section: string) => [
    ...new Set(
      users.flatMap((u) => u.lines.filter((l) => l.Section === section && !l.Name.includes('__')).map((l) => l.Name))
    ),
  ];
  return { permissionSets: of('permissionSet'), groups: of('permissionSetGroup') };
}

/** Permission sets and groups as Metadata API files, with the permission sets inside each group. */
export async function accessFiles(
  client: SalesforceClient,
  names: { permissionSets: string[]; groups: string[] }
): Promise<AccessFile[]> {
  if (!names.permissionSets.length && !names.groups.length) return [];
  const read = async (components: Array<{ type: AccessFile['type']; fullName: string }>): Promise<AccessFile[]> => {
    const result = await retrieveZip(client, components, { pollMs: 1000 });
    if (!result.zipFile) throw new Error(result.errorMessage ?? 'The permission sets could not be retrieved.');
    const files = await readZip(fromBase64(result.zipFile));
    return [...files]
      .filter(([path]) => /\.(permissionset|permissionsetgroup)$/.test(path))
      .map(([path, bytes]) => ({
        type: path.endsWith('group') ? 'PermissionSetGroup' : 'PermissionSet',
        name: path.replace(/^.*\//, '').replace(/\.\w+$/, ''),
        xml: new TextDecoder().decode(bytes),
      }));
  };
  const groups = names.groups.length
    ? await read(names.groups.map((fullName) => ({ type: 'PermissionSetGroup' as const, fullName })))
    : [];
  // A group needs its permission sets: brought along
  const inGroups = groups.flatMap((g) =>
    [...g.xml.matchAll(/<permissionSets>([^<]+)<\/permissionSets>/g)].map((m) => m[1])
  );
  const sets = [...new Set([...names.permissionSets, ...inGroups])];
  return [
    ...(sets.length ? await read(sets.map((fullName) => ({ type: 'PermissionSet' as const, fullName }))) : []),
    ...groups,
  ];
}

// ---------- the workbook ----------

const USERS_SHEET = 'NomadSF users';
const METADATA_SHEET = 'NomadSF metadata';
/** Excel holds at most 32,767 characters in a cell: longer metadata files go over several. */
const CELL = 32_000;

/** The basket as sheets: a sheet per object, the users with their access, and the metadata. */
export function basketSheets(bundle: {
  records: Record<string, Row[]>;
  users: UserCopy[];
  metadata: AccessFile[];
}): Sheet[] {
  const sheets: Sheet[] = Object.entries(bundle.records).map(([name, rows]) => ({
    name,
    columns: rows[0] ? Object.keys(rows[0]) : ['Id'],
    rows,
  }));
  if (bundle.users.length)
    sheets.push({
      name: USERS_SHEET,
      columns: ['User', 'Section', 'Name', 'Value'],
      rows: bundle.users.flatMap((u) => u.lines.map((l) => ({ User: u.username, ...l }))),
    });
  if (bundle.metadata.length) {
    const parts = Math.max(1, ...bundle.metadata.map((m) => Math.ceil(m.xml.length / CELL)));
    const columns = Array.from({ length: parts }, (_, i) => `Xml${i + 1}`);
    sheets.push({
      name: METADATA_SHEET,
      columns: ['Type', 'Name', ...columns],
      rows: bundle.metadata.map((m) => ({
        Type: m.type,
        Name: m.name,
        ...Object.fromEntries(columns.map((c, i) => [c, m.xml.slice(i * CELL, (i + 1) * CELL)])),
      })),
    });
  }
  return sheets;
}

/** A basket workbook back: the record tables, and the users and metadata sheets when there are. */
export function fromBasketSheets(tables: FileTable[]): {
  tables: FileTable[];
  users: UserCopy[];
  metadata: AccessFile[];
} {
  const usersSheet = tables.find((t) => t.name === USERS_SHEET);
  const metaSheet = tables.find((t) => t.name === METADATA_SHEET);
  const users: UserCopy[] = [];
  for (const r of usersSheet?.rows ?? []) {
    let u = users.find((x) => x.username === r.User);
    if (!u) users.push((u = { username: r.User, lines: [] }));
    u.lines.push({ Section: r.Section as SnapshotLine['Section'], Name: r.Name ?? '', Value: r.Value ?? '' });
  }
  const metadata: AccessFile[] = (metaSheet?.rows ?? [])
    .filter((r) => r.Type === 'PermissionSet' || r.Type === 'PermissionSetGroup')
    .map((r) => ({
      type: r.Type as AccessFile['type'],
      name: r.Name,
      xml: Object.keys(r)
        .filter((k) => /^Xml\d+$/.test(k))
        .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
        .map((k) => r[k])
        .join(''),
    }));
  return { tables: tables.filter((t) => t !== usersSheet && t !== metaSheet), users, metadata };
}

// ---------- into the target ----------

export type UserPlan = {
  username: string;
  /** The same user in the target (username, with or without a sandbox suffix). */
  found?: string;
  /** For a user to create: a free username. */
  suggested: string;
  access: number;
};

export type AccessPlan = {
  users: UserPlan[];
  /** Permission sets and groups the target lacks: made from their files. */
  create: Array<{ type: AccessFile['type']; name: string }>;
  /** Licenses the target lacks: cannot be made, those assignments fail. */
  noLicense: string[];
};

/** What copying the users does in the target: who is found, who is created, what is missing. */
export async function planUsers(target: SalesforceClient, users: UserCopy[], targetLabel: string): Promise<AccessPlan> {
  const plans = await Promise.all(
    users.map(async (u) => ({
      username: u.username,
      found: (await snapshotUser(target, u.lines)) ?? undefined,
      suggested: suggestUsername(u.lines, targetLabel),
      access: u.lines.filter((l) => !['info', 'field', 'lookup'].includes(l.Section)).length,
    }))
  );
  const names = accessNames(users);
  const quotedNames = (list: string[]) => list.map((n) => `'${n.replace(/'/g, "\\'")}'`).join(', ');
  const plain = names.permissionSets.filter((n) => !n.includes('__'));
  const haveSets = plain.length
    ? new Set(
        (
          await query(
            target,
            `SELECT Name FROM PermissionSet WHERE NamespacePrefix = null AND Name IN (${quotedNames(plain)})`
          )
        ).rows.map((r) => String(r.Name))
      )
    : new Set<string>();
  const haveGroups = names.groups.length
    ? new Set(
        (
          await query(
            target,
            `SELECT DeveloperName FROM PermissionSetGroup WHERE DeveloperName IN (${quotedNames(names.groups)})`
          )
        ).rows.map((r) => String(r.DeveloperName))
      )
    : new Set<string>();
  const licenses = [
    ...new Set(users.flatMap((u) => u.lines.filter((l) => l.Section === 'license').map((l) => l.Name))),
  ];
  const haveLicenses = licenses.length
    ? new Set(
        (
          await query(
            target,
            `SELECT DeveloperName FROM PermissionSetLicense WHERE DeveloperName IN (${quotedNames(licenses)})`
          )
        ).rows.map((r) => String(r.DeveloperName))
      )
    : new Set<string>();
  return {
    users: plans,
    create: [
      // Managed (namespace__Name) permission sets come with their package: never made here
      ...plain.filter((n) => !haveSets.has(n)).map((name) => ({ type: 'PermissionSet' as const, name })),
      ...names.groups.filter((n) => !haveGroups.has(n)).map((name) => ({ type: 'PermissionSetGroup' as const, name })),
    ],
    noLicense: licenses.filter((l) => !haveLicenses.has(l)),
  };
}

/**
 * Copies the users: the missing permission sets and groups first (from their files), then each user
 * found gets the picked access they lack, and each missing user is created under the username given.
 */
export async function copyUsers(
  target: SalesforceClient,
  users: UserCopy[],
  plan: AccessPlan,
  options: { usernames: Record<string, string>; metadata: AccessFile[]; targetLabel?: string }
): Promise<ApplyOutcome> {
  const out: ApplyOutcome = { done: [], failed: [] };
  const create = [...plan.create];
  // A new group needs its permission sets: those the target lacks are made too
  const inGroups = options.metadata
    .filter((m) => m.type === 'PermissionSetGroup' && create.some((c) => c.type === m.type && c.name === m.name))
    .flatMap((g) => [...g.xml.matchAll(/<permissionSets>([^<]+)<\/permissionSets>/g)].map((x) => x[1]))
    .filter((n) => !n.includes('__') && !create.some((c) => c.type === 'PermissionSet' && c.name === n));
  if (inGroups.length) {
    const have = new Set(
      (
        await query(
          target,
          `SELECT Name FROM PermissionSet WHERE NamespacePrefix = null AND Name IN (${inGroups
            .map((n) => `'${n.replace(/'/g, "\\'")}'`)
            .join(', ')})`
        )
      ).rows.map((r) => String(r.Name))
    );
    create.push(...inGroups.filter((n) => !have.has(n)).map((name) => ({ type: 'PermissionSet' as const, name })));
  }
  const files = (type: AccessFile['type']) =>
    options.metadata.filter((m) => m.type === type && create.some((c) => c.type === type && c.name === m.name));
  for (const type of ['PermissionSet', 'PermissionSetGroup'] as const) {
    const list = files(type);
    for (const c of create.filter((x) => x.type === type && !list.some((m) => m.name === x.name)))
      out.failed.push({ item: `${type} ${c.name}`, error: 'its metadata is not in the basket' });
    if (!list.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await deployFiles(
      target,
      type,
      list.map((m) => ({ fullName: m.name, xml: m.xml }))
    );
    if (r.success) out.done.push(...list.map((m) => `created ${type} ${m.name}`));
    else out.failed.push(...list.map((m) => ({ item: `create ${type} ${m.name}`, error: r.problems.join('; ') })));
  }
  for (const u of users) {
    const p = plan.users.find((x) => x.username === u.username);
    try {
      if (p?.found) {
        /* eslint-disable no-await-in-loop */
        const now = await takeUserSnapshot(target, p.found, options.targetLabel);
        // Only what was picked and is missing: fields and other access stay as they are
        const add = diffSnapshot(u.lines, now).filter(
          (d) => !['field', 'lookup'].includes(d.section) && !d.extra && !d.checkOnly
        );
        const r = add.length ? await applySnapshot(target, p.found, add) : { done: [], failed: [] };
        out.done.push(`${u.username}: found, ${r.done.length} added`);
        out.failed.push(...r.failed.map((f) => ({ item: `${u.username}: ${f.item}`, error: f.error })));
      } else {
        const username = options.usernames[u.username] || p?.suggested || u.username;
        const r = await createUserFromSnapshot(target, u.lines, username, options.targetLabel);
        out.done.push(`${username}: created (${r.outcome.done.length - 1} access added)`);
        out.failed.push(...r.outcome.failed.map((f) => ({ item: `${username}: ${f.item}`, error: f.error })));
        /* eslint-enable no-await-in-loop */
      }
    } catch (e) {
      out.failed.push({ item: u.username, error: (e as Error).message });
    }
  }
  return out;
}
