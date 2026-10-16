import { useEffect, useState } from 'react';
import {
  bulkIngest,
  bulkQuery,
  deleteByQuery,
  describeGlobal,
  mainSObject,
  parseCsv,
  query,
  type IngestOperation,
  type IngestResult,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { storage, useStudio } from '../context';

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

function Preview({ csv, name, instanceUrl }: { csv: string; name: string; instanceUrl?: string }) {
  const table = parseCsv(csv);
  return <DataTable columns={table.columns} rows={table.rows} name={name} rowKey="__none" instanceUrl={instanceUrl} />;
}

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

  // ---------- export ----------
  const [exportSoql, setExportSoql] = useState<string>(() =>
    storage.get('data.export', 'SELECT Id, Name FROM Account')
  );
  const [exportDeleted, setExportDeleted] = useState(false);
  const [exportCsv, setExportCsv] = useState('');
  const [exportStatus, setExportStatus] = useState('');

  const runExport = async () => {
    storage.set('data.export', exportSoql);
    setExportCsv('');
    setExportStatus('Starting Bulk query…');
    try {
      const r = await bulkQuery(client, exportSoql, {
        includeDeleted: exportDeleted,
        onProgress: (state) => setExportStatus(`Bulk query: ${state}…`),
      });
      setExportCsv(r.csv);
      setExportStatus(`${r.rows.toLocaleString()} rows · job ${r.jobId}`);
      saveFile(`${org.label}-${mainSObject(exportSoql) ?? 'export'}-${stamp()}.csv`, r.csv);
      logActivity('bulk-export', { soql: exportSoql, rows: r.rows });
    } catch (e) {
      setExportStatus(`❌ ${(e as Error).message}`);
    }
  };

  // ---------- import ----------
  const [object, setObject] = useState('');
  const [operation, setOperation] = useState<IngestOperation>('insert');
  const [externalId, setExternalId] = useState('');
  const [file, setFile] = useState<{ name: string; csv: string } | null>(null);
  const [ingestStatus, setIngestStatus] = useState('');
  const [ingest, setIngest] = useState<IngestResult | null>(null);
  const preview = file ? parseCsv(file.csv) : null;

  const runIngest = async () => {
    if (!file || !object || !preview) return;
    const label = OPERATIONS.find(([op]) => op === operation)?.[1];
    if (!confirmChange(`${label} ${preview.rows.length.toLocaleString()} ${object} record(s) in ${org.label}.`)) return;
    setIngest(null);
    setIngestStatus('Uploading…');
    try {
      const r = await bulkIngest(
        client,
        { object, operation, csv: file.csv, externalIdField: externalId || undefined },
        { onProgress: (state, n) => setIngestStatus(`Bulk ${operation}: ${state} · ${n} processed…`) }
      );
      setIngest(r);
      setIngestStatus('');
      logActivity(`bulk-${operation}`, {
        object,
        file: file.name,
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

      <div className="card section">
        <h3>Export</h3>
        <textarea rows={3} value={exportSoql} onChange={(e) => setExportSoql(e.target.value)} spellCheck={false} />
        <div className="form">
          <label className="check">
            <input type="checkbox" checked={exportDeleted} onChange={(e) => setExportDeleted(e.target.checked)} />{' '}
            Include deleted &amp; archived
          </label>
          <button className="primary" onClick={() => void runExport()}>
            Export CSV
          </button>
          <span className="muted">{exportStatus}</span>
        </div>
        {exportCsv && <Preview csv={exportCsv} name="export" instanceUrl={org.instanceUrl} />}
      </div>

      <div className="grid2">
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
                  if (!f) return;
                  void f.text().then((csv) => setFile({ name: f.name, csv }));
                }}
              />
            </label>
          </div>
          {preview && (
            <p className="muted" style={{ margin: 0 }}>
              {file?.name}: {preview.rows.length.toLocaleString()} rows · columns{' '}
              <code>{preview.columns.join(', ')}</code>
            </p>
          )}
          <div className="form">
            <button
              className="primary"
              disabled={!preview || preview.rows.length === 0 || !object}
              onClick={() => void runIngest()}
            >
              Run…
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
