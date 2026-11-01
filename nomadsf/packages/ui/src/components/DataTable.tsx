import { Fragment, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { InspectContext } from '../context';
import { useRegisterTable } from '../pageTables';
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

export function download(name: string, content: string | Uint8Array, type: string): void {
  const a = document.createElement('a');
  // CSV with a UTF-8 BOM: Excel otherwise reads it as ANSI (→, é and the like turn into gibberish)
  const body =
    typeof content === 'string' && type === 'text/csv' && !content.startsWith('\uFEFF') ? `\uFEFF${content}` : content;
  a.href = URL.createObjectURL(new Blob([body], { type }));
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
  /** A cell drawn by the page (a select, a button); undefined draws the value as usual. */
  renderCell?: (column: string, row: Row) => ReactNode | undefined;
  /** Rows of the same value of this column (a metadata type) under one line you open, like a dropdown. */
  groupBy?: string;
};

/** Columns with this many distinct values or fewer get value checkboxes in the filters panel. */
const PICK_MAX = 12;

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
  renderCell,
  selected,
  onSelectedChange,
  groupBy,
}: DataTableProps) {
  const inspect = useContext(InspectContext);
  const selectable = Boolean(selected && onSelectedChange);
  const keyOf = (r: Row): string => String(r[rowKey] ?? '');
  const [filter, setFilter] = useState('');
  const [colFilters, setColFilters] = useState<Record<string, string>>({});
  // Values picked per column in the filters panel (empty: all)
  const [picks, setPicks] = useState<Record<string, string[]>>({});
  const [ticked, setTicked] = useState<'all' | 'ticked' | 'unticked'>('all');
  const [panel, setPanel] = useState(false);
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  // Groups opened (all closed at first when there are several)
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const visible = useMemo(() => {
    let out = rows;
    if (filter) out = out.filter((r) => columns.some((c) => matches(r[c], filter)));
    for (const [c, f] of Object.entries(colFilters)) if (f) out = out.filter((r) => matches(r[c], f));
    for (const [c, values] of Object.entries(picks))
      if (values.length) out = out.filter((r) => values.includes(text(r[c])));
    if (selectable && ticked !== 'all') out = out.filter((r) => selected!.has(keyOf(r)) === (ticked === 'ticked'));
    if (sort || groupBy) {
      out = [...out].sort((a, b) => {
        if (groupBy) {
          const g = text(a[groupBy]).localeCompare(text(b[groupBy]));
          if (g) return g;
        }
        if (!sort) return 0;
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
    // keyOf reads rowKey, selected is read through ticked
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, columns, filter, colFilters, picks, ticked, selected, sort, groupBy]);

  // The values a column takes, for the filters panel: only counted while the panel is open
  const distinct = useMemo(() => {
    if (!panel) return {} as Record<string, string[]>;
    const out: Record<string, string[]> = {};
    for (const c of columns) {
      const seen = new Set<string>();
      for (const r of rows) {
        seen.add(text(r[c]));
        if (seen.size > PICK_MAX) break;
      }
      if (seen.size <= PICK_MAX && seen.size > 1) out[c] = [...seen].sort();
    }
    return out;
  }, [panel, rows, columns]);
  const active =
    Object.values(colFilters).filter(Boolean).length +
    Object.values(picks).filter((v) => v.length).length +
    (ticked !== 'all' ? 1 : 0);
  const clearFilters = (): void => {
    setColFilters({});
    setPicks({});
    setTicked('all');
  };

  // Groups: the rows of each value of groupBy, in order
  const groups = useMemo(() => {
    if (!groupBy) return null;
    const out = new Map<string, Row[]>();
    for (const r of visible.slice(0, maxShown)) {
      const g = text(r[groupBy]);
      const list = out.get(g);
      if (list) list.push(r);
      else out.set(g, [r]);
    }
    return out;
  }, [groupBy, visible, maxShown]);
  const isOpen = (g: string): boolean => (groups?.size ?? 0) <= 1 || Boolean(filter) || openGroups.has(g);
  const toggleGroup = (g: string): void => {
    const next = new Set(openGroups);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    setOpenGroups(next);
  };

  // In the page's ⤓ download, as shown (filters and sorting applied)
  const root = useRef<HTMLDivElement>(null);
  useRegisterTable(root, () => ({ name, columns, rows: visible }));

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

  const rowOf = (r: Row, i: number): ReactNode => (
    <tr
      key={`${String(r[rowKey] ?? '')}:${i}`}
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
      {columns.map((c, ci) => (
        // Long text is cut to the column: hovering shows all of it
        <td key={`${ci}:${c}`} title={fullText(r[c])}>
          {renderCell?.(c, r) ?? cell(c, r[c])}
        </td>
      ))}
    </tr>
  );

  return (
    <div className="dt" ref={root}>
      <div className="dt-bar">
        <input
          className="dt-filter"
          placeholder="Filter all columns…  (=exact  !not  >10  <5)"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="muted dt-count">
          {visible.length.toLocaleString()} of {rows.length.toLocaleString()} rows {note}
        </span>
        <span className="dt-actions">
          <button
            className={`dt-filters-toggle ${panel ? 'active' : ''}`}
            title="Filter by any column, by its values, or by what is ticked"
            onClick={() => setPanel(!panel)}
          >
            ⚲ Filters{active ? ` (${active})` : ''}
          </button>
          {groups && groups.size > 1 && (
            <button
              title="Open or close every group"
              onClick={() => setOpenGroups(openGroups.size ? new Set() : new Set(groups.keys()))}
            >
              {openGroups.size ? 'Close all' : 'Open all'}
            </button>
          )}
          <button onClick={() => navigator.clipboard.writeText(toTsv())}>Copy</button>
          <button onClick={() => download(`${name}.csv`, toCsv(), 'text/csv')}>CSV</button>
          <button onClick={() => download(`${name}.json`, JSON.stringify(visible, null, 2), 'application/json')}>
            JSON
          </button>
        </span>
      </div>
      <div className={`dt-main ${panel ? 'with-panel' : ''}`}>
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
                {/* Keys by position: a column name can repeat (a file's own column and a looked-up one) */}
                {columns.map((c, ci) => (
                  <th
                    key={`${ci}:${c}`}
                    onClick={() =>
                      setSort(sort?.col === c ? { col: c, dir: sort.dir === 1 ? -1 : 1 } : { col: c, dir: 1 })
                    }
                  >
                    {c}
                    {sort?.col === c ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups
                ? [...groups].map(([g, list]) => {
                    const open = isOpen(g);
                    const allOn = selectable && list.every((r) => selected!.has(keyOf(r)));
                    return (
                      <Fragment key={`group:${g}`}>
                        {groups.size > 1 && (
                          <tr className={`dt-group ${open ? 'open' : ''}`} onClick={() => toggleGroup(g)}>
                            {selectable && (
                              <td className="sel" onClick={(e) => e.stopPropagation()}>
                                <input
                                  type="checkbox"
                                  title={`Tick every ${g}`}
                                  checked={allOn}
                                  onChange={(e) => {
                                    const next = new Set(selected);
                                    for (const r of list) e.target.checked ? next.add(keyOf(r)) : next.delete(keyOf(r));
                                    onSelectedChange!(next);
                                  }}
                                />
                              </td>
                            )}
                            <td colSpan={columns.length}>
                              <span className="caret">{open ? '▾' : '▸'}</span> <b>{g || '—'}</b>{' '}
                              <span className="muted">{list.length}</span>
                              {selectable && (
                                <span className="muted">
                                  {' '}
                                  · {list.filter((r) => selected!.has(keyOf(r))).length} ticked
                                </span>
                              )}
                            </td>
                          </tr>
                        )}
                        {open && list.map((r, i) => rowOf(r, i))}
                      </Fragment>
                    );
                  })
                : visible.slice(0, maxShown).map((r, i) => rowOf(r, i))}
            </tbody>
          </table>
        </div>
        {panel && (
          <aside className="dt-panel">
            <div className="dt-panel-head">
              <b>Filters</b>
              <button className="link" disabled={!active} onClick={clearFilters}>
                Clear
              </button>
            </div>
            {selectable && (
              <label>
                <span>Ticked</span>
                <select value={ticked} onChange={(e) => setTicked(e.target.value as typeof ticked)}>
                  <option value="all">All rows</option>
                  <option value="ticked">Ticked only ({selected!.size})</option>
                  <option value="unticked">Not ticked</option>
                </select>
              </label>
            )}
            {columns.map((c, ci) => (
              <div key={`${ci}:${c}`} className="dt-panel-field">
                <label>
                  <span>{c}</span>
                  <input
                    placeholder="contains…  =exact  !not  >10"
                    value={colFilters[c] ?? ''}
                    onChange={(e) => setColFilters({ ...colFilters, [c]: e.target.value })}
                  />
                </label>
                {distinct[c] && (
                  <div className="dt-picks">
                    {distinct[c].map((v) => {
                      const on = (picks[c] ?? []).includes(v);
                      return (
                        <button
                          key={v}
                          className={`dt-pick ${on ? 'on' : ''}`}
                          onClick={() =>
                            setPicks({
                              ...picks,
                              [c]: on ? (picks[c] ?? []).filter((x) => x !== v) : [...(picks[c] ?? []), v],
                            })
                          }
                        >
                          {v || '(empty)'}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </aside>
        )}
      </div>
      {visible.length > maxShown && (
        <p className="muted">Showing the first {maxShown.toLocaleString()} rows. Filter, or export for all.</p>
      )}
    </div>
  );
}

const fullText = (value: unknown): string | undefined =>
  (typeof value === 'string' || typeof value === 'number') && String(value) !== '' ? String(value) : undefined;

/** Shown when Salesforce returns nothing: records the user cannot see are left out silently. */
export function EmptyHint({ what = 'rows' }: { what?: string }) {
  return (
    <p className="muted" style={{ margin: 0 }}>
      No {what}. If you expected some, your user may not be able to see them (sharing, object or field permissions).
    </p>
  );
}
