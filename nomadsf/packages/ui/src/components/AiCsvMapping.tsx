import { useContext, useState } from 'react';
import { parseCsvMapping, type FieldRule } from '@nomadsf/core';
import { StudioContext } from '../context';
import { useProject } from '../project';
import { askAi } from './AiHelp';
import { Status } from '../statusLog';

/**
 * "✦ Map the columns": the AI matches a file's columns to the object's fields (by meaning: labels, abbreviations,
 * other languages); you read the mapping, change any line, then rename the columns — nothing is sent until you run.
 */
export function AiCsvMapping({
  object,
  operation,
  rules,
  columns,
  sample,
  onApply,
}: {
  object: string;
  operation: string;
  rules: FieldRule[];
  columns: string[];
  /** A few rows, for the AI to see the values. */
  sample: Array<Record<string, string>>;
  /** Renames the columns (old → field); columns left out stay as they are. */
  onApply: (renames: Record<string, string>) => void;
}) {
  const hostKind = useContext(StudioContext)?.hostKind ?? 'app';
  const { aiReady } = useProject();
  const [mapping, setMapping] = useState<Record<string, string> | null>(null);
  const [note, setNote] = useState('');
  const [status, setStatus] = useState('');
  if (!aiReady) return null;
  const fieldNames = rules.map((r) => r.name);

  const ask = async (): Promise<void> => {
    setStatus('Asking the AI…');
    try {
      const answer = await askAi(hostKind, {
        task: 'map-csv',
        object,
        operation,
        fields: rules.map((r) => `${r.name} (${r.label}, ${r.type})`).join('; '),
        columns: columns.join(', '),
        sample: sample
          .slice(0, 3)
          .map((row) => columns.map((c) => `${c}=${String(row[c] ?? '').slice(0, 60)}`).join(' | '))
          .join('\n'),
      });
      const parsed = parseCsvMapping(answer.text, columns, fieldNames);
      setMapping(parsed.mapping);
      setNote(parsed.note);
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const changes = mapping ? Object.entries(mapping).filter(([column, field]) => field && field !== column) : [];
  return (
    <div className="ai-mapping">
      <div className="form">
        <button onClick={() => void ask()} title="The AI matches the file's columns to the object's fields">
          ✦ Map the columns to {object}’s fields
        </button>
        {status && <Status text={status} />}
      </div>
      {mapping && (
        <div className="card section">
          {note && <p className="muted">{note}</p>}
          <table className="table">
            <thead>
              <tr>
                <th>Column in the file</th>
                <th>Field</th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => (
                <tr key={column}>
                  <td className="mono">{column}</td>
                  <td>
                    <select
                      value={mapping[column] ?? ''}
                      onChange={(e) => setMapping({ ...mapping, [column]: e.target.value })}
                    >
                      <option value="">— leave as it is —</option>
                      {rules.map((r) => (
                        <option key={r.name} value={r.name}>
                          {r.label} ({r.name})
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="form">
            <button
              className="primary"
              disabled={!changes.length}
              onClick={() => {
                onApply(Object.fromEntries(changes));
                setMapping(null);
              }}
            >
              Rename {changes.length} column(s)
            </button>
            <button onClick={() => setMapping(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
