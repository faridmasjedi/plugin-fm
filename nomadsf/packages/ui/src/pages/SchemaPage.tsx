import { useEffect, useMemo, useState } from 'react';
import { describeGlobal, objectSchema, type SchemaField, type SchemaInfo, type SObjectSummary } from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { ObjectOptions } from '../components/ObjectOptions';
import { Status } from '../statusLog';

type Tab = 'fields' | 'relationships' | 'recordTypes';
const yes = (v: boolean): string => (v ? '✓' : '');
const MAX_SIDE = 10;
/** Feeds, histories, shares, change events…: related to almost everything, rarely what you look for. */
const SYSTEM =
  /(Feed|History|Share|ChangeEvent|CleanInfo|Tag)$|^(ActivityHistory|AttachedContentDocument|CombinedAttachment|ContentDocumentLink|ContentVersion|EmailMessage|EntitySubscription|FeedComment|FeedItem|NoteAndAttachment|OpenActivity|ProcessInstance|ProcessInstanceHistory|RecordAction|TopicAssignment|FlowRecordRelation|ProcessException|EventRelation|Note|Attachment|Task|Event)$/;
const COMMON = new Set([
  'Account',
  'Contact',
  'Opportunity',
  'Case',
  'Contract',
  'Order',
  'Asset',
  'Lead',
  'Quote',
  'Campaign',
  'CampaignMember',
  'OpportunityLineItem',
  'Product2',
  'Pricebook2',
  'Entitlement',
  'ServiceContract',
  'WorkOrder',
  'User',
  'Group',
]);
/** Custom objects first, then everyday CRM objects, other standard ones, system objects last. */
const rank = (name: string): number => (name.endsWith('__c') ? 0 : COMMON.has(name) ? 1 : SYSTEM.test(name) ? 3 : 2);

/** An object's schema: fields (with picklist values and formulas), relationships with a small diagram, record types. */
export function SchemaPage() {
  const { client, org } = useStudio();
  const [objects, setObjects] = useState<SObjectSummary[]>([]);
  const [typed, setTyped] = useState(() => storage.get('schema.object', 'Account'));
  const [name, setName] = useState(() => storage.get('schema.object', 'Account'));
  const [schema, setSchema] = useState<SchemaInfo | null>(null);
  const [tab, setTab] = useState<Tab>('fields');
  const [field, setField] = useState<SchemaField | null>(null);
  const [customOnly, setCustomOnly] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    describeGlobal(client)
      .then((list) => setObjects(list.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => undefined);
  }, [client]);
  useEffect(() => {
    setSchema(null);
    setField(null);
    if (!name) return;
    setStatus(`Reading ${name}…`);
    objectSchema(client, name)
      .then((s) => {
        setSchema(s);
        setStatus('');
        storage.set('schema.object', name);
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, name]);

  const open = (next: string) => {
    const object = next.split(',')[0].trim();
    setTyped(object);
    setName(object);
    setTab('fields');
  };
  const fields = useMemo(() => (schema?.fields ?? []).filter((f) => !customOnly || f.custom), [schema, customOnly]);

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Schema</h2>
        <span className="muted">Fields, relationships and record types on {org.label}</span>
      </div>
      <div className="form">
        <input
          list="schema-objects"
          value={typed}
          placeholder="Object, e.g. Account"
          onChange={(e) => {
            setTyped(e.target.value);
            const match = objects.find((o) => o.name.toLowerCase() === e.target.value.trim().toLowerCase());
            if (match && match.name !== name) open(match.name);
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const match = objects.find((o) => o.name.toLowerCase() === typed.trim().toLowerCase());
            if (match) open(match.name);
            else setStatus(`❌ No object called "${typed.trim()}" in this org.`);
          }}
        />
        <ObjectOptions id="schema-objects" objects={objects} typed={typed} />
        {schema && (
          <span className="muted">
            {`${schema.label} (${schema.labelPlural}) · prefix ${schema.keyPrefix || '—'} · ${
              schema.custom ? 'custom' : 'standard'
            } · you can ${schema.access || 'not access it'}`}
          </span>
        )}
        <Status text={status} />
      </div>
      {schema && (
        <>
          <div className="tabs">
            {(
              [
                ['fields', `Fields (${schema.fields.length})`],
                ['relationships', `Relationships (${schema.parents.length + schema.children.length})`],
                ['recordTypes', `Record types (${schema.recordTypes.length})`],
              ] as Array<[Tab, string]>
            ).map(([id, text]) => (
              <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
                {text}
              </button>
            ))}
          </div>

          {tab === 'fields' && (
            <div className="split schema-fields">
              <div>
                <label className="check">
                  <input type="checkbox" checked={customOnly} onChange={(e) => setCustomOnly(e.target.checked)} />{' '}
                  Custom fields only
                </label>
                <DataTable
                  columns={['label', 'name', 'type', 'length', 'required', 'unique', 'externalId', 'referenceTo']}
                  rows={fields.map((f) => ({
                    ...f,
                    required: yes(f.required),
                    unique: yes(f.unique),
                    externalId: yes(f.externalId),
                    type: f.formula ? `${f.type} (formula)` : f.type,
                  }))}
                  rowKey="name"
                  name={`${schema.name}-fields`}
                  selectedKey={field?.name}
                  onRowClick={(row) => setField(schema.fields.find((f) => f.name === row.name) ?? null)}
                  note={<span>· click a field for its details</span>}
                />
              </div>
              <div className="card section">
                {!field ? (
                  <p className="muted">Click a field to see its picklist values, formula, help text and more.</p>
                ) : (
                  <>
                    <h3>
                      {field.label} <span className="muted mono">{field.name}</span>
                    </h3>
                    <p className="muted" style={{ margin: 0 }}>
                      {field.type}
                      {field.length ? ` (${field.length})` : ''}
                      {field.required ? ' · required' : ''}
                      {field.unique ? ' · unique' : ''}
                      {field.externalId ? ' · external Id' : ''}
                      {field.custom ? ' · custom' : ''}
                    </p>
                    {field.referenceTo && (
                      <p>
                        Points to{' '}
                        {field.referenceTo.split(', ').map((t) => (
                          <button key={t} className="link" onClick={() => open(t)}>
                            {t}
                          </button>
                        ))}{' '}
                        <span className="muted">as {field.relationship}</span>
                      </p>
                    )}
                    {field.helpText && (
                      <p>
                        <b>Help text:</b> {field.helpText}
                      </p>
                    )}
                    {field.formula && <pre className="mono wrap">{field.formula}</pre>}
                    {field.picklist.length > 0 && (
                      <>
                        <h4>Picklist values ({field.picklist.length})</h4>
                        <ul className="chips">
                          {field.picklist.map((v) => (
                            <li key={v} className="chip">
                              {v}
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          )}

          {tab === 'relationships' && (
            <>
              <RelationshipDiagram schema={schema} onOpen={open} />
              <div className="grid2">
                <div className="section">
                  <h3>Points to ({schema.parents.length})</h3>
                  <DataTable
                    columns={['field', 'to', 'relationship']}
                    rows={schema.parents.map((p) => ({ ...p }))}
                    rowKey="field"
                    name={`${schema.name}-parents`}
                    onRowClick={(row) => open(String(row.to))}
                    note={<span>· click to open that object</span>}
                  />
                </div>
                <div className="section">
                  <h3>Pointed to by ({schema.children.length})</h3>
                  <DataTable
                    columns={['object', 'field', 'relationship', 'cascadeDelete']}
                    rows={schema.children.map((c, i) => ({ ...c, cascadeDelete: yes(c.cascadeDelete), key: i }))}
                    rowKey="key"
                    name={`${schema.name}-children`}
                    onRowClick={(row) => open(String(row.object))}
                    note={<span>· click to open that object</span>}
                  />
                </div>
              </div>
            </>
          )}

          {tab === 'recordTypes' &&
            (schema.recordTypes.length === 0 ? (
              <EmptyHint what="record types" />
            ) : (
              <DataTable
                columns={['name', 'developerName', 'active', 'isDefault']}
                rows={schema.recordTypes.map((r) => ({ ...r, active: yes(r.active), isDefault: yes(r.isDefault) }))}
                rowKey="developerName"
                name={`${schema.name}-record-types`}
                note={<span>· isDefault: the default for your profile</span>}
              />
            ))}
        </>
      )}
    </div>
  );
}

/** The object in the middle, what it points to on the left, what points to it on the right. */
function RelationshipDiagram({ schema, onOpen }: { schema: SchemaInfo; onOpen: (name: string) => void }) {
  const [system, setSystem] = useState(false);
  const [find, setFind] = useState('');
  const order = (names: string[]) =>
    [...new Set(names)]
      .filter((n) => n !== schema.name && (system || !SYSTEM.test(n)))
      .filter((n) => !find.trim() || n.toLowerCase().includes(find.trim().toLowerCase()))
      .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const parents = order(schema.parents.flatMap((p) => p.to.split(', ')));
  const children = order(schema.children.map((c) => c.object));
  const left = parents.slice(0, MAX_SIDE);
  const right = children.slice(0, MAX_SIDE);
  const rows = Math.max(left.length, right.length, 1);
  const H = Math.max(140, rows * 34 + 20);
  const W = 760;
  const box = { w: 190, h: 26 };
  const y = (i: number, n: number) => (H / (n + 1)) * (i + 1);
  const cx = W / 2;
  const cy = H / 2;
  const node = (label: string, x: number, yy: number, i: string, onClick?: () => void, center = false) => (
    <g
      key={i}
      className={`schema-node${center ? ' center' : ''}`}
      onClick={onClick}
      style={{ cursor: onClick ? 'pointer' : 'default' }}
    >
      <rect x={x - box.w / 2} y={yy - box.h / 2} width={box.w} height={box.h} rx={6} />
      <text x={x} y={yy + 4} textAnchor="middle">
        {label.length > 26 ? `${label.slice(0, 25)}…` : label}
      </text>
    </g>
  );
  return (
    <div className="card schema-diagram">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxWidth: 860, display: 'block', margin: '0 auto' }}
        role="img"
        aria-label={`${schema.name} relationships`}
      >
        {left.map((p, i) => (
          <line key={`l${p}`} x1={120 + box.w / 2 - 10} y1={y(i, left.length)} x2={cx - box.w / 2} y2={cy} />
        ))}
        {right.map((c, i) => (
          <line key={`r${c}`} x1={cx + box.w / 2} y1={cy} x2={W - 120 - box.w / 2 + 10} y2={y(i, right.length)} />
        ))}
        {left.map((p, i) => node(p, 120, y(i, left.length), `L${p}`, () => onOpen(p)))}
        {node(schema.name, cx, cy, 'C', undefined, true)}
        {right.map((c, i) => node(c, W - 120, y(i, right.length), `R${c}`, () => onOpen(c)))}
      </svg>
      <p className="muted" style={{ margin: 0 }}>
        <input
          placeholder="Find a related object"
          value={find}
          onChange={(e) => setFind(e.target.value)}
          style={{ width: 180, marginRight: 8 }}
        />
        <label className="check">
          <input type="checkbox" checked={system} onChange={(e) => setSystem(e.target.checked)} /> System objects too
        </label>{' '}
        · ← points to ({parents.length}
        {parents.length > MAX_SIDE ? `, first ${MAX_SIDE}` : ''}) · pointed to by → ({children.length}
        {children.length > MAX_SIDE ? `, first ${MAX_SIDE}` : ''}) · click an object to open it
      </p>
    </div>
  );
}
