import { useEffect, useMemo, useState } from 'react';
import {
  createCustomSetting,
  customSettings,
  deleteSettingRow,
  findUsers,
  orgLevelId,
  query,
  saveSettingRow,
  settingValue,
  settingValues,
  type CustomSettingInfo,
  type NewSettingField,
  type Row,
  type SettingKind,
  type SettingValues,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { Select } from '../components/Select';
import { storage, useStudio } from '../context';
import { Status } from '../statusLog';

type Mode = 'values' | 'new';
type Level = 'org' | 'profile' | 'user';
/** The row being edited (an Id) or added ('new'), with its values as typed. */
type Editing = { id: string | 'new'; values: Record<string, string> };

const apiName = (label: string): string =>
  `${label
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'X$1')}__c`;
const shown = (v: unknown): string =>
  v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? '✓' : '') : String(v);

/**
 * Develop › Custom settings: every custom setting of the org with its values — edit one, add one (a level of a hierarchy
 * setting, a row of a list setting), delete one — and a new custom setting with its fields. Each change asks first.
 */
export function CustomSettingsPage() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [mode, setMode] = useState<Mode>('values');
  const [settings, setSettings] = useState<CustomSettingInfo[] | null>(null);
  const [name, setName] = useState(() => storage.get('settings.custom', ''));
  const [values, setValues] = useState<SettingValues | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [level, setLevel] = useState<Level>('org');
  const [profiles, setProfiles] = useState<Row[]>([]);
  const [owner, setOwner] = useState('');
  const [userText, setUserText] = useState('');
  const [users, setUsers] = useState<Row[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setSettings(null);
    try {
      setSettings(await customSettings(client));
    } catch (e) {
      setSettings([]);
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    void load();
    setValues(null);
    setEditing(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  const open = async (n: string) => {
    setName(n);
    storage.set('settings.custom', n);
    setEditing(null);
    setValues(null);
    if (!n) return;
    setStatus(`Reading ${n}…`);
    try {
      setValues(await settingValues(client, n));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    if (settings && name && settings.some((s) => s.name === name) && !values) void open(name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);
  useEffect(() => {
    if (editing?.id === 'new' && level === 'profile' && !profiles.length)
      void query(client, 'SELECT Id, Name FROM Profile ORDER BY Name', { maxRows: 2000 }).then((r) =>
        setProfiles(r.rows)
      );
  }, [editing, level, profiles.length, client]);
  useEffect(() => {
    if (level !== 'user' || userText.trim().length < 2) return undefined;
    const t = setTimeout(
      () =>
        void findUsers(client, { names: [userText.trim()] })
          .then((l) => setUsers(l.slice(0, 20)))
          .catch(() => setUsers([])),
      300
    );
    return () => clearTimeout(t);
  }, [userText, level, client]);

  const info = settings?.find((s) => s.name === name);
  const hasOrgLevel = Boolean(values?.rows.some((r) => r.Level === 'Organization'));
  const startEdit = (row?: Row) => {
    setEditing({
      id: row ? String(row.Id) : 'new',
      values: Object.fromEntries((values?.fields ?? []).map((f) => [f.name, row ? String(row[f.name] ?? '') : ''])),
    });
    if (!row) {
      setLevel(values?.kind === 'Hierarchy' && !hasOrgLevel ? 'org' : values?.kind === 'Hierarchy' ? 'profile' : 'org');
      setOwner('');
      if (values?.kind === 'List') setOwner('');
    }
  };

  const save = async () => {
    if (!editing || !values) return;
    const payload: Record<string, unknown> = {};
    for (const f of values.fields.filter((x) => x.updateable))
      payload[f.name] = settingValue(f.type, editing.values[f.name] ?? '');
    let where = '';
    if (editing.id === 'new') {
      if (values.kind === 'List') {
        if (!owner.trim()) return setStatus('⚠ Give the row a name.');
        payload.Name = owner.trim();
        where = `row ${owner.trim()}`;
      } else {
        const ownerId = level === 'org' ? await orgLevelId(client) : owner;
        if (!ownerId) return setStatus(`⚠ Choose the ${level}.`);
        payload.SetupOwnerId = ownerId;
        where = level === 'org' ? 'the organization level' : `the ${level} level`;
      }
    }
    if (
      !(await confirmChange(
        `${editing.id === 'new' ? `Add ${where} to` : 'Change a value of'} ${name} in ${org.label}.`
      ))
    )
      return;
    setBusy(true);
    try {
      await saveSettingRow(client, name, payload, editing.id === 'new' ? undefined : editing.id);
      logActivity('custom-setting-save', { setting: name, row: editing.id });
      setStatus(`✓ Saved in ${name}.`);
      setEditing(null);
      setValues(await settingValues(client, name));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (row: Row) => {
    const what = String(row.Level ?? row.Name ?? row.Id);
    if (!(await confirmChange(`Delete ${what} of ${name} in ${org.label}.`))) return;
    try {
      await deleteSettingRow(client, name, String(row.Id));
      logActivity('custom-setting-delete', { setting: name, row: what });
      setStatus(`✓ Deleted ${what}.`);
      setValues(await settingValues(client, name));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const columns = useMemo(
    () => (values ? [values.kind === 'Hierarchy' ? 'Level' : 'Name', ...values.fields.map((f) => f.name)] : []),
    [values]
  );

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Custom settings</h2>
        <span className="muted">Their values in {org.label} — edit, add, delete; or a new custom setting</span>
      </div>
      <div className="form">
        <div className="segmented" role="group" aria-label="Custom settings">
          <button className={mode === 'values' ? 'active' : ''} onClick={() => setMode('values')}>
            Values
          </button>
          <button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>
            + New custom setting
          </button>
        </div>
      </div>
      {status && <Status text={status} block />}

      {mode === 'values' && (
        <>
          <div className="form">
            {settings === null ? (
              <span className="muted">Reading the custom settings…</span>
            ) : settings.length === 0 ? (
              <span className="muted">This org has no custom settings: make one with + New custom setting.</span>
            ) : (
              <label>
                Custom setting
                <Select value={name} onChange={(e) => void open(e.target.value)}>
                  <option value="">Choose one ({settings.length})…</option>
                  {settings.map((s) => (
                    <option key={s.name} value={s.name}>
                      {s.label} — {s.name} · {s.kind}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>
          {values && info && (
            <div className="card section">
              <div className="form">
                <b>{info.label}</b>
                <span className="pill">{values.kind}</span>
                <span className="muted small">
                  {values.kind === 'Hierarchy'
                    ? 'A value per level: the organization default, then a profile, then a user (the closest one wins).'
                    : 'Rows by name, the same for everyone.'}
                </span>
                <span className="grow" />
                <button className="primary" onClick={() => startEdit()}>
                  + Add {values.kind === 'Hierarchy' ? 'a level' : 'a row'}
                </button>
              </div>
              {values.rows.length ? (
                <DataTable
                  name={`custom-setting-${name}`}
                  columns={[...columns, 'actions']}
                  rows={values.rows.map((r) => ({
                    ...Object.fromEntries(columns.map((c) => [c, shown(r[c])])),
                    Id: String(r.Id),
                    actions: '',
                  }))}
                  renderCell={(c, row) => {
                    if (c !== 'actions') return undefined;
                    const original = values.rows.find((r) => String(r.Id) === String(row.Id));
                    return original ? (
                      <span className="row-actions">
                        <button className="link" onClick={() => startEdit(original)}>
                          Edit
                        </button>
                        <button className="link danger" onClick={() => void remove(original)}>
                          Delete
                        </button>
                      </span>
                    ) : undefined;
                  }}
                />
              ) : (
                <p className="muted">No values yet.</p>
              )}
              {editing && (
                <div className="setting-edit">
                  <h4>{editing.id === 'new' ? `New ${values.kind === 'Hierarchy' ? 'level' : 'row'}` : 'Edit'}</h4>
                  {editing.id === 'new' && values.kind === 'List' && (
                    <div className="form">
                      <label>
                        Name
                        <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="e.g. Default" />
                      </label>
                    </div>
                  )}
                  {editing.id === 'new' && values.kind === 'Hierarchy' && (
                    <div className="form">
                      <div className="segmented" role="group" aria-label="Level">
                        {(
                          [
                            ['org', 'Organization'],
                            ['profile', 'A profile'],
                            ['user', 'A user'],
                          ] as Array<[Level, string]>
                        )
                          .filter(([l]) => l !== 'org' || !hasOrgLevel)
                          .map(([l, label]) => (
                            <button
                              key={l}
                              className={level === l ? 'active' : ''}
                              onClick={() => {
                                setLevel(l);
                                setOwner('');
                              }}
                            >
                              {label}
                            </button>
                          ))}
                      </div>
                      {level === 'profile' && (
                        <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
                          <option value="">Choose the profile…</option>
                          {profiles.map((p) => (
                            <option key={String(p.Id)} value={String(p.Id)}>
                              {String(p.Name)}
                            </option>
                          ))}
                        </Select>
                      )}
                      {level === 'user' && (
                        <>
                          <input
                            placeholder="User: name"
                            value={userText}
                            onChange={(e) => setUserText(e.target.value)}
                          />
                          {users.length > 0 && (
                            <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
                              <option value="">{users.length} user(s)…</option>
                              {users.map((u) => (
                                <option key={String(u.Id)} value={String(u.Id)}>
                                  {String(u.Name)} — {String(u.Username)}
                                </option>
                              ))}
                            </Select>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  <div className="setting-fields">
                    {values.fields.map((f) => (
                      <label key={f.name}>
                        <span>
                          {f.label} <span className="muted small mono">{f.name}</span>
                        </span>
                        {f.type === 'boolean' ? (
                          <input
                            type="checkbox"
                            disabled={!f.updateable}
                            checked={settingValue('boolean', editing.values[f.name] ?? '') === true}
                            onChange={(e) =>
                              setEditing({
                                ...editing,
                                values: { ...editing.values, [f.name]: String(e.target.checked) },
                              })
                            }
                          />
                        ) : (
                          <input
                            disabled={!f.updateable}
                            value={editing.values[f.name] ?? ''}
                            onChange={(e) =>
                              setEditing({ ...editing, values: { ...editing.values, [f.name]: e.target.value } })
                            }
                          />
                        )}
                      </label>
                    ))}
                  </div>
                  <div className="form">
                    <button className="primary" disabled={busy} onClick={() => void save()}>
                      Save…
                    </button>
                    <button onClick={() => setEditing(null)}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {mode === 'new' && (
        <NewCustomSetting
          onCreated={(n) =>
            void load().then(() => {
              setMode('values');
              void open(n);
            })
          }
        />
      )}
    </div>
  );
}

/** A new custom setting: its label and API name, kind, visibility and fields, deployed after the org name is typed. */
function NewCustomSetting({ onCreated }: { onCreated: (name: string) => void }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<SettingKind>('Hierarchy');
  const [visibility, setVisibility] = useState<'Public' | 'Protected'>('Public');
  const [description, setDescription] = useState('');
  const [fields, setFields] = useState<NewSettingField[]>([{ name: '', label: '', type: 'Text' }]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const field = (i: number, change: Partial<NewSettingField>) =>
    setFields(fields.map((f, n) => (n === i ? { ...f, ...change } : f)));

  const create = async () => {
    const api = name || apiName(label);
    const list = fields.filter((f) => f.label.trim()).map((f) => ({ ...f, name: f.name || apiName(f.label) }));
    if (!(await confirmChange(`Create the custom setting ${api} with ${list.length} field(s) in ${org.label}.`)))
      return;
    setBusy(true);
    setStatus('Deploying…');
    try {
      await createCustomSetting(client, { name: api, label, kind, visibility, description, fields: list });
      logActivity('custom-setting-create', { setting: api, fields: list.length });
      setStatus(`✓ ${api} created.`);
      onCreated(api);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card section new-setting">
      <div className="form">
        <label>
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Billing Settings" />
        </label>
        <label>
          API name
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Made from the label" />
          {!name && label && <span className="muted small api-hint">{apiName(label)}</span>}
        </label>
        <label>
          Kind
          <Select value={kind} onChange={(e) => setKind(e.target.value as SettingKind)}>
            <option value="Hierarchy">Hierarchy (org, profile, user)</option>
            <option value="List">List (rows by name)</option>
          </Select>
        </label>
        <label>
          Visibility
          <Select value={visibility} onChange={(e) => setVisibility(e.target.value as 'Public' | 'Protected')}>
            <option value="Public">Public</option>
            <option value="Protected">Protected</option>
          </Select>
        </label>
      </div>
      <div className="form">
        <label className="grow">
          Description (optional)
          <input value={description} onChange={(e) => setDescription(e.target.value)} />
        </label>
      </div>
      <h4>Fields</h4>
      {fields.map((f, i) => (
        <div key={i} className="form">
          <input
            placeholder="Label, e.g. Endpoint"
            value={f.label}
            onChange={(e) => field(i, { label: e.target.value })}
          />
          <span className="api-field">
            <input
              placeholder="API name (from the label)"
              value={f.name}
              onChange={(e) => field(i, { name: e.target.value })}
            />
            {!f.name && f.label && <span className="muted small api-hint">{apiName(f.label)}</span>}
          </span>
          <Select value={f.type} onChange={(e) => field(i, { type: e.target.value as NewSettingField['type'] })}>
            {(['Text', 'Number', 'Checkbox', 'Url', 'Email'] as const).map((t) => (
              <option key={t}>{t}</option>
            ))}
          </Select>
          <button className="link danger" onClick={() => setFields(fields.filter((_, n) => n !== i))}>
            Remove
          </button>
        </div>
      ))}
      <div className="form">
        <button onClick={() => setFields([...fields, { name: '', label: '', type: 'Text' }])}>+ Field</button>
        <span className="grow" />
        <button className="primary" disabled={busy || !label.trim()} onClick={() => void create()}>
          Create…
        </button>
        <Status text={status} />
      </div>
    </div>
  );
}
