import type { SalesforceClient } from './client.js';
import { query, soqlText, type Row } from './query.js';
import { missingSchema } from './recordCopy.js';
import { packageXml, retrieveZip } from './metadata.js';
import { fromBase64, makeZip, readZip } from './zip.js';

/**
 * What components need besides themselves before a deploy can succeed: Salesforce's own record of what uses what
 * (MetadataComponentDependency, in the org they come from), followed until nothing new is missing in the target.
 * A deploy is all or nothing — one class that uses another the target lacks fails the whole package.
 */

export type Piece = { type: string; name: string };
export type AddedPiece = Piece & { neededBy: string };

const ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const quoted = (list: string[]) => list.map((v) => `'${soqlText(v)}'`).join(', ');
const tooling = async (client: SalesforceClient, soql: string): Promise<Row[]> =>
  (await query(client, soql, { tooling: true, maxRows: 10_000 }).catch(() => ({ rows: [] as Row[] }))).rows;

/** A custom object's API name from its DeveloperName and namespace. */
const objectName = (r: Row): string =>
  `${r.NamespacePrefix ? `${text(r.NamespacePrefix)}__` : ''}${text(r.DeveloperName)}__c`;

/** The Ids of the pieces in the source org (classes and custom objects; a field is found through its object). */
async function idsOf(source: SalesforceClient, pieces: Piece[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const classes = pieces.filter((p) => p.type === 'ApexClass').map((p) => p.name);
  const objects = pieces.filter((p) => p.type === 'CustomObject' && p.name.endsWith('__c'));
  for (let i = 0; i < classes.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    for (const r of await tooling(
      source,
      `SELECT Id, Name FROM ApexClass WHERE NamespacePrefix = null AND Name IN (${quoted(classes.slice(i, i + 200))})`
    ))
      out.set(`ApexClass:${text(r.Name)}`, text(r.Id));
  }
  const bare = objects.map((o) => o.name.replace(/__c$/, '').replace(/^\w+?__/, ''));
  for (let i = 0; i < bare.length; i += 200) {
    // eslint-disable-next-line no-await-in-loop
    for (const r of await tooling(
      source,
      `SELECT Id, DeveloperName, NamespacePrefix FROM CustomObject WHERE DeveloperName IN (${quoted(
        bare.slice(i, i + 200)
      )})`
    ))
      out.set(`CustomObject:${objectName(r)}`, text(r.Id));
  }
  return out;
}

/** What the pieces use, by name: classes, custom objects and custom fields (Object.Field). */
async function usedBy(source: SalesforceClient, ids: Map<string, string>): Promise<Array<Piece & { by: string }>> {
  const byId = new Map([...ids].map(([k, v]) => [v, k.split(':')[1]]));
  const list = [...byId.keys()].filter((i) => ID.test(i));
  const deps: Row[] = [];
  for (let i = 0; i < list.length; i += 100) {
    // eslint-disable-next-line no-await-in-loop
    deps.push(
      ...(await tooling(
        source,
        `SELECT MetadataComponentId, RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE MetadataComponentId IN (${quoted(
          list.slice(i, i + 100)
        )})`
      ))
    );
  }
  // Names of the custom objects and fields used (the record gives their bare DeveloperName)
  const objectIds = deps
    .filter((d) => d.RefMetadataComponentType === 'CustomObject')
    .map((d) => text(d.RefMetadataComponentId));
  const fieldIds = deps
    .filter((d) => d.RefMetadataComponentType === 'CustomField')
    .map((d) => text(d.RefMetadataComponentId));
  const objects = new Map<string, string>();
  if (objectIds.length)
    for (const r of await tooling(
      source,
      `SELECT Id, DeveloperName, NamespacePrefix FROM CustomObject WHERE Id IN (${quoted(objectIds)})`
    ))
      objects.set(text(r.Id).slice(0, 15), objectName(r));
  const fields = new Map<string, string>();
  if (fieldIds.length) {
    const rows = await tooling(
      source,
      `SELECT Id, DeveloperName, NamespacePrefix, TableEnumOrId FROM CustomField WHERE Id IN (${quoted(fieldIds)})`
    );
    // A field of a custom object names it by Id
    const tables = [...new Set(rows.map((r) => text(r.TableEnumOrId)).filter((t) => /^01I/.test(t)))];
    const tableNames = new Map<string, string>();
    if (tables.length)
      for (const r of await tooling(
        source,
        `SELECT Id, DeveloperName, NamespacePrefix FROM CustomObject WHERE Id IN (${quoted(tables)})`
      ))
        tableNames.set(text(r.Id).slice(0, 15), objectName(r));
    for (const r of rows) {
      const table = text(r.TableEnumOrId);
      const object = /^01I/.test(table) ? tableNames.get(table.slice(0, 15)) ?? '' : table;
      if (object)
        fields.set(
          text(r.Id).slice(0, 15),
          `${object}.${r.NamespacePrefix ? `${text(r.NamespacePrefix)}__` : ''}${text(r.DeveloperName)}__c`
        );
    }
  }
  const out: Array<Piece & { by: string }> = [];
  for (const d of deps) {
    const by = byId.get(text(d.MetadataComponentId)) ?? '';
    const ref = text(d.RefMetadataComponentId).slice(0, 15);
    if (d.RefMetadataComponentType === 'ApexClass')
      out.push({ type: 'ApexClass', name: text(d.RefMetadataComponentName), by });
    else if (d.RefMetadataComponentType === 'CustomObject' && objects.has(ref))
      out.push({ type: 'CustomObject', name: objects.get(ref)!, by });
    else if (d.RefMetadataComponentType === 'CustomField' && fields.has(ref))
      out.push({ type: 'CustomField', name: fields.get(ref)!, by });
  }
  return out;
}

/**
 * The pieces the chosen ones need in the target too, found in the source org and followed (a class that uses a class
 * that uses an object…). Only what the target lacks and the chosen ones do not already bring; a field of an object
 * that is added comes with the object.
 */
export async function neededToo(
  source: SalesforceClient,
  target: SalesforceClient,
  chosen: Piece[],
  rounds = 5
): Promise<AddedPiece[]> {
  const have = new Set(chosen.map((c) => `${c.type}:${c.name}`));
  const added: AddedPiece[] = [];
  let frontier: Piece[] = chosen;
  for (let round = 0; round < rounds && frontier.length; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const ids = await idsOf(source, frontier);
    // eslint-disable-next-line no-await-in-loop
    const used = (await usedBy(source, ids)).filter((u) => !have.has(`${u.type}:${u.name}`));
    if (!used.length) break;
    // eslint-disable-next-line no-await-in-loop
    const missing = await missingSchema(target, [], {
      objects: used.filter((u) => u.type === 'CustomObject').map((u) => u.name),
      fields: used.filter((u) => u.type === 'CustomField').map((u) => u.name),
      classes: used.filter((u) => u.type === 'ApexClass').map((u) => u.name),
    });
    const isMissing = (u: Piece) =>
      (u.type === 'CustomObject' && missing.objects.includes(u.name)) ||
      (u.type === 'CustomField' &&
        (missing.fields.includes(u.name) || missing.objects.includes(u.name.split('.')[0]))) ||
      (u.type === 'ApexClass' && missing.classes.includes(u.name));
    const next: Piece[] = [];
    for (const u of used) {
      if (!isMissing(u)) continue;
      // A field whose object is missing comes with the object
      const piece =
        u.type === 'CustomField' && missing.objects.includes(u.name.split('.')[0])
          ? { type: 'CustomObject', name: u.name.split('.')[0] }
          : { type: u.type, name: u.name };
      const key = `${piece.type}:${piece.name}`;
      if (have.has(key)) continue;
      have.add(key);
      added.push({ ...piece, neededBy: u.by });
      next.push(piece);
    }
    frontier = next;
  }
  return added;
}

/** A role's parents in the source org (by DeveloperName), nearest first: a role is deployed under its parent. */
async function parentRoles(source: SalesforceClient, roles: string[]): Promise<Array<{ name: string; child: string }>> {
  if (!roles.length) return [];
  const all = await query(source, 'SELECT Id, DeveloperName, ParentRoleId FROM UserRole', { maxRows: 50_000 }).catch(
    () => ({ rows: [] as Row[] })
  );
  const byId = new Map(all.rows.map((r) => [text(r.Id), r]));
  const byName = new Map(all.rows.flatMap((r) => [[text(r.Name), r] as const, [text(r.DeveloperName), r] as const]));
  const out: Array<{ name: string; child: string }> = [];
  for (const role of roles) {
    let r = byName.get(role);
    while (r && r.ParentRoleId) {
      const parent = byId.get(text(r.ParentRoleId));
      if (!parent) break;
      out.push({ name: text(parent.DeveloperName), child: text(r.DeveloperName) });
      r = parent;
    }
  }
  return out;
}

/** The roles' parents the target lacks too, to deploy with them. */
export async function rolesToo(
  source: SalesforceClient,
  target: SalesforceClient,
  roles: string[]
): Promise<AddedPiece[]> {
  const parents = await parentRoles(source, roles);
  if (!parents.length) return [];
  const missing = await missingSchema(target, [], { roles: parents.map((p) => p.name) });
  const seen = new Set(roles);
  return parents
    .filter((p) => missing.roles.includes(p.name) && !seen.has(p.name) && (seen.add(p.name), true))
    .map((p) => ({ type: 'Role', name: p.name, neededBy: p.child }));
}

/**
 * A deployable zip of the pieces, retrieved from the source org: classes, objects (whole), fields (each in a copy of
 * its object's file that holds only the fields asked for — a field is not a file of its own), roles, groups.
 */
export async function piecesZip(source: SalesforceClient, pieces: Piece[]): Promise<Uint8Array> {
  const version = await source.version();
  // A role named by its name ("Support Manager") is deployed by its API name
  if (pieces.some((p) => p.type === 'Role')) {
    const roles = (await query(source, 'SELECT DeveloperName, Name FROM UserRole', { maxRows: 50_000 })).rows;
    const api = new Map(
      roles.flatMap((r) => [
        [text(r.Name), text(r.DeveloperName)] as const,
        [text(r.DeveloperName), text(r.DeveloperName)] as const,
      ])
    );
    pieces = pieces.map((p) => (p.type === 'Role' ? { ...p, name: api.get(p.name) ?? p.name } : p));
  }
  // A queue is its own metadata type (a public group is a Group)
  const groupNames = pieces.filter((p) => p.type === 'Group').map((p) => p.name);
  if (groupNames.length) {
    const kinds = (
      await query(source, `SELECT DeveloperName, Type FROM Group WHERE DeveloperName IN (${quoted(groupNames)})`, {
        maxRows: 5000,
      })
    ).rows;
    const queues = new Set(kinds.filter((r) => r.Type === 'Queue').map((r) => text(r.DeveloperName)));
    pieces = pieces.map((p) => (p.type === 'Group' && queues.has(p.name) ? { ...p, type: 'Queue' } : p));
  }
  // Fields are retrieved through their object (the object's file holds them)
  const fieldObjects = [...new Set(pieces.filter((p) => p.type === 'CustomField').map((p) => p.name.split('.')[0]))];
  const wholeObjects = new Set(pieces.filter((p) => p.type === 'CustomObject').map((p) => p.name));
  const retrieve = [
    ...pieces.filter((p) => p.type !== 'CustomField').map((p) => ({ type: p.type, fullName: p.name })),
    ...fieldObjects.filter((o) => !wholeObjects.has(o)).map((o) => ({ type: 'CustomObject', fullName: o })),
  ];
  const retrieved = await retrieveZip(source, retrieve);
  if (!retrieved.zipFile) throw new Error(retrieved.errorMessage ?? 'The source org returned no files.');
  const zip = await readZip(fromBase64(retrieved.zipFile));
  const out = new Map<string, Uint8Array>();
  const take = (path: string) => {
    const f = zip.get(path);
    if (!f) return;
    // A queue's members are users of the source org: left out (the users join it when they are created)
    out.set(
      path,
      path.endsWith('.queue')
        ? new TextEncoder().encode(new TextDecoder().decode(f).replace(/\s*<users>[\s\S]*?<\/users>/g, ''))
        : f
    );
  };
  for (const p of pieces) {
    if (p.type === 'ApexClass') {
      take(`classes/${p.name}.cls`);
      take(`classes/${p.name}.cls-meta.xml`);
    } else if (p.type === 'CustomObject') take(`objects/${p.name}.object`);
    else if (p.type === 'Role') take(`roles/${p.name}.role`);
    else if (p.type === 'Group') take(`groups/${p.name}.group`);
    else if (p.type === 'Queue') take(`queues/${p.name}.queue`);
  }
  // An object's file cut down to the fields asked for
  for (const object of fieldObjects.filter((o) => !wholeObjects.has(o))) {
    const file = zip.get(`objects/${object}.object`);
    if (!file) continue;
    const xml = new TextDecoder().decode(file);
    const wanted = new Set(
      pieces.filter((p) => p.type === 'CustomField' && p.name.startsWith(`${object}.`)).map((p) => p.name.split('.')[1])
    );
    const blocks = [...xml.matchAll(/<fields>[\s\S]*?<\/fields>/g)]
      .map((m) => m[0])
      .filter((b) => wanted.has(/<fullName>([^<]+)<\/fullName>/.exec(b)?.[1] ?? ''));
    out.set(
      `objects/${object}.object`,
      new TextEncoder().encode(
        `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n    ${blocks.join(
          '\n    '
        )}\n</CustomObject>\n`
      )
    );
  }
  out.set(
    'package.xml',
    new TextEncoder().encode(
      packageXml(
        pieces.map((p) => ({ type: p.type, fullName: p.name })),
        version
      )
    )
  );
  return makeZip([...out].map(([path, content]) => ({ path, content })));
}
