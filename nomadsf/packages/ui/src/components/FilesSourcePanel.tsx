import { Fragment, useEffect, useState } from 'react';
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
import { Status } from '../statusLog';

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
  // B's objects are read (until then a typed object is not marked wrong)
  const [loaded, setLoaded] = useState(false);
  // Rows taken out (sheet#row), and the sheets opened to pick rows
  const [off, setOff] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<Set<string>>(new Set());

  useEffect(() => {
    setObjects([]);
    setLoaded(false);
    if (!targetClient) return;
    void targetClient()
      .then((c) => describeGlobal(c))
      .then((list) => {
        setObjects(list.map((o) => ({ name: o.name, label: o.label })));
        setLoaded(true);
      })
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
      setOff(new Set());
      setOpened(new Set());
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const known = (name: string): string | undefined =>
    objects.find((o) => o.name.toLowerCase() === name.trim().toLowerCase())?.name;
  const rowKey = (t: FileTable, i: number) => `${t.name}#${i}`;
  const picked = (t: FileTable) => t.rows.filter((_, i) => !off.has(rowKey(t, i)));
  const chosen = (file?.tables ?? [])
    .filter((t) => known(match[t.name] ?? ''))
    .map((t) => ({ ...t, rows: picked(t) }))
    .filter((t) => t.rows.length);
  const toggle = (keys: string[], on: boolean) => {
    const next = new Set(off);
    for (const k of keys)
      if (on) next.delete(k);
      else next.add(k);
    setOff(next);
  };
  const nameOf = (r: Record<string, string>) =>
    r.Name || r.CaseNumber || r.Subject || r.Title || [r.FirstName, r.LastName].filter(Boolean).join(' ') || r.Id || '';

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
      setStatus(
        `✓ ${chosen
          .map((t) => `${t.rows.length} ${known(match[t.name])}`)
          .join(', ')}: choose what to copy below (change the ticks above, then Use these files again).`
      );
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
        {!targetClient ? (
          <span className="muted">Choose B (copy into) first: its objects describe the files.</span>
        ) : (
          !loaded && <span className="muted">Reading the objects of B…</span>
        )}
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
              <Fragment key={t.name}>
                <tr>
                  <td>
                    <button
                      className="link"
                      title="Pick the rows to copy"
                      onClick={() => {
                        const next = new Set(opened);
                        if (next.has(t.name)) next.delete(t.name);
                        else next.add(t.name);
                        setOpened(next);
                      }}
                    >
                      {opened.has(t.name) ? '▾' : '▸'}
                    </button>{' '}
                    {t.name}
                  </td>
                  <td>
                    {picked(t).length === t.rows.length
                      ? t.rows.length.toLocaleString()
                      : `${picked(t).length.toLocaleString()} of ${t.rows.length.toLocaleString()}`}
                  </td>
                  <td>
                    <input
                      list={`files-objects-${t.name}`}
                      placeholder="skip"
                      value={match[t.name] ?? ''}
                      onChange={(e) => setMatch({ ...match, [t.name]: e.target.value })}
                      className={loaded && match[t.name] && !known(match[t.name]) ? 'bad-input' : ''}
                    />
                    <ObjectOptions id={`files-objects-${t.name}`} objects={objects} typed={match[t.name] ?? ''} />
                  </td>
                  <td className="muted">
                    {t.columns.some((c) => c.toLowerCase() === 'id')
                      ? '✓ lookups to it are kept'
                      : 'none: nothing can point to these'}
                  </td>
                </tr>
                {opened.has(t.name) && (
                  <tr>
                    <td colSpan={4}>
                      <ul className="relation-tree root">
                        <li>
                          <label className="check">
                            <input
                              type="checkbox"
                              checked={picked(t).length === t.rows.length}
                              onChange={(e) =>
                                toggle(
                                  t.rows.map((_, i) => rowKey(t, i)),
                                  e.target.checked
                                )
                              }
                            />{' '}
                            All {t.rows.length.toLocaleString()}
                          </label>
                        </li>
                        {t.rows.slice(0, 500).map((r, i) => (
                          <li key={rowKey(t, i)}>
                            <label className="check">
                              <input
                                type="checkbox"
                                checked={!off.has(rowKey(t, i))}
                                onChange={(e) => toggle([rowKey(t, i)], e.target.checked)}
                              />{' '}
                              {nameOf(r)} <span className="muted mono">{r.Id}</span>
                            </label>
                          </li>
                        ))}
                        {t.rows.length > 500 && (
                          <li className="muted">The first 500 rows are listed; All covers every row.</li>
                        )}
                      </ul>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
      {file && (
        <div className="form">
          <button className="primary" disabled={busy || !chosen.length || !targetClient} onClick={() => void use()}>
            Use these files ({chosen.reduce((n, t) => n + t.rows.length, 0).toLocaleString()} rows)
          </button>
          <span className="muted">
            Sheets left empty are skipped. Lookup columns holding Ids of other sheets (AccountId…) are pointed to the
            new records.
          </span>
        </div>
      )}
      {status && <Status text={status} block />}
    </div>
  );
}
