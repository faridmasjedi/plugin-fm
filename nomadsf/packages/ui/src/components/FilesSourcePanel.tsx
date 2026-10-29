import { useEffect, useState } from 'react';
import {
  describeData,
  describeGlobal,
  filesAsSource,
  readTableFile,
  type BackupState,
  type FileTable,
  type SalesforceClient,
} from '@nomadsf/core';
import { ObjectOptions } from './ObjectOptions';

/**
 * Migrate › From files: an Excel workbook, a CSV or a ⤓ zip; each sheet matched to an object of the
 * target (guessed from its name). The tables then go through Migrate like a backup run: the plan,
 * parents first, every lookup between the files pointed to the new records.
 */
export function FilesSourcePanel({
  targetClient,
  onUse,
}: {
  /** The target org: its objects and fields describe the files. */
  targetClient?: () => Promise<SalesforceClient>;
  onUse: (state: BackupState, objects: string[], notes: string[]) => void;
}) {
  const [objects, setObjects] = useState<Array<{ name: string; label: string }>>([]);
  const [file, setFile] = useState<{ name: string; tables: FileTable[] } | null>(null);
  const [match, setMatch] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setObjects([]);
    if (!targetClient) return;
    void targetClient()
      .then((c) => describeGlobal(c))
      .then((list) => setObjects(list.map((o) => ({ name: o.name, label: o.label }))))
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [targetClient]);

  // A sheet named after an object (Query's ⤓ names them so): matched already
  const guess = (sheet: string): string =>
    objects.find((o) => [o.name.toLowerCase(), o.label.toLowerCase()].includes(sheet.trim().toLowerCase()))?.name ??
    objects.find((o) => o.name.toLowerCase() === sheet.split(/[-_ ]/)[0].toLowerCase())?.name ??
    '';
  useEffect(() => {
    if (!file || !objects.length) return;
    setMatch((m) => Object.fromEntries(file.tables.map((t) => [t.name, m[t.name] || guess(t.name)])));
    // guess reads objects
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, objects]);

  const open = async (f: File) => {
    setStatus('');
    try {
      const tables = (await readTableFile(f.name, new Uint8Array(await f.arrayBuffer()))).filter(
        (t) => t.columns.length
      );
      if (!tables.length) throw new Error(`No table in ${f.name}.`);
      setFile({ name: f.name, tables });
      setMatch({});
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const known = (name: string): string | undefined =>
    objects.find((o) => o.name.toLowerCase() === name.trim().toLowerCase())?.name;
  const chosen = (file?.tables ?? []).filter((t) => known(match[t.name] ?? ''));

  const use = async () => {
    if (!targetClient || !chosen.length) return;
    setBusy(true);
    setStatus('Reading the fields of the objects…');
    try {
      const client = await targetClient();
      const objectsUsed = [...new Set(chosen.map((t) => known(match[t.name])!))];
      const schemas = Object.fromEntries(
        await Promise.all(objectsUsed.map(async (o) => [o, await describeData(client, o)] as const))
      );
      const source = filesAsSource(
        chosen.map((t) => ({ ...t, object: known(match[t.name])! })),
        schemas
      );
      // Like a backup run's manifest: the file stands for the org (not production: no masking unless ticked)
      const manifest = {
        format: 1,
        job: { id: 'files', name: file!.name },
        org: { id: 'files0000000000', name: file!.name, isSandbox: true },
        kind: 'full',
        finishedAt: new Date().toISOString(),
      };
      const state = { manifest, schema: source.schema, rows: source.rows, runs: [] } as unknown as BackupState;
      onUse(state, objectsUsed, source.notes);
      setStatus(`✓ ${chosen.length} sheet(s) as ${objectsUsed.join(', ')}: choose what to copy below.`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section files-source">
      <div className="form">
        <label>
          File
          <input
            type="file"
            accept=".xlsx,.csv,.zip,text/csv,application/zip,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            title="An Excel workbook (a sheet per object), a CSV, or a zip of CSVs — ⤓ on any page downloads these"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void open(f);
              e.target.value = '';
            }}
          />
        </label>
        {!targetClient && <span className="muted">Choose B (copy into) first: its objects describe the files.</span>}
      </div>
      {file && (
        <table className="edit-table">
          <thead>
            <tr>
              <th>Sheet</th>
              <th>Rows</th>
              <th>Object in B</th>
              <th>Id column</th>
            </tr>
          </thead>
          <tbody>
            {file.tables.map((t) => (
              <tr key={t.name}>
                <td>{t.name}</td>
                <td>{t.rows.length.toLocaleString()}</td>
                <td>
                  <input
                    list={`files-objects-${t.name}`}
                    placeholder="skip"
                    value={match[t.name] ?? ''}
                    onChange={(e) => setMatch({ ...match, [t.name]: e.target.value })}
                    className={match[t.name] && !known(match[t.name]) ? 'bad-input' : ''}
                  />
                  <ObjectOptions id={`files-objects-${t.name}`} objects={objects} typed={match[t.name] ?? ''} />
                </td>
                <td className="muted">
                  {t.columns.some((c) => c.toLowerCase() === 'id')
                    ? '✓ lookups to it are kept'
                    : 'none: nothing can point to these'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {file && (
        <div className="form">
          <button className="primary" disabled={busy || !chosen.length || !targetClient} onClick={() => void use()}>
            Use these files ({chosen.length} sheet{chosen.length === 1 ? '' : 's'})
          </button>
          <span className="muted">
            Sheets left empty are skipped. Lookup columns holding Ids of other sheets (AccountId…) are pointed to the
            new records.
          </span>
        </div>
      )}
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
