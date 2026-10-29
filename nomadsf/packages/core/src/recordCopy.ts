import type { SalesforceClient } from './client.js';
import { deployFiles } from './accessMeta.js';
import { describeData, type DataField } from './backup.js';
import {
  describeBoth,
  orgMaps,
  sameOrgMaps,
  type LoadProgress,
  type LoadResult,
  type OrgMaps,
  type SourceRow,
} from './dataLoad.js';
import { retrieveZip } from './metadata.js';
import {
  gatherRows,
  planMigration,
  runMigration,
  type MigrateObject,
  type MigratePlan,
  type RowSource,
} from './migrate.js';
import { query, soqlText, type Row } from './query.js';
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
import { getUserInfo } from './soap.js';
import type { FileTable, Sheet } from './workbook.js';
import { fromBase64, readZip } from './zip.js';

/**
 * Copying a record with what was ticked under it (Record › Related): exactly those records, the
 * links between them kept, into another org — or into a workbook, and from it into any org later.
 * A user goes with only the permission sets, groups and licenses ticked under them; permission sets
 * and groups the target lacks are made from their metadata.
 */

/** Records ticked in the tree: a whole relationship (by its lookup) or single records (by Id). */
export type CopyPick = { object: string; where: string };

/** The picks as Migrate objects, one per object (conditions joined with OR). */
export function copyObjects(picks: CopyPick[]): MigrateObject[] {
  const byObject = new Map<string, string[]>();
  for (const p of picks) byObject.set(p.object, [...new Set([...(byObject.get(p.object) ?? []), p.where])]);
  return [...byObject].map(([name, where]) => ({
    name,
    where: where.length === 1 ? where[0] : where.map((w) => `(${w})`).join(' OR '),
  }));
}

/** Every field of the ticked records, per object (to save them in a workbook). */
export async function readPicked(client: SalesforceClient, picks: CopyPick[]): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {};
  for (const o of copyObjects(picks)) {
    /* eslint-disable no-await-in-loop */
    const fields = (await describeData(client, o.name))
      .filter((f) => !['address', 'location', 'base64'].includes(f.type))
      .map((f) => f.name);
    out[o.name] = (
      await query(client, `SELECT ${fields.join(', ')} FROM ${o.name} WHERE ${o.where}`, { maxRows: 50_000 })
    ).rows;
    /* eslint-enable no-await-in-loop */
  }
  return out;
}

/** Where the records come from: an org, or a saved workbook (its tables matched to objects). */
export type CopySource =
  | { kind: 'org'; client: SalesforceClient }
  | { kind: 'file'; schema: Record<string, DataField[]>; rows: Record<string, Map<string, SourceRow>> };

export type PreparedCopy = {
  plan: MigratePlan;
  rows: Record<string, SourceRow[]>;
  maps: OrgMaps;
  /** Records per object, in load order. */
  counts: Array<{ object: string; records: number }>;
};

const isSandbox = async (client: SalesforceClient): Promise<boolean> =>
  (await query(client, 'SELECT IsSandbox FROM Organization')).rows[0]?.IsSandbox === true;

/**
 * Reads what a copy will load (parents first) and how owners, record types and queues match in the
 * target — nothing is written yet. Lookups to records outside the copy: owners by username, the rest
 * left empty.
 */
export async function prepareCopy(
  source: CopySource,
  target: SalesforceClient,
  objects: MigrateObject[],
  options: { mask: boolean; onProgress?: (object: string, rows: number) => void }
): Promise<PreparedCopy> {
  const names = objects.map((o) => o.name);
  const schemas = await describeBoth(source.kind === 'org' ? source.client : source.schema, target, names);
  const plan = planMigration(objects, schemas, { mask: options.mask });
  if (plan.missingObjects.length) throw new Error(`Not in the target org: ${plan.missingObjects.join(', ')}.`);
  const rowSource: RowSource =
    source.kind === 'org' ? { kind: 'org', client: source.client } : { kind: 'backup', rows: source.rows };
  const rows = await gatherRows(rowSource, plan, options.onProgress);
  const me = await getUserInfo(target);
  const maps =
    source.kind === 'org'
      ? await orgMaps(source.client, target, {
          sourceSandbox: await isSandbox(source.client),
          targetSandbox: await isSandbox(target),
          defaultOwner: me.userId,
        })
      : { ...sameOrgMaps(), defaultOwner: me.userId };
  return { plan, rows, maps, counts: plan.order.map((object) => ({ object, records: rows[object]?.length ?? 0 })) };
}

/** Loads a prepared copy into the target (the result's `created` undoes it with undoLoad). */
export function runCopy(target: SalesforceClient, copy: PreparedCopy, onProgress?: LoadProgress): Promise<LoadResult> {
  return runMigration(target, copy.plan, copy.rows, { maps: copy.maps, onProgress });
}

/** A user to copy: their fields and lookups by name, and only the access that was picked. */
export type UserCopy = { username: string; lines: SnapshotLine[] };
/** A permission set or group as a Metadata API file (to create it where it is missing). */
export type AccessFile = { type: 'PermissionSet' | 'PermissionSetGroup'; name: string; xml: string };

/** A user's access as the tree shows it: permission sets, groups, licenses, public groups and queues. */
export const ACCESS_SECTIONS: Array<{ section: SnapshotLine['Section']; label: string }> = [
  { section: 'permissionSet', label: 'Permission sets' },
  { section: 'permissionSetGroup', label: 'Permission set groups' },
  { section: 'license', label: 'Permission set licenses' },
  { section: 'group', label: 'Public groups and queues' },
];

/** Labels of a user's access as people know them ("Sales Ops" for Sales_Ops), by section:name. */
export async function accessLabels(client: SalesforceClient): Promise<Record<string, string>> {
  const read = async (soql: string): Promise<Row[]> =>
    (await query(client, soql, { maxRows: 50_000 }).catch(() => ({ rows: [] as Row[] }))).rows;
  const [sets, groups, licenses, publicGroups] = await Promise.all([
    read('SELECT Name, NamespacePrefix, Label FROM PermissionSet WHERE IsOwnedByProfile = false'),
    read('SELECT DeveloperName, MasterLabel FROM PermissionSetGroup'),
    read('SELECT DeveloperName, MasterLabel FROM PermissionSetLicense'),
    read("SELECT DeveloperName, Name FROM Group WHERE Type IN ('Regular', 'Queue')"),
  ]);
  const ns = (r: Row) => (r.NamespacePrefix ? `${String(r.NamespacePrefix)}__` : '');
  return Object.fromEntries([
    ...sets.map((r) => [`permissionSet:${ns(r)}${String(r.Name)}`, String(r.Label ?? '')]),
    ...groups.map((r) => [`permissionSetGroup:${String(r.DeveloperName)}`, String(r.MasterLabel ?? '')]),
    ...licenses.map((r) => [`license:${String(r.DeveloperName)}`, String(r.MasterLabel ?? '')]),
    ...publicGroups.map((r) => [`group:${String(r.DeveloperName)}`, String(r.Name ?? '')]),
  ]);
}

/** The user with only the access ticked (the rest of their snapshot: fields and lookups by name). */
export function userCopy(snapshot: SnapshotLine[], picked: SnapshotLine[]): UserCopy {
  return {
    username: snapshot.find((l) => l.Section === 'info' && l.Name === 'user')?.Value ?? '',
    lines: [...snapshot.filter((l) => ['info', 'field', 'lookup'].includes(l.Section)), ...picked],
  };
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

/** A copy as sheets: a sheet per object, the user with their access, and the metadata. */
export function copySheets(bundle: {
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

/** A saved copy back: the record tables, and the users and metadata sheets when there are. */
export function fromCopySheets(tables: FileTable[]): {
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

/** "In field: recordType - no RecordType named Case.Escalation found" → Case.Escalation */
const MISSING = /no \w+ named (\S+?) found/g;

/** The file without the entries naming a component (a record type's visibility, a field's access…). */
export function withoutEntries(xml: string, names: string[]): string {
  let out = xml;
  for (const name of names) {
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // An entry is a block with child elements, one of which holds exactly the name
    out = out.replace(
      new RegExp(`\\n?[ \\t]*<(\\w+)>(?:(?!</?\\1>)[\\s\\S])*?<\\w+>${esc}</\\w+>(?:(?!</?\\1>)[\\s\\S])*?</\\1>`, 'g'),
      ''
    );
  }
  return out;
}

/**
 * Deploys permission sets or groups; when the target lacks something they mention (a record type,
 * a field, a class, an app…), those entries are left out and the deploy is tried again, so the
 * rest of the access still arrives.
 */
export async function deployAccessFiles(
  target: SalesforceClient,
  type: AccessFile['type'],
  files: AccessFile[]
): Promise<{ success: boolean; problems: string[]; leftOut: string[] }> {
  let current = files;
  const leftOut: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await deployFiles(
      target,
      type,
      current.map((m) => ({ fullName: m.name, xml: m.xml }))
    );
    if (r.success) return { success: true, problems: [], leftOut };
    const missing = [...new Set(r.problems.flatMap((p) => [...p.matchAll(MISSING)].map((m) => m[1])))].filter(
      (n) => !leftOut.includes(n)
    );
    if (!missing.length) return { success: false, problems: r.problems, leftOut };
    leftOut.push(...missing);
    current = current.map((m) => ({ ...m, xml: withoutEntries(m.xml, missing) }));
  }
  return { success: false, problems: ['Too many missing components to leave out.'], leftOut };
}

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
  const quotedNames = (list: string[]) => list.map((n) => `'${soqlText(n)}'`).join(', ');
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
            .map((n) => `'${soqlText(n)}'`)
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
      out.failed.push({ item: `${type} ${c.name}`, error: 'its metadata could not be read' });
    if (!list.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await deployAccessFiles(target, type, list);
    if (r.success)
      out.done.push(
        ...list.map(
          (m) =>
            `created ${type} ${m.name}${r.leftOut.length ? ` (without ${r.leftOut.join(', ')}: not in this org)` : ''}`
        )
      );
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
