import { useEffect, useMemo, useState } from 'react';
import {
  CONFIG_TYPES,
  compareItems,
  configFiles,
  configItems,
  deployConfigs,
  diffItems,
  forAnotherOrg,
  type ItemComparison,
} from '@nomadsf/core';
import { DataTable } from './DataTable';
import { OrgPairBar, usePairClients } from '../pair';
import { useStudio } from '../context';
import { askTyped } from './Dialogs';
import { Status } from '../statusLog';

type Show = 'all' | ItemComparison['status'];

/**
 * The connected apps, external client apps, named and external credentials of A and B: where each is, every setting
 * side by side (or only the differences), and A's version deployed to B (secrets and consumer keys never travel).
 */
export function ConfigCompare() {
  const { logActivity } = useStudio();
  const { a, b, clientA, clientB, error } = usePairClients();
  const [rows, setRows] = useState<ItemComparison[] | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [chosen, setChosen] = useState('');
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (quiet = false) => {
    if (!clientA || !clientB) return;
    setRows(null);
    setChosen('');
    if (!quiet) setStatus('Reading the apps and credentials of both orgs…');
    try {
      const [fa, fb] = await Promise.all([configFiles(clientA, CONFIG_TYPES), configFiles(clientB, CONFIG_TYPES)]);
      setRows(compareItems(configItems(fa), configItems(fb)));
      if (!quiet) setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientA, clientB]);

  const count = (s: Show) => (rows ?? []).filter((r) => s === 'all' || r.status === s).length;
  const item = rows?.find((r) => `${r.kind}:${r.name}` === chosen);
  const diff = useMemo(() => (item ? diffItems(item.a, item.b) : []), [item]);
  const shownDiff = onlyDiff ? diff.filter((d) => !d.same) : diff;

  const deployToB = async () => {
    if (!item?.a || !clientB || !b) return;
    if (
      !(await askTyped(
        `Deploy ${item.kind} ${item.label} as it is in ${a?.label ?? 'A'} to ${b.label} (${
          item.a.files.length
        } file(s); secrets, the consumer key and org-specific links are not copied).`,
        b.label,
        { ok: 'Deploy' }
      ))
    )
      return;
    setBusy(true);
    setStatus(`Deploying ${item.label} to ${b.label}…`);
    try {
      await deployConfigs(
        clientB,
        item.a.files.map((f) => ({ ...f, xml: forAnotherOrg(f.xml) }))
      );
      logActivity('config-deploy-to-b', { item: item.name, kind: item.kind, to: b.label });
      setStatus(`✓ ${item.label} deployed to ${b.label}.`);
      const keep = chosen;
      await load(true);
      setChosen(keep);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Settings of apps & credentials</h2>
        <span className="muted">connected apps, external client apps, named and external credentials in two orgs</span>
        <span className="grow" />
        <button disabled={!clientB} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <OrgPairBar />
      {error && <p className="bad-text">{error}</p>}
      {!b && <p className="muted">Choose the other org (B) above.</p>}
      {status && <Status text={status} block />}
      {rows && (
        <div className="card section">
          <div className="segmented" role="group" aria-label="Show">
            {(['all', 'only in A', 'only in B', 'different', 'same'] as Show[]).map((s) => (
              <button key={s} className={show === s ? 'active' : ''} onClick={() => setShow(s)}>
                {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)} ({count(s)})
              </button>
            ))}
          </div>
          {rows.length ? (
            <DataTable
              name="apps-credentials-compare"
              columns={['kind', 'label', 'name', 'status', 'differences']}
              rows={rows
                .filter((r) => show === 'all' || r.status === show)
                .map((r) => ({ ...r, Id: `${r.kind}:${r.name}`, differences: r.differences || '' }))}
              onRowClick={(r) => setChosen(String(r.Id))}
              selectedKey={chosen}
            />
          ) : (
            <p className="muted">Neither org defines a connected app, external client app or credential.</p>
          )}
        </div>
      )}
      {item && (
        <div className="card section">
          <div className="form">
            <span className="pill">{item.kind}</span>
            <b>{item.label}</b>
            <span className="muted small">{item.status}</span>
            <span className="grow" />
            <label className="check">
              <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Only the
              differences
            </label>
            {item.a && item.status !== 'same' && (
              <button className="primary" disabled={busy} onClick={() => void deployToB()}>
                Deploy A’s version to {b?.label ?? 'B'}…
              </button>
            )}
          </div>
          <table className="config-table config-diff">
            <thead>
              <tr>
                <th>Setting</th>
                <th>{a?.label ?? 'A'}</th>
                <th>{b?.label ?? 'B'}</th>
              </tr>
            </thead>
            <tbody>
              {shownDiff.map((d) => (
                <tr key={d.path} className={d.same ? '' : 'changed'}>
                  <td className="mono small">{d.path}</td>
                  <td>{d.a || <span className="muted">—</span>}</td>
                  <td>{d.b || <span className="muted">—</span>}</td>
                </tr>
              ))}
              {!shownDiff.length && (
                <tr>
                  <td colSpan={3} className="muted">
                    The same in both.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p className="muted small">
            The consumer key differs in every org and is not a difference. Secrets (client secrets, passwords, private
            keys) are not in these files and are never copied: set them in Setup in {b?.label ?? 'B'}.
          </p>
        </div>
      )}
    </div>
  );
}
