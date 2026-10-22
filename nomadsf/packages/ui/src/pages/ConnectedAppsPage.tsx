import { useEffect, useMemo, useState } from 'react';
import { compareConnectedApps, connectedAppsReport, type AppComparison, type ConnectedAppsReport } from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { OtherOrgSelect, useOtherOrg } from '../components/OtherOrg';
import { storage, useStudio } from '../context';

type View = 'apps' | 'tokens' | 'compare';

/**
 * Connected apps, external client apps and OAuth usage: which apps people use, and who uses each one; compared with
 * another org: which apps exist where, their settings and who may use them.
 */
export function ConnectedAppsPage() {
  const { client, org } = useStudio();
  const otherOrg = useOtherOrg('apps.org');
  const [comparison, setComparison] = useState<AppComparison[] | null>(null);
  const [compareStatus, setCompareStatus] = useState('');
  const [compared, setCompared] = useState('');
  const [report, setReport] = useState<ConnectedAppsReport | null>(null);
  const [status, setStatus] = useState('');
  const [view, setView] = useState<View>(() => storage.get('apps.view', 'apps'));
  const [app, setApp] = useState('');

  const load = async () => {
    setStatus('Reading connected apps and OAuth tokens…');
    try {
      const next = await connectedAppsReport(client);
      setReport(next);
      setStatus(next.notes.length ? `Some lists could not be read: ${next.notes.join(' · ')}` : '');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    setReport(null);
    setApp('');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    setComparison(null);
    setCompared('');
    setCompareStatus('');
    if (!otherOrg.client) return;
    let canceled = false;
    setCompareStatus(`Comparing with ${otherOrg.other?.label}…`);
    compareConnectedApps(client, otherOrg.client)
      .then((result) => {
        if (canceled) return;
        setComparison(result.apps);
        setCompareStatus(result.notes.length ? `Some lists could not be read: ${result.notes.join(' · ')}` : '');
      })
      .catch((e: Error) => !canceled && setCompareStatus(`❌ ${e.message}`));
    return () => {
      canceled = true;
    };
  }, [client, otherOrg.client, otherOrg.other]);
  const shownView: View = view === 'compare' && !otherOrg.other ? 'apps' : view;
  const comparedApp = comparison?.find((x) => x.name === compared);

  const usersOfApp = useMemo(
    () => (report && app ? report.tokens.filter((t) => String(t.App).toLowerCase() === app.toLowerCase()) : []),
    [report, app]
  );
  const choose = (next: View) => {
    setView(next);
    storage.set('apps.view', next);
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Connected apps</h2>
        <span className="muted">Connected apps, external client apps and OAuth usage on {org.label}</span>
        <span className="grow" />
        <OtherOrgSelect state={otherOrg} />
        <button onClick={() => void load()}>Refresh</button>
      </div>
      {status && <p className="muted">{status}</p>}
      {report && (
        <>
          <div className="metrics">
            <div className="metric">
              <b>{report.apps.filter((a) => a.kind === 'Connected app').length}</b>connected apps
            </div>
            <div className="metric">
              <b>{report.apps.filter((a) => a.kind === 'External client app').length}</b>external client apps
            </div>
            <div className="metric">
              <b>{new Set(report.tokens.map((t) => t.UserId)).size}</b>users with OAuth tokens
            </div>
            <div className="metric">
              <b>{report.tokens.length}</b>OAuth tokens
            </div>
          </div>
          <div className="tabs">
            {(
              [
                ['apps', `Apps (${report.apps.length})`],
                ['tokens', `All OAuth tokens (${report.tokens.length})`],
                ...(otherOrg.other
                  ? [['compare', `Compare with ${otherOrg.other.label}${comparison ? ` (${comparison.length})` : ''}`]]
                  : []),
              ] as Array<[View, string]>
            ).map(([id, text]) => (
              <button key={id} className={`tab ${shownView === id ? 'active' : ''}`} onClick={() => choose(id)}>
                {text}
              </button>
            ))}
          </div>
          {shownView === 'apps' &&
            (report.apps.length === 0 ? (
              <EmptyHint what="apps" />
            ) : (
              <>
                <DataTable
                  columns={['name', 'kind', 'users', 'tokens', 'uses', 'lastUsed', 'created']}
                  rows={report.apps.map((a) => ({ ...a }))}
                  rowKey="name"
                  name={`${org.label}-apps`}
                  selectedKey={app}
                  onRowClick={(row) => setApp(String(row.name))}
                  note={
                    <span>
                      · click an app to see its users · "OAuth only": an app with tokens but no connected app in this
                      org (e.g. Salesforce CLI)
                    </span>
                  }
                />
                {app && (
                  <div className="section">
                    <h3>
                      Users of {app} ({usersOfApp.length})
                    </h3>
                    {usersOfApp.length ? (
                      <DataTable
                        columns={['User', 'Username', 'Active', 'Uses', 'LastUsed', 'Connected']}
                        rows={usersOfApp}
                        rowKey="Id"
                        name={`${org.label}-${app}-users`}
                      />
                    ) : (
                      <EmptyHint what="OAuth tokens for this app" />
                    )}
                  </div>
                )}
              </>
            ))}
          {shownView === 'compare' && (
            <>
              {compareStatus && <p className="muted">{compareStatus}</p>}
              {comparison && (
                <DataTable
                  columns={['name', 'status', 'differences', 'kindA', 'kindB', 'usersA', 'usersB']}
                  rows={comparison.map((x) => ({ ...x, differences: x.differences.length }))}
                  rowKey="name"
                  name={`${org.label}-${otherOrg.other?.label}-apps`}
                  selectedKey={compared}
                  onRowClick={(row) => setCompared(String(row.name))}
                  note={
                    <span>
                      · A = {org.label}, B = {otherOrg.other?.label} · click an app in both for its settings and who may
                      use it
                    </span>
                  }
                />
              )}
              {comparedApp && comparedApp.status !== 'only in A' && comparedApp.status !== 'only in B' && (
                <div className="section">
                  <h3>{comparedApp.name}</h3>
                  {comparedApp.differences.length ? (
                    <DataTable
                      columns={['area', 'item', 'a', 'b']}
                      rows={comparedApp.differences.map((d, i) => ({ ...d, key: i }))}
                      rowKey="key"
                      name={`${comparedApp.name}-compare`}
                      note={<span>· only the differences</span>}
                    />
                  ) : (
                    <p className="good">✓ The same settings and the same profiles and permission sets in both orgs.</p>
                  )}
                </div>
              )}
            </>
          )}
          {shownView === 'tokens' &&
            (report.tokens.length === 0 ? (
              <EmptyHint what="OAuth tokens" />
            ) : (
              <DataTable
                columns={['App', 'User', 'Username', 'Active', 'Uses', 'LastUsed', 'Connected']}
                rows={report.tokens}
                rowKey="Id"
                name={`${org.label}-oauth-tokens`}
                note={<span>· every user and the apps they connected with OAuth</span>}
              />
            ))}
        </>
      )}
    </div>
  );
}
