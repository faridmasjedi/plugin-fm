import { useEffect, useState } from 'react';
import { describeGlobal, saveOrder, type SaveStep, type SObjectSummary } from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { storage, useStudio } from '../context';

/** What runs when a record of an object is saved, in Salesforce's order of execution. */
export function AutomationPage() {
  const { client, org } = useStudio();
  const [objects, setObjects] = useState<SObjectSummary[]>([]);
  const [typed, setTyped] = useState(() => storage.get('automation.object', 'Case'));
  const [name, setName] = useState(() => storage.get('automation.object', 'Case'));
  const [result, setResult] = useState<{ steps: SaveStep[]; notes: string[] } | null>(null);
  const [activeOnly, setActiveOnly] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    describeGlobal(client)
      .then((list) => setObjects(list.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => undefined);
  }, [client]);
  useEffect(() => {
    setResult(null);
    if (!name) return;
    setStatus(`Reading the automation on ${name}…`);
    saveOrder(client, name)
      .then((r) => {
        setResult(r);
        setStatus('');
        storage.set('automation.object', name);
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, name]);

  const steps = (result?.steps ?? []).filter((s) => !activeOnly || s.active);
  const pick = (value: string) => {
    const match = objects.find((o) => o.name.toLowerCase() === value.trim().toLowerCase());
    if (match) setName(match.name);
    return Boolean(match);
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Automation</h2>
        <span className="muted">What runs when a record is saved, in order, on {org.label}</span>
      </div>
      <div className="form">
        <input
          list="automation-objects"
          value={typed}
          placeholder="Object, e.g. Case"
          onChange={(e) => {
            setTyped(e.target.value);
            pick(e.target.value);
          }}
          onKeyDown={(e) => e.key === 'Enter' && !pick(typed) && setStatus(`❌ No object called "${typed.trim()}".`)}
        />
        <datalist id="automation-objects">
          {objects.map((o) => (
            <option key={o.name} value={o.name}>
              {o.label}
            </option>
          ))}
        </datalist>
        <label className="check">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active only
        </label>
        <span className="muted">{status}</span>
      </div>
      {result && (
        <>
          <ol className="save-order">
            {[
              ['System validation', 'required fields, field formats, lengths (always)'],
              ['Before save', 'before-save flows, before triggers, validation and duplicate rules'],
              ['Saved (not committed)', 'the record gets its Id'],
              ['After save', 'after triggers, assignment and workflow rules, after-save flows'],
              ['Commit', 'emails and platform events go out'],
            ].map(([title, hint]) => (
              <li key={title}>
                <b>{title}</b> <span className="muted">{hint}</span>
              </li>
            ))}
          </ol>
          {steps.length === 0 ? (
            <EmptyHint what="automation on this object" />
          ) : (
            <DataTable
              columns={['order', 'when', 'kind', 'name', 'active', 'events', 'detail']}
              rows={steps.map((s) => ({ ...s, active: s.active ? '✓' : 'off' }))}
              rowKey="order"
              name={`${org.label}-${name}-automation`}
              note={<span>· in the order Salesforce runs them on save</span>}
            />
          )}
          {result.notes.length > 0 && (
            <p className="muted" style={{ margin: 0 }}>
              {result.notes.join(' · ')}
            </p>
          )}
        </>
      )}
    </div>
  );
}
