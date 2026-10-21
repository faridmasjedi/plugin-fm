import { useContext, useMemo, useState, type ReactNode } from 'react';
import { InspectContext } from '../context';
import { CopyId } from './CopyId';

type Row = Record<string, unknown>;

const ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const text = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** Filter syntax: plain text = contains; =x exact; !x does not contain; >n / <n numeric. */
export function matches(value: unknown, filter: string): boolean {
  const v = text(value).toLowerCase();
  const f = filter.toLowerCase();
  if (f.startsWith('=')) return v === f.slice(1);
  if (f.startsWith('!')) return !v.includes(f.slice(1));
  if (/^[<>]/.test(f) && !Number.isNaN(parseFloat(f.slice(1)))) {
    return f[0] === '<' ? parseFloat(v) < parseFloat(f.slice(1)) : parseFloat(v) > parseFloat(f.slice(1));
  }
  return v.includes(f);
}

export function download(name: string, content: string, type: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export type DataTableProps = {
  columns: string[];
  rows: Row[];
  name?: string;
  instanceUrl?: string;
  /** Extra info next to the row count. */
  note?: ReactNode;
  onRowClick?: (row: Row) => void;
  selectedKey?: unknown;
  rowKey?: string;
  maxShown?: number;
  /** Checkbox column; `selected` holds the rowKey values of the checked rows. */
  selected?: Set<string>;
  onSelectedChange?: (selected: Set<string>) => void;
};

export function DataTable({
  columns,
  rows,
  name = 'results',
  instanceUrl,
  note,
  onRowClick,
  selectedKey,
  rowKey = 'Id',
  maxShown = 1000,
  selected,
  onSelectedChange,
}: DataTableProps) {
  const inspect = useContext(InspectContext);
  const selectable = Boolean(selected && onSelectedChange);
  const keyOf = (r: Row): string => String(r[rowKey] ?? '');
  const [filter, setFilter] = useState('');
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);

  const visible = useMemo(() => {
    let out = rows;
    if (filter) out = out.filter((r) => columns.some((c) => matches(r[c], filter)));
    for (const [c, f] of Object.entries(colFilters)) if (f) out = out.filter((r) => matches(r[c], f));
    if (sort) {
      out = [...out].sort((a, b) => {
        const x = a[sort.col];
        const y = b[sort.col];
        const nx = Number(x);
        const ny = Number(y);
        const cmp =
          x !== null && y !== null && !Number.isNaN(nx) && !Number.isNaN(ny) && text(x) !== '' && text(y) !== ''
            ? nx - ny
            : text(x).localeCompare(text(y));
        return cmp * sort.dir;
      });
    }
    return out;
  }, [rows, columns, filter, colFilters, sort]);

  const toCsv = (): string =>
    [
      columns.join(','),
      ...visible.map((r) => columns.map((c) => `"${text(r[c]).replace(/"/g, '""')}"`).join(',')),
    ].join('\n');
  const toTsv = (): string =>
    [columns.join('\t'), ...visible.map((r) => columns.map((c) => text(r[c]).replace(/[\t\n]/g, ' ')).join('\t'))].join(
      '\n'
    );

  const cell = (c: string, v: unknown): ReactNode => {
    const s = text(v);
    if (instanceUrl && ID_RE.test(s) && (c === 'Id' || c.endsWith('Id'))) {
      // The Id is text (one click selects it, ⌘C copies); a link would only drag or open
      return (
        <span className="id-cell">
          <span className="id-text">{s}</span>
          <CopyId id={s} />
          <a
            className="id-action"
            href={`${instanceUrl}/${s}`}
            target="_blank"
            rel="noreferrer"
            title="Open in Salesforce"
            onClick={(e) => e.stopPropagation()}
          >
            ↗
          </a>
          {inspect && (
            <button
              className="link inspect"
              title="Show all fields"
              onClick={(e) => {
                e.stopPropagation();
                inspect(s);
              }}
            >
              ⓘ
            </button>
          )}
        </span>
      );
    }
    return s.length > 300 ? `${s.slice(0, 300)}…` : s;
  };

  return (
    <div className="dt">
      <div className="dt-bar">
        <input
          className="dt-filter"
          placeholder="Filter all columns…  (=exact  !not  >10  <5)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="muted">
          {visible.length.toLocaleString()} of {rows.length.toLocaleString()} rows {note}
        </span>
        <span className="grow" />
        <button onClick={() => navigator.clipboard.writeText(toTsv())}>Copy</button>
        <button onClick={() => download(`${name}.csv`, toCsv(), 'text/csv')}>CSV</button>
        <button onClick={() => download(`${name}.json`, JSON.stringify(visible, null, 2), 'application/json')}>
          JSON
        </button>
      </div>
      <div className="dt-wrap">
        <table>
          <thead>
            <tr>
              {selectable && (
                <th className="sel">
                  <input
                    type="checkbox"
                    title="Select all shown"
                    checked={visible.length > 0 && visible.every((r) => selected!.has(keyOf(r)))}
                    onChange={(e) => {
                      const next = new Set(selected);
                      for (const r of visible) e.target.checked ? next.add(keyOf(r)) : next.delete(keyOf(r));
                      onSelectedChange!(next);
                    }}
                  />
                </th>
              )}
              {columns.map((c) => (
                <th
                  key={c}
                  onClick={() =>
                    setSort(sort?.col === c ? { col: c, dir: sort.dir === 1 ? -1 : 1 } : { col: c, dir: 1 })
                  }
                >
                  {c}
                  {sort?.col === c ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
            <tr className="dt-filters">
              {selectable && <th />}
              {columns.map((c) => (
                <th key={c}>
                  <input
                    placeholder="filter"
                    value={colFilters[c] ?? ''}
                    onChange={(e) => setColFilters({ ...colFilters, [c]: e.target.value })}
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.slice(0, maxShown).map((r, i) => (
              <tr
                key={String(r[rowKey] ?? i)}
                className={`${onRowClick ? 'clickable' : ''} ${
                  selectedKey !== undefined && r[rowKey] === selectedKey ? 'selected' : ''
                }`}
                onClick={onRowClick ? () => onRowClick(r) : undefined}
              >
                {selectable && (
                  <td className="sel" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected!.has(keyOf(r))}
                      onChange={(e) => {
                        const next = new Set(selected);
                        e.target.checked ? next.add(keyOf(r)) : next.delete(keyOf(r));
                        onSelectedChange!(next);
                      }}
                    />
                  </td>
                )}
                {columns.map((c) => (
                  <td key={c}>{cell(c, r[c])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {visible.length > maxShown && (
        <p className="muted">Showing the first {maxShown.toLocaleString()} rows. Filter, or export for all.</p>
      )}
    </div>
  );
}

/** Shown when Salesforce returns nothing: records the user cannot see are left out silently. */
export function EmptyHint({ what = 'rows' }: { what?: string }) {
  return (
    <p className="muted" style={{ margin: 0 }}>
      No {what}. If you expected some, your user may not be able to see them (sharing, object or field permissions).
    </p>
  );
}
