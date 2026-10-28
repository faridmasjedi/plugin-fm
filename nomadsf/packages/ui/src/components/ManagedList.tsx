import { useState, type ReactNode } from 'react';
import type { Row } from '@nomadsf/core';
import { useStudio } from '../context';
import { EmptyHint } from './DataTable';

export type Choice = { id: string; label: string; detail?: string };

/**
 * A list someone can change: each row has Remove, and a picker adds one more. Every change asks for
 * the org's name first (confirmChange) and is written to the activity log.
 */
export function ManagedList({
  rows,
  columns,
  what,
  whatPlural,
  removeKey,
  onRemove,
  choices,
  addLabel,
  onAdd,
  onChanged,
  extra,
}: {
  rows: Row[];
  columns: string[];
  /** "permission set", "group or queue"… for the messages. */
  what: string;
  /** When "s" is not enough ("groups or queues"). */
  whatPlural?: string;
  /** Row field holding what Remove needs (an assignment or membership Id); rows without it cannot be removed. */
  removeKey: string;
  onRemove: (row: Row) => Promise<void>;
  /** What can be added (already present ones are left out by the caller). */
  choices?: Choice[];
  addLabel?: string;
  onAdd?: (choice: Choice) => Promise<void>;
  onChanged: () => void;
  extra?: ReactNode;
}) {
  const { org, confirmChange, logActivity } = useStudio();
  const [adding, setAdding] = useState('');
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const act = async (text: string, action: () => Promise<void>) => {
    if (!(await confirmChange(`${text} in ${org.label}`))) return;
    setBusy(true);
    setStatus(`${text}…`);
    try {
      await action();
      logActivity('access change', { what: text });
      setStatus(`✓ ${text}.`);
      onChanged();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const needle = filter.trim().toLowerCase();
  const shownChoices = (choices ?? []).filter(
    (c) => !needle || `${c.label} ${c.detail ?? ''}`.toLowerCase().includes(needle)
  );
  const name = (r: Row): string => String(r[columns[0]] ?? r.Name ?? '');

  return (
    <div className="managed-list">
      {rows.length === 0 ? (
        <EmptyHint what={whatPlural ?? `${what}s`} />
      ) : (
        <table className="edit-table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c}>{c}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={String(r[removeKey] ?? i)}>
                {columns.map((c) => (
                  <td key={c} className={c === 'Name' || c === 'DeveloperName' ? 'mono' : ''}>
                    {r[c] == null ? '' : String(r[c])}
                  </td>
                ))}
                <td>
                  {r[removeKey] ? (
                    <button
                      className="link danger"
                      disabled={busy}
                      onClick={() => void act(`Remove ${what} ${name(r)}`, () => onRemove(r))}
                    >
                      Remove
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {onAdd && (
        <div className="form">
          <input
            placeholder={`Filter ${choices?.length ?? 0}`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: 140 }}
          />
          <select value={adding} onChange={(e) => setAdding(e.target.value)} style={{ minWidth: 300 }}>
            <option value="">
              {addLabel ?? `Add ${/^[aeiou]/i.test(what) ? 'an' : 'a'} ${what}`} ({shownChoices.length})…
            </option>
            {shownChoices.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {c.detail ? ` — ${c.detail}` : ''}
              </option>
            ))}
          </select>
          <button
            disabled={!adding || busy}
            onClick={() => {
              const choice = choices?.find((c) => c.id === adding);
              if (!choice) return;
              setAdding('');
              void act(`Add ${what} ${choice.label}`, () => onAdd(choice));
            }}
          >
            Add
          </button>
          {extra}
        </div>
      )}
      {status && <p className="muted">{status}</p>}
    </div>
  );
}
