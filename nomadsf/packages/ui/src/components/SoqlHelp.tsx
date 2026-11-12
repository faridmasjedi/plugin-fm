import { useState } from 'react';
import { SOQL_EXAMPLES, SOQL_HELP, type SoqlPiece } from '@nomadsf/core';
import { storage } from '../context';

/**
 * Query: the pieces of SOQL people forget, to click — date literals (LAST_N_DAYS:n, N_DAYS_AGO:n, THIS_QUARTER…),
 * filters (IN, INCLUDES, semi-joins), grouping and counting, sorting — each explained on hover, put in at the cursor;
 * and whole examples (duplicates, records per month…) that replace the query. Closed until opened.
 */
export function SoqlHelp({
  onInsert,
  onExample,
}: {
  /** Put a piece in at the cursor (a snippet: ${1:30} is selected to type over). */
  onInsert: (snippet: string) => void;
  onExample: (soql: string) => void;
}) {
  const [tab, setTab] = useState<string>(() => storage.get('query.help', ''));
  const pick = (id: string) => {
    const next = tab === id ? '' : id;
    setTab(next);
    storage.set('query.help', next);
  };
  const group = SOQL_HELP.find((g) => g.id === tab);
  const chip = (p: SoqlPiece, onClick: () => void) => (
    <button key={p.label} className="soql-chip" title={p.hint} onClick={onClick}>
      {p.label}
    </button>
  );
  return (
    <div className="soql-help">
      <div className="soql-help-tabs">
        <span className="muted small">SOQL help:</span>
        {[...SOQL_HELP.map((g) => [g.id, g.title]), ['examples', 'Examples']].map(([id, title]) => (
          <button key={id} className={`link ${tab === id ? 'active' : ''}`} onClick={() => pick(id)}>
            {title}
          </button>
        ))}
        {tab && (
          <span className="muted small">
            {tab === 'examples'
              ? 'click one to replace the query (⌘Z / Ctrl+Z brings yours back)'
              : 'click to put it in at the cursor · hover for what it means'}
          </span>
        )}
      </div>
      {group && <div className="soql-chips">{group.pieces.map((p) => chip(p, () => onInsert(p.insert)))}</div>}
      {tab === 'examples' && (
        <div className="soql-chips">{SOQL_EXAMPLES.map((p) => chip(p, () => onExample(p.insert)))}</div>
      )}
    </div>
  );
}
