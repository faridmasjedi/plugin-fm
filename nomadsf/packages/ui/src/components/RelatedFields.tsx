import { useEffect, useMemo, useState } from 'react';
import { describeSObject, type FieldSummary, type SalesforceClient } from '@nomadsf/core';

type Describe = { label: string; fields: FieldSummary[] };
const describes = new WeakMap<SalesforceClient, Map<string, Promise<Describe | null>>>();

/** Describe of an object, once per org while the Studio is open. */
function describeOnce(client: SalesforceClient, sobject: string): Promise<Describe | null> {
  let cache = describes.get(client);
  if (!cache) describes.set(client, (cache = new Map()));
  if (!cache.has(sobject))
    cache.set(
      sobject,
      describeSObject(client, sobject).catch(() => null)
    );
  return cache.get(sobject)!;
}

/** Fields offered for an object: its own, plus the name of each record it points to (Owner.Name). */
function choices(fields: FieldSummary[]): Array<{ name: string; label: string; type: string }> {
  const out = fields.map((f) => ({ name: f.name, label: f.label, type: f.type }));
  for (const f of fields) {
    if (f.relationshipName && f.referenceTo.length === 1)
      out.push({ name: `${f.relationshipName}.Name`, label: `${f.label} → Name`, type: `${f.referenceTo[0]} name` });
  }
  return out;
}

/**
 * Fields of the records an Id column points to (Case.AccountId → Account.Industry,
 * UserLogin.UserId → User.Email), chosen per object and remembered. When SOQL can follow the
 * link, the same fields can go into the query itself instead.
 */
export function RelatedFields({
  client,
  objects,
  links,
  related,
  onChange,
  onAddToQuery,
}: {
  client: SalesforceClient;
  /** Id column -> the objects its Ids belong to. */
  objects: Record<string, string[]>;
  /** Id column -> the relationship SOQL can follow from the FROM object (AccountId -> Account). */
  links: Record<string, string>;
  /** Fields chosen per object. */
  related: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
  /** The fields go into the SELECT instead; the object's choice is cleared (no double columns). */
  onAddToQuery: (fields: string[], sobject: string) => void;
}) {
  const columns = useMemo(() => Object.keys(objects).filter((c) => objects[c].length), [objects]);
  const [column, setColumn] = useState(columns[0] ?? '');
  useEffect(() => {
    if (!columns.includes(column)) setColumn(columns[0] ?? '');
  }, [columns, column]);
  const targets = useMemo(() => objects[column] ?? [], [objects, column]);
  const [sobject, setSobject] = useState(targets[0] ?? '');
  useEffect(() => {
    if (!targets.includes(sobject)) setSobject(targets[0] ?? '');
  }, [targets, sobject]);

  const [describe, setDescribe] = useState<Describe | null>(null);
  useEffect(() => {
    setDescribe(null);
    if (sobject) void describeOnce(client, sobject).then(setDescribe);
  }, [client, sobject]);

  const [filter, setFilter] = useState('');
  const chosen = related[sobject] ?? [];
  const list = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const all = describe ? choices(describe.fields) : [];
    return all.filter((f) => !needle || `${f.name} ${f.label}`.toLowerCase().includes(needle));
  }, [describe, filter]);
  const toggle = (field: string, on: boolean) =>
    onChange({ ...related, [sobject]: on ? [...chosen, field] : chosen.filter((f) => f !== field) });

  if (!columns.length) return <p className="muted">No Id columns in this result.</p>;
  const link = links[column];
  return (
    <div className="related-fields">
      <div className="form">
        <label>
          Id column
          <select value={column} onChange={(e) => setColumn(e.target.value)}>
            {columns.map((c) => (
              <option key={c} value={c}>
                {c} → {objects[c].join(' / ')}
              </option>
            ))}
          </select>
        </label>
        {targets.length > 1 && (
          <label>
            Object
            <select value={sobject} onChange={(e) => setSobject(e.target.value)}>
              {targets.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
          </label>
        )}
        <input placeholder={`Filter ${sobject} fields`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="muted">
          {chosen.length} chosen for {sobject} · kept for every query with {sobject} Ids
        </span>
        <span className="grow" />
        {chosen.length > 0 && <button onClick={() => onChange({ ...related, [sobject]: [] })}>Clear</button>}
        {link && chosen.length > 0 && targets.length === 1 && (
          <button
            title={`SOQL can follow ${column}: adds ${chosen
              .map((f) => `${link}.${f}`)
              .join(', ')} to the SELECT and runs it`}
            onClick={() =>
              onAddToQuery(
                chosen.map((f) => `${link}.${f}`),
                sobject
              )
            }
          >
            Add to the query instead
          </button>
        )}
      </div>
      {!describe && <p className="muted">Loading {sobject} fields…</p>}
      <div className="field-checks two-lines">
        {list.map((f) => (
          <label key={f.name} className="check" title={`${f.label} · ${f.name} · ${f.type}`}>
            <input
              type="checkbox"
              checked={chosen.includes(f.name)}
              onChange={(e) => toggle(f.name, e.target.checked)}
            />{' '}
            <span className="field-check-text">
              <span>{f.label}</span>
              <span className="muted mono">{f.name}</span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
