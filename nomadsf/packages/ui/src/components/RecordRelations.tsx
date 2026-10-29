import { Fragment, useContext, useEffect, useState } from 'react';
import {
  childRecords,
  childrenSoql,
  flattenParents,
  recordChildren,
  recordParents,
  writeWorkbook,
  type ChildRelation,
  type MigrateObject,
  type ParentNode,
  type RecordField,
  type Row,
  type Sheet,
} from '@nomadsf/core';
import { GoContext, handoff, useStudio } from '../context';
import { usePair } from '../pair';
import { CopyId } from './CopyId';
import { DataTable, download } from './DataTable';

const keyOf = (c: Pick<ChildRelation, 'object' | 'field'>): string => `${c.object}.${c.field}`;
const display = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** The parents tree: each lookup with the record it points to, and that record's own lookups under it. */
function ParentTree({ nodes, onOpen }: { nodes: ParentNode[]; onOpen: (id: string) => void }) {
  return (
    <ul className="relation-tree">
      {nodes.map((n) => (
        <li key={`${n.field}-${n.id}`}>
          <span className="mono muted" title={n.fieldLabel}>
            {n.field}
          </span>{' '}
          → <b>{n.object}</b> ·{' '}
          {n.repeated ? (
            <span className="muted">shown above</span>
          ) : (
            <button className="link" onClick={() => onOpen(n.id)} title="Open this record">
              {n.name || n.id}
            </button>
          )}{' '}
          <CopyId id={n.id} />
          {n.parents.length > 0 && <ParentTree nodes={n.parents} onOpen={onOpen} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * Record › Related: the records this one points to (parents, grandparents…) and the records that
 * point to it (children, per relationship). Children can be listed, queried, copied to another
 * org with the record (Migrate), and everything goes in one workbook.
 */
export function RecordRelations({
  sobject,
  id,
  name,
  fields,
  onOpen,
}: {
  sobject: string;
  id: string;
  name: string;
  fields: RecordField[];
  onOpen: (id: string) => void;
}) {
  const { client, org } = useStudio();
  const go = useContext(GoContext);
  const [pair, setPair] = usePair();
  const [audit, setAudit] = useState(false);
  const [parents, setParents] = useState<ParentNode[] | null>(null);
  const [children, setChildren] = useState<ChildRelation[] | null>(null);
  const [system, setSystem] = useState(false);
  const [empty, setEmpty] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState('');
  const [list, setList] = useState<Row[] | null>(null);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState('');

  useEffect(() => {
    let canceled = false;
    setParents(null);
    recordParents(client, sobject, id, { audit })
      .then((t) => !canceled && setParents(t.parents))
      .catch((e: Error) => !canceled && setStatus(`❌ ${e.message}`));
    return () => {
      canceled = true;
    };
  }, [client, sobject, id, audit]);

  useEffect(() => {
    let canceled = false;
    setChildren(null);
    setPicked(new Set());
    setOpen('');
    setProgress('');
    recordChildren(client, sobject, id, {
      system,
      onProgress: (done, total) => !canceled && setProgress(`${done} of ${total}`),
    })
      .then((c) => !canceled && setChildren(c))
      .catch((e: Error) => !canceled && setStatus(`❌ ${e.message}`));
    return () => {
      canceled = true;
    };
  }, [client, sobject, id, system]);

  const shown = (children ?? []).filter((c) => empty || c.count > 0);
  const chosen = shown.filter((c) => picked.has(keyOf(c)));

  const show = async (c: ChildRelation) => {
    if (open === keyOf(c)) return setOpen('');
    setOpen(keyOf(c));
    setList(null);
    try {
      setList(await childRecords(client, c, id, 200));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const toQuery = async (c: ChildRelation) => {
    try {
      handoff.query(await childrenSoql(client, c, id, 2000));
      go?.('query');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  // The record, then the children ticked (only those linked through the ticked lookup); parents come
  // along with Migrate's "Bring the records they point to". A user is not copied (Migrate matches
  // owners by username; Users › Snapshot copies a user): their records are, by condition.
  const toMigrate = () => {
    const objects: MigrateObject[] = sobject === 'User' ? [] : [{ name: sobject, where: `Id = '${id}'` }];
    for (const c of chosen.filter((x) => x.object !== sobject)) {
      const same = objects.find((o) => o.name === c.object);
      if (sobject === 'User')
        if (same) same.where = `${same.where} OR ${c.field} = '${id}'`;
        else objects.push({ name: c.object, where: `${c.field} = '${id}'` });
      else if (same) same.via = [...(same.via ?? []), c.field];
      else objects.push({ name: c.object, relatedOnly: true, via: [c.field] });
    }
    handoff.migrate(org.id, objects);
    setPair({ a: org.id, b: pair.b === org.id ? '' : pair.b });
    go?.('migrate');
  };

  const workbook = async () => {
    setStatus('Reading the related records…');
    try {
      const sheets: Sheet[] = [
        {
          name: sobject,
          columns: ['Label', 'API name', 'Type', 'Value'],
          rows: fields.map((f) => ({ Label: f.label, 'API name': f.name, Type: f.type, Value: display(f.value) })),
        },
        { name: 'Parents', columns: ['Level', 'Path', 'Object', 'Id', 'Name'], rows: flattenParents(parents ?? []) },
        {
          name: 'Children',
          columns: ['Object', 'Through', 'Relationship', 'Records'],
          rows: shown.map((c) => ({
            Object: c.object,
            Through: c.field,
            Relationship: c.relationship,
            Records: c.count,
          })),
        },
      ];
      // The records of the ticked relationships, or of every one shown with records
      for (const c of (chosen.length ? chosen : shown).filter((x) => x.count > 0)) {
        // eslint-disable-next-line no-await-in-loop
        const rows = await childRecords(client, c, id, 2000);
        sheets.push({ name: `${c.object} ${c.field}`, columns: rows[0] ? Object.keys(rows[0]) : ['Id'], rows });
      }
      download(
        `${sobject}-${name || id}-related.xlsx`.replace(/[\\/:*?"<>|]/g, '_'),
        writeWorkbook(sheets),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      setStatus(`✓ Workbook with ${sheets.length} sheets.`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div className="record-relations">
      <div className="form">
        <button disabled={!parents || !children} onClick={() => void workbook()}>
          Workbook (this record, parents, children)
        </button>
        <button
          disabled={!chosen.length}
          title="Migrate with this record and the ticked children; the records they point to come along"
          onClick={toMigrate}
        >
          Copy to another org… ({chosen.length})
        </button>
        <span className="muted">{status}</span>
      </div>

      <h4>Parents: what this record points to</h4>
      <label className="check">
        <input type="checkbox" checked={audit} onChange={(e) => setAudit(e.target.checked)} /> Created by / Last
        modified by
      </label>
      {!parents ? (
        <p className="muted">Reading…</p>
      ) : parents.length === 0 ? (
        <p className="muted">No lookup of this record has a value.</p>
      ) : (
        <ParentTree nodes={parents} onOpen={onOpen} />
      )}

      <h4>Children: what points to this record</h4>
      <div className="form">
        <label className="check">
          <input type="checkbox" checked={system} onChange={(e) => setSystem(e.target.checked)} /> System relations
          (history, feed, sharing, created by: slow on users)
        </label>
        <label className="check">
          <input type="checkbox" checked={empty} onChange={(e) => setEmpty(e.target.checked)} /> Relationships without
          records
        </label>
      </div>
      {!children ? (
        <p className="muted">Counting the records of every relationship… {progress}</p>
      ) : shown.length === 0 ? (
        <p className="muted">No records point to this one{system ? '' : ' (system relations aside)'}.</p>
      ) : (
        <table className="edit-table relation-children">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  title="Tick every relationship with records"
                  checked={shown.filter((c) => c.count > 0).every((c) => picked.has(keyOf(c)))}
                  onChange={(e) =>
                    setPicked(e.target.checked ? new Set(shown.filter((c) => c.count > 0).map(keyOf)) : new Set())
                  }
                />
              </th>
              <th>Object</th>
              <th>Through</th>
              <th>Records</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <Fragment key={keyOf(c)}>
                <tr>
                  <td>
                    <input
                      type="checkbox"
                      checked={picked.has(keyOf(c))}
                      onChange={(e) => {
                        const next = new Set(picked);
                        if (e.target.checked) next.add(keyOf(c));
                        else next.delete(keyOf(c));
                        setPicked(next);
                      }}
                    />
                  </td>
                  <td>
                    <b>{c.object}</b> {c.relationship && <span className="muted">({c.relationship})</span>}
                  </td>
                  <td className="mono">{c.field}</td>
                  <td>{c.count.toLocaleString()}</td>
                  <td className="composer-actions">
                    {c.count > 0 && (
                      <button className="link" onClick={() => void show(c)}>
                        {open === keyOf(c) ? 'Hide' : 'Show'}
                      </button>
                    )}
                    <button className="link" title="Open these records in Query" onClick={() => void toQuery(c)}>
                      Query
                    </button>
                  </td>
                </tr>
                {open === keyOf(c) && (
                  <tr>
                    <td colSpan={5}>
                      {!list ? (
                        <p className="muted">Reading…</p>
                      ) : (
                        <DataTable
                          columns={list[0] ? Object.keys(list[0]) : ['Id']}
                          rows={list}
                          rowKey="Id"
                          name={`${c.object}-${c.field}`}
                          onRowClick={(row) => onOpen(String(row.Id))}
                          note={<span>· newest first, at most 200 · click one to open it</span>}
                        />
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
