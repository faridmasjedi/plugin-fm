import { useMemo, useState } from 'react';
import {
  bulkIngest,
  changedRecords,
  fieldRules,
  mainSObject,
  openQuery,
  queryMore,
  toCsv,
  type IngestResult,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { IngestSummary } from './IngestSummary';
import { EditableGrid, type GridRow } from './EditableGrid';

/** Records loaded for editing at most (bigger jobs: export, edit the CSV, use the CSV tab). */
const MAX_ROWS = 10_000;

const text = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/**
 * Edit records in place: run a query (with Id), change cells, then Update sends only the
 * changed fields of the changed records (Bulk API 2.0). Ticked rows can be deleted.
 */
export function QueryEditTab() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [soql, setSoql] = useState<string>(() =>
    storage.get(
      'data.editSoql',
      'SELECT Id, Name, Industry, Phone FROM Account ORDER BY LastModifiedDate DESC LIMIT 200'
    )
  );
  const [sobject, setSobject] = useState('');
  const [columns, setColumns] = useState<string[]>([]);
  const [editable, setEditable] = useState<string[]>([]);
  const [rows, setRows] = useState<GridRow[]>([]);
  const [original, setOriginal] = useState<Map<number, Record<string, string>>>(new Map());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<IngestResult | null>(null);

  const changes = useMemo(() => {
    try {
      return changedRecords(editable, rows, original);
    } catch {
      return { columns: [], rows: [], cells: 0 };
    }
  }, [editable, rows, original]);
  const locked = useMemo(() => new Set(columns.filter((c) => !editable.includes(c))), [columns, editable]);

  const load = async (after?: string) => {
    const object = mainSObject(soql);
    if (!object) return setStatus('❌ The query needs a FROM clause.');
    setBusy(true);
    if (!after) setResult(null);
    setStatus('Running the query…');
    storage.set('data.editSoql', soql);
    try {
      let cursor = await openQuery(client, soql);
      while (cursor.next && cursor.rows.length < MAX_ROWS) {
        // eslint-disable-next-line no-await-in-loop
        cursor = await queryMore(client, cursor);
        setStatus(`Loading… ${cursor.rows.length.toLocaleString()} of ${cursor.totalSize.toLocaleString()}`);
      }
      if (!cursor.columns.includes('Id')) throw new Error('Add Id to the SELECT: records are updated by their Id.');
      const name = cursor.sobject ?? object;
      const rules = await fieldRules(client, name);
      const canEdit = new Set(rules.filter((r) => r.updateable && !r.calculated).map((r) => r.name.toLowerCase()));
      // Only fields of the object itself (not Owner.Name…) that Salesforce lets you change
      const editableColumns = cursor.columns.filter(
        (c) => c !== 'Id' && !c.includes('.') && canEdit.has(c.toLowerCase())
      );
      const loaded = cursor.rows.slice(0, MAX_ROWS).map((row, id) => ({
        id,
        values: Object.fromEntries(cursor.columns.map((c) => [c, text(row[c])])),
      }));
      setSobject(name);
      setColumns(cursor.columns);
      setEditable(editableColumns);
      setRows(loaded);
      setOriginal(new Map(loaded.map((r) => [r.id, r.values])));
      setSelected(new Set());
      setStatus(
        `${after ? `${after} · reloaded: ` : ''}${loaded.length.toLocaleString()} ${name} record(s)${
          cursor.totalSize > loaded.length
            ? ` of ${cursor.totalSize.toLocaleString()} (first ${MAX_ROWS.toLocaleString()} only; narrow the query, or use the CSV tab)`
            : ''
        } · ${editableColumns.length} editable column(s), 🔒 = read-only`
      );
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const run = async (operation: 'update' | 'delete') => {
    const payload =
      operation === 'update'
        ? { columns: changes.columns, rows: changes.rows }
        : { columns: ['Id'], rows: rows.filter((r) => selected.has(r.id)).map((r) => ({ Id: r.values.Id })) };
    if (!payload.rows.length) return;
    const what =
      operation === 'update'
        ? `Update ${payload.rows.length.toLocaleString()} ${sobject} record(s) (${
            changes.cells
          } field change(s): ${changes.columns.slice(1).join(', ')})`
        : `Delete ${payload.rows.length.toLocaleString()} ${sobject} record(s)`;
    if (!confirmChange(`${what} in ${org.label}.`)) return;
    setBusy(true);
    setResult(null);
    setStatus(`${operation === 'update' ? 'Updating' : 'Deleting'}…`);
    try {
      const r = await bulkIngest(
        client,
        { object: sobject, operation, csv: toCsv(payload.columns, payload.rows) },
        { onProgress: (state, n) => setStatus(`Bulk ${operation}: ${state} · ${n} processed…`) }
      );
      logActivity(`query-${operation}`, {
        object: sobject,
        soql,
        records: payload.rows.length,
        failed: r.failed,
        job: r.jobId,
      });
      setResult(r);
      const done = `✓ ${operation === 'update' ? 'Updated' : 'Deleted'} ${(
        r.processed - r.failed
      ).toLocaleString()} record(s)`;
      setStatus(r.failed ? `${done}, ${r.failed} failed (see below)` : done);
      // Show what is in the org now (failed edits stay on screen to fix and retry)
      if (r.failed === 0) await load(done);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card section">
      <h3>Edit records from a query</h3>
      <p className="muted" style={{ margin: 0 }}>
        Include <code>Id</code>. Click a cell to change it; <b>Update</b> sends only the changed fields of the changed
        records. Tick rows to delete them. A cleared cell empties the field.
      </p>
      <textarea rows={3} value={soql} onChange={(e) => setSoql(e.target.value)} spellCheck={false} />
      <div className="form">
        <button className="primary" disabled={busy} onClick={() => void load()}>
          Load records
        </button>
        {rows.length > 0 && (
          <>
            <button className="primary" disabled={busy || !changes.rows.length} onClick={() => void run('update')}>
              Update {changes.rows.length.toLocaleString()} record(s)…
            </button>
            {changes.cells > 0 && (
              <button
                disabled={busy}
                onClick={() => {
                  setRows(rows.map((r) => ({ ...r, values: { ...(original.get(r.id) ?? r.values) } })));
                }}
              >
                Undo changes
              </button>
            )}
            <button className="danger" disabled={busy || !selected.size} onClick={() => void run('delete')}>
              Delete {selected.size.toLocaleString()} selected…
            </button>
          </>
        )}
        <span className="muted">{status}</span>
      </div>
      {rows.length > 0 && (
        <EditableGrid
          columns={columns}
          rows={rows}
          original={original}
          included={selected}
          onRowsChange={setRows}
          onIncludedChange={setSelected}
          lockedColumns={locked}
          allowAddRemove={false}
          includedWord="selected"
        />
      )}
      {result && <IngestSummary result={result} orgLabel={org.label} object={sobject} />}
    </div>
  );
}
