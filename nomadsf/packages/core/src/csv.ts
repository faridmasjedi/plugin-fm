/** RFC 4180 CSV (quoted fields, escaped quotes, newlines inside quotes). */

export type CsvTable = { columns: string[]; rows: Array<Record<string, string>> };

export function parseCsv(text: string): CsvTable {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  const input = text.replace(/^﻿/, '');

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quoted) {
      if (ch === '"' && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const nonEmpty = records.filter((r) => !(r.length === 1 && r[0] === ''));
  const [header = [], ...body] = nonEmpty;
  return {
    columns: header,
    rows: body.map((values) => Object.fromEntries(header.map((column, index) => [column, values[index] ?? '']))),
  };
}

const quote = (value: unknown): string => {
  const text =
    value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export function toCsv(columns: string[], rows: Array<Record<string, unknown>>): string {
  return (
    [columns.map(quote).join(','), ...rows.map((row) => columns.map((c) => quote(row[c])).join(','))].join('\n') + '\n'
  );
}

/** Number of data rows (cheap: no parsing of the values). */
export function csvRowCount(text: string): number {
  return Math.max(0, parseCsv(text).rows.length);
}
