import { parseCsv, type IngestResult } from '@nomadsf/core';
import { DataTable } from './DataTable';

function saveFile(name: string, content: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

const stamp = (): string => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);

/** Result of a Bulk API job: counts, failures and the result files. */
export function IngestSummary({
  result,
  orgLabel,
  object,
}: {
  result: IngestResult;
  orgLabel: string;
  object: string;
}) {
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
