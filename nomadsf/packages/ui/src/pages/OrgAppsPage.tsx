import { useEffect, useState } from 'react';
import { compareConnectedApps, type AppComparison } from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { OrgPairBar, usePairClients } from '../pair';

type Show = 'all' | AppComparison['status'];

/** Org to org › Connected apps: which apps exist in A and B, and for apps in both their settings and who may use them. */
export function OrgAppsPage() {
  const { a, b, clientA, clientB, error } = usePairClients();
  const [apps, setApps] = useState<AppComparison[] | null>(null);
  const [status, setStatus] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [chosen, setChosen] = useState('');

  const load = async () => {
    if (!clientA || !clientB) return;
    setApps(null);
    setChosen('');
    setStatus('Reading the connected apps of both orgs…');
    try {
      const result = await compareConnectedApps(clientA, clientB);
      setApps(result.apps);
      setStatus(result.notes.length ? `Some lists could not be read: ${result.notes.join(' · ')}` : '');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    setApps(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientA, clientB]);

  const count = (s: Show): number => (apps ?? []).filter((x) => s === 'all' || x.status === s).length;
  const shown = (apps ?? []).filter((x) => show === 'all' || x.status === show);
  const app = apps?.find((x) => x.name === chosen);

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Connected apps</h2>
        <span className="muted">connected apps, external client apps and OAuth apps in two orgs</span>
        <span className="grow" />
        <button disabled={!clientB} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <OrgPairBar />
      {error && <p className="bad-text">{error}</p>}
      {!b && <p className="muted">Choose the other org (B) above.</p>}
      {status && <p className="muted">{status}</p>}
      {apps && (
        <>
          <div className="segmented" role="group" aria-label="Show">
            {(['all', 'only in A', 'only in B', 'different', 'same'] as Show[]).map((s) => (
              <button key={s} className={show === s ? 'active' : ''} onClick={() => setShow(s)}>
                {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)} ({count(s)})
              </button>
            ))}
          </div>
          <DataTable
            columns={['name', 'status', 'differences', 'kindA', 'kindB', 'usersA', 'usersB']}
            rows={shown.map((x) => ({ ...x, differences: x.differences.length }))}
            rowKey="name"
            name={`${a?.label}-${b?.label}-apps`}
            selectedKey={chosen}
            onRowClick={(row) => setChosen(String(row.name))}
            note={
              <span>
                · A = {a?.label}, B = {b?.label} · click an app in both for its settings and who may use it
              </span>
            }
          />
          {app && app.status !== 'only in A' && app.status !== 'only in B' && (
            <div className="section">
              <h3>{app.name}</h3>
              {app.differences.length ? (
                <DataTable
                  columns={['area', 'item', 'a', 'b']}
                  rows={app.differences.map((d, i) => ({ ...d, key: i }))}
                  rowKey="key"
                  name={`${app.name}-compare`}
                  note={<span>· only the differences</span>}
                />
              ) : (
                <p className="good">✓ The same settings and the same profiles and permission sets in both orgs.</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
