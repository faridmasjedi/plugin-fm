import { useCallback, useEffect, useMemo, useState } from 'react';
import { getUserInfo, type SalesforceClient, type UserInfo } from '@nomadsf/core';
import { detectHost, orgFacts, type OrgChoice, type OrgFacts } from './host';
import { StudioContext, storage, type Studio } from './context';
import { toggleTheme } from './theme';
import { ExecutePage } from './pages/ExecutePage';
import { LogsPage } from './pages/LogsPage';
import { QueryPage } from './pages/QueryPage';

const PAGES = [
  { id: 'apex', label: 'Execute Apex', icon: '▶' },
  { id: 'logs', label: 'Debug Logs', icon: '☰' },
  { id: 'query', label: 'Query', icon: '⌕' },
] as const;
type PageId = (typeof PAGES)[number]['id'];

const host = detectHost();

export function App() {
  const [orgs, setOrgs] = useState<OrgChoice[]>([]);
  const [orgId, setOrgId] = useState<string>(() => storage.get('studio.org', ''));
  // #apex / #logs / #query (links from the extension popup) win over the last page used
  const [page, setPage] = useState<PageId>(() => {
    const fromHash = location.hash.slice(1);
    return PAGES.some((p) => p.id === fromHash) ? (fromHash as PageId) : storage.get('studio.page', 'apex');
  });
  const [client, setClient] = useState<SalesforceClient | null>(null);
  const [facts, setFacts] = useState<OrgFacts | undefined>();
  const [user, setUser] = useState<UserInfo | undefined>();
  const [error, setError] = useState('');

  useEffect(() => {
    host
      .orgs()
      .then((list) => {
        setOrgs(list);
        setOrgId((current) => (list.some((o) => o.id === current) ? current : list[0]?.id ?? ''));
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const org = useMemo(() => orgs.find((o) => o.id === orgId), [orgs, orgId]);

  useEffect(() => {
    if (!org) return;
    storage.set('studio.org', org.id);
    setClient(null);
    setFacts(undefined);
    setUser(undefined);
    setError('');
    let canceled = false;
    host
      .client(org)
      .then(async (c) => {
        const [f, u] = await Promise.all([orgFacts(c), getUserInfo(c)]);
        if (canceled) return;
        setClient(c);
        setFacts(f);
        setUser(u);
      })
      .catch((e: Error) => !canceled && setError(e.message));
    return () => {
      canceled = true;
    };
  }, [org]);

  useEffect(() => storage.set('studio.page', page), [page]);

  const production = facts ? !facts.isSandbox : org?.type === 'Production' || org?.type === 'Dev Hub';
  const confirmRisky = useCallback(
    (what: string) =>
      !production || confirm(`${what} in ${org?.label} — a PRODUCTION org (${facts?.name ?? ''}).\n\nContinue?`),
    [production, org, facts]
  );
  const studio: Studio | null = client && org ? { client, org, facts, user, confirmRisky } : null;

  return (
    <div className="studio">
      <header className="top">
        <div className="brand">
          <span className="logo" />
          NomadSF <span className="muted">Studio</span>
        </div>
        {host.kind === 'app' ? (
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
                {o.type ? ` — ${o.type}` : ''}
              </option>
            ))}
          </select>
        ) : (
          <span className="org-name">{org?.label}</span>
        )}
        {facts && (
          <span className={`pill ${production ? 'bad' : 'good'}`}>{production ? 'Production' : 'Sandbox'}</span>
        )}
        {user && (
          <span className="muted user">
            {user.userFullName} · {user.organizationName}
          </span>
        )}
        <span className="grow" />
        {host.kind === 'app' && (
          <a className="muted" href="/">
            ← NomadSF
          </a>
        )}
        <button onClick={toggleTheme} title="Toggle theme">
          ◐
        </button>
      </header>
      <nav className="side">
        {PAGES.map((p) => (
          <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)}>
            <span className="icon">{p.icon}</span>
            {p.label}
          </button>
        ))}
      </nav>
      <main>
        {error && <div className="error">{error}</div>}
        {!error && !studio && (
          <p className="muted">
            {orgs.length || host.kind === 'extension' ? 'Connecting…' : 'No orgs. Connect one in NomadSF → Orgs.'}
          </p>
        )}
        {studio && (
          <StudioContext.Provider value={studio}>
            {page === 'apex' && <ExecutePage />}
            {page === 'logs' && <LogsPage />}
            {page === 'query' && <QueryPage />}
          </StudioContext.Provider>
        )}
      </main>
    </div>
  );
}
