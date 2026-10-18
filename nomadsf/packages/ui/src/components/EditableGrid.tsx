import { useMemo, useState } from 'react';

export type GridRow = { id: number; values: Record<string, string> };

const PAGE = 100;

/**
 * Spreadsheet-like editor for uploaded rows: click a cell to edit it, untick rows to leave them
 * out, delete or add rows. Edited cells are highlighted against the original file. Pages of 100
 * rows keep large files fast.
 */
export function EditableGrid({
  columns,
  rows,
  original,
  included,
  onRowsChange,
  onIncludedChange,
  mutedColumns,
}: {
  columns: string[];
  rows: GridRow[];
  /** Values as uploaded, by row id (to highlight edits). */
  original: Map<number, Record<string, string>>;
  included: Set<number>;
  onRowsChange: (rows: GridRow[]) => void;
  onIncludedChange: (included: Set<number>) => void;
  /** Columns that will not be sent (greyed out). */
  mutedColumns?: Set<string>;
}) {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [editing, setEditing] = useState<{ id: number; column: string } | null>(null);

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? rows.filter((r) => columns.some((c) => (r.values[c] ?? '').toLowerCase().includes(needle))) : rows;
  }, [rows, columns, filter]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  const current = Math.min(page, pages - 1);
  const visible = shown.slice(current * PAGE, current * PAGE + PAGE);
  const edits = rows.reduce(
    (n, r) => n + columns.filter((c) => (r.values[c] ?? '') !== (original.get(r.id)?.[c] ?? '')).length,
    0
  );

  const setCell = (id: number, column: string, value: string): void =>
    onRowsChange(rows.map((r) => (r.id === id ? { ...r, values: { ...r.values, [column]: value } } : r)));

  const toggleAll = (on: boolean): void => {
    const next = new Set(included);
    for (const r of shown) {
      if (on) next.add(r.id);
      else next.delete(r.id);
    }
    onIncludedChange(next);
  };

  return (
    <div className="egrid">
      <div className="form">
        <input
          placeholder="Filter rows"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(0);
          }}
        />
        <span className="muted">
          {included.size.toLocaleString()} of {rows.length.toLocaleString()} rows included
          {edits ? ` · ${edits.toLocaleString()} cell(s) edited` : ''}
        </span>
        <span className="grow" />
        <button
          onClick={() => {
            const id = Math.max(-1, ...rows.map((r) => r.id)) + 1;
            onRowsChange([...rows, { id, values: Object.fromEntries(columns.map((c) => [c, ''])) }]);
            onIncludedChange(new Set([...included, id]));
            setFilter('');
            setPage(Math.floor(rows.length / PAGE));
            setEditing({ id, column: columns[0] });
          }}
        >
          Add row
        </button>
      </div>
      <div className="egrid-scroll">
        <table>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  title="Include the rows shown"
                  checked={shown.length > 0 && shown.every((r) => included.has(r.id))}
                  onChange={(e) => toggleAll(e.target.checked)}
                />
              </th>
              <th className="muted">#</th>
              {columns.map((c) => (
                <th
                  key={c}
                  className={mutedColumns?.has(c) ? 'muted-col' : ''}
                  title={mutedColumns?.has(c) ? 'Not sent' : undefined}
                >
                  {c}
                </th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {visible.map((r) => (
              <tr key={r.id} className={included.has(r.id) ? '' : 'excluded'}>
                <td>
                  <input
                    type="checkbox"
                    checked={included.has(r.id)}
                    onChange={(e) => {
                      const next = new Set(included);
                      if (e.target.checked) next.add(r.id);
                      else next.delete(r.id);
                      onIncludedChange(next);
                    }}
                  />
                </td>
                <td className="muted">{r.id + 1}</td>
                {columns.map((c) => {
                  const value = r.values[c] ?? '';
                  const changed = value !== (original.get(r.id)?.[c] ?? '');
                  const isEditing = editing?.id === r.id && editing.column === c;
                  return (
                    <td
                      key={c}
                      className={`cell ${changed ? 'changed' : ''} ${mutedColumns?.has(c) ? 'muted-col' : ''}`}
                      title={changed ? `Was: ${original.get(r.id)?.[c] ?? '(new row)'}` : 'Click to edit'}
                      onClick={() => !isEditing && setEditing({ id: r.id, column: c })}
                    >
                      {isEditing ? (
                        <input
                          autoFocus
                          value={value}
                          onChange={(e) => setCell(r.id, c, e.target.value)}
                          onBlur={() => setEditing(null)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === 'Escape') setEditing(null);
                            if (e.key === 'Tab') {
                              e.preventDefault();
                              const next = columns[columns.indexOf(c) + (e.shiftKey ? -1 : 1)];
                              setEditing(next ? { id: r.id, column: next } : null);
                            }
                          }}
                        />
                      ) : (
                        value
                      )}
                    </td>
                  );
                })}
                <td>
                  <button
                    className="link"
                    title="Remove this row"
                    onClick={() => {
                      onRowsChange(rows.filter((x) => x.id !== r.id));
                      const next = new Set(included);
                      next.delete(r.id);
                      onIncludedChange(next);
                    }}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="form">
          <button disabled={current === 0} onClick={() => setPage(current - 1)}>
            ‹ Previous
          </button>
          <span className="muted">
            Page {current + 1} of {pages} · rows {(current * PAGE + 1).toLocaleString()}–
            {Math.min(shown.length, current * PAGE + PAGE).toLocaleString()} of {shown.length.toLocaleString()}
          </span>
          <button disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}
