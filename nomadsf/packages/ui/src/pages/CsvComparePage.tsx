import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyCsv,
  compareCsv,
  describeGlobal,
  type FileTable,
  planCsv,
  type CsvPlan,
  type CsvRowResult,
  type CsvTable,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { DataTable } from '../components/DataTable';
import { EditableGrid, type GridRow } from '../components/EditableGrid';
import { ObjectOptions } from '../components/ObjectOptions';
import { TableFileInput } from '../components/TableFileInput';
import { Status } from '../statusLog';

/**
 * Data › Compare with CSV: a CSV of records (from an old org, a backup, a spreadsheet) next to this
 * org — what is the same, what differs field by field, what is missing — then make the org match it.
 */
export function CsvComparePage() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [objects, setObjects] = useState<Array<{ name: string; label: string }>>([]);
  const [object, setObject] = useState('');
  const [file, setFile] = useState<{ name: string; columns: string[] } | null>(null);
  const [rows, setRows] = useState<GridRow[]>([]);
  const [original, setOriginal] = useState<Map<number, Record<string, string>>>(new Map());
  const [included, setIncluded] = useState<Set<number>>(new Set());
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [plan, setPlan] = useState<CsvPlan | null>(null);
  const [results, setResults] = useState<CsvRowResult[] | null>(null);
  const [show, setShow] = useState<'all' | CsvRowResult['status']>('all');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    describeGlobal(client)
      .then((list) => setObjects(list.map((o) => ({ name: o.name, label: o.label }))))
      .catch(() => undefined);
  }, [client]);
  const known = objects.find((o) => o.name.toLowerCase() === object.trim().toLowerCase())?.name;

  // The CSV as it is now (with edits), only the ticked rows
  const table: CsvTable | null = useMemo(
    () => file && { columns: file.columns, rows: rows.filter((r) => included.has(r.id)).map((r) => r.values) },
    [file, rows, included]
  );

  useEffect(() => {
    setPlan(null);
    setResults(null);
    if (!known || !file) return;
    planCsv(client, known, file.columns, 'Id')
      .then((p) => {
        setPlan(p);
        // A key the org can find records by: an External ID / unique field in the CSV, else Name
        const candidates = p.keyFields.filter((k) => file.columns.includes(k) && k !== 'Id');
        setKey((k) => (k && candidates.includes(k) ? k : candidates.find((c) => c !== 'Name') ?? candidates[0] ?? ''));
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, known, file]);

  const guessed = useRef<string | undefined>(undefined);
  const open = (parsed: FileTable, fileName: string) => {
    const loaded = parsed.rows.map((values, id) => ({ id, values }));
    setFile({ name: fileName, columns: parsed.columns });
    setRows(loaded);
    setOriginal(new Map(loaded.map((r) => [r.id, r.values])));
    setIncluded(new Set(loaded.map((r) => r.id)));
    setResults(null);
    setStatus('');
    // A sheet or file named after its object (Query's downloads are): fill it in
    const guess = objects.find((o) => o.name.toLowerCase() === parsed.name.split(/[-_ ]/)[0].toLowerCase());
    // Switching sheets switches the object too, unless one was chosen by hand
    if (guess && (!object || object === guessed.current)) setObject(guess.name);
    guessed.current = guess?.name;
  };

  const compare = async () => {
    if (!known || !file || !table) return;
    setBusy(true);
    setStatus('Comparing…');
    try {
      const p = await planCsv(client, known, file.columns, key);
      setPlan(p);
      const r = await compareCsv(client, p, table);
      setResults(r);
      setPicked(
        new Set(r.filter((x) => x.status === 'different' || x.status === 'only in CSV').map((x) => String(x.row)))
      );
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!plan || !table || !results) return;
    const chosen = results.filter(
      (r) => picked.has(String(r.row)) && (r.status === 'different' || r.status === 'only in CSV')
    );
    const updates = chosen.filter((r) => r.status === 'different').length;
    const inserts = chosen.length - updates;
    if (
      !(await confirmChange(
        `In ${org.label}: update ${updates} ${plan.sobject} record(s) to match the CSV and insert ${inserts} new one(s)`
      ))
    )
      return;
    setBusy(true);
    setStatus('Saving…');
    try {
      const r = await applyCsv(client, plan, table, chosen);
      logActivity('apply csv', {
        object: plan.sobject,
        file: file?.name,
        updated: r.updated,
        inserted: r.inserted,
        failed: r.failed.length,
      });
      setStatus(
        `✓ ${r.updated} updated, ${r.inserted} inserted.${
          r.failed.length
            ? ` ❌ ${r.failed.length} failed: ${r.failed
                .slice(0, 5)
                .map((f) => `${f.key}: ${f.error}`)
                .join('; ')}`
            : ''
        }`
      );
      setResults(await compareCsv(client, plan, table));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const count = (s: CsvRowResult['status']): number => (results ?? []).filter((r) => r.status === s).length;
  const shown = (results ?? []).filter((r) => show === 'all' || r.status === show);
  const keyOptions = plan ? plan.keyFields.filter((k) => file?.columns.includes(k) && k !== 'Id') : [];

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Compare with CSV</h2>
        <span className="muted">a CSV of records next to {org.label}: what differs, then make the org match it</span>
      </div>
      <div className="card section">
        <div className="form">
          <TableFileInput label="CSV or Excel file" onTable={open} onError={(m) => setStatus(`❌ ${m}`)} />
          <label>
            Object
            <input
              list="csv-compare-objects"
              value={object}
              placeholder="e.g. Contact"
              onChange={(e) => setObject(e.target.value)}
            />
          </label>
          <ObjectOptions id="csv-compare-objects" objects={objects} typed={object} />
          <label title="How a CSV row finds its record in this org: a unique field (Email, an External ID…). Ids from another org do not match.">
            Match records by
            <select value={key} onChange={(e) => setKey(e.target.value)}>
              <option value="">{plan ? 'Choose a field…' : 'Choose the file and object'}</option>
              {keyOptions.map((k) => (
                <option key={k}>{k}</option>
              ))}
              {file?.columns.includes('Id') && <option value="Id">Id (same org only)</option>}
            </select>
          </label>
          <button className="primary" disabled={!known || !file || !key || busy} onClick={() => void compare()}>
            Compare
          </button>
          {file && (
            <button onClick={() => setEditing(!editing)}>
              {editing ? 'Hide the CSV' : `Edit the CSV (${included.size} rows)`}
            </button>
          )}
        </div>
        {plan && (
          <p className="muted">
            Compared: {plan.columns.map((c) => c.column).join(', ')}
            {plan.ignored.length ? ` · not fields of ${plan.sobject} (left out): ${plan.ignored.join(', ')}` : ''} ·
            lookups are compared by name when the CSV has it (Account.Name for AccountId).
          </p>
        )}
        {status && <Status text={status} block />}
      </div>
      {editing && file && (
        <EditableGrid
          columns={file.columns}
          rows={rows}
          original={original}
          included={included}
          onRowsChange={setRows}
          onIncludedChange={setIncluded}
        />
      )}
      {results && (
        <div className="card section">
          <div className="segmented" role="group" aria-label="Show">
            {(['all', 'different', 'only in CSV', 'same', 'no key'] as const).map((s) => (
              <button key={s} className={show === s ? 'active' : ''} onClick={() => setShow(s)}>
                {s === 'all' ? `All (${results.length})` : `${s[0].toUpperCase()}${s.slice(1)} (${count(s)})`}
              </button>
            ))}
          </div>
          <DataTable
            columns={['key', 'status', 'differences']}
            rows={shown.map((r) => ({
              ...r,
              rowKey: String(r.row),
              differences: r.differences.map((d) => `${d.column}: ${d.org || '—'} → ${d.csv || '—'}`).join(' · '),
            }))}
            rowKey="rowKey"
            name={`${plan?.sobject ?? 'csv'}-compare`}
            selected={picked}
            onSelectedChange={setPicked}
            note={<span>· differences: org now → CSV · ticked rows are applied</span>}
          />
          <div className="form">
            <button className="primary" disabled={busy || !picked.size} onClick={() => void apply()}>
              Make {org.label} match the CSV ({picked.size} ticked)…
            </button>
            <span className="muted">Updates the fields that differ; inserts rows that are only in the CSV.</span>
          </div>
        </div>
      )}
    </div>
  );
}
