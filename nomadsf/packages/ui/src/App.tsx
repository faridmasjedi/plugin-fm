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
import { SettingsPage } from './pages/SettingsPage';
import { TestsPage } from './pages/TestsPage';
import { RecordPage } from './pages/RecordPage';
import { LimitsPage } from './pages/LimitsPage';
import { RestPage } from './pages/RestPage';
import { ApexTestsPage } from './pages/ApexTestsPage';
import { CodePage } from './pages/CodePage';
import { EventsPage } from './pages/EventsPage';
import { FieldUsagePage } from './pages/FieldUsagePage';
import { LookupPage } from './pages/LookupPage';
import { OrgComparePage } from './pages/OrgComparePage';
import { BackupPage } from './pages/BackupPage';
import { useBackupRun, useBackupScheduler } from './backups';
import { ProjectStateContext, useProjectState } from './project';

const PAGES = [
  { id: 'project', label: 'Project', icon: '⌂' },
  { id: 'apex', label: 'Execute Apex', icon: '▶' },
  { id: 'code', label: 'Code', icon: '{}' },
  { id: 'apextests', label: 'Apex tests', icon: '◎' },
  { id: 'logs', label: 'Debug Logs', icon: '☰' },
  { id: 'query', label: 'Query', icon: '⌕' },
  { id: 'record', label: 'Record', icon: 'ⓘ' },
  { id: 'data', label: 'Data', icon: '⇅' },
  { id: 'lookup', label: 'Lookup', icon: '⌖' },
  { id: 'access', label: 'Users & access', icon: '⚿' },
  { id: 'metadata', label: 'Metadata', icon: '◫' },
  { id: 'orgdiff', label: 'Org compare', icon: '⇋' },
  { id: 'backup', label: 'Backup', icon: '⛁' },
  { id: 'fields', label: 'Field usage', icon: '▦' },
  { id: 'events', label: 'Events', icon: '⚡' },
  { id: 'limits', label: 'Org limits', icon: '▤' },
  { id: 'rest', label: 'REST Explorer', icon: '⇄' },
  { id: 'tests', label: 'E2E tests', icon: '✓' },
  { id: 'activity', label: 'Activity', icon: '⏱' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
] as const;
const host = detectHost();
// Pages of the NomadSF CLI app (CLI orgs, AI settings) only make sense inside the extension
const LOCAL = host.kind === 'extension' ? LOCAL_PAGES : [];
type PageId = (typeof PAGES)[number]['id'] | (typeof LOCAL_PAGES)[number]['id'];
const isPage = (id: string): id is PageId => PAGES.some((p) => p.id === id) || LOCAL.some((p) => p.id === id);

export function App() {
  const [orgs, setOrgs] = useState<OrgChoice[]>([]);
  // The extension opened from a Salesforce tab starts on that tab's org
  const [orgId, setOrgId] = useState<string>(
    () =>
      (host.kind === 'extension' && new URLSearchParams(location.search).get('host')) || storage.get('studio.org', '')
  );
  // #apex / #logs / #query (links from the extension popup) win over the last page used
  const [page, setPage] = useState<PageId>(() => {
    const [fromHash, value] = location.hash.slice(1).split(/=(.*)/s);
    // #query=<SOQL> (VS Code "Run SOQL") prefills the Query page
    if (fromHash === 'query' && value) storage.set('query.soql', decodeURIComponent(value));
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

  const loadOrgs = useCallback(() => {
    host
      .orgs()
      .then((list) => {
        // Same orgs as before: keep the old list, so nothing reconnects (e.g. after a dialog returns focus)
        setOrgs((current) => (JSON.stringify(current) === JSON.stringify(list) ? current : list));
        setOrgId((current) => (list.some((o) => o.id === current) ? current : list[0]?.id ?? ''));
      })
      .catch((e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    loadOrgs();
    // In the extension, orgs logged in to in another tab show up when you come back
    if (host.kind !== 'extension') return undefined;
    window.addEventListener('focus', loadOrgs);
    return () => window.removeEventListener('focus', loadOrgs);
  }, [loadOrgs]);

  const switchOrg = useCallback((id: string) => {
    setOrgId(id);
    if (host.kind === 'extension') {
      // Keep the address in step, so a reload stays on this org
      const url = new URL(location.href);
      url.searchParams.set('host', id);
      history.replaceState(null, '', url);
    }
  }, []);

  // Stable while the chosen org stays the same, even if the org list is read again
  const orgKey = JSON.stringify(orgs.find((o) => o.id === orgId) ?? null);
  const org = useMemo(() => (JSON.parse(orgKey) as OrgChoice | null) ?? undefined, [orgKey]);

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
      .catch(
        (e: Error) =>
          !canceled &&
          setError(
            host.kind === 'extension' && orgs.length > 1
              ? `${e.message} Choose another org in Settings, or log in to this one again.`
              : e.message
          )
      );
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

  const project = useProjectState(host.kind);

  // Backups can run against any org of the list (scheduled ones too, from any page)
  const clientFor = useCallback(
    async (id: string): Promise<SalesforceClient> => {
      if (client && org?.id === id) return client;
      return host.client(orgs.find((o) => o.id === id) ?? { id, label: id });
    },
    [client, org, orgs]
  );
  useBackupScheduler(clientFor);
  const backupRun = useBackupRun();
  // E2E tests and the Local app pages need the NomadSF CLI app; the extension hides them without it
  const needsLocal = (id: string): boolean => id === 'tests' || LOCAL.some((p) => p.id === id);
  const shownPages = PAGES.filter((p) => !needsLocal(p.id) || project.localAppReady);
  const shownLocal = project.localAppReady ? LOCAL : [];
  const localPage = shownLocal.find((p) => p.id === page);
  useEffect(() => {
    if (project.localChecked && !project.localAppReady && needsLocal(page)) setPage('project');
  }, [project.localChecked, project.localAppReady, page]);

  return (
    <ProjectStateContext.Provider value={project}>
      <div className="studio">
        <header className="top">
          <div className="brand">
            <img className="logo" src="./logo.png" alt="" />
            NomadSF <span className="muted">Studio</span>
          </div>
          {orgs.length > 1 || host.kind === 'app' ? (
            <select value={orgId} onChange={(e) => switchOrg(e.target.value)} title="Org (change it in Settings too)">
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
          {backupRun && !backupRun.done && !backupRun.error && (
            <button className="link backup-pill" onClick={() => setPage('backup')} title="Backup running">
              ⛁ {backupRun.jobName} · {backupRun.index + 1}/{backupRun.total || '?'}
            </button>
          )}
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
          {shownPages
            .filter((p) => p.id !== 'settings')
            .map((p) => (
              <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)}>
                <span className="icon">{p.icon}</span>
                {p.label}
              </button>
            ))}
          {shownLocal.length > 0 && <div className="nav-section">Local app</div>}
          {shownLocal.map((p) => (
            <button key={p.id} className={page === p.id ? 'active' : ''} onClick={() => setPage(p.id)}>
              <span className="icon">{p.icon}</span>
              {p.label}
            </button>
          ))}
          {/* Settings last, under everything else */}
          <div className="nav-spacer" />
          <button className={page === 'settings' ? 'active' : ''} onClick={() => setPage('settings')}>
            <span className="icon">⚙</span>
            Settings
          </button>
        </nav>
        <main className={localPage ? 'local' : ''}>
          {localPage && <LocalAppPage page={localPage.page} />}
          {page === 'project' && (
            <ProjectPage
              studio={studio}
              onOpenMetadata={() => setPage('metadata')}
              onOpenSettings={() => setPage('settings')}
              onOpenCode={() => setPage('code')}
            />
          )}
          {page === 'settings' && (
            <SettingsPage
              hostKind={host.kind}
              onOpenProject={() => setPage('project')}
              orgs={orgs}
              orgId={orgId}
              onSwitchOrg={switchOrg}
              onRefreshOrgs={loadOrgs}
            />
          )}
          {page === 'tests' && project.localAppReady && (
            <TestsPage hostKind={host.kind} defaultOrg={host.kind === 'app' ? org?.id : undefined} />
          )}
          {!localPage && !['project', 'tests', 'settings'].includes(page) && error && (
            <div className="error">{error}</div>
          )}
          {!localPage && !['project', 'tests', 'settings'].includes(page) && !error && !studio && (
            <p className="muted">
              {orgs.length || host.kind === 'extension' ? 'Connecting…' : 'No orgs. Connect one in NomadSF → Orgs.'}
            </p>
          )}
          {!localPage && !['project', 'tests', 'settings'].includes(page) && studio && (
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
                {page === 'code' && <CodePage />}
                {page === 'backup' && <BackupPage orgs={orgs} clientFor={clientFor} />}
                {page === 'events' && <EventsPage />}
                {page === 'fields' && <FieldUsagePage />}
                {page === 'lookup' && <LookupPage />}
                {page === 'orgdiff' && <OrgComparePage orgs={orgs} />}
                {page === 'apextests' && <ApexTestsPage />}
              </InspectContext.Provider>
            </StudioContext.Provider>
          )}
        </main>
      </div>
    </ProjectStateContext.Provider>
  );
}
