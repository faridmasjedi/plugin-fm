import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  coerceFieldValue,
  inspectRecord,
  loginAsPath,
  query,
  recordHistory,
  updateRecord,
  type HistoryEntry,
  type InspectedRecord,
  type RecordField,
} from '@nomadsf/core';
import { InspectContext, storage, useStudio } from '../context';
import { openInOrg } from '../host';
import { CopyId } from '../components/CopyId';
import { DataTable } from '../components/DataTable';
import { NewRecord } from '../components/NewRecord';
import { RecordPicker } from '../components/RecordPicker';
import { RecordRelations } from '../components/RecordRelations';

const display = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

type UserMatch = { id: string; name: string; username: string; active: boolean };

const soqlText = (s: string): string => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * What the search box holds: a record Id or URL as it is, a username, or a user's name
 * (several users with that name come back as a list to choose from).
 */
async function resolveInput(
  client: ReturnType<typeof useStudio>['client'],
  input: string
): Promise<string | UserMatch[]> {
  const text = input.trim();
  if (/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(text) || text.includes('/')) return text;
  const byUsername = /^[^\s@'\\]+@[^\s@'\\]+$/.test(text);
  const where = byUsername ? `Username = '${soqlText(text)}'` : `Name LIKE '%${soqlText(text)}%'`;
  const result = await query(
    client,
    `SELECT Id, Name, Username, IsActive FROM User WHERE ${where} ORDER BY IsActive DESC, Name LIMIT 20`
  );
  const users = result.rows.map((r) => ({
    id: String(r.Id),
    name: String(r.Name ?? ''),
    username: String(r.Username ?? ''),
    active: Boolean(r.IsActive),
  }));
  if (!users.length) throw new Error(byUsername ? `No user with the username ${text}.` : `No user named “${text}”.`);
  const exact = users.filter((u) => u.name.toLowerCase() === text.toLowerCase());
  if (users.length === 1) return users[0].id;
  if (exact.length === 1) return exact[0].id;
  return users;
}

/** Every field of one record, with inline edit (Salesforce Inspector's "Show all data"). */
/** `embedded`: inside another page (no own search bar). */
export function RecordPage({ initialId, embedded = false }: { initialId?: string; embedded?: boolean }) {
  const studio = useStudio();
  const { client, org, user } = studio;
  const [input, setInput] = useState(initialId ?? '');
  const [record, setRecord] = useState<InspectedRecord | null>(null);
  const [filter, setFilter] = useState('');
  const [onlyFilled, setOnlyFilled] = useState(false);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [view, setView] = useState<'fields' | 'history' | 'related'>('fields');
  const inspect = useContext(InspectContext);
  const [history, setHistory] = useState<{ object?: string; entries: HistoryEntry[] } | null>(null);
  // Another record (or the same one after a save): its history is read again
  useEffect(() => setHistory(null), [record]);
  const [recent, setRecent] = useState<Array<{ id: string; label: string }>>(() => storage.get('record.recent', []));
  const [choices, setChoices] = useState<UserMatch[]>([]);
  const [creating, setCreating] = useState(false);

  const open = useCallback(
    async (value: string) => {
      setStatus('Loading…');
      setEditing(false);
      setEdits({});
      setChoices([]);
      try {
        const target = await resolveInput(client, value);
        if (Array.isArray(target)) {
          setRecord(null);
          setChoices(target);
          setStatus(`${target.length} users match “${value.trim()}”: choose one.`);
          return;
        }
        const loaded = await inspectRecord(client, target);
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
      !(await studio.confirmChange(
        `Update ${changed.length} field(s) of ${record.sobject} ${record.id}: ${changed.join(', ')}`
      ))
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
    if (!(await studio.confirmRisky(`Log in as ${record.name ?? record.id}`))) return;
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
      const input = (
        <input
          className={changed.includes(f.name) ? 'changed' : ''}
          value={current}
          maxLength={f.length}
          onChange={(e) => setEdits({ ...edits, [f.name]: e.target.value })}
        />
      );
      // Lookups (ProfileId, UserRoleId, ManagerId…): find the record by name, its Id goes in
      if (f.referenceTo.length)
        return (
          <span className="lookup-edit">
            {input}
            <RecordPicker
              client={client}
              objects={f.referenceTo}
              onPick={(id) => setEdits({ ...edits, [f.name]: id })}
            />
          </span>
        );
      return input;
    }
    const text = display(f.value);
    if (f.referenceTo.length && text) {
      return (
        <span className="id-cell">
          <span className="id-text">{text}</span>
          <CopyId id={text} />
          <button
            className="link id-action"
            onClick={() => void open(text)}
            title={`Open ${f.referenceTo.join(' / ')}`}
          >
            →
          </button>
        </span>
      );
    }
    return <span className="mono">{text.length > 500 ? `${text.slice(0, 500)}…` : text}</span>;
  };

  return (
    <div className={embedded ? 'record-embedded' : 'page'}>
      {!embedded && (
        <div className="toolbar">
          <h2>Record</h2>
          <input
            style={{ minWidth: 360 }}
            placeholder="Record Id, record URL, username or a user's name"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void open(input)}
          />
          <button className="primary" disabled={!input.trim()} onClick={() => void open(input)}>
            Show all data
          </button>
          {user && (
            <button title="Your own user in this org" onClick={() => void open(user.userId)}>
              Me
            </button>
          )}
          <button title="Create a record of any object" onClick={() => setCreating(true)}>
            New…
          </button>
          {recent.length > 0 && (
            <select className="menu-select" value="" onChange={(e) => e.target.value && void open(e.target.value)}>
              <option value="">Recent…</option>
              {recent.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {creating && !embedded && (
        <NewRecord
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void open(id).then(() => setStatus('✓ Created.'));
          }}
        />
      )}
      {status && <p className="muted">{status}</p>}
      {choices.length > 0 && (
        <div className="card section">
          <DataTable
            name="users"
            columns={['Name', 'Username', 'Active', 'Id']}
            rows={choices.map((u) => ({ Name: u.name, Username: u.username, Active: u.active ? '✓' : '', Id: u.id }))}
            onRowClick={(row) => void open(String(row.Id))}
          />
        </div>
      )}
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
          <div className="tabs">
            <button className={`tab ${view === 'fields' ? 'active' : ''}`} onClick={() => setView('fields')}>
              Fields
            </button>
            <button className={`tab ${view === 'history' ? 'active' : ''}`} onClick={() => setView('history')}>
              History
            </button>
            <button className={`tab ${view === 'related' ? 'active' : ''}`} onClick={() => setView('related')}>
              Related
            </button>
          </div>
          {view === 'related' && (
            <RecordRelations
              sobject={record.sobject}
              id={record.id}
              name={record.name ?? ''}
              // Inside Users: a related record opens in the Record tool
              onOpen={(id) => (embedded && inspect ? inspect(id) : void open(id))}
            />
          )}
          {view === 'history' && (
            <RecordHistory
              sobject={record.sobject}
              id={record.id}
              fields={record.fields}
              state={history}
              onLoad={setHistory}
            />
          )}
          {view === 'fields' && (
            <>
              <div className="form">
                <input
                  placeholder="Filter fields and values"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
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
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Field changes of the record (from its history object, when field history tracking is on). */
function RecordHistory({
  sobject,
  id,
  fields,
  state,
  onLoad,
}: {
  sobject: string;
  id: string;
  fields: Array<{ name: string; label: string }>;
  state: { object?: string; entries: HistoryEntry[] } | null;
  onLoad: (h: { object?: string; entries: HistoryEntry[] }) => void;
}) {
  const { client } = useStudio();
  const [error, setError] = useState('');
  useEffect(() => {
    if (state) return;
    recordHistory(client, sobject, id)
      .then(onLoad)
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, sobject, id, state]);
  if (error) return <p className="bad">❌ {error}</p>;
  if (!state) return <p className="muted">Reading history…</p>;
  if (!state.object)
    return (
      <p className="muted">
        {sobject} keeps no field history in this org. Turn on <b>Track field history</b> for it in Setup (Object Manager
        › {sobject} › Fields &amp; Relationships › Set History Tracking).
      </p>
    );
  const labelOf = (f: string): string =>
    f === 'created' ? 'Created' : fields.find((x) => x.name.toLowerCase() === f.toLowerCase())?.label ?? f;
  return state.entries.length === 0 ? (
    <p className="muted">No tracked changes yet ({state.object}).</p>
  ) : (
    <DataTable
      columns={['when', 'field', 'from', 'to', 'by']}
      rows={state.entries.map((e, i) => ({ ...e, field: labelOf(e.field), key: i }))}
      rowKey="key"
      name={`${sobject}-${id}-history`}
      note={<span>· tracked fields only, newest first ({state.object})</span>}
    />
  );
}
