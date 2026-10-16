import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  coerceFieldValue,
  inspectRecord,
  loginAsPath,
  query,
  updateRecord,
  type InspectedRecord,
  type RecordField,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { openInOrg } from '../host';

const display = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

/** Finds a user's Id from a username (the inspector also accepts usernames). */
async function resolveInput(client: ReturnType<typeof useStudio>['client'], input: string): Promise<string> {
  const text = input.trim();
  if (!/^[^\s@'\\]+@[^\s@'\\]+$/.test(text)) return text;
  const result = await query(client, `SELECT Id FROM User WHERE Username = '${text}' LIMIT 1`);
  const id = result.rows[0]?.Id;
  if (!id) throw new Error(`No user with the username ${text}.`);
  return String(id);
}

/** Every field of one record, with inline edit (Salesforce Inspector's "Show all data"). */
export function RecordPage({ initialId }: { initialId?: string }) {
  const studio = useStudio();
  const { client, org, user } = studio;
  const [input, setInput] = useState(initialId ?? '');
  const [record, setRecord] = useState<InspectedRecord | null>(null);
  const [filter, setFilter] = useState('');
  const [onlyFilled, setOnlyFilled] = useState(false);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [recent, setRecent] = useState<Array<{ id: string; label: string }>>(() => storage.get('record.recent', []));

  const open = useCallback(
    async (value: string) => {
      setStatus('Loading…');
      setEditing(false);
      setEdits({});
      try {
        const loaded = await inspectRecord(client, await resolveInput(client, value));
        setRecord(loaded);
        setInput(loaded.id);
        setStatus('');
        const label = `${loaded.label}: ${loaded.name || loaded.id}`;
        setRecent((list) => {
          const next = [{ id: loaded.id, label }, ...list.filter((r) => r.id !== loaded.id)].slice(0, 15);
          storage.set('record.recent', next);
          return next;
        });
      } catch (e) {
        setRecord(null);
        setStatus(`❌ ${(e as Error).message}`);
      }
    },
    [client]
  );

  useEffect(() => {
    if (initialId) void open(initialId);
  }, [initialId, open]);

  const fields = useMemo(() => {
    const needle = filter.toLowerCase();
    return (record?.fields ?? []).filter(
      (f) =>
        (!onlyFilled || display(f.value) !== '') &&
        (!needle || `${f.name} ${f.label} ${display(f.value)}`.toLowerCase().includes(needle))
    );
  }, [record, filter, onlyFilled]);

  const changed = Object.keys(edits).filter((name) => {
    const field = record?.fields.find((f) => f.name === name);
    return field && edits[name] !== display(field.value);
  });

  const save = async () => {
    if (!record) return;
    let changes: Record<string, unknown>;
    try {
      changes = Object.fromEntries(
        changed.map((name) => [name, coerceFieldValue(record.fields.find((f) => f.name === name)!, edits[name])])
      );
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
      return;
    }
    if (
      !studio.confirmChange(
        `Update ${changed.length} field(s) of ${record.sobject} ${record.id}: ${changed.join(', ')}`
      )
    )
      return;
    setStatus('Saving…');
    try {
      await updateRecord(client, record.sobject, record.id, changes);
      studio.logActivity('record update', { sobject: record.sobject, id: record.id, fields: changed });
      await open(record.id);
      setStatus(`✓ Saved ${changed.length} field(s).`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const loginAs = async () => {
    if (!record || !user) return;
    if (!studio.confirmRisky(`Log in as ${record.name ?? record.id}`)) return;
    try {
      await openInOrg(studio.hostKind, org, loginAsPath(user.organizationId, record.id));
      studio.logActivity('login as', { user: record.name, id: record.id });
      setStatus('Opened in the browser. Needs "Login as any user" (or the user granting access).');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const valueCell = (f: RecordField) => {
    const current = edits[f.name] ?? display(f.value);
    if (editing && f.updateable && !f.calculated) {
      if (f.type === 'picklist' && f.picklistValues.length) {
        return (
          <select value={current} onChange={(e) => setEdits({ ...edits, [f.name]: e.target.value })}>
            <option value="">—</option>
            {f.picklistValues.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        );
      }
      if (f.type === 'boolean') {
        return (
          <input
            type="checkbox"
            checked={current === 'true'}
            onChange={(e) => setEdits({ ...edits, [f.name]: String(e.target.checked) })}
          />
        );
      }
      return (
        <input
          className={changed.includes(f.name) ? 'changed' : ''}
          value={current}
          maxLength={f.length}
          onChange={(e) => setEdits({ ...edits, [f.name]: e.target.value })}
        />
      );
    }
    const text = display(f.value);
    if (f.referenceTo.length && text) {
      return (
        <button className="link" onClick={() => void open(text)} title={`Open ${f.referenceTo.join(' / ')}`}>
          {text}
        </button>
      );
    }
    return <span className="mono">{text.length > 500 ? `${text.slice(0, 500)}…` : text}</span>;
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Record</h2>
        <input
          style={{ minWidth: 360 }}
          placeholder="Record Id, record URL or username"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void open(input)}
        />
        <button className="primary" disabled={!input.trim()} onClick={() => void open(input)}>
          Show all data
        </button>
        {recent.length > 0 && (
          <select value="" onChange={(e) => e.target.value && void open(e.target.value)}>
            <option value="">Recent…</option>
            {recent.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        )}
      </div>
      {status && <p className="muted">{status}</p>}
      {record && (
        <div className="card section">
          <div className="toolbar">
            <h3 style={{ margin: 0 }}>
              {record.label} · {record.name || record.id} <span className="muted mono">{record.id}</span>
            </h3>
            <span className="grow" />
            <a href={`${org.instanceUrl ?? ''}/${record.id}`} target="_blank" rel="noreferrer">
              Open in Salesforce ↗
            </a>
            {record.sobject === 'User' && <button onClick={() => void loginAs()}>Log in as this user</button>}
            {editing ? (
              <>
                <button
                  onClick={() => {
                    setEditing(false);
                    setEdits({});
                  }}
                >
                  Cancel
                </button>
                <button className="primary" disabled={changed.length === 0} onClick={() => void save()}>
                  Save {changed.length || ''}
                </button>
              </>
            ) : (
              <button onClick={() => setEditing(true)}>Edit</button>
            )}
          </div>
          <div className="form">
            <input placeholder="Filter fields and values" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={onlyFilled} onChange={(e) => setOnlyFilled(e.target.checked)} /> Only
              fields with a value
            </label>
            <span className="muted">
              {fields.length} of {record.fields.length} fields
            </span>
          </div>
          <table className="record">
            <thead>
              <tr>
                <th>Label</th>
                <th>API name</th>
                <th>Type</th>
                <th>Value</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => (
                <tr key={f.name}>
                  <td>{f.label}</td>
                  <td className="mono">{f.name}</td>
                  <td className="muted">
                    {f.type}
                    {f.referenceTo.length ? ` → ${f.referenceTo.join(', ')}` : ''}
                    {f.calculated ? ' · formula' : ''}
                  </td>
                  <td>{valueCell(f)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
