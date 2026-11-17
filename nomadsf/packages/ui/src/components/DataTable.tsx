import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseFilterLogic } from '@nomadsf/core';
import { Select } from './Select';
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
  /** A list to choose from (test classes…): no Filters, Copy, CSV or JSON — the page has its own search. */
  picker?: boolean;
};

/** A column's values offered in a filter's dropdown: at most this many (the box still takes anything typed). */
const SUGGEST_MAX = 200;

/** A filter: a column ('' = any column) and what to look for (same syntax as before: =exact !not >10 <5). */
type Condition = { column: string; value: string; op?: Op };
/** has: the value typed (contains, =exact, !not, >n, <n) · empty: blank or null · filled: has a value. */
type Op = 'has' | 'empty' | 'filled';
const blank = (v: unknown): boolean => text(v).trim() === '';
const isOn = (c: Condition): boolean => (c.op ?? 'has') !== 'has' || c.value !== '';
const NEW: Condition = { column: '', value: '', op: 'has' };

/**
 * The columns hidden in a table, remembered in this browser by its set of columns: the same kind of table (another
 * user's access, another org's list) keeps the choice; a table with other columns has its own.
 */
const hiddenKey = (columns: string[]): string => `dt.hidden:${columns.join(',')}`;
function readHidden(key: string): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.map(String) : []);
  } catch {
    return new Set();
  }
}

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
  picker,
}: DataTableProps) {
  const inspect = useContext(InspectContext);
  const listId = useId();
  const selectable = Boolean(selected && onSelectedChange);
  const keyOf = (r: Row): string => String(r[rowKey] ?? '');
  const [conditions, setConditions] = useState<Condition[]>([]);
  // How the filters combine: "1 OR (2 AND 3)"; empty = all of them
  const [logic, setLogic] = useState('');
  const logicCheck = useMemo(() => {
    try {
      return { run: parseFilterLogic(logic, conditions.length), error: '' };
    } catch (e) {
      return { run: (r: boolean[]) => r.every(Boolean), error: (e as Error).message };
    }
  }, [logic, conditions.length]);
  const [ticked, setTicked] = useState<'all' | 'ticked' | 'unticked'>('all');
  const [panel, setPanel] = useState<'filters' | 'columns' | null>(null);
  // Columns the user chose not to see (all are shown at first); exports follow what is shown
  const storeKey = hiddenKey(columns);
  const [hidden, setHiddenState] = useState<Set<string>>(() => readHidden(storeKey));
  useEffect(() => setHiddenState(readHidden(storeKey)), [storeKey]);
  const setHidden = (next: Set<string>): void => {
    setHiddenState(next);
    try {
      if (next.size) localStorage.setItem(storeKey, JSON.stringify([...next]));
      else localStorage.removeItem(storeKey);
    } catch {
      /* not remembered: still applied */
    }
  };
  const cols = useMemo(() => {
    const out = columns.filter((c) => !hidden.has(c));
    return out.length ? out : columns;
  }, [columns, hidden]);
  const hiddenCount = columns.length - cols.length;
  const [sort, setSort] = useState<{ col: string; dir: 1 | -1 } | null>(null);
  // Groups opened (all closed at first when there are several)
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set());

  const visible = useMemo(() => {
    let out = rows;
    // Each filter on a row; one not filled in counts as passed
    const test = (c: Condition, r: Row): boolean => {
      const op = c.op ?? 'has';
      if (op === 'empty') return c.column ? blank(r[c.column]) : columns.some((col) => blank(r[col]));
      if (op === 'filled') return c.column ? !blank(r[c.column]) : columns.every((col) => !blank(r[col]));
      return c.column ? matches(r[c.column], c.value) : columns.some((col) => matches(r[col], c.value));
    };
    if (conditions.some(isOn)) out = out.filter((r) => logicCheck.run(conditions.map((c) => !isOn(c) || test(c, r))));
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
  }, [rows, columns, conditions, logicCheck, ticked, selected, sort, groupBy]);

  // The values of the columns being filtered, for their dropdowns: only those columns, at most SUGGEST_MAX each
  const suggestions = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const { column } of conditions) {
      if (!column || out[column]) continue;
      const seen = new Set<string>();
      for (const r of rows) {
        const v = text(r[column]);
        if (v) seen.add(v);
        if (seen.size >= SUGGEST_MAX) break;
      }
      out[column] = [...seen].sort();
    }
    return out;
  }, [conditions, rows]);
  const active = conditions.filter(isOn).length + (ticked !== 'all' ? 1 : 0);
  const setCondition = (i: number, next: Partial<Condition>): void =>
    setConditions(conditions.map((c, j) => (j === i ? { ...c, ...next } : c)));

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
  // One group starts open, several start closed; a click turns the default over; filtering opens them all
  const isOpen = (g: string): boolean => active > 0 || (groups?.size ?? 0) <= 1 !== openGroups.has(g);
  const toggleGroup = (g: string): void => {
    const next = new Set(openGroups);
    if (next.has(g)) next.delete(g);
    else next.add(g);
    setOpenGroups(next);
  };

  // In the page's ⤓ download, as shown (filters and sorting applied)
  const root = useRef<HTMLDivElement>(null);
  useRegisterTable(root, () => ({ name, columns: cols, rows: visible }));
  // In a narrow pane the Filters or Columns panel goes under the bar instead of squeezing the table
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => setNarrow(el.clientWidth > 0 && el.clientWidth < 640));
    watch.observe(el);
    return () => watch.disconnect();
  }, []);

  const toCsv = (): string =>
    [cols.join(','), ...visible.map((r) => cols.map((c) => `"${text(r[c]).replace(/"/g, '""')}"`).join(','))].join(
      '\n'
    );
  const toTsv = (): string =>
    [cols.join('\t'), ...visible.map((r) => cols.map((c) => text(r[c]).replace(/[\t\n]/g, ' ')).join('\t'))].join('\n');
  const toJson = (): string =>
    JSON.stringify(hiddenCount ? visible.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]]))) : visible, null, 2);

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

  // In group boxes the grouped column is the box's title: not repeated on every row (exports keep it)
  const shownColumns = groups && groups.size > 0 ? cols.filter((c) => c !== groupBy) : cols;

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
      {shownColumns.map((c, ci) => (
        // Long text is cut to the column: hovering shows all of it
        <td key={`${ci}:${c}`} title={fullText(r[c])}>
          {renderCell?.(c, r) ?? cell(c, r[c])}
        </td>
      ))}
    </tr>
  );

  const header = (list: Row[]): ReactNode => (
    <thead>
      <tr>
        {selectable && (
          <th className="sel">
            <input
              type="checkbox"
              title="Select all shown"
              checked={list.length > 0 && list.every((r) => selected!.has(keyOf(r)))}
              onChange={(e) => {
                const next = new Set(selected);
                for (const r of list) e.target.checked ? next.add(keyOf(r)) : next.delete(keyOf(r));
                onSelectedChange!(next);
              }}
            />
          </th>
        )}
        {/* Keys by position: a column name can repeat (a file's own column and a looked-up one) */}
        {shownColumns.map((c, ci) => (
          <th
            key={`${ci}:${c}`}
            onClick={() => setSort(sort?.col === c ? { col: c, dir: sort.dir === 1 ? -1 : 1 } : { col: c, dir: 1 })}
          >
            {c}
            {sort?.col === c ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
          </th>
        ))}
      </tr>
    </thead>
  );

  const table =
    groups && groups.size > 0 ? (
      // Grouped: a box per group (a metadata type, an object…), opened like a dropdown — as in Release lists
      <div className="dt-groups">
        {[...groups].map(([g, list]) => {
          const open = isOpen(g);
          const tickedHere = selectable ? list.filter((r) => selected!.has(keyOf(r))).length : 0;
          return (
            <div key={`group:${g}`} className={`dt-group-box ${open ? 'open' : ''}`}>
              <div className="dt-group-head">
                {selectable && (
                  <input
                    type="checkbox"
                    title={`Tick every ${g}`}
                    checked={tickedHere === list.length}
                    onChange={(e) => {
                      const next = new Set(selected);
                      for (const r of list) e.target.checked ? next.add(keyOf(r)) : next.delete(keyOf(r));
                      onSelectedChange!(next);
                    }}
                  />
                )}
                <button className="dt-group-toggle" aria-expanded={open} onClick={() => toggleGroup(g)}>
                  <span className="caret">{open ? '▾' : '▸'}</span>
                  <b>{g || '—'}</b>
                  <span className="pill">{list.length}</span>
                </button>
                {tickedHere > 0 && <span className="pill good">{tickedHere} ticked</span>}
              </div>
              {open && (
                <div className="dt-wrap">
                  <table>
                    {header(list)}
                    <tbody>{list.map((r, i) => rowOf(r, i))}</tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    ) : (
      <div className="dt-wrap">
        <table>
          {header(visible)}
          <tbody>{visible.slice(0, maxShown).map((r, i) => rowOf(r, i))}</tbody>
        </table>
      </div>
    );

  return (
    <div className={`dt${narrow ? ' narrow' : ''}`} ref={root}>
      <div className="dt-bar">
        <span className="muted dt-count">
          {visible.length.toLocaleString()} of {rows.length.toLocaleString()} rows {note}
        </span>
        <span className="dt-actions" hidden={picker}>
          <button
            className={`dt-filters-toggle ${panel === 'filters' || active ? 'active' : ''}`}
            title="Filter: choose a column, then type or choose a value"
            onClick={() => {
              if (panel !== 'filters' && !conditions.length) setConditions([NEW]);
              setPanel(panel === 'filters' ? null : 'filters');
            }}
          >
            ⚲ Filters{active ? ` (${active})` : ''}
          </button>
          <button
            className={`dt-filters-toggle ${panel === 'columns' || hiddenCount ? 'active' : ''}`}
            title="Choose the columns to show (exports follow)"
            onClick={() => setPanel(panel === 'columns' ? null : 'columns')}
          >
            ▥ Columns{hiddenCount ? ` (${cols.length}/${columns.length})` : ''}
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
          <button onClick={() => download(`${name}.json`, toJson(), 'application/json')}>JSON</button>
        </span>
      </div>
      <div className={`dt-main ${panel ? 'with-panel' : ''}`}>
        {table}
        {panel === 'columns' && (
          <aside className="dt-panel dt-columns">
            <div className="dt-panel-head">
              <b>Columns</b>
              <span className="dt-columns-all">
                <button className="link" disabled={!hiddenCount} onClick={() => setHidden(new Set())}>
                  Show all
                </button>
                <button
                  className="link"
                  disabled={cols.length <= 1}
                  title="Keep only the first column"
                  onClick={() => setHidden(new Set(columns.slice(1)))}
                >
                  None
                </button>
              </span>
            </div>
            <div className="dt-columns-list">
              {[...new Set(columns)].map((c) => (
                <label key={c} className="dt-column-pick">
                  <input
                    type="checkbox"
                    checked={!hidden.has(c)}
                    disabled={!hidden.has(c) && cols.length <= 1}
                    onChange={(e) => {
                      const next = new Set(hidden);
                      if (e.target.checked) next.delete(c);
                      else next.add(c);
                      setHidden(next);
                    }}
                  />
                  <span title={c}>{c}</span>
                </label>
              ))}
            </div>
            <p className="muted small">Remembered for this table. Copy, CSV and JSON export the columns shown.</p>
          </aside>
        )}
        {panel === 'filters' && (
          <aside className="dt-panel">
            <div className="dt-panel-head">
              <b>Filters</b>
              <button
                className="link"
                disabled={!active && conditions.length <= 1 && !logic}
                onClick={() => {
                  setConditions([NEW]);
                  setLogic('');
                  setTicked('all');
                }}
              >
                Clear
              </button>
            </div>
            {conditions.map((c, i) => (
              <div key={i} className="dt-condition">
                <div className="dt-condition-row">
                  {conditions.length > 1 && (
                    <span className="dt-condition-n" title={`Filter ${i + 1} (for the logic below)`}>
                      {i + 1}
                    </span>
                  )}
                  <Select value={c.column} onChange={(e) => setCondition(i, { column: e.target.value, value: '' })}>
                    <option value="">Any column</option>
                    {columns.map((col, ci) => (
                      <option key={`${ci}:${col}`} value={col}>
                        {col}
                      </option>
                    ))}
                  </Select>
                  <button
                    className="link"
                    title="Remove this filter"
                    onClick={() => {
                      setConditions(conditions.filter((_, j) => j !== i));
                      // The numbers after it move up: the logic is written again by hand
                      if (logic) setLogic('');
                    }}
                  >
                    ✕
                  </button>
                </div>
                <div className="dt-condition-row">
                  <Select
                    className="dt-condition-op"
                    value={c.op ?? 'has'}
                    onChange={(e) => setCondition(i, { op: e.target.value as Op })}
                    title={c.column ? undefined : 'With Any column: empty = some column is empty; not empty = none is'}
                  >
                    <option value="has">Matches</option>
                    <option value="filled">Is not empty</option>
                    <option value="empty">Is empty</option>
                  </Select>
                  {(c.op ?? 'has') === 'has' && (
                    <input
                      list={c.column ? `${listId}-${c.column}` : undefined}
                      placeholder={c.column ? 'Type or choose a value…' : 'Text in any column…'}
                      value={c.value}
                      onChange={(e) => setCondition(i, { value: e.target.value })}
                    />
                  )}
                </div>
                {c.column && (
                  <datalist id={`${listId}-${c.column}`}>
                    {(suggestions[c.column] ?? []).map((v) => (
                      <option key={v} value={`=${v}`}>
                        {v}
                      </option>
                    ))}
                  </datalist>
                )}
              </div>
            ))}
            <button onClick={() => setConditions([...conditions, NEW])}>+ Add a filter</button>
            {conditions.length > 1 && (
              <label className="dt-logic">
                <span>Filter logic</span>
                <input
                  className={logicCheck.error ? 'bad' : ''}
                  placeholder={conditions.map((_, i) => i + 1).join(' AND ')}
                  value={logic}
                  spellCheck={false}
                  onChange={(e) => setLogic(e.target.value)}
                />
                {logicCheck.error ? (
                  <small className="bad-text">{logicCheck.error} Using AND for now.</small>
                ) : (
                  <small>e.g. 1 OR 2 OR (3 AND 4) · NOT 2 · empty = all of them</small>
                )}
              </label>
            )}
            {selectable && (
              <label>
                <span>Ticked</span>
                <Select value={ticked} onChange={(e) => setTicked(e.target.value as typeof ticked)}>
                  <option value="all">All rows</option>
                  <option value="ticked">Ticked only ({selected!.size})</option>
                  <option value="unticked">Not ticked</option>
                </Select>
              </label>
            )}
            <p className="muted small">
              Matches: plain text finds rows that contain it · =exact · !not · &gt;10 · &lt;5 · Is empty / Is not empty:
              blank or null
            </p>
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
    <p className="empty-hint">
      <b>No {what}.</b> If you expected some, your user may not be able to see them (sharing, object or field
      permissions).
    </p>
  );
}
