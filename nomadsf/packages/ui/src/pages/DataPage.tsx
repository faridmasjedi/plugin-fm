import { useEffect, useMemo, useState } from 'react';
import {
  bulkIngest,
  checkColumns,
  deleteByQuery,
  fieldRules,
  describeGlobal,
  mainSObject,
  parseCsv,
  query,
  toCsv,
  type FieldRule,
  type IngestOperation,
  type IngestResult,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { EditableGrid, type GridRow } from '../components/EditableGrid';
import { useStudio } from '../context';

const OPERATIONS: Array<[IngestOperation, string]> = [
  ['insert', 'Insert'],
  ['update', 'Update'],
  ['upsert', 'Upsert'],
  ['delete', 'Delete'],
  ['hardDelete', 'Hard delete (skips the recycle bin)'],
];

function saveFile(name: string, content: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const stamp = (): string => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

function IngestSummary({ result, orgLabel, object }: { result: IngestResult; orgLabel: string; object: string }) {
  const failed = parseCsv(result.failedCsv);
  return (
    <div className="section">
      <div className="metrics">
        <div className="metric good">
          <b>{result.processed - result.failed}</b>Succeeded
        </div>
        <div className={`metric ${result.failed ? 'bad' : ''}`}>
          <b>{result.failed}</b>Failed
        </div>
        <div className="metric">
          <b>{parseCsv(result.unprocessedCsv).rows.length}</b>Unprocessed
        </div>
        <div className="metric">
          <b className="muted" style={{ fontSize: 12 }}>
            {result.jobId}
          </b>
          {result.state}
        </div>
      </div>
      {result.errorMessage && <div className="error">{result.errorMessage}</div>}
      <div className="form">
        <button onClick={() => saveFile(`${orgLabel}-${object}-success-${stamp()}.csv`, result.successfulCsv)}>
          Successful rows CSV
        </button>
        {result.failed > 0 && (
          <button onClick={() => saveFile(`${orgLabel}-${object}-failures-${stamp()}.csv`, result.failedCsv)}>
            Failures CSV
          </button>
        )}
      </div>
      {failed.rows.length > 0 && (
        <DataTable columns={failed.columns} rows={failed.rows} name="failures" rowKey="__none" />
      )}
    </div>
  );
}

export function DataPage() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [objects, setObjects] = useState<string[]>([]);
  useEffect(() => {
    describeGlobal(client)
      .then((list) => setObjects(list.map((o) => o.name)))
      .catch(() => undefined);
  }, [client]);

  // ---------- import ----------
  const [object, setObject] = useState('');
  const [operation, setOperation] = useState<IngestOperation>('insert');
  const [externalId, setExternalId] = useState('');
  // The uploaded file as editable rows; what is sent is the edited, included rows
  const [file, setFile] = useState<{ name: string; columns: string[] } | null>(null);
  const [rows, setRows] = useState<GridRow[]>([]);
  const [original, setOriginal] = useState<Map<number, Record<string, string>>>(new Map());
  const [included, setIncluded] = useState<Set<number>>(new Set());
  const [ingestStatus, setIngestStatus] = useState('');
  const [ingest, setIngest] = useState<IngestResult | null>(null);
  const toSend = useMemo(() => rows.filter((r) => included.has(r.id)), [rows, included]);

  // Which columns Salesforce accepts for this object and operation; the others start unticked
  const [rules, setRules] = useState<FieldRule[] | null>(null);
  const [sendColumns, setSendColumns] = useState<Set<string>>(new Set());
  const knownObject = objects.find((o) => o.toLowerCase() === object.trim().toLowerCase());
  useEffect(() => {
    setRules(null);
    if (!knownObject) return;
    fieldRules(client, knownObject)
      .then(setRules)
      .catch(() => setRules(null));
  }, [client, knownObject]);
  const report = useMemo(
    () => (rules && file ? checkColumns(rules, file.columns, operation, externalId || undefined) : null),
    [rules, file, operation, externalId]
  );
  useEffect(() => {
    if (report) setSendColumns(new Set(report.columns.filter((c) => c.ok).map((c) => c.column)));
    else if (file) setSendColumns(new Set(file.columns));
  }, [report, file]);
  const columnsToSend = (file?.columns ?? []).filter((c) => sendColumns.has(c));

  const openFile = async (f: File) => {
    const table = parseCsv(await f.text());
    const loaded = table.rows.map((values, id) => ({ id, values }));
    setFile({ name: f.name, columns: table.columns });
    setRows(loaded);
    setOriginal(new Map(loaded.map((r) => [r.id, r.values])));
    setIncluded(new Set(loaded.map((r) => r.id)));
    setIngest(null);
    setIngestStatus('');
  };

  const runIngest = async () => {
    if (!file || !object || !toSend.length || report?.problems.length || !columnsToSend.length) return;
    const label = OPERATIONS.find(([op]) => op === operation)?.[1];
    if (!confirmChange(`${label} ${toSend.length.toLocaleString()} ${object} record(s) in ${org.label}.`)) return;
    setIngest(null);
    setIngestStatus('Uploading…');
    try {
      const r = await bulkIngest(
        client,
        {
          object,
          operation,
          csv: toCsv(
            columnsToSend,
            toSend.map((r) => r.values)
          ),
          externalIdField: externalId || undefined,
        },
        { onProgress: (state, n) => setIngestStatus(`Bulk ${operation}: ${state} · ${n} processed…`) }
      );
      setIngest(r);
      setIngestStatus('');
      logActivity(`bulk-${operation}`, {
        object,
        file: file.name,
        rows: toSend.length,
        columns: columnsToSend,
        processed: r.processed,
        failed: r.failed,
        job: r.jobId,
      });
    } catch (e) {
      setIngestStatus(`❌ ${(e as Error).message}`);
    }
  };

  // ---------- delete by query ----------
  const [deleteSoql, setDeleteSoql] = useState("SELECT Id FROM Case WHERE Subject LIKE 'TEST%'");
  const [hard, setHard] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState('');
  const [deleteResult, setDeleteResult] = useState<IngestResult | null>(null);

  const countMatches = async () => {
    const object = mainSObject(deleteSoql);
    if (!object) return setDeleteStatus('❌ The query needs a FROM clause.');
    try {
      const rest = deleteSoql
        .slice(deleteSoql.search(new RegExp(`\\bfrom\\s+${object}\\b`, 'i')))
        .replace(/\blimit\s+\d+/i, '');
      const r = await query(client, `SELECT COUNT() ${rest}`);
      setDeleteStatus(`${r.totalSize.toLocaleString()} record(s) match.`);
    } catch (e) {
      setDeleteStatus(`❌ ${(e as Error).message}`);
    }
  };
  const runDelete = async () => {
    if (!confirmChange(`${hard ? 'HARD delete' : 'Delete'} every record returned by:\n${deleteSoql}`)) return;
    setDeleteResult(null);
    setDeleteStatus('Finding records…');
    try {
      const r = await deleteByQuery(client, deleteSoql, {
        hardDelete: hard,
        onProgress: (state) => setDeleteStatus(`Bulk: ${state}…`),
      });
      if (!r) return setDeleteStatus('Nothing matched; nothing deleted.');
      setDeleteResult(r);
      setDeleteStatus('');
      logActivity(hard ? 'bulk-hard-delete-query' : 'bulk-delete-query', {
        soql: deleteSoql,
        processed: r.processed,
        failed: r.failed,
        job: r.jobId,
      });
    } catch (e) {
      setDeleteStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Data</h2>
        <span className="muted">Bulk API 2.0 on {org.label}</span>
      </div>
      <datalist id="objects">
        {objects.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>

      <p className="muted" style={{ margin: 0 }}>
        To export records, use <b>Query</b>: Export CSV there uses the Bulk API for large results, including deleted
        &amp; archived rows.
      </p>

      <div className="data-sections">
        <div className="card section">
          <h3>Import, update or delete from CSV</h3>
          <p className="muted" style={{ margin: 0 }}>
            Header row with API field names. Update, delete and hard delete need an <code>Id</code> column.
          </p>
          <div className="form">
            <label>
              Object
              <input list="objects" value={object} onChange={(e) => setObject(e.target.value)} placeholder="Account" />
            </label>
            <label>
              Operation
              <select value={operation} onChange={(e) => setOperation(e.target.value as IngestOperation)}>
                {OPERATIONS.map(([op, label]) => (
                  <option key={op} value={op}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {operation === 'upsert' && (
              <label>
                External ID field
                <input
                  value={externalId}
                  onChange={(e) => setExternalId(e.target.value)}
                  placeholder="External_Id__c"
                />
              </label>
            )}
            <label>
              CSV file
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void openFile(f);
                  e.target.value = '';
                }}
              />
            </label>
          </div>
          {file && (
            <>
              <p className="muted" style={{ margin: 0 }}>
                {file.name} · columns <code>{file.columns.join(', ')}</code> · click a cell to change it before running
              </p>
              {!knownObject && <p className="muted">Choose the object to check which columns Salesforce accepts.</p>}
              {report && (
                <div className="column-check">
                  {report.problems.map((p) => (
                    <div key={p} className="error">
                      {p}
                    </div>
                  ))}
                  <b>Columns to send</b>
                  <div className="column-list">
                    {report.columns.map((c) => (
                      <label key={c.column} className={`check ${c.ok ? '' : 'warn'}`} title={c.reason}>
                        <input
                          type="checkbox"
                          checked={sendColumns.has(c.column)}
                          onChange={(e) => {
                            const next = new Set(sendColumns);
                            if (e.target.checked) next.add(c.column);
                            else next.delete(c.column);
                            setSendColumns(next);
                          }}
                        />{' '}
                        {c.ok ? '✓' : '⚠'} <code>{c.column}</code>
                        {c.reason && <span className="muted"> — {c.reason}</span>}
                      </label>
                    ))}
                  </div>
                  {report.columns.some((c) => !c.ok) && (
                    <span className="muted">
                      Columns marked ⚠ would fail every row, so they start unticked; tick one to send it anyway.
                    </span>
                  )}
                </div>
              )}
              <EditableGrid
                mutedColumns={new Set(file.columns.filter((c) => !sendColumns.has(c)))}
                columns={file.columns}
                rows={rows}
                original={original}
                included={included}
                onRowsChange={setRows}
                onIncludedChange={setIncluded}
              />
            </>
          )}
          <div className="form">
            <button className="primary" disabled={!toSend.length || !object} onClick={() => void runIngest()}>
              Run on {toSend.length.toLocaleString()} row(s), {columnsToSend.length} column(s)…
            </button>
            <span className="muted">{ingestStatus}</span>
          </div>
          {ingest && <IngestSummary result={ingest} orgLabel={org.label} object={object} />}
        </div>

        <div className="card section">
          <h3>Delete records matching a query</h3>
          <textarea rows={3} value={deleteSoql} onChange={(e) => setDeleteSoql(e.target.value)} spellCheck={false} />
          <div className="form">
            <label className="check">
              <input type="checkbox" checked={hard} onChange={(e) => setHard(e.target.checked)} /> Hard delete
            </label>
            <button onClick={() => void countMatches()}>Count</button>
            <button className="danger" onClick={() => void runDelete()}>
              Delete…
            </button>
            <span className="muted">{deleteStatus}</span>
          </div>
          {deleteResult && (
            <IngestSummary result={deleteResult} orgLabel={org.label} object={mainSObject(deleteSoql) ?? 'records'} />
          )}
        </div>
      </div>
    </div>
  );
}
