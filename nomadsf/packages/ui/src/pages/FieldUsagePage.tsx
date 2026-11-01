import { useEffect, useRef, useState } from 'react';
import {
  describeGlobal,
  fieldAccess,
  fieldDependencies,
  fillRates,
  objectFields,
  type FieldAccess,
  type FieldDependency,
  type FieldInfo,
  type SObjectSummary,
} from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { ObjectOptions } from '../components/ObjectOptions';
import { Status } from '../statusLog';

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
  const [access, setAccess] = useState<FieldAccess[] | null>(null);
  const [tab, setTab] = useState<'usage' | 'access'>(() => storage.get('fields.tab', 'usage'));
  const [countingOne, setCountingOne] = useState(false);
  // Access tab: which level (tile) and which kind of holder to list
  const [level, setLevel] = useState<FieldAccess['access'] | 'all'>('all');
  const [kind, setKind] = useState<FieldAccess['kind'] | 'all'>('all');
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
    setAccess(null);
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

  const openField = (name: string) => {
    setField(fields?.find((f) => f.name === name) ?? null);
    setDeps(null);
    setAccess(null);
  };

  // What the chosen field's tab needs, loaded when the field or tab changes
  useEffect(() => {
    if (!field) return;
    let canceled = false;
    if (tab === 'usage' && field.custom && deps === null) {
      fieldDependencies(client, sobject, field.name)
        .then((d) => !canceled && setDeps(d))
        .catch((e: Error) => !canceled && setStatus(`❌ ${e.message}`));
    }
    if (tab === 'access' && access === null && field.permissionable !== false) {
      fieldAccess(client, sobject, field.name)
        .then((a) => !canceled && setAccess(a))
        .catch((e: Error) => !canceled && setStatus(`❌ ${e.message}`));
    }
    return () => {
      canceled = true;
    };
    // deps / access are results, not triggers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, sobject, field, tab]);

  const countOne = async () => {
    if (!field) return;
    setCountingOne(true);
    await fillRates(client, sobject, [field], total, (updated) => {
      setFields((list) => list?.map((f) => (f.name === updated.name ? updated : f)) ?? null);
      setField(updated);
    });
    setCountingOne(false);
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
        <ObjectOptions id="field-usage-objects" objects={objects} typed={typed} />
        <label className="check">
          <input type="checkbox" checked={onlyCustom} onChange={(e) => setOnlyCustom(e.target.checked)} /> Custom fields
          only
        </label>
        <span className="grow" />
        {counting ? (
          <button onClick={() => abort.current?.abort()}>Stop counting</button>
        ) : (
          <button className="primary" disabled={!fields || !total} onClick={() => void count()}>
            Count all ({shown.filter((f) => f.filterable).length} queries)
          </button>
        )}
      </div>
      {status && <Status text={status} block />}
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
              note={<span>· click a field</span>}
            />
          )}
        </div>
        <div className="card section">
          {!field ? (
            <p className="muted">Click a field to see how full it is, where it is used and who can access it.</p>
          ) : (
            <>
              <h3>
                {field.label} <span className="muted mono">{field.name}</span>{' '}
                <span className="muted">· {field.type}</span>
              </h3>
              <div className="tabs">
                {(
                  [
                    ['usage', 'Usage'],
                    ['access', 'Access'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    className={`tab ${tab === id ? 'active' : ''}`}
                    onClick={() => {
                      setTab(id);
                      storage.set('fields.tab', id);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {tab === 'usage' && (
                <>
                  <div className="form">
                    <button disabled={countingOne || !field.filterable || !total} onClick={() => void countOne()}>
                      {countingOne ? 'Counting…' : 'Count filled values'}
                    </button>
                    {field.filled !== undefined ? (
                      <span>
                        <b>{field.filled.toLocaleString()}</b> of {total.toLocaleString()} records filled (
                        <b>{field.percent}%</b>)
                      </span>
                    ) : (
                      !field.filterable && <span className="muted">Salesforce cannot count this field type.</span>
                    )}
                  </div>
                  <h3 style={{ margin: 0 }}>Where it is used</h3>
                  {!field.custom ? (
                    <p className="muted">Salesforce lists references for custom fields only.</p>
                  ) : deps === null ? (
                    <p className="muted">Finding references…</p>
                  ) : deps.length === 0 ? (
                    <p className="muted">
                      Nothing references it (reports and some metadata types are not tracked by Salesforce; check them
                      too).
                    </p>
                  ) : (
                    <DataTable
                      columns={['type', 'name']}
                      groupBy="type"
                      rows={deps.map((d) => ({ ...d }))}
                      rowKey="id"
                      name={`${field.name}-references`}
                      note={<span>· {deps.length} component(s)</span>}
                    />
                  )}
                </>
              )}
              {tab === 'access' &&
                (field.permissionable === false ? (
                  <p className="muted">
                    No field-level security on this field: everyone who can see {sobject} records sees it.
                  </p>
                ) : access === null ? (
                  <p className="muted">Reading field permissions…</p>
                ) : access.length === 0 ? (
                  <EmptyHint what="profiles or permission sets" />
                ) : (
                  <>
                    <div className="metrics">
                      {(['all', 'Read & edit', 'Read only', 'No access'] as const).map((id) => {
                        const n = access.filter(
                          (x) => (kind === 'all' || x.kind === kind) && (id === 'all' || x.access === id)
                        ).length;
                        return (
                          <button
                            key={id}
                            className={`metric filter ${level === id ? 'active' : ''} ${
                              id === 'No access' || id === 'all' ? '' : 'good'
                            }`}
                            onClick={() => setLevel(id)}
                          >
                            <b>{n}</b>
                            {id === 'all' ? 'All' : id}
                          </button>
                        );
                      })}
                    </div>
                    <div className="form">
                      <label>
                        Show
                        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                          <option value="all">Profiles, permission sets and groups</option>
                          <option value="Profile">Profiles</option>
                          <option value="Permission set">Permission sets</option>
                          <option value="Permission set group">Permission set groups</option>
                        </select>
                      </label>
                    </div>
                    <DataTable
                      columns={['access', 'kind', 'name']}
                      groupBy="kind"
                      rows={access
                        .filter((x) => (kind === 'all' || x.kind === kind) && (level === 'all' || x.access === level))
                        .map((x, i) => ({ ...x, key: i }))}
                      rowKey="key"
                      name={`${field.name}-access`}
                    />
                  </>
                ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
