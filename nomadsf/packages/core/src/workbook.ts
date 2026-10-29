import { parseCsv } from './csv.js';
import { makeZip, readZip } from './zip.js';

/**
 * Tables as an Excel workbook (.xlsx, one sheet per table) and back, and any table file the
 * Studio is given — a CSV, a zip of CSVs or a workbook — as named tables. Values are written as
 * text, so Ids, codes with leading zeros and dates come back exactly as they were.
 */

export type Sheet = { name: string; columns: string[]; rows: Array<Record<string, unknown>> };
export type FileTable = { name: string; columns: string[]; rows: Array<Record<string, string>> };

const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // Characters XML 1.0 cannot hold
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const unesc = (s: string): string =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** A1-style column letters: 0 → A, 25 → Z, 26 → AA. */
export const columnLetters = (index: number): string => {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
};
const columnIndex = (letters: string): number => [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;

/** Sheet names Excel accepts: 31 characters at most, none of []:*?/\, each one different. */
export function sheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = (raw.replace(/[[\]:*?/\\]/g, ' ').trim() || 'Sheet').slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    return name;
  });
}

const text = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** An .xlsx file: one sheet per table, the header row bold, frozen and with filters. */
export function writeWorkbook(sheets: Sheet[]): Uint8Array {
  const names = sheetNames(sheets.map((s) => s.name));
  const cell = (ref: string, value: string, style = 0): string =>
    value === ''
      ? ''
      : `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${esc(
          value
        )}</t></is></c>`;
  const sheetXml = (s: Sheet): string => {
    const last = columnLetters(Math.max(0, s.columns.length - 1));
    const header = `<row r="1">${s.columns.map((c, i) => cell(`${columnLetters(i)}1`, c, 1)).join('')}</row>`;
    const body = s.rows
      .map(
        (r, n) =>
          `<row r="${n + 2}">${s.columns.map((c, i) => cell(`${columnLetters(i)}${n + 2}`, text(r[c]))).join('')}</row>`
      )
      .join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetData>${header}${body}</sheetData>${
      s.columns.length ? `<autoFilter ref="A1:${last}${s.rows.length + 1}"/>` : ''
    }</worksheet>`;
  };
  const files = [
    {
      path: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${
              i + 1
            }.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join('')}</Types>`,
    },
    {
      path: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      path: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names
        .map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets><definedNames>${sheets
        .map((s, i) =>
          s.columns.length
            ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${esc(
                names[i].replace(/'/g, "''")
              )}'!$A$1:$${columnLetters(s.columns.length - 1)}$${s.rows.length + 1}</definedName>`
            : ''
        )
        .join('')}</definedNames></workbook>`,
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map(
          (_, i) =>
            `<Relationship Id="rId${
              i + 1
            }" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${
              i + 1
            }.xml"/>`
        )
        .join('')}<Relationship Id="rId${
        sheets.length + 1
      }" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      path: 'xl/styles.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    },
    ...sheets.map((s, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, content: sheetXml(s) })),
  ];
  return makeZip(files);
}

const attr = (tag: string, name: string): string | undefined => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];

/** The text of an Excel string item: plain <t> or rich text runs. */
const stringItem = (xml: string): string =>
  [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => unesc(m[1])).join('');

/** Built-in Excel number formats that are dates or times. */
const DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 30, 36, 45, 46, 47, 50, 57]);

/** Which cell styles (by index) show a date: built-in date formats, or custom ones with d, m, y, h or s. */
function dateStyles(styles: string): Set<number> {
  const custom = new Map(
    [...styles.matchAll(/<numFmt\b[^>]*>/g)].map((m) => [
      Number(attr(m[0], 'numFmtId')),
      unesc(attr(m[0], 'formatCode') ?? ''),
    ])
  );
  const isDate = (id: number): boolean => {
    if (DATE_FORMATS.has(id)) return true;
    // Quoted text and [colours] are not date parts
    const code = (custom.get(id) ?? '').replace(/"[^"]*"|\[[^\]]*\]/g, '');
    return /[dmyhs]/i.test(code) && !/^(General|@)$/i.test(code);
  };
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? '';
  const out = new Set<number>();
  [...xfs.matchAll(/<xf\b[^>]*>/g)].forEach((m, i) => isDate(Number(attr(m[0], 'numFmtId') ?? 0)) && out.add(i));
  return out;
}

/** An Excel date number (days since 1899-12-30) as 2026-11-03, or 2026-11-03T14:30:00Z with a time. */
export function excelDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  const iso = new Date(ms).toISOString();
  return Number.isInteger(serial) ? iso.slice(0, 10) : `${iso.slice(0, 19)}Z`;
}

/** The sheets of an .xlsx file (Excel's or ours), the first row as the header. */
export async function readWorkbook(bytes: Uint8Array): Promise<FileTable[]> {
  const files = await readZip(bytes);
  const read = (path: string): string => new TextDecoder().decode(files.get(path) ?? new Uint8Array());
  const workbook = read('xl/workbook.xml');
  if (!workbook) throw new Error('Not an Excel workbook.');
  const rels = new Map(
    [...read('xl/_rels/workbook.xml.rels').matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      attr(m[0], 'Id') ?? '',
      attr(m[0], 'Target') ?? '',
    ])
  );
  const shared = [...read('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => stringItem(m[1]));
  const dates = dateStyles(read('xl/styles.xml'));
  const out: FileTable[] = [];
  for (const sheet of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unesc(attr(sheet[0], 'name') ?? 'Sheet');
    const target = rels.get(attr(sheet[0], 'r:id') ?? '') ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = read(path);
    const grid: string[][] = [];
    for (const row of xml.matchAll(/<row\b[^>]*\/>|<row\b[^>]*[^/]>([\s\S]*?)<\/row>/g)) {
      const r = Number(attr(row[0], 'r') ?? grid.length + 1) - 1;
      const cells: string[] = [];
      for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = attr(c[0], 'r');
        const col = ref ? columnIndex(ref.replace(/\d+/g, '')) : cells.length;
        const type = attr(c[0], 't');
        const inner = c[2] ?? '';
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        cells[col] =
          type === 's'
            ? shared[Number(v)] ?? ''
            : type === 'inlineStr'
            ? stringItem(inner)
            : type === 'b'
            ? v === '1'
              ? 'true'
              : 'false'
            : v !== undefined && dates.has(Number(attr(c[0], 's') ?? -1)) && !Number.isNaN(Number(v))
            ? excelDate(Number(v))
            : unesc(v ?? '');
      }
      grid[r] = cells;
    }
    const [header = [], ...rest] = grid;
    const columns = header.map((h, i) => (h ?? '').trim() || `Column ${i + 1}`);
    const rows = rest
      .filter((r) => r && r.some((v) => (v ?? '') !== ''))
      .map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i] ?? ''])));
    out.push({ name, columns, rows });
  }
  return out;
}

/** Any table file as named tables: a CSV (one), a zip (each CSV in it) or a workbook (each sheet). */
export async function readTableFile(fileName: string, bytes: Uint8Array): Promise<FileTable[]> {
  const lower = fileName.toLowerCase();
  const base = (path: string): string =>
    path
      .split('/')
      .pop()!
      .replace(/\.csv$/i, '')
      .replace(/^\d+-/, '');
  if (lower.endsWith('.xlsx')) return readWorkbook(bytes);
  if (lower.endsWith('.zip')) {
    const files = await readZip(bytes);
    return [...files]
      .filter(([path]) => path.toLowerCase().endsWith('.csv') && !path.startsWith('__MACOSX'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, data]) => ({ name: base(path), ...parseCsv(new TextDecoder().decode(data)) }));
  }
  return [{ name: base(fileName), ...parseCsv(new TextDecoder().decode(bytes)) }];
}
