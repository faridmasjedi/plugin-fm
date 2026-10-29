import { useEffect, useMemo, useState } from 'react';
import { coerceFieldValue, createRecord, describeGlobal } from '@nomadsf/core';
import { useStudio } from '../context';
import { ObjectOptions } from './ObjectOptions';
import { RecordPicker } from './RecordPicker';
import { Status } from '../statusLog';

type CreateField = {
  name: string;
  label: string;
  type: string;
  required: boolean;
  referenceTo: string[];
  picklist: Array<{ value: string; label: string; isDefault: boolean }>;
  length?: number;
};

/**
 * A new record of any object: its createable fields (required ones first), picklists as lists,
 * lookups found by name; created after the org's name is typed, then opened.
 */
export function NewRecord({ onCreated, onClose }: { onCreated: (id: string) => void; onClose: () => void }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [objects, setObjects] = useState<Array<{ name: string; label: string }>>([]);
  const [typed, setTyped] = useState('');
  const [sobject, setSobject] = useState('');
  const [fields, setFields] = useState<CreateField[] | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    describeGlobal(client)
      .then((list) => setObjects(list.map((o) => ({ name: o.name, label: o.label }))))
      .catch(() => undefined);
  }, [client]);

  useEffect(() => {
    setFields(null);
    setValues({});
    if (!sobject) return;
    client
      .rest<{
        createable: boolean;
        fields: Array<{
          name: string;
          label: string;
          type: string;
          createable: boolean;
          nillable: boolean;
          defaultedOnCreate: boolean;
          referenceTo: string[];
          length: number;
          picklistValues: Array<{ value: string; label: string; active: boolean; defaultValue: boolean }>;
        }>;
      }>('GET', `/sobjects/${sobject}/describe`)
      .then((d) => {
        if (!d.createable) {
          setStatus(`❌ Your user cannot create ${sobject} records.`);
          return;
        }
        setStatus('');
        const list = d.fields
          .filter((f) => f.createable)
          .map((f) => ({
            name: f.name,
            label: f.label,
            type: f.type,
            required: !f.nillable && !f.defaultedOnCreate && f.type !== 'boolean',
            referenceTo: f.referenceTo ?? [],
            picklist: (f.picklistValues ?? [])
              .filter((p) => p.active)
              .map((p) => ({ value: p.value, label: p.label, isDefault: p.defaultValue })),
            length: f.length || undefined,
          }))
          .sort((a, b) => Number(b.required) - Number(a.required) || a.label.localeCompare(b.label));
        setFields(list);
        // Picklist defaults, as Salesforce's own New page fills them in
        setValues(
          Object.fromEntries(
            list.flatMap((f) => {
              const d0 = f.picklist.find((p) => p.isDefault);
              return d0 ? [[f.name, d0.value]] : [];
            })
          )
        );
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, sobject]);

  const needle = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (fields ?? []).filter(
        (f) =>
          (showAll || f.required || values[f.name]) &&
          (!needle || `${f.label} ${f.name}`.toLowerCase().includes(needle))
      ),
    [fields, showAll, values, needle]
  );
  const missing = (fields ?? []).filter((f) => f.required && !values[f.name]?.trim());

  const create = async () => {
    if (!fields) return;
    let record: Record<string, unknown>;
    try {
      record = Object.fromEntries(
        Object.entries(values)
          .filter(([, v]) => v.trim() !== '')
          .map(([name, v]) => {
            const f = fields.find((x) => x.name === name)!;
            if (f.type === 'datetime') return [name, new Date(v).toISOString()];
            return [name, coerceFieldValue(f, v)];
          })
      );
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
      return;
    }
    const list = Object.entries(record)
      .slice(0, 12)
      .map(([k, v]) => `• ${k}: ${String(v)}`)
      .join('\n');
    if (!(await confirmChange(`Create a ${sobject} record in ${org.label}:\n${list}`))) return;
    setBusy(true);
    setStatus('Creating…');
    try {
      const id = await createRecord(client, sobject, record);
      logActivity('record create', { sobject, id, fields: Object.keys(record) });
      onCreated(id);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const input = (f: CreateField) => {
    const value = values[f.name] ?? '';
    const set = (v: string) => setValues({ ...values, [f.name]: v });
    if (f.type === 'boolean')
      return <input type="checkbox" checked={value === 'true'} onChange={(e) => set(String(e.target.checked))} />;
    if ((f.type === 'picklist' || f.type === 'multipicklist') && f.picklist.length)
      return (
        <select value={value} onChange={(e) => set(e.target.value)}>
          <option value="">—</option>
          {f.picklist.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      );
    if (f.referenceTo.length)
      return (
        <span className="lookup-edit">
          <input className="mono" placeholder="Id" value={value} onChange={(e) => set(e.target.value)} />
          <RecordPicker client={client} objects={f.referenceTo} onPick={set} />
        </span>
      );
    if (f.type === 'textarea')
      return <textarea rows={2} value={value} maxLength={f.length} onChange={(e) => set(e.target.value)} />;
    const type = f.type === 'date' ? 'date' : f.type === 'datetime' ? 'datetime-local' : 'text';
    return <input type={type} value={value} maxLength={f.length} onChange={(e) => set(e.target.value)} />;
  };

  return (
    <div className="card section">
      <div className="form">
        <h3 style={{ margin: 0 }}>New record</h3>
        <input
          list="new-record-objects"
          placeholder="Object, e.g. Case"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value);
            const match = objects.find((o) => o.name.toLowerCase() === e.target.value.trim().toLowerCase());
            if (match) setSobject(match.name);
          }}
        />
        <ObjectOptions id="new-record-objects" objects={objects} typed={typed} />
        {fields && (
          <>
            <input placeholder="Filter fields" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <label className="check">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> All{' '}
              {fields.length} fields
            </label>
          </>
        )}
        <span className="grow" />
        <button onClick={onClose}>Close</button>
      </div>
      {status && <Status text={status} block />}
      {sobject && !fields && !status && <p className="muted">Reading {sobject}…</p>}
      {fields && (
        <>
          <table className="edit-table">
            <tbody>
              {shown.map((f) => (
                <tr key={f.name}>
                  <td>
                    {f.label}
                    {f.required && <span className="bad"> *</span>}
                  </td>
                  <td className="muted mono">{f.name}</td>
                  <td>{input(f)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!showAll && (
            <p className="muted">Required fields (*) and the ones you filled; tick “All fields” for the rest.</p>
          )}
          <div className="form">
            <button className="primary" disabled={busy || missing.length > 0} onClick={() => void create()}>
              Create {sobject}…
            </button>
            {missing.length > 0 && (
              <span className="muted">Still needed: {missing.map((f) => f.label).join(', ')}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}
