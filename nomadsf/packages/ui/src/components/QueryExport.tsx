import { useState } from 'react';
import { bulkCompatible, bulkQuery, toCsvFiles, type QueryCursor } from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { download } from './DataTable';

const SIZES = [10_000, 50_000, 100_000, 500_000, 1_000_000];

const fileName = (base: string, index: number, total: number): string =>
  total > 1 ? `${base}-part-${index + 1}.csv` : `${base}.csv`;

/**
 * CSV export of a query, split into files of at most N rows. Everything loaded: split here.
 * More rows in the org: Bulk API 2.0 streams them chunk by chunk, one file per chunk.
 */
export function QueryExport({
  soql,
  cursor,
  includeDeleted,
}: {
  soql: string;
  cursor: QueryCursor;
  includeDeleted: boolean;
}) {
  const studio = useStudio();
  const [perFile, setPerFile] = useState<number>(() => storage.get('query.rowsPerFile', 100_000));
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const base = (cursor.sobject ?? 'query').replace(/\W+/g, '_');
  const complete = !cursor.next;
  const viaBulk = !complete && bulkCompatible(soql, cursor.tooling);

  const exportLoaded = () => {
    const files = toCsvFiles(cursor.columns, cursor.rows, perFile);
    files.forEach((csv, i) => download(fileName(base, i, files.length), csv, 'text/csv'));
    setStatus(
      `✓ ${cursor.rows.length.toLocaleString()} rows in ${files.length} file(s)${
        complete ? '' : ` — only the loaded rows (${cursor.tooling ? 'Tooling API' : 'subqueries'} cannot use Bulk API)`
      }.`
    );
  };

  const exportBulk = async () => {
    setBusy(true);
    setStatus('Bulk API: preparing the export in Salesforce…');
    try {
      let files = 0;
      const result = await bulkQuery(studio.client, soql, {
        includeDeleted,
        rowsPerFile: perFile,
        onProgress: (state, processed) => setStatus(`Bulk API: ${state} · ${processed.toLocaleString()} rows`),
        // Each chunk is saved as soon as it arrives; the whole export is never held in memory
        onFile: (csv, index, rows) => {
          files = index + 1;
          download(`${base}-part-${index + 1}.csv`, csv, 'text/csv');
          setStatus(`Bulk API: saved part ${index + 1} (${rows.toLocaleString()} rows)…`);
        },
      });
      studio.logActivity('export', { soql, rows: result.rows, files, job: result.jobId });
      setStatus(`✓ ${result.rows.toLocaleString()} rows in ${files} file(s) · Bulk job ${result.jobId}`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="form query-export">
      <label className="check">
        Rows per file
        <select
          value={perFile}
          onChange={(e) => {
            setPerFile(Number(e.target.value));
            storage.set('query.rowsPerFile', Number(e.target.value));
          }}
        >
          {SIZES.map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString()}
            </option>
          ))}
        </select>
      </label>
      <button disabled={busy} onClick={() => (viaBulk ? void exportBulk() : exportLoaded())}>
        {viaBulk ? `Export all ${cursor.totalSize.toLocaleString()} rows to CSV` : 'Export CSV'}
      </button>
      {status && <span className="muted">{status}</span>}
    </div>
  );
}
