import { useState } from 'react';
import { readTableFile, type FileTable } from '@nomadsf/core';

/**
 * A table to work with, from a CSV, an Excel workbook or a zip of CSVs (what ⤓ downloads):
 * with several tables, the sheet is chosen from a list.
 */
export function TableFileInput({
  label = 'File',
  onTable,
  onError,
}: {
  label?: string;
  /** The table chosen, and the file it came from. */
  onTable: (table: FileTable, fileName: string) => void;
  onError?: (message: string) => void;
}) {
  const [file, setFile] = useState<{ name: string; tables: FileTable[] } | null>(null);
  const [sheet, setSheet] = useState('');

  const open = async (f: File) => {
    try {
      const tables = (await readTableFile(f.name, new Uint8Array(await f.arrayBuffer()))).filter(
        (t) => t.columns.length
      );
      if (!tables.length) throw new Error(`No table in ${f.name}.`);
      setFile({ name: f.name, tables });
      setSheet(tables[0].name);
      onTable(tables[0], f.name);
    } catch (e) {
      onError?.((e as Error).message);
    }
  };

  return (
    <>
      <label>
        {label}
        <input
          type="file"
          accept=".csv,text/csv,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.zip,application/zip"
          title="A CSV, an Excel workbook or a zip of CSVs (⤓ on any page downloads these)"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void open(f);
          }}
        />
      </label>
      {file && file.tables.length > 1 && (
        <label>
          Sheet
          <select
            value={sheet}
            onChange={(e) => {
              const t = file.tables.find((x) => x.name === e.target.value);
              if (!t) return;
              setSheet(t.name);
              onTable(t, file.name);
            }}
          >
            {file.tables.map((t) => (
              <option key={t.name} value={t.name}>
                {t.name} ({t.rows.length})
              </option>
            ))}
          </select>
        </label>
      )}
    </>
  );
}
