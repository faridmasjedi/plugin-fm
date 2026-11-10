import { useMemo, useState, type ReactNode } from 'react';
import { nameMatcher } from '@nomadsf/core';

/**
 * Metadata types to compare, found by typing: the boxes show only the types that match, the ticked ones stay listed as
 * chips, and an optional Names box keeps only the components whose names match (Case*, Billing).
 */
export function TypePicker({
  types,
  chosen,
  onChosen,
  names,
  onNames,
  buttons,
  action,
}: {
  types: Array<{ type: string; count?: number }>;
  chosen: Set<string>;
  onChosen: (next: Set<string>) => void;
  /** What the names of the components must match (empty: every component). */
  names: string;
  onNames: (text: string) => void;
  /** More quick picks (Common…). */
  buttons?: ReactNode;
  /** The Compare button. */
  action: ReactNode;
}) {
  const [find, setFind] = useState('');
  const shown = useMemo(() => types.filter((t) => nameMatcher(find)(t.type)), [types, find]);
  const set = (list: string[], on: boolean) => {
    const next = new Set(chosen);
    for (const t of list) {
      if (on) next.add(t);
      else next.delete(t);
    }
    onChosen(next);
  };
  return (
    <div className="type-picker">
      <div className="form">
        <input
          type="search"
          className="type-find"
          placeholder="Find types… (flow, perm*, apex)"
          value={find}
          onChange={(e) => setFind(e.target.value)}
        />
        <button
          disabled={!shown.length}
          onClick={() =>
            set(
              shown.map((t) => t.type),
              true
            )
          }
        >
          {find ? `Tick shown (${shown.length})` : 'All'}
        </button>
        <button
          disabled={!chosen.size}
          onClick={() =>
            find
              ? set(
                  shown.map((t) => t.type),
                  false
                )
              : onChosen(new Set())
          }
        >
          {find ? 'Untick shown' : 'None'}
        </button>
        {buttons}
        <span className="muted">
          {chosen.size} of {types.length} ticked
        </span>
      </div>
      {chosen.size > 0 && (
        <div className="type-chips">
          {[...chosen].sort().map((t) => (
            <button key={t} className="chip" title="Untick" onClick={() => set([t], false)}>
              {t} ×
            </button>
          ))}
        </div>
      )}
      <div className="field-checks">
        {shown.map((t) => (
          <label key={t.type} className="check">
            <input type="checkbox" checked={chosen.has(t.type)} onChange={(e) => set([t.type], e.target.checked)} />{' '}
            {t.type} {t.count !== undefined && <span className="muted">({t.count})</span>}
          </label>
        ))}
        {!shown.length && <span className="muted">No type matches “{find}”.</span>}
      </div>
      <div className="form">
        <label className="type-names">
          Names{' '}
          <input
            type="search"
            placeholder="Only components named… e.g. Case*, Billing (empty: all)"
            value={names}
            onChange={(e) => onNames(e.target.value)}
          />
        </label>
        {action}
      </div>
    </div>
  );
}
