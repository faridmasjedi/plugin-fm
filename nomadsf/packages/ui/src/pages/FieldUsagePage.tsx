import { useEffect, useRef, useState } from 'react';
import {
  describeGlobal,
  fieldDependencies,
  fillRates,
  objectFields,
  type FieldDependency,
  type FieldInfo,
  type SObjectSummary,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { storage, useStudio } from '../context';

/** How full each field is, and what references a custom field, before changing or deleting it. */
export function FieldUsagePage() {
  const { client } = useStudio();
  const [objects, setObjects] = useState<SObjectSummary[]>([]);
  const [sobject, setSobject] = useState<string>(() => storage.get('fields.object', 'Account'));
  // What is typed in the box; an object loads only once this is a real object name
  const [typed, setTyped] = useState(sobject);
  const [fields, setFields] = useState<FieldInfo[] | null>(null);
  const [total, setTotal] = useState(0);
  const [onlyCustom, setOnlyCustom] = useState(true);
  const [counting, setCounting] = useState(false);
  const [field, setField] = useState<FieldInfo | null>(null);
  const [deps, setDeps] = useState<FieldDependency[] | null>(null);
  const [status, setStatus] = useState('');
  const abort = useRef<AbortController>(undefined);

  useEffect(() => {
    describeGlobal(client)
      .then(setObjects)
      .catch(() => undefined);
  }, [client]);

  useEffect(() => {
    abort.current?.abort();
    setFields(null);
    setField(null);
    setDeps(null);
    storage.set('fields.object', sobject);
    objectFields(client, sobject)
      .then((r) => {
        setFields(r.fields);
        setTotal(r.total);
        setStatus('');
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, sobject]);

  const shown = (fields ?? []).filter((f) => !onlyCustom || f.custom);

  const count = async () => {
    abort.current?.abort();
    abort.current = new AbortController();
    setCounting(true);
    await fillRates(
      client,
      sobject,
      shown,
      total,
      (updated) => setFields((list) => list?.map((f) => (f.name === updated.name ? updated : f)) ?? null),
      abort.current.signal
    );
    setCounting(false);
  };

  const openField = async (name: string) => {
    const chosen = fields?.find((f) => f.name === name) ?? null;
    setField(chosen);
    setDeps(null);
    if (!chosen?.custom) return;
    try {
      setDeps(await fieldDependencies(client, sobject, name));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Field usage</h2>
        <input
          list="field-usage-objects"
          value={typed}
          placeholder="Object, e.g. Account"
          onChange={(e) => {
            const value = e.target.value;
            setTyped(value);
            // Picking from the list (or typing a full name) opens it; partial text just filters the list
            const match = objects.find((o) => o.name.toLowerCase() === value.trim().toLowerCase());
            if (match && match.name !== sobject) setSobject(match.name);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const match = objects.find((o) => o.name.toLowerCase() === typed.trim().toLowerCase());
            if (match) setSobject(match.name);
            else setStatus(`❌ No object called "${typed.trim()}" in this org.`);
          }}
          onBlur={() => {
            if (!objects.some((o) => o.name.toLowerCase() === typed.trim().toLowerCase())) setTyped(sobject);
          }}
          style={{ minWidth: 240 }}
        />
        <datalist id="field-usage-objects">
          {objects.map((o) => (
            <option key={o.name} value={o.name}>
              {o.label}
            </option>
          ))}
        </datalist>
        <label className="check">
          <input type="checkbox" checked={onlyCustom} onChange={(e) => setOnlyCustom(e.target.checked)} /> Custom fields
          only
        </label>
        <span className="grow" />
        {counting ? (
          <button onClick={() => abort.current?.abort()}>Stop counting</button>
        ) : (
          <button className="primary" disabled={!fields || !total} onClick={() => void count()}>
            Count filled values ({shown.filter((f) => f.filterable).length} queries)
          </button>
        )}
      </div>
      {status && <p className="muted">{status}</p>}
      {fields && (
        <p className="muted">
          {total.toLocaleString()} {sobject} records · {fields.length} fields
        </p>
      )}
      <div className="split">
        <div className="card">
          {fields === null ? (
            <p className="muted">Loading…</p>
          ) : (
            <DataTable
              columns={['name', 'type', 'filled', 'percent']}
              rows={shown.map((f) => ({
                ...f,
                filled: f.filled ?? '',
                percent: f.percent === undefined ? '' : `${f.percent}%`,
              }))}
              rowKey="name"
              name={`${sobject}-field-usage`}
              onRowClick={(row) => void openField(String(row.name))}
              selectedKey={field?.name}
              note={<span>· click a custom field for what uses it</span>}
            />
          )}
        </div>
        <div className="card section">
          {!field ? (
            <p className="muted">Click a field to see where it is used.</p>
          ) : !field.custom ? (
            <p className="muted">Salesforce lists references for custom fields only.</p>
          ) : deps === null ? (
            <p className="muted">Finding references to {field.name}…</p>
          ) : (
            <>
              <h3>
                {field.name} <span className="muted">used by {deps.length} component(s)</span>
              </h3>
              {deps.length === 0 ? (
                <p className="muted">
                  Nothing references it (reports and some metadata types are not tracked by Salesforce; check them too).
                </p>
              ) : (
                <DataTable
                  columns={['type', 'name']}
                  rows={deps.map((d) => ({ ...d }))}
                  rowKey="id"
                  name={`${field.name}-references`}
                />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
