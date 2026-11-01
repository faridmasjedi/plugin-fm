import { useEffect, useState } from 'react';
import { describeGlobal, saveOrder, type SaveStep, type SObjectSummary } from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { ObjectOptions } from '../components/ObjectOptions';
import { TableTabs } from '../components/TableTabs';
import { Status } from '../statusLog';

/**
 * The save as lanes, left to right: one column per moment of the save (before save, after save…), each step a card in
 * the order it runs — what a graph would show, without drawing one.
 */
/** The moments of a save, in order, with what happens there (steps of other moments get their own lane). */
const PHASES: Array<[string, string]> = [
  ['System validation', 'required fields, formats, lengths (always)'],
  ['Before save', 'before-save flows, before triggers, validation and duplicate rules'],
  ['Saved (not committed)', 'the record gets its Id'],
  ['After save', 'after triggers, assignment and workflow rules, after-save flows'],
  ['Commit', 'emails and platform events go out'],
];

function SaveLanes({ steps }: { steps: SaveStep[] }) {
  const byWhen = new Map<string, SaveStep[]>();
  for (const s of [...steps].sort((a, b) => a.order - b.order)) byWhen.set(s.when, [...(byWhen.get(s.when) ?? []), s]);
  const lanes: Array<[string, string, SaveStep[]]> = [
    // Moments outside a save (before delete…) first, then the save's own
    ...[...byWhen.keys()]
      .filter((w) => !PHASES.some(([p]) => p === w))
      .map((w): [string, string, SaveStep[]] => [w, '', byWhen.get(w)!]),
    ...PHASES.map(([p, hint]): [string, string, SaveStep[]] => [p, hint, byWhen.get(p) ?? []]),
  ];
  return (
    <div className="save-lanes">
      {lanes.map(([when, hint, list], i) => (
        <div key={when} className={`save-lane ${list.length ? '' : 'empty'}`}>
          <div className="save-lane-head">
            <span className="save-lane-step">{i + 1}</span>
            <b>{when}</b>
            {list.length > 0 && <span className="muted">{list.length}</span>}
          </div>
          {hint && <p className="muted small save-lane-hint">{hint}</p>}
          {list.map((s) => (
            <div key={s.order} className={`save-card ${s.active ? '' : 'off'}`} title={s.detail}>
              <span className="save-card-order">{s.order}</span>
              <span className="pill">{s.kind}</span>
              <b className="save-card-name">{s.name}</b>
              {s.events && <span className="muted small">{s.events}</span>}
              {!s.active && <span className="muted small">inactive</span>}
            </div>
          ))}
          {!list.length && <p className="muted small">Nothing of yours here.</p>}
        </div>
      ))}
    </div>
  );
}

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
        <ObjectOptions id="automation-objects" objects={objects} typed={typed} />
        <label className="check">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active only
        </label>
        <Status text={status} />
      </div>
      {result && (
        <>
          {steps.length === 0 ? (
            <EmptyHint what="automation on this object" />
          ) : (
            <TableTabs
              tabs={[
                {
                  id: 'diagram',
                  label: 'Order of a save',
                  count: steps.length,
                  content: <SaveLanes steps={steps} />,
                },
                {
                  id: 'table',
                  label: 'Table',
                  count: steps.length,
                  content: (
                    <DataTable
                      columns={['order', 'when', 'kind', 'name', 'active', 'events', 'detail']}
                      rows={steps.map((s) => ({ ...s, active: s.active ? '✓' : 'off' }))}
                      rowKey="order"
                      name={`${org.label}-${name}-automation`}
                      note={<span>· in the order Salesforce runs them on save</span>}
                    />
                  ),
                },
              ]}
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
