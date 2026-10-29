import { useEffect, useState } from 'react';
import {
  childObjectsInSchema,
  childObjectsOf,
  countChildren,
  type ChildObject,
  type DataField,
  type RowSource,
} from '@nomadsf/core';
import { Status } from '../statusLog';

/**
 * The objects that point to a parent being copied (Contacts, Cases, Opportunities of
 * Accounts…), with how many records each would bring for the parent's records; tick and add
 * them as "Related only", so the copy takes just the children of the copied parents.
 */
export function ChildObjects({
  parent,
  parentWhere,
  source,
  allowed,
  isChosen,
  onAdd,
  onClose,
}: {
  parent: string;
  parentWhere?: string;
  source: RowSource & { schema?: Record<string, DataField[]> };
  /** Objects that can be copied (the candidates of the source). */
  allowed: Set<string>;
  isChosen: (name: string) => boolean;
  /** `via`: each child's lookups to the parent, the ones its records are followed through. */
  onAdd: (objects: string[], via: Record<string, string[]>) => void;
  onClose: () => void;
}) {
  const [children, setChildren] = useState<ChildObject[] | null>(null);
  const [counts, setCounts] = useState<Record<string, Record<string, number> | string>>({});
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');

  useEffect(() => {
    let canceled = false;
    setChildren(null);
    setCounts({});
    void (async () => {
      try {
        const list =
          source.kind === 'org'
            ? await childObjectsOf(source.client, parent, allowed)
            : childObjectsInSchema(source.schema ?? {}, parent).filter((c) => allowed.has(c.object));
        if (canceled) return;
        setChildren(list);
        // Counts one by one, shown as they come
        for (const child of list) {
          // eslint-disable-next-line no-await-in-loop
          const n = await countChildren(source, parent, child, parentWhere).catch((e: Error) => e.message);
          if (canceled) return;
          setCounts((c) => ({ ...c, [child.object]: n }));
        }
      } catch (e) {
        if (!canceled) setError((e as Error).message);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [parent, parentWhere, source, allowed]);

  const total = (object: string): number | undefined => {
    const c = counts[object];
    return typeof c === 'object' ? Math.max(0, ...Object.values(c)) : undefined;
  };
  const addable = [...ticked].filter((o) => !isChosen(o));

  return (
    <div className="child-objects">
      <div className="child-head">
        <b>Child objects of {parent}</b>
        <span className="muted">
          records linked to the {parent} records being copied{parentWhere ? ` (${parentWhere})` : ''}
        </span>
        <span className="grow" />
        <button className="link" onClick={onClose}>
          Close
        </button>
      </div>
      <Status text={error} kind="problem" block />
      {children === null && !error && <p className="muted">Looking for objects that point to {parent}…</p>}
      {children && !children.length && <p className="muted">No other object points to {parent} here.</p>}
      {children && children.length > 0 && (
        <>
          <div className="child-list">
            {children.map((c) => {
              const chosen = isChosen(c.object);
              const n = counts[c.object];
              return (
                <label key={c.object} className={`child-row ${chosen ? 'chosen' : ''}`}>
                  <input
                    type="checkbox"
                    disabled={chosen}
                    checked={chosen || ticked.has(c.object)}
                    onChange={(e) => {
                      const next = new Set(ticked);
                      if (e.target.checked) next.add(c.object);
                      else next.delete(c.object);
                      setTicked(next);
                    }}
                  />
                  <span className="mono">{c.object}</span>
                  <span className="muted">via {c.fields.join(', ')}</span>
                  <span className="grow" />
                  {chosen ? (
                    <span className="backup-tag">already in the copy</span>
                  ) : n === undefined ? (
                    <span className="muted">counting…</span>
                  ) : typeof n === 'string' ? (
                    <span className="muted" title={n}>
                      count not available
                    </span>
                  ) : (
                    <span
                      className={`backup-tag ${total(c.object) ? '' : 'muted'}`}
                      title={Object.entries(n)
                        .map(([f, v]) => `${f}: ${v}`)
                        .join(', ')}
                    >
                      {(total(c.object) ?? 0).toLocaleString()} related
                    </span>
                  )}
                </label>
              );
            })}
          </div>
          <div className="form">
            <button
              onClick={() =>
                setTicked(
                  new Set(
                    children.filter((c) => !isChosen(c.object) && (total(c.object) ?? 0) > 0).map((c) => c.object)
                  )
                )
              }
            >
              Tick those with records
            </button>
            <button
              className="primary"
              disabled={!addable.length}
              onClick={() =>
                onAdd(
                  addable,
                  Object.fromEntries(addable.map((o) => [o, children.find((c) => c.object === o)?.fields ?? []]))
                )
              }
            >
              Add {addable.length || ''} as Related only
            </button>
          </div>
        </>
      )}
    </div>
  );
}
