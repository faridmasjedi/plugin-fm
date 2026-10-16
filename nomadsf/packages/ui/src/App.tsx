import { useCallback, useEffect, useMemo, useState } from 'react';
import { getUserInfo, type SalesforceClient, type UserInfo } from '@nomadsf/core';
import { detectHost, orgFacts, type OrgChoice, type OrgFacts } from './host';
import { InspectContext, StudioContext, activityLog, storage, type Studio } from './context';
import { toggleTheme } from './theme';
import { ExecutePage } from './pages/ExecutePage';
import { LogsPage } from './pages/LogsPage';
import { QueryPage } from './pages/QueryPage';
import { DataPage } from './pages/DataPage';
import { AccessPage } from './pages/AccessPage';
import { ActivityPage } from './pages/ActivityPage';
import { MetadataPage } from './pages/MetadataPage';
import { LOCAL_PAGES, LocalAppPage } from './pages/LocalAppPage';
import { ProjectPage } from './pages/ProjectPage';
import { TestsPage } from './pages/TestsPage';
import { RecordPage } from './pages/RecordPage';
import { LimitsPage } from './pages/LimitsPage';
import { RestPage } from './pages/RestPage';
import { ProjectStateContext, useProjectState } from './project';

const PAGES = [
  { id: 'project', label: 'Project', icon: '⌂' },
  { id: 'apex', label: 'Execute Apex', icon: '▶' },
  { id: 'logs', label: 'Debug Logs', icon: '☰' },
  { id: 'query', label: 'Query', icon: '⌕' },
  { id: 'record', label: 'Record', icon: 'ⓘ' },
  { id: 'data', label: 'Data', icon: '⇅' },
  { id: 'access', label: 'Users & access', icon: '⚿' },
  { id: 'metadata', label: 'Metadata', icon: '◫' },
  { id: 'limits', label: 'Org limits', icon: '▤' },
  { id: 'rest', label: 'REST Explorer', icon: '⇄' },
  { id: 'tests', label: 'Tests', icon: '✓' },
  { id: 'activity', label: 'Activity', icon: '⏱' },
] as const;
const host = detectHost();
// Local app pages (pipelines, runbooks, repository) only make sense inside the extension
const LOCAL = host.kind === 'extension' ? LOCAL_PAGES : [];
type PageId = (typeof PAGES)[number]['id'] | (typeof LOCAL_PAGES)[number]['id'];
const isPage = (id: string): id is PageId => PAGES.some((p) => p.id === id) || LOCAL.some((p) => p.id === id);

export function App() {
  const [orgs, setOrgs] = useState<OrgChoice[]>([]);
  const [orgId, setOrgId] = useState<string>(() => storage.get('studio.org', ''));
  // #apex / #logs / #query (links from the extension popup) win over the last page used
  const [page, setPage] = useState<PageId>(() => {
    const fromHash = location.hash.slice(1).split('=')[0];
    const stored = storage.get<string>('studio.page', 'apex');
    return isPage(fromHash) ? fromHash : isPage(stored) ? stored : 'apex';
  });
  const [client, setClient] = useState<SalesforceClient | null>(null);
  const [facts, setFacts] = useState<OrgFacts | undefined>();
  const [user, setUser] = useState<UserInfo | undefined>();
  const [error, setError] = useState('');
  // #record=<Id> (the extension popup on a record page) opens the inspector
  const [inspectId, setInspectId] = useState<string | undefined>(
    () => /^#record=([a-zA-Z0-9]{15,18})$/.exec(location.hash)?.[1]
  );
  const inspect = useCallback((id: string) => {
    setInspectId(id);
    setPage('record');
  }, []);

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
  const confirmChange = useCallback(
    (what: string) => {
      const warn = production ? `\n\n⚠ ${org?.label} is a PRODUCTION org.` : '';
      return prompt(`${what}${warn}\n\nType the org name "${org?.label}" to confirm:`) === org?.label;
    },
    [production, org]
  );
  const logActivity = useCallback(
    (action: string, details: Record<string, unknown>) => {
      activityLog.add({
        at: new Date().toISOString(),
        org: org?.label ?? '',
        user: user?.userName ?? '',
        action,
        details,
      });
      // In the app, changes also go to the project's shared log (.fm/org-activity.log)
      if (host.kind === 'app') {
        void fetch('/api/org/activity', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-fm-dashboard': '1' },
          body: JSON.stringify({ org: org?.id, action, details }),
        }).catch(() => undefined);
      }
    },
    [org, user]
  );
  const studio: Studio | null =
    client && org ? { hostKind: host.kind, client, org, facts, user, confirmRisky, confirmChange, logActivity } : null;

  const localPage = LOCAL.find((p) => p.id === page);
  const project = useProjectState(host.kind);

  return (
    <ProjectStateContext.Provider value={project}>
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
          {LOCAL.length > 0 && <div className="nav-section">Local app</div>}
          {LOCAL.map((p) => (
            <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)}>
              <span className="icon">{p.icon}</span>
              {p.label}
            </button>
          ))}
        </nav>
        <main className={localPage ? 'local' : ''}>
          {localPage && <LocalAppPage page={localPage.page} />}
          {page === 'project' && (
            <ProjectPage studio={studio} hostKind={host.kind} onOpenMetadata={() => setPage('metadata')} />
          )}
          {page === 'tests' && (
            <TestsPage hostKind={host.kind} defaultOrg={host.kind === 'app' ? org?.id : undefined} />
          )}
          {!localPage && !['project', 'tests'].includes(page) && error && <div className="error">{error}</div>}
          {!localPage && !['project', 'tests'].includes(page) && !error && !studio && (
            <p className="muted">
              {orgs.length || host.kind === 'extension' ? 'Connecting…' : 'No orgs. Connect one in NomadSF → Orgs.'}
            </p>
          )}
          {!localPage && !['project', 'tests'].includes(page) && studio && (
            <StudioContext.Provider value={studio}>
              <InspectContext.Provider value={inspect}>
                {page === 'apex' && <ExecutePage />}
                {page === 'logs' && <LogsPage />}
                {page === 'query' && <QueryPage />}
                {page === 'data' && <DataPage />}
                {page === 'access' && <AccessPage />}
                {page === 'metadata' && <MetadataPage />}
                {page === 'activity' && <ActivityPage />}
                {page === 'record' && <RecordPage initialId={inspectId} />}
                {page === 'limits' && <LimitsPage />}
                {page === 'rest' && <RestPage />}
              </InspectContext.Provider>
            </StudioContext.Provider>
          )}
        </main>
      </div>
    </ProjectStateContext.Provider>
  );
}
