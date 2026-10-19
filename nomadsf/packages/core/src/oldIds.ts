import { describeData } from './backup.js';
import { bulkIngest, bulkQuery } from './bulk.js';
import type { SalesforceClient } from './client.js';
import { parseCsv, toCsv } from './csv.js';
import {
  createRecords,
  deleteRecords,
  fieldPlan,
  loadOrder,
  transformRow,
  updateRecords,
  type LoadFailure,
  type LoadProgress,
  type LoadResult,
  type ObjectLoadResult,
  type ObjectLoad,
  type OrgMaps,
  type Resolver,
  type SourceRow,
} from './dataLoad.js';
import { deleteFromOrg, deployZip } from './deploy.js';
import { packageXml } from './metadata.js';
import { query } from './query.js';
import { getUserInfo } from './soap.js';
import { makeZip, toBase64 } from './zip.js';

/**
 * Keeping the old Ids in the target org: a field NomadSF_Old_Id__c (text, External ID, unique)
 * on every object loaded holds the Id each record had in the source org or backup. Records are
 * upserted on it with the Bulk API (running again never duplicates), and old Id -> new Id is
 * read back from the org after each object, so lookups of the next objects point to the right
 * records. Objects that cannot take custom fields use the in-browser Id map instead.
 */

export const OLD_ID_FIELD = 'NomadSF_Old_Id__c';
export const OLD_ID_PERMISSION_SET = 'NomadSF_Old_Ids';

export type OldIdStatus = {
  object: string;
  /** ready: the field exists and you can write it; create: it is created (or you get access); unsupported: no custom fields here. */
  status: 'ready' | 'create' | 'unsupported';
  exists: boolean;
};

/** Which objects already have the field, which get it, and which cannot have custom fields. */
export async function oldIdFieldStatus(target: SalesforceClient, objects: string[]): Promise<OldIdStatus[]> {
  const names = objects.filter((o) => /^\w+$/.test(o));
  if (!names.length) return [];
  const entities = await query(
    target,
    `SELECT QualifiedApiName, IsCustomizable FROM EntityDefinition WHERE QualifiedApiName IN (${names
      .map((n) => `'${n}'`)
      .join(',')})`,
    { tooling: true, maxRows: 2000 }
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  const customizable = new Map(entities.rows.map((r) => [String(r.QualifiedApiName), Boolean(r.IsCustomizable)]));
  const out: OldIdStatus[] = [];
  for (const object of names) {
    // eslint-disable-next-line no-await-in-loop
    const fields = await describeData(target, object).catch(() => []);
    const field = fields.find((f) => f.name === OLD_ID_FIELD);
    if (field?.createable && field.updateable) out.push({ object, status: 'ready', exists: true });
    else if (field) out.push({ object, status: 'create', exists: true });
    else if (customizable.get(object) === false || object.endsWith('__mdt') || object.endsWith('__e'))
      out.push({ object, status: 'unsupported', exists: false });
    else out.push({ object, status: 'create', exists: false });
  }
  return out;
}

const fieldXml = (): string => `    <fields>
        <fullName>${OLD_ID_FIELD}</fullName>
        <label>NomadSF Old Id</label>
        <description>Id of this record in the org or backup it was copied from (NomadSF data load). Can be deleted after the load.</description>
        <type>Text</type>
        <length>18</length>
        <externalId>true</externalId>
        <unique>true</unique>
        <caseSensitive>true</caseSensitive>
        <required>false</required>
    </fields>`;

/** The metadata package: the field on the objects that lack it, and a permission set to write it on all of them. */
export function oldIdFieldPackage(
  create: string[],
  all: string[],
  apiVersion: string
): { zipBase64: string; packageXml: string } {
  const entries: Array<{ path: string; content: string }> = [];
  for (const object of create)
    entries.push({
      path: `objects/${object}.object`,
      content: `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n${fieldXml()}\n</CustomObject>\n`,
    });
  entries.push({
    path: `permissionsets/${OLD_ID_PERMISSION_SET}.permissionset`,
    content: `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>NomadSF Old Ids</label>
    <description>Lets the person loading data with NomadSF write the old-Id field. Can be deleted after the load.</description>
${all
  .map(
    (o) =>
      `    <fieldPermissions>\n        <editable>true</editable>\n        <field>${o}.${OLD_ID_FIELD}</field>\n        <readable>true</readable>\n    </fieldPermissions>`
  )
  .join('\n')}
</PermissionSet>
`,
  });
  const manifest = packageXml(
    [
      ...create.map((o) => ({ type: 'CustomField', fullName: `${o}.${OLD_ID_FIELD}` })),
      { type: 'PermissionSet', fullName: OLD_ID_PERMISSION_SET },
    ],
    apiVersion
  );
  return {
    zipBase64: toBase64(makeZip([{ path: 'package.xml', content: manifest }, ...entries])),
    packageXml: manifest,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates the field where it is missing, gives you write access with the permission set, and
 * waits until it can be written. Objects that cannot have it are returned as unsupported.
 */
export async function ensureOldIdFields(
  target: SalesforceClient,
  objects: string[],
  onProgress?: (text: string) => void,
  options: { pollMs?: number } = {}
): Promise<OldIdStatus[]> {
  let status = await oldIdFieldStatus(target, objects);
  const usable = status.filter((s) => s.status !== 'unsupported').map((s) => s.object);
  const create = status.filter((s) => s.status === 'create' && !s.exists).map((s) => s.object);
  if (status.some((s) => s.status === 'create')) {
    onProgress?.(`Creating ${OLD_ID_FIELD} on ${create.length} object(s) and the permission set…`);
    const pkg = oldIdFieldPackage(create, usable, await target.version());
    const outcome = await deployZip(target, pkg.zipBase64, { testLevel: 'Default', pollMs: options.pollMs });
    if (!outcome.success)
      throw new Error(
        `Could not create the old-Id field: ${
          outcome.componentFailures.map((f) => `${f.name}: ${f.problem}`).join('; ') ||
          outcome.errorMessage ||
          outcome.status
        }`
      );
    onProgress?.('Giving you access to the field…');
    const set = await query(target, `SELECT Id FROM PermissionSet WHERE Name = '${OLD_ID_PERMISSION_SET}'`);
    const setId = String(set.rows[0]?.Id ?? '');
    const me = await getUserInfo(target);
    if (setId) {
      const assigned = await query(
        target,
        `SELECT Id FROM PermissionSetAssignment WHERE PermissionSetId = '${setId}' AND AssigneeId = '${me.userId}'`
      );
      if (!assigned.rows.length)
        await target.rest('POST', '/sobjects/PermissionSetAssignment', {
          PermissionSetId: setId,
          AssigneeId: me.userId,
        });
    }
    // Field access can take a moment to show in describe
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      status = await oldIdFieldStatus(target, objects);
      if (!status.some((s) => s.status === 'create')) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(options.pollMs ?? 2000);
    }
    const stuck = status.filter((s) => s.status === 'create').map((s) => s.object);
    if (stuck.length)
      throw new Error(`The old-Id field is not writable yet on ${stuck.join(', ')}; try again in a minute.`);
  }
  return status;
}

/** Removes the field from the objects and the permission set (assignments first). */
export async function removeOldIdFields(
  target: SalesforceClient,
  objects: string[],
  onProgress?: (text: string) => void,
  options: { pollMs?: number } = {}
): Promise<{ removed: string[] }> {
  const status = await oldIdFieldStatus(target, objects);
  const withField = status.filter((s) => s.exists).map((s) => s.object);
  onProgress?.('Removing the permission set assignments…');
  const assignments = await query(
    target,
    `SELECT Id FROM PermissionSetAssignment WHERE PermissionSet.Name = '${OLD_ID_PERMISSION_SET}'`
  ).catch(() => ({ rows: [] as Array<Record<string, unknown>> }));
  if (assignments.rows.length)
    await deleteRecords(
      target,
      assignments.rows.map((r) => String(r.Id))
    );
  const set = await query(target, `SELECT Id FROM PermissionSet WHERE Name = '${OLD_ID_PERMISSION_SET}'`).catch(() => ({
    rows: [] as Array<Record<string, unknown>>,
  }));
  const components = [
    ...withField.map((o) => ({ type: 'CustomField', fullName: `${o}.${OLD_ID_FIELD}` })),
    ...(set.rows.length ? [{ type: 'PermissionSet', fullName: OLD_ID_PERMISSION_SET }] : []),
  ];
  if (!components.length) return { removed: [] };
  onProgress?.(`Removing ${OLD_ID_FIELD} from ${withField.length} object(s)…`);
  const outcome = await deleteFromOrg(target, components, { testLevel: 'Default', pollMs: options.pollMs });
  if (!outcome.success)
    throw new Error(
      `Could not remove the old-Id fields: ${
        outcome.componentFailures.map((f) => `${f.name}: ${f.problem}`).join('; ') ||
        outcome.errorMessage ||
        outcome.status
      }`
    );
  return { removed: withField };
}

/** Old Id -> new Id of the records of an object that carry the field. */
export async function readOldIds(target: SalesforceClient, object: string): Promise<Map<string, string>> {
  const result = await bulkQuery(target, `SELECT Id, ${OLD_ID_FIELD} FROM ${object} WHERE ${OLD_ID_FIELD} != null`);
  return new Map(parseCsv(result.csv).rows.map((r) => [r[OLD_ID_FIELD], r.Id]));
}

const csvValue = (v: unknown): string =>
  typeof v === 'boolean' ? String(v) : v === null || v === undefined ? '' : String(v);

/**
 * Loads rows into the target through the old-Id field (Bulk API upsert): parents first,
 * lookups translated with the old -> new map read back from the org, self and circular lookups
 * in a second upsert. Objects in `withoutField` use sObject Collections and the in-browser map.
 */
export async function loadWithOldIds(
  target: SalesforceClient,
  loads: ObjectLoad[],
  rows: Record<string, SourceRow[]>,
  options: {
    maps: OrgMaps;
    keepUnmapped?: boolean;
    known?: Record<string, string>;
    withoutField?: string[];
    onProgress?: LoadProgress;
    pollMs?: number;
  }
): Promise<LoadResult> {
  const { order, deferred } = loadOrder(
    loads.map((l) => l.name),
    Object.fromEntries(loads.map((l) => [l.name, l.source]))
  );
  const noField = new Set(options.withoutField ?? []);
  const ids = new Map(Object.entries(options.known ?? {}));
  // Records loaded by an earlier run carry their old Id: start from them
  for (const name of order.filter((o) => !noField.has(o))) {
    /* eslint-disable no-await-in-loop */
    for (const [oldId, newId] of await readOldIds(target, name)) ids.set(oldId, newId);
  }
  const resolver: Resolver = { ids, maps: options.maps, keepUnmapped: Boolean(options.keepUnmapped) };
  const objects: ObjectLoadResult[] = [];
  const failures: LoadFailure[] = [];
  const created: LoadResult['created'] = [];
  const later: Record<string, Array<{ oldId: string; fields: Record<string, string> }>> = {};

  for (const [index, name] of order.entries()) {
    const load = loads.find((l) => l.name === name)!;
    const list = rows[name] ?? [];
    const plan = fieldPlan(load, list.length ? Object.keys(list[0]) : undefined);
    const result: ObjectLoadResult = { name, rows: list.length, created: 0, updated: 0, failed: 0, dropped: {} };
    objects.push(result);
    const step = (done: number, phase: string): void =>
      options.onProgress?.({ object: name, index, total: order.length, done, rows: list.length, phase });
    if (!list.length) continue;
    const records = list.map((row) => {
      const t = transformRow(row, load, plan.write, deferred[name] ?? [], resolver);
      for (const d of t.dropped) result.dropped[d] = (result.dropped[d] ?? 0) + 1;
      if (Object.keys(t.deferred).length) (later[name] ??= []).push({ oldId: row.Id, fields: t.deferred });
      return { row, record: t.record };
    });

    if (noField.has(name)) {
      // No custom field possible here: sObject Collections, like the default load
      step(0, 'creating');
      const made = await createRecords(
        target,
        name,
        records.map((r) => r.record)
      );
      const newIds: string[] = [];
      made.forEach((m, k) => {
        if (m.success && m.id) {
          ids.set(records[k].row.Id, m.id);
          newIds.push(m.id);
          result.created++;
        } else {
          result.failed++;
          failures.push({
            object: name,
            sourceId: records[k].row.Id,
            error: (m.errors ?? []).map((e) => `${e.statusCode}: ${e.message}`).join('; ') || 'Failed',
          });
        }
      });
      if (newIds.length) created.unshift({ object: name, ids: newIds });
      step(list.length, 'done');
      continue;
    }

    step(0, 'upserting');
    const columns = [OLD_ID_FIELD, ...new Set(records.flatMap((r) => Object.keys(r.record)))];
    const csv = toCsv(
      columns,
      records.map((r) =>
        Object.fromEntries([[OLD_ID_FIELD, r.row.Id], ...Object.entries(r.record).map(([k, v]) => [k, csvValue(v)])])
      )
    );
    const job = await bulkIngest(
      target,
      { object: name, operation: 'upsert', csv, externalIdField: OLD_ID_FIELD },
      {
        pollMs: options.pollMs,
        onProgress: (state, processed) => step(processed, state),
      }
    );
    const ok = parseCsv(job.successfulCsv || '').rows;
    const newIds = ok.filter((r) => r.sf__Created === 'true').map((r) => r.sf__Id);
    result.created = newIds.length;
    result.updated = ok.length - newIds.length;
    for (const f of parseCsv(job.failedCsv || '').rows) {
      result.failed++;
      failures.push({ object: name, sourceId: f[OLD_ID_FIELD] ?? '', error: f.sf__Error ?? 'Failed' });
    }
    if (newIds.length) created.unshift({ object: name, ids: newIds });
    for (const [oldId, newId] of await readOldIds(target, name)) ids.set(oldId, newId);
    step(list.length, 'done');
  }

  // Second pass: lookups to the same object or across a circle
  for (const name of order) {
    const pending = later[name] ?? [];
    if (!pending.length) continue;
    const updates = pending
      .map((p) => {
        const values: Record<string, string> = {};
        for (const [field, value] of Object.entries(p.fields)) {
          const mapped = ids.get(value) ?? (options.keepUnmapped ? value : undefined);
          if (mapped) values[field] = mapped;
        }
        return { oldId: p.oldId, values };
      })
      .filter((u) => Object.keys(u.values).length);
    if (!updates.length) continue;
    options.onProgress?.({
      object: name,
      index: order.indexOf(name),
      total: order.length,
      done: 0,
      rows: updates.length,
      phase: 'linking',
    });
    if (noField.has(name)) {
      const done = await updateByIds(target, name, updates, ids);
      failures.push(...done);
      continue;
    }
    const columns = [OLD_ID_FIELD, ...new Set(updates.flatMap((u) => Object.keys(u.values)))];
    const job = await bulkIngest(
      target,
      {
        object: name,
        operation: 'upsert',
        externalIdField: OLD_ID_FIELD,
        csv: toCsv(
          columns,
          updates.map((u) => ({ [OLD_ID_FIELD]: u.oldId, ...u.values }))
        ),
      },
      { pollMs: options.pollMs }
    );
    for (const f of parseCsv(job.failedCsv || '').rows)
      failures.push({ object: name, sourceId: f[OLD_ID_FIELD] ?? '', error: `Linking: ${f.sf__Error ?? 'Failed'}` });
  }
  /* eslint-enable no-await-in-loop */
  return { objects, failures, ids: Object.fromEntries(ids), created };
}

async function updateByIds(
  target: SalesforceClient,
  object: string,
  updates: Array<{ oldId: string; values: Record<string, string> }>,
  ids: Map<string, string>
): Promise<LoadFailure[]> {
  const records = updates.filter((u) => ids.get(u.oldId)).map((u) => ({ Id: ids.get(u.oldId)!, ...u.values }));
  const results = await updateRecords(target, object, records);
  return results
    .map((r, k) =>
      r.success
        ? undefined
        : { object, sourceId: records[k].Id, error: `Linking: ${(r.errors ?? []).map((e) => e.message).join('; ')}` }
    )
    .filter((f): f is LoadFailure => Boolean(f));
}
