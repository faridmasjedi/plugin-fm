import { chooseFields, type DataField, type FieldChoice } from './backup.js';
import type { SalesforceClient } from './client.js';
import {
  defaultMasking,
  fetchRelated,
  fetchRows,
  fieldPlan,
  loadOrder,
  loadRecords,
  type FieldPlan,
  type LoadProgress,
  type LoadResult,
  type MaskRule,
  type OrgMaps,
  type SourceRow,
} from './dataLoad.js';

/**
 * Moving data between orgs (or from a backup into an org): which objects and records, which
 * fields, masking, then the rows are gathered parents first and loaded with the Id mapping of
 * dataLoad. "Related only" takes just the records that point to records already chosen, so a
 * sandbox can be seeded with e.g. 100 Accounts and their Contacts and Opportunities.
 */

export type MigrateObject = {
  name: string;
  /** SOQL condition (source org only; a backup has no SOQL). */
  where?: string;
  fields?: FieldChoice;
  /** Only records whose lookups point to records of the objects loaded before it. */
  relatedOnly?: boolean;
};

export type MigrateObjectPlan = {
  name: string;
  fields: FieldPlan;
  /** Fields read from the source (the field choice, with Id). */
  read: string[];
  mask: Record<string, MaskRule>;
  /** Lookups to objects of the plan (for "related only" and the order). */
  links: Array<{ field: string; to: string }>;
  relatedOnly: boolean;
  where?: string;
};

export type MigratePlan = {
  order: string[];
  deferred: Record<string, string[]>;
  objects: MigrateObjectPlan[];
  schemas: Record<string, { source: DataField[]; target: DataField[] }>;
  /** Objects that do not exist in the target. */
  missingObjects: string[];
};

export function planMigration(
  input: MigrateObject[],
  schemas: Record<string, { source: DataField[]; target: DataField[] }>,
  options: { mask: boolean; maskOverrides?: Record<string, Record<string, MaskRule | 'none'>> }
): MigratePlan {
  const missingObjects = input.filter((o) => !schemas[o.name]?.target.length).map((o) => o.name);
  const usable = input.filter((o) => !missingObjects.includes(o.name));
  const names = usable.map((o) => o.name);
  const { order, deferred } = loadOrder(names, Object.fromEntries(names.map((n) => [n, schemas[n].source])));
  const objects = order.map((name) => {
    const o = usable.find((x) => x.name === name)!;
    const { source, target } = schemas[name];
    const read = chooseFields(source, o.fields);
    const fields = fieldPlan({ source, target }, read);
    const mask: Record<string, MaskRule> = options.mask
      ? defaultMasking(target.filter((f) => fields.write.includes(f.name)))
      : {};
    for (const [field, rule] of Object.entries(options.maskOverrides?.[name] ?? {})) {
      if (rule === 'none') delete mask[field];
      else if (fields.write.includes(field)) mask[field] = rule;
    }
    const links = source
      .filter((f) => f.type === 'reference' && read.includes(f.name))
      .flatMap((f) =>
        f.referenceTo.filter((to) => names.includes(to) && to !== name).map((to) => ({ field: f.name, to }))
      );
    return { name, fields, read, mask, links, relatedOnly: Boolean(o.relatedOnly), where: o.where };
  });
  return { order, deferred, objects, schemas, missingObjects };
}

export type RowSource =
  | { kind: 'org'; client: SalesforceClient }
  | { kind: 'backup'; rows: Record<string, Map<string, SourceRow>> };

/** The rows to load, parents first; "related only" objects keep the rows linked to rows gathered before. */
export async function gatherRows(
  source: RowSource,
  plan: MigratePlan,
  onProgress?: (object: string, rows: number) => void
): Promise<Record<string, SourceRow[]>> {
  const out: Record<string, SourceRow[]> = {};
  for (const o of plan.objects) {
    const links = o.links.filter((l) => out[l.to]).map((l) => ({ field: l.field, ids: out[l.to].map((r) => r.Id) }));
    let rows: SourceRow[];
    if (source.kind === 'org') {
      /* eslint-disable no-await-in-loop */
      rows =
        o.relatedOnly && links.length
          ? await fetchRelated(source.client, o.name, o.read, links, o.where)
          : await fetchRows(source.client, o.name, o.read, o.where);
      /* eslint-enable no-await-in-loop */
    } else {
      const all = [...(source.rows[o.name]?.values() ?? [])];
      const linked = links.map((l) => ({ field: l.field, ids: new Set(l.ids) }));
      rows = o.relatedOnly && links.length ? all.filter((r) => linked.some((l) => l.ids.has(r[l.field]))) : all;
    }
    out[o.name] = rows;
    onProgress?.(o.name, rows.length);
  }
  return out;
}

export async function runMigration(
  target: SalesforceClient,
  plan: MigratePlan,
  rows: Record<string, SourceRow[]>,
  options: {
    maps: OrgMaps;
    known?: Record<string, string>;
    keepUnmapped?: boolean;
    onProgress?: LoadProgress;
    signal?: AbortSignal;
  }
): Promise<LoadResult> {
  return loadRecords(
    target,
    plan.objects.map((o) => ({
      name: o.name,
      source: plan.schemas[o.name].source,
      target: plan.schemas[o.name].target,
      mask: o.mask,
    })),
    rows,
    options
  );
}
