import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { DataField, MigrateObject } from '@nomadsf/core';

type Node = { o: MigrateObject; depth: number; via?: string };

/** Each chosen object under the one it links to ("related only" objects), roots first. */
function tree(chosen: MigrateObject[], fields: Record<string, DataField[]>): Node[] {
  const names = new Set(chosen.map((c) => c.name));
  const parentOf = new Map<string, { parent: string; via: string }>();
  for (const c of chosen.filter((x) => x.relatedOnly)) {
    const link = (fields[c.name] ?? []).find(
      (f) => f.type === 'reference' && f.referenceTo.some((t) => names.has(t) && t !== c.name)
    );
    if (link)
      parentOf.set(c.name, { parent: link.referenceTo.find((t) => names.has(t) && t !== c.name)!, via: link.name });
  }
  const out: Node[] = [];
  const seen = new Set<string>();
  const walk = (name: string, depth: number, via?: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const o = chosen.find((c) => c.name === name)!;
    out.push({ o, depth, via });
    for (const child of chosen.filter((c) => parentOf.get(c.name)?.parent === name))
      walk(child.name, depth + 1, parentOf.get(child.name)!.via);
  };
  for (const c of chosen.filter((x) => !x.onlyReferenced && !parentOf.has(x.name))) walk(c.name, 0);
  // Anything left (a loop, or fields not read yet) at the top level
  for (const c of chosen.filter((x) => !x.onlyReferenced)) walk(c.name, 0);
  return out;
}

const fieldsText = (o: MigrateObject): string =>
  !o.fields || o.fields.mode === 'all'
    ? 'All fields'
    : o.fields.mode === 'only'
    ? `Only ${o.fields.fields.length}`
    : `All except ${o.fields.fields.length}`;

/**
 * Migrate's plan as one table, like a data composer: every object with its children under it,
 * which records (all, related only, only those pointed to), a condition, a limit and the fields —
 * and from each row add children or parents, or remove it.
 */
export function MigrateComposer({
  chosen,
  fields,
  loadFields,
  setSettings,
  remove,
  addParent,
  renderFields,
  renderChildren,
  backup,
}: {
  chosen: MigrateObject[];
  fields: Record<string, DataField[]>;
  loadFields: (name: string) => Promise<void>;
  setSettings: (name: string, patch: Partial<MigrateObject>) => void;
  remove: (name: string) => void;
  addParent: (name: string) => void;
  renderFields: (name: string) => ReactNode;
  renderChildren: (name: string, close: () => void) => ReactNode;
  /** From a backup: no SOQL conditions. */
  backup: boolean;
}) {
  const [open, setOpen] = useState('');
  // The tree needs each object's lookups
  useEffect(() => {
    const missing = chosen.map((c) => c.name).filter((n) => !fields[n]);
    void (async () => {
      for (const name of missing) {
        // eslint-disable-next-line no-await-in-loop
        await loadFields(name).catch(() => undefined);
      }
    })();
    // loadFields changes with the page; the names are what matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen.map((c) => c.name).join(',')]);

  const rows = useMemo(() => tree(chosen, fields), [chosen, fields]);
  const referenced = chosen.filter((c) => c.onlyReferenced);
  const names = new Set(chosen.map((c) => c.name));
  const parentsOf = (name: string): Array<{ object: string; via: string }> =>
    (fields[name] ?? [])
      .filter((f) => f.type === 'reference')
      .flatMap((f) => f.referenceTo.filter((t) => !names.has(t) && t !== name).map((t) => ({ object: t, via: f.name })))
      .filter((p, i, list) => list.findIndex((x) => x.object === p.object) === i);

  const row = (n: Node, group: 'tree' | 'parents') => {
    const o = n.o;
    const parents = parentsOf(o.name);
    return (
      <Fragment key={o.name}>
        <tr>
          <td>
            <span style={{ paddingLeft: n.depth * 18 }} className="composer-object">
              {n.depth > 0 && <span className="muted">↳ </span>}
              <b>{o.name}</b>
              {n.via && <span className="muted"> via {n.via}</span>}
            </span>
          </td>
          <td>
            <select
              value={o.onlyReferenced ? 'referenced' : o.relatedOnly ? 'related' : 'all'}
              title="Which records of this object are copied"
              onChange={(e) =>
                setSettings(o.name, {
                  relatedOnly: e.target.value === 'related',
                  onlyReferenced: e.target.value === 'referenced',
                })
              }
            >
              <option value="all">{backup ? 'All' : 'All (or the condition)'}</option>
              <option value="related">Related to the ones above</option>
              <option value="referenced">Only those pointed to</option>
            </select>
          </td>
          <td>
            <input
              className="mono"
              placeholder={backup ? 'no SOQL from a backup' : "e.g. Industry = 'Retail'"}
              disabled={backup || group === 'parents'}
              value={o.where ?? ''}
              onChange={(e) => setSettings(o.name, { where: e.target.value || undefined })}
            />
          </td>
          <td>
            <input
              type="number"
              min={1}
              placeholder="all"
              title="At most this many records, the newest first"
              disabled={group === 'parents'}
              value={o.limit ?? ''}
              onChange={(e) =>
                setSettings(o.name, { limit: e.target.value ? Math.max(1, Number(e.target.value)) : undefined })
              }
              style={{ width: 90 }}
            />
          </td>
          <td>
            <button className="link" onClick={() => setOpen(open === `fields:${o.name}` ? '' : `fields:${o.name}`)}>
              {fieldsText(o)}
            </button>
          </td>
          <td className="composer-actions">
            {group === 'tree' && (
              <button
                className="link"
                onClick={() => setOpen(open === `children:${o.name}` ? '' : `children:${o.name}`)}
              >
                + Children…
              </button>
            )}
            {parents.length > 0 && (
              <select
                value=""
                title="Also copy the records this object's lookups point to"
                onChange={(e) => e.target.value && addParent(e.target.value)}
              >
                <option value="">+ Parent…</option>
                {parents.map((p) => (
                  <option key={p.object} value={p.object}>
                    {p.object} (via {p.via})
                  </option>
                ))}
              </select>
            )}
            <button className="link danger" onClick={() => remove(o.name)}>
              Remove
            </button>
          </td>
        </tr>
        {open === `fields:${o.name}` && (
          <tr>
            <td colSpan={6}>{renderFields(o.name)}</td>
          </tr>
        )}
        {open === `children:${o.name}` && (
          <tr>
            <td colSpan={6}>{renderChildren(o.name, () => setOpen(''))}</td>
          </tr>
        )}
      </Fragment>
    );
  };

  if (!chosen.length)
    return <p className="muted">Tick objects below (or use + Children… on one) to build the plan here.</p>;
  return (
    <div className="composer">
      <table className="edit-table composer-table">
        <thead>
          <tr>
            <th>Object</th>
            <th>Records</th>
            <th>Condition (SOQL)</th>
            <th>Limit</th>
            <th>Fields</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((n) => row(n, 'tree'))}
          {referenced.length > 0 && (
            <tr>
              <td colSpan={6} className="muted composer-group">
                Parents: only the records the copied ones point to (brought in so every lookup is kept)
              </td>
            </tr>
          )}
          {referenced.map((o) => row({ o, depth: 0 }, 'parents'))}
        </tbody>
      </table>
    </div>
  );
}
