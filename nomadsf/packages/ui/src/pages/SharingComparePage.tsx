import { useEffect, useMemo, useState } from 'react';
import { compareSharing, deploySharing, orgSharing, sharingModelLabel, type SharingDiff } from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { askTyped } from '../components/Dialogs';
import { OrgPairBar, usePairClients } from '../pair';
import { useStudio } from '../context';
import { Status } from '../statusLog';

type Show = 'all' | 'different' | 'only in A' | 'only in B' | 'same';
const statusOf = (d: SharingDiff): Exclude<Show, 'all'> =>
  !d.inB ? 'only in A' : !d.inA ? 'only in B' : d.defaultsDiffer || d.rulesDiffer ? 'different' : 'same';
const model = (v?: string) => (v ? sharingModelLabel(v) : '');

/**
 * Compare & Deploy › Compare sharing: every object's org-wide defaults and sharing rules in A and B, rule by rule,
 * and A's defaults or rules deployed to B (typing B's name first).
 */
export function SharingComparePage() {
  const { logActivity } = useStudio();
  const { a, b, clientA, clientB, error } = usePairClients();
  const [diffs, setDiffs] = useState<SharingDiff[] | null>(null);
  const [status, setStatus] = useState('');
  const [show, setShow] = useState<Show>('different');
  const [chosen, setChosen] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = async (quiet = false) => {
    if (!clientA || !clientB) return;
    if (!quiet) {
      setDiffs(null);
      setStatus('Reading the sharing settings of both orgs…');
    }
    try {
      const [x, y] = await Promise.all([orgSharing(clientA), orgSharing(clientB)]);
      setDiffs(compareSharing(x, y));
      if (!quiet) setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    setChosen('');
    setTicked(new Set());
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientA, clientB]);

  const count = (s: Show) => (diffs ?? []).filter((d) => s === 'all' || statusOf(d) === s).length;
  const rows = useMemo(
    () =>
      (diffs ?? [])
        .filter((d) => show === 'all' || statusOf(d) === show)
        .map((d) => ({
          Object: d.object,
          Label: d.label,
          Status: statusOf(d),
          'Default A': model(d.a?.internal),
          'Default B': model(d.b?.internal),
          'External A': model(d.a?.external),
          'External B': model(d.b?.external),
          'Rules A': d.a ? d.a.rules : '',
          'Rules B': d.b ? d.b.rules : '',
          'Rule differences': d.rules.filter((r) => r.status !== 'same').length,
        })),
    [diffs, show]
  );
  const item = diffs?.find((d) => d.object === chosen);

  /** Makes B like A for these objects: defaults that differ, rules that differ (A's file). */
  const deploy = async (list: SharingDiff[], what: 'both' | 'defaults' | 'rules') => {
    if (!clientB || !b) return;
    const items = list
      .filter((d) => d.inA && d.inB)
      .map((d) => ({
        diff: d,
        defaults: what !== 'rules' && d.defaultsDiffer,
        rules: what !== 'defaults' && d.rulesDiffer && Boolean(d.a?.xml),
      }))
      .filter((i) => i.defaults || i.rules);
    if (!items.length) {
      setStatus('Nothing to deploy: no differences A can bring (rules only in B stay as they are).');
      return;
    }
    const parts = items.map(
      (i) => `${i.diff.object} (${[i.defaults && 'defaults', i.rules && 'rules'].filter(Boolean).join(' + ')})`
    );
    if (
      !(await askTyped(
        `Deploy the sharing of ${items.length} object(s) as it is in ${a?.label ?? 'A'} to ${b.label}: ${parts.join(
          ', '
        )}. Changing a default makes Salesforce recalculate sharing in ${b.label}; rules only in B are kept.`,
        b.label,
        { ok: 'Deploy' }
      ))
    )
      return;
    setBusy(true);
    setStatus(`Deploying to ${b.label}…`);
    try {
      const r = await deploySharing(clientB, items);
      logActivity('sharing-deploy-to-b', { to: b.label, done: r.done, failed: r.failed.map((f) => f.item) });
      setStatus(
        r.failed.length
          ? `❌ ${r.failed.map((f) => `${f.item}: ${f.error}`).join(' · ')}${
              r.done.length ? ` (✓ ${r.done.join(', ')})` : ''
            }`
          : `✓ Deployed ${r.done.join(', ')} to ${b.label}.`
      );
      setTicked(new Set());
      await load(true);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const tickedDiffs = (diffs ?? []).filter((d) => ticked.has(d.object));
  const shownRules = item ? item.rules.filter((r) => !onlyDiff || r.status !== 'same') : [];

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Compare sharing</h2>
        <span className="muted">org-wide defaults and sharing rules of every object in two orgs</span>
        <span className="grow" />
        <button disabled={!clientB || busy} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <OrgPairBar />
      {error && <p className="bad-text">{error}</p>}
      {!b && <p className="muted">Choose the other org (B) above.</p>}
      {status && <Status text={status} block />}
      {diffs && (
        <div className="card section sharing-compare-table">
          <div className="form sharing-compare-bar">
            <div className="segmented" role="group" aria-label="Show">
              {(['different', 'only in A', 'only in B', 'same', 'all'] as Show[]).map((s) => (
                <button key={s} className={show === s ? 'active' : ''} onClick={() => setShow(s)}>
                  {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)} ({count(s)})
                </button>
              ))}
            </div>
            <span className="grow" />
            <button
              className="primary"
              disabled={busy || !tickedDiffs.length}
              onClick={() => void deploy(tickedDiffs, 'both')}
            >
              Deploy {tickedDiffs.length || ''} ticked to B…
            </button>
          </div>
          {rows.length === 0 && show === 'different' ? (
            <p className="good">
              ✓ Every object is shared the same way in {a?.label} and {b?.label}: the same defaults and rules.
            </p>
          ) : (
            <DataTable
              columns={[
                'Object',
                'Status',
                'Default A',
                'Default B',
                'External A',
                'External B',
                'Rules A',
                'Rules B',
                'Rule differences',
                'Label',
              ]}
              rows={rows}
              rowKey="Object"
              name={`${a?.label}-${b?.label}-sharing`}
              selectedKey={chosen}
              onRowClick={(r) => setChosen(String(r.Object))}
              selected={ticked}
              onSelectedChange={setTicked}
              renderCell={(c, r) =>
                c === 'Status' ? (
                  <span className={`pill ${r.Status === 'same' ? 'good' : r.Status === 'different' ? 'warn' : ''}`}>
                    {String(r.Status)}
                  </span>
                ) : (c === 'Default B' && r['Default A'] !== r['Default B'] && r.Status === 'different') ||
                  (c === 'External B' && r['External A'] !== r['External B'] && r.Status === 'different') ? (
                  <b className="bad-text">{String(r[c])}</b>
                ) : undefined
              }
              note={<span>· click one for its rules in A and B</span>}
            />
          )}
        </div>
      )}
      {item && (
        <div className="card section sharing-compare-detail">
          <div className="item-head">
            <span className={`pill ${statusOf(item) === 'same' ? 'good' : 'warn'}`}>{statusOf(item)}</span>
            <b>{item.object}</b>
            <span className="muted small">{item.label}</span>
          </div>
          <table className="config-table sharing-defaults">
            <thead>
              <tr>
                <th />
                <th>A · {a?.label}</th>
                <th>B · {b?.label}</th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['Default (inside the company)', item.a?.internal, item.b?.internal],
                  ['External default (portals, sites)', item.a?.external, item.b?.external],
                  ['Sharing rules', item.a?.rules, item.b?.rules],
                ] as Array<[string, unknown, unknown]>
              ).map(([label, x, y]) => (
                <tr key={label} className={item.inA && item.inB && x !== y ? 'changed' : ''}>
                  <td>{label}</td>
                  <td>{typeof x === 'string' ? model(x) : String(x ?? '—')}</td>
                  <td>{typeof y === 'string' ? model(y) : String(y ?? '—')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {item.inA && item.inB && (
            <div className="form">
              <button disabled={busy || !item.defaultsDiffer} onClick={() => void deploy([item], 'defaults')}>
                Deploy A&rsquo;s defaults to B…
              </button>
              <button disabled={busy || !item.rulesDiffer || !item.a?.xml} onClick={() => void deploy([item], 'rules')}>
                Deploy A&rsquo;s rules to B…
              </button>
            </div>
          )}
          {item.rules.length > 0 && (
            <>
              <label className="check">
                <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Differences
                only
              </label>
              {shownRules.length === 0 ? (
                <p className="good">✓ The same rules in both orgs.</p>
              ) : (
                <DataTable
                  columns={['Rule', 'Status', `In A · ${a?.label ?? 'A'}`, `In B · ${b?.label ?? 'B'}`, 'API name']}
                  rows={shownRules.map((r) => ({
                    Rule: r.label,
                    Status: r.status,
                    [`In A · ${a?.label ?? 'A'}`]: r.a || '—',
                    [`In B · ${b?.label ?? 'B'}`]: r.b || '—',
                    'API name': r.name,
                  }))}
                  rowKey="API name"
                  name={`${item.object}-sharing-rules-a-b`}
                  renderCell={(c, r) =>
                    c === 'Status' ? (
                      <span className={`pill ${r.Status === 'same' ? 'good' : 'warn'}`}>{String(r.Status)}</span>
                    ) : undefined
                  }
                  note={<span>· each rule: which records → with whom (access)</span>}
                />
              )}
            </>
          )}
          {item.rules.length === 0 && <p className="muted">No sharing rules on {item.object} in either org.</p>}
        </div>
      )}
    </div>
  );
}
