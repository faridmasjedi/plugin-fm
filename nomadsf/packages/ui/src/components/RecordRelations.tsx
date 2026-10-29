import { Fragment, useContext, useEffect, useState } from 'react';
import {
  childRecords,
  childRelations,
  childrenSoql,
  recordLookups,
  type ChildRelation,
  type RecordLookup,
} from '@nomadsf/core';
import { basket, useBasket } from '../basket';
import { GoContext, handoff, useStudio } from '../context';
import { BasketPanel } from './BasketPanel';
import { CopyId } from './CopyId';

const keyOf = (c: Pick<ChildRelation, 'object' | 'field'>): string => `${c.object}.${c.field}`;

/** The records a record points to; ▸ shows what each of those points to (read when opened). */
function Lookups({ object, id, onOpen }: { object: string; id: string; onOpen: (id: string) => void }) {
  const { client, org } = useStudio();
  const items = useBasket(org.id);
  const [list, setList] = useState<RecordLookup[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    let canceled = false;
    recordLookups(client, object, id)
      .then((l) => !canceled && setList(l))
      .catch((e: Error) => !canceled && setError(e.message));
    return () => {
      canceled = true;
    };
  }, [client, object, id]);
  if (error) return <p className="bad">❌ {error}</p>;
  if (!list) return <p className="muted">Reading…</p>;
  if (!list.length) return <p className="muted">Nothing: no lookup has a value.</p>;
  return (
    <ul className="relation-tree">
      {list.map((l) => (
        <li key={l.field}>
          <button
            className="link"
            title="What this record points to"
            onClick={() => {
              const next = new Set(open);
              if (next.has(l.field)) next.delete(l.field);
              else next.add(l.field);
              setOpen(next);
            }}
          >
            {open.has(l.field) ? '▾' : '▸'}
          </button>{' '}
          <span className="muted">{l.label}</span> →{' '}
          <button className="link" title="Open this record" onClick={() => onOpen(l.id)}>
            {l.name || l.id}
          </button>{' '}
          <span className="muted">({l.object})</span> <CopyId id={l.id} />{' '}
          {items.some((i) => i.id === l.id) ? (
            <span className="muted">✓ in the basket</span>
          ) : (
            <button
              className="link"
              onClick={() => basket.add(org.id, [{ object: l.object, id: l.id, name: l.name || l.id }])}
            >
              + Basket
            </button>
          )}
          {open.has(l.field) && <Lookups object={l.object} id={l.id} onOpen={onOpen} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * Record › Related: what the record points to, and what points to it. Nothing is read until asked:
 * Show lists a relationship's records, Query opens them in Query. Records ticked go in the basket,
 * which is copied to another org or saved as a workbook (and opened again later).
 */
export function RecordRelations({
  sobject,
  id,
  name,
  onOpen,
}: {
  sobject: string;
  id: string;
  name: string;
  onOpen: (id: string) => void;
}) {
  const { client, org } = useStudio();
  const go = useContext(GoContext);
  const items = useBasket(org.id);
  const [relations, setRelations] = useState<ChildRelation[] | null>(null);
  const [filter, setFilter] = useState('');
  const [system, setSystem] = useState(false);
  const [open, setOpen] = useState('');
  const [list, setList] = useState<Array<{ id: string; name: string }> | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');

  useEffect(() => {
    let canceled = false;
    setRelations(null);
    setOpen('');
    childRelations(client, sobject)
      .then((r) => !canceled && setRelations(r))
      .catch((e: Error) => !canceled && setStatus(`❌ ${e.message}`));
    return () => {
      canceled = true;
    };
  }, [client, sobject]);

  const needle = filter.trim().toLowerCase();
  const shown = (relations ?? []).filter(
    (r) =>
      (system || !r.system) && (!needle || `${r.objectLabel} ${r.object} ${r.field}`.toLowerCase().includes(needle))
  );

  const show = async (r: ChildRelation) => {
    if (open === keyOf(r)) return setOpen('');
    setOpen(keyOf(r));
    setList(null);
    setTicked(new Set());
    try {
      setList(await childRecords(client, r, id, 200));
    } catch (e) {
      setList([]);
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const toQuery = async (r: ChildRelation) => {
    try {
      handoff.query(await childrenSoql(client, r, id, 2000));
      go?.('query');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const addTicked = (r: ChildRelation) => {
    basket.add(
      org.id,
      (list ?? []).filter((x) => ticked.has(x.id)).map((x) => ({ object: r.object, id: x.id, name: x.name }))
    );
    setTicked(new Set());
  };

  return (
    <div className="record-relations">
      <BasketPanel />
      <div className="form">
        {items.some((i) => i.id === id) ? (
          <span className="muted">✓ This record is in the basket</span>
        ) : (
          <button onClick={() => basket.add(org.id, [{ object: sobject, id, name: name || id }])}>
            + Add this record to the basket
          </button>
        )}
        <span className="muted">{status}</span>
      </div>

      <h4>Points to</h4>
      <Lookups object={sobject} id={id} onOpen={onOpen} />

      <h4>Pointed to by</h4>
      <div className="form">
        <input placeholder="Filter: contacts, cases…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={system} onChange={(e) => setSystem(e.target.checked)} /> Also history, feed,
          sharing, created by
        </label>
      </div>
      {!relations ? (
        <p className="muted">Reading…</p>
      ) : shown.length === 0 ? (
        <p className="muted">No relationship{needle ? ' matches' : ''}.</p>
      ) : (
        <table className="edit-table relation-children">
          <tbody>
            {shown.map((r) => (
              <Fragment key={keyOf(r)}>
                <tr>
                  <td>
                    <b>{r.objectLabel}</b>{' '}
                    <span className="muted mono">
                      {r.object}.{r.field}
                    </span>
                  </td>
                  <td className="composer-actions">
                    <button className="link" onClick={() => void show(r)}>
                      {open === keyOf(r) ? 'Hide' : 'Show'}
                    </button>
                    <button className="link" title="Open these records in Query" onClick={() => void toQuery(r)}>
                      Query
                    </button>
                  </td>
                </tr>
                {open === keyOf(r) && (
                  <tr>
                    <td colSpan={2}>
                      {!list ? (
                        <p className="muted">Reading…</p>
                      ) : list.length === 0 ? (
                        <p className="muted">No records.</p>
                      ) : (
                        <div className="relation-records">
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={list.every((x) => ticked.has(x.id) || items.some((i) => i.id === x.id))}
                              onChange={(e) =>
                                setTicked(
                                  e.target.checked
                                    ? new Set(list.filter((x) => !items.some((i) => i.id === x.id)).map((x) => x.id))
                                    : new Set()
                                )
                              }
                            />{' '}
                            All {list.length}
                            {list.length === 200 ? ' (the newest 200; Query for more)' : ''}
                          </label>
                          {list.map((x) => {
                            const inside = items.some((i) => i.id === x.id);
                            return (
                              <div key={x.id} className="relation-record">
                                <input
                                  type="checkbox"
                                  disabled={inside}
                                  checked={inside || ticked.has(x.id)}
                                  onChange={(e) => {
                                    const next = new Set(ticked);
                                    if (e.target.checked) next.add(x.id);
                                    else next.delete(x.id);
                                    setTicked(next);
                                  }}
                                />
                                <button className="link" onClick={() => onOpen(x.id)} title="Open this record">
                                  {x.name}
                                </button>
                                <span className="muted mono">{x.id}</span>
                                {inside && <span className="muted">✓ in the basket</span>}
                              </div>
                            );
                          })}
                          <div className="form">
                            <button className="primary" disabled={!ticked.size} onClick={() => addTicked(r)}>
                              + Add {ticked.size || ''} to the basket
                            </button>
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
