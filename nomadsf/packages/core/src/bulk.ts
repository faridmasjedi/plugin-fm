import type { SalesforceClient } from './client.js';
import { mainSObject } from './query.js';

/** Bulk API 2.0: query to CSV, and insert / update / upsert / delete / hard delete from CSV. */

type JobInfo = {
  id: string;
  state: 'Open' | 'UploadComplete' | 'InProgress' | 'JobComplete' | 'Failed' | 'Aborted';
  numberRecordsProcessed?: number;
  numberRecordsFailed?: number;
  errorMessage?: string;
};

export type BulkProgress = (state: string, processed: number) => void;

type PollOptions = { pollMs?: number; timeoutMs?: number; onProgress?: BulkProgress };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForJob(client: SalesforceClient, path: string, options: PollOptions): Promise<JobInfo> {
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60_000);
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const info = await client.rest<JobInfo>('GET', path);
    options.onProgress?.(info.state, info.numberRecordsProcessed ?? 0);
    if (['JobComplete', 'Failed', 'Aborted'].includes(info.state)) return info;
    if (Date.now() > deadline)
      throw new Error(`Bulk job ${info.id} is still ${info.state}; check it later in Setup > Bulk Data Load Jobs.`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(options.pollMs ?? 2000);
  }
}

export type BulkQueryResult = { jobId: string; csv: string; rows: number };

/**
 * Bulk API 2.0 query. Results come in chunks (one per `rowsPerFile`, default 50,000); with
 * `onFile` each chunk is handed over as its own CSV file (with the header) and nothing is kept
 * in memory, so exports of millions of rows work. Without it, the chunks are joined into `csv`.
 */
export async function bulkQuery(
  client: SalesforceClient,
  soql: string,
  options: PollOptions & {
    includeDeleted?: boolean;
    rowsPerFile?: number;
    onFile?: (csv: string, index: number, rows: number) => void | Promise<void>;
  } = {}
): Promise<BulkQueryResult & { files: number }> {
  const job = await client.rest<JobInfo>('POST', '/jobs/query', {
    operation: options.includeDeleted ? 'queryAll' : 'query',
    query: soql.trim().replace(/;$/, ''),
    contentType: 'CSV',
    columnDelimiter: 'COMMA',
    lineEnding: 'LF',
  });
  const info = await waitForJob(client, `/jobs/query/${job.id}`, options);
  if (info.state !== 'JobComplete') throw new Error(info.errorMessage ?? `Bulk query ${info.state.toLowerCase()}.`);

  const version = await client.version();
  const perFile = Math.max(1, Math.floor(options.rowsPerFile ?? 50_000));
  let csv = '';
  let rows = 0;
  let files = 0;
  let locator = '';
  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await client.raw({
      method: 'GET',
      path: `/services/data/v${version}/jobs/query/${job.id}/results?maxRecords=${perFile}${
        locator ? `&locator=${encodeURIComponent(locator)}` : ''
      }`,
      headers: { accept: 'text/csv' },
    });
    const body = page.body.endsWith('\n') ? page.body : `${page.body}\n`;
    const count = Number(page.headers['sforce-numberofrecords'] ?? 0);
    rows += count;
    if (options.onFile) {
      // Every chunk starts with the header row, so each one is a complete CSV file
      // eslint-disable-next-line no-await-in-loop
      await options.onFile(body, files, count);
    } else {
      // Joined: keep the header once
      csv += csv ? body.slice(body.indexOf('\n') + 1) : body;
    }
    files++;
    locator = page.headers['sforce-locator'] ?? '';
  } while (locator && locator !== 'null');
  return { jobId: job.id, csv, rows, files };
}

export type IngestOperation = 'insert' | 'update' | 'upsert' | 'delete' | 'hardDelete';

export type IngestResult = {
  jobId: string;
  state: string;
  processed: number;
  failed: number;
  successfulCsv: string;
  failedCsv: string;
  unprocessedCsv: string;
  errorMessage?: string;
};

export async function bulkIngest(
  client: SalesforceClient,
  request: { object: string; operation: IngestOperation; csv: string; externalIdField?: string },
  options: PollOptions = {}
): Promise<IngestResult> {
  if (!/^\w+$/.test(request.object)) throw new Error('Invalid object name.');
  if (request.operation === 'upsert' && !request.externalIdField) throw new Error('Upsert needs an external ID field.');
  const job = await client.rest<JobInfo>('POST', '/jobs/ingest', {
    object: request.object,
    operation: request.operation,
    ...(request.externalIdField ? { externalIdFieldName: request.externalIdField } : {}),
    contentType: 'CSV',
    lineEnding: 'LF',
  });
  const version = await client.version();
  const base = `/services/data/v${version}/jobs/ingest/${job.id}`;
  await client.raw({
    method: 'PUT',
    path: `${base}/batches`,
    headers: { 'content-type': 'text/csv' },
    body: request.csv.replace(/\r\n?/g, '\n'),
  });
  await client.rest('PATCH', `/jobs/ingest/${job.id}`, { state: 'UploadComplete' });
  const info = await waitForJob(client, `/jobs/ingest/${job.id}`, options);

  const result = async (name: string): Promise<string> =>
    (await client.raw({ method: 'GET', path: `${base}/${name}/`, headers: { accept: 'text/csv' } })).body;
  const [successfulCsv, failedCsv, unprocessedCsv] = await Promise.all([
    result('successfulResults'),
    result('failedResults'),
    result('unprocessedrecords'),
  ]);
  return {
    jobId: job.id,
    state: info.state,
    processed: info.numberRecordsProcessed ?? 0,
    failed: info.numberRecordsFailed ?? 0,
    successfulCsv,
    failedCsv,
    unprocessedCsv,
    errorMessage: info.errorMessage,
  };
}

/** Deletes every record a query returns: Bulk query of the Ids, then a Bulk delete. */
export async function deleteByQuery(
  client: SalesforceClient,
  soql: string,
  options: PollOptions & { hardDelete?: boolean } = {}
): Promise<IngestResult | undefined> {
  const object = mainSObject(soql);
  if (!object) throw new Error('The query needs a FROM clause.');
  const rest = soql.slice(soql.search(new RegExp(`\\bfrom\\s+${object}\\b`, 'i')));
  const ids = await bulkQuery(client, `SELECT Id ${rest}`, options);
  if (ids.rows === 0) return undefined;
  return bulkIngest(client, { object, operation: options.hardDelete ? 'hardDelete' : 'delete', csv: ids.csv }, options);
}
