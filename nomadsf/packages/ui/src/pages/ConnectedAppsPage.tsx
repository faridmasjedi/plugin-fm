import { useEffect, useMemo, useState } from 'react';
import {
  connectedAppDetails,
  connectedAppsReport,
  grantSetupAccess,
  permissionHolders,
  revokeSetupAccess,
  revokeTokens,
  setupAccessHolders,
  type ConnectedAppsReport,
  type OAuthApp,
  type PermissionHolder,
  type Row,
} from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { ManagedList } from '../components/ManagedList';
import { storage, useStudio } from '../context';
import { Status } from '../statusLog';

type View = 'connected' | 'external' | 'users' | 'tokens';

/** Settings worth seeing first, when the org returns them. */
const KEY_SETTINGS = [
  'Name',
  'OptionsAllowAdminApprovedUsersOnly',
  'OptionsRefreshTokenValidityMetric',
  'RefreshTokenValidityPeriod',
  'OptionsHasSessionLevelPolicy',
  'OptionsIsInternal',
  'OptionsFullContentPushNotifications',
  'StartUrl',
  'MobileStartUrl',
  'MobileSessionTimeout',
  'PinLength',
  'CreatedDate',
  'LastModifiedDate',
];

const fail = (r: { errors: string[] }): void => {
  if (r.errors.length) throw new Error(r.errors.join('; '));
};

/** Connected apps, external client apps and OAuth usage: each count opens its list; apps and users open their details. */
export function ConnectedAppsPage() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [report, setReport] = useState<ConnectedAppsReport | null>(null);
  const [status, setStatus] = useState('');
  const [view, setView] = useState<View>(() => storage.get('apps.view2', 'connected'));
  const [app, setApp] = useState<OAuthApp | null>(null);
  const [userId, setUserId] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  const load = async () => {
    setStatus('Reading connected apps and OAuth tokens…');
    try {
      const next = await connectedAppsReport(client);
      setReport(next);
      setPicked(new Set());
      setStatus(next.notes.length ? `Some lists could not be read: ${next.notes.join(' · ')}` : '');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    setReport(null);
    setApp(null);
    setUserId('');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const choose = (next: View) => {
    setView(next);
    setApp(null);
    setUserId('');
    setPicked(new Set());
    storage.set('apps.view2', next);
  };

  const apps = report?.apps ?? [];
  const tokens = report?.tokens ?? [];
  const users = useMemo(() => {
    const byUser = new Map<string, Row & { apps: Set<string> }>();
    for (const t of tokens) {
      const id = String(t.UserId);
      const u = byUser.get(id) ?? {
        Id: id,
        User: t.User,
        Username: t.Username,
        Active: t.Active,
        Uses: 0,
        LastUsed: '',
        apps: new Set<string>(),
      };
      u.Uses = Number(u.Uses) + Number(t.Uses ?? 0);
      if (String(t.LastUsed ?? '') > String(u.LastUsed)) u.LastUsed = t.LastUsed;
      u.apps.add(String(t.App));
      byUser.set(id, u);
    }
    return [...byUser.values()]
      .map(({ apps: a, ...u }): Row => ({ ...u, Apps: [...a].sort().join(', '), AppCount: a.size }))
      .sort((a, b) => String(a.User).localeCompare(String(b.User)));
  }, [tokens]);

  const revoke = async (ids: string[]) => {
    if (!ids.length) return;
    if (
      !(await confirmChange(
        `Revoke ${ids.length} OAuth token(s) in ${org.label} (those users connect again next time)`
      ))
    )
      return;
    setStatus('Revoking…');
    try {
      await revokeTokens(client, ids);
      logActivity('revoke oauth tokens', { count: ids.length });
      await load();
      setStatus(`✓ Revoked ${ids.length} token(s).`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const tokenTable = (rows: Row[], name: string, note: string) =>
    rows.length === 0 ? (
      <EmptyHint what="OAuth tokens" />
    ) : (
      <>
        <DataTable
          columns={['App', 'User', 'Username', 'Active', 'Uses', 'LastUsed', 'Connected']}
          rows={rows}
          rowKey="Id"
          name={name}
          selected={picked}
          onSelectedChange={setPicked}
          note={<span>· {note} · tick tokens to revoke them</span>}
        />
        {picked.size > 0 && (
          <div className="form">
            <button className="danger" onClick={() => void revoke([...picked])}>
              Revoke {picked.size} token(s)…
            </button>
          </div>
        )}
      </>
    );

  const metric = (id: View, count: number, label: string) => (
    <button
      className={`metric filter ${view === id ? 'active' : ''}`}
      onClick={() => choose(id)}
      title={`Show the ${label}`}
    >
      <b>{count}</b>
      {label}
    </button>
  );
  const appList = apps.filter((a) =>
    view === 'connected' ? a.kind !== 'External client app' : a.kind === 'External client app'
  );

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Connected apps</h2>
        <span className="muted">Connected apps, external client apps and OAuth usage on {org.label}</span>
        <span className="grow" />
        <button onClick={() => void load()}>Refresh</button>
      </div>
      {status && <Status text={status} block />}
      {report && (
        <>
          <div className="metrics">
            {metric('connected', apps.filter((a) => a.kind !== 'External client app').length, 'connected apps')}
            {metric('external', apps.filter((a) => a.kind === 'External client app').length, 'external client apps')}
            {metric('users', users.length, 'users with OAuth tokens')}
            {metric('tokens', tokens.length, 'OAuth tokens')}
          </div>

          {(view === 'connected' || view === 'external') &&
            (appList.length === 0 ? (
              <EmptyHint what={view === 'connected' ? 'connected apps' : 'external client apps'} />
            ) : (
              <DataTable
                columns={['name', 'kind', 'users', 'tokens', 'uses', 'lastUsed', 'created']}
                rows={appList.map((a) => ({ ...a }))}
                rowKey="name"
                name={`${org.label}-apps`}
                selectedKey={app?.name}
                onRowClick={(row) => {
                  setApp(apps.find((a) => a.name === row.name) ?? null);
                  setPicked(new Set());
                }}
                note={
                  <span>
                    · click an app for its users{view === 'connected' ? ' and settings' : ''} · "OAuth only": tokens but
                    no app in this org (e.g. Salesforce CLI)
                  </span>
                }
              />
            ))}
          {app && (view === 'connected' || view === 'external') && (
            <div className="section">
              <h3>{app.name}</h3>
              {app.id && app.kind === 'Connected app' && <AppDetails appId={app.id} />}
              <h4>
                Users ({tokens.filter((t) => String(t.App).toLowerCase() === app.name.toLowerCase()).length} tokens)
              </h4>
              {tokenTable(
                tokens.filter((t) => String(t.App).toLowerCase() === app.name.toLowerCase()),
                `${org.label}-${app.name}-users`,
                `who connected ${app.name}`
              )}
            </div>
          )}

          {view === 'users' &&
            (users.length === 0 ? (
              <EmptyHint what="users with OAuth tokens" />
            ) : (
              <DataTable
                columns={['User', 'Username', 'Active', 'AppCount', 'Apps', 'Uses', 'LastUsed']}
                rows={users}
                rowKey="Id"
                name={`${org.label}-oauth-users`}
                selectedKey={userId}
                onRowClick={(row) => {
                  setUserId(String(row.Id));
                  setPicked(new Set());
                }}
                note={<span>· click a user for their tokens</span>}
              />
            ))}
          {view === 'users' && userId && (
            <div className="section">
              <h3>{String(users.find((u) => u.Id === userId)?.User ?? '')}</h3>
              {tokenTable(
                tokens.filter((t) => String(t.UserId) === userId),
                `${org.label}-user-tokens`,
                'the apps this user connected'
              )}
            </div>
          )}

          {view === 'tokens' &&
            tokenTable(tokens, `${org.label}-oauth-tokens`, 'every user and the apps they connected')}
        </>
      )}
    </div>
  );
}

/** A connected app's settings, and the profiles and permission sets that may use it (pre-authorized). */
function AppDetails({ appId }: { appId: string }) {
  const { client } = useStudio();
  const [details, setDetails] = useState<Row | null>(null);
  const [holders, setHolders] = useState<Row[] | null>(null);
  const [all, setAll] = useState<PermissionHolder[] | null>(null);
  const [status, setStatus] = useState('');
  const loadHolders = () =>
    setupAccessHolders(client, appId)
      .then(setHolders)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  useEffect(() => {
    setDetails(null);
    setHolders(null);
    connectedAppDetails(client, appId)
      .then(setDetails)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
    void loadHolders();
    permissionHolders(client)
      .then(setAll)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, appId]);

  const settings = details
    ? [
        ...KEY_SETTINGS.filter((k) => k in details),
        ...Object.keys(details)
          .filter((k) => !KEY_SETTINGS.includes(k) && k !== 'Id' && !k.includes('.'))
          .sort(),
      ].map((k) => ({ Setting: k, Value: details[k] === null || details[k] === undefined ? '' : String(details[k]) }))
    : [];
  return (
    <>
      {status && <Status text={status} block />}
      <h4>Settings</h4>
      {!details ? (
        <p className="muted">Reading…</p>
      ) : (
        <DataTable columns={['Setting', 'Value']} rows={settings} rowKey="Setting" name={`app-${appId}-settings`} />
      )}
      <h4>Pre-authorized: profiles and permission sets that may use it</h4>
      <p className="muted">
        Counts when the app's OAuth policy is "Admin approved users are pre-authorized"
        {details && 'OptionsAllowAdminApprovedUsersOnly' in details
          ? ` (here: ${details.OptionsAllowAdminApprovedUsersOnly ? 'yes' : 'no — all users may self-authorize'})`
          : ''}
        .
      </p>
      {!holders ? (
        <p className="muted">Reading…</p>
      ) : (
        <ManagedList
          rows={holders}
          columns={['Name', 'Kind']}
          what="profile or permission set"
          whatPlural="profiles or permission sets"
          removeKey="AccessId"
          onRemove={async (r) => fail(await revokeSetupAccess(client, [String(r.AccessId)]))}
          choices={(all ?? [])
            .filter((h) => h.kind !== 'Permission set group')
            .filter((h) => !holders.some((x) => String(x.PermissionSetId).slice(0, 15) === h.id.slice(0, 15)))
            .map((h) => ({ id: h.id, label: h.name, detail: h.kind }))}
          addLabel="Pre-authorize a profile or permission set"
          onAdd={async (c) => fail(await grantSetupAccess(client, c.id, [appId]))}
          onChanged={() => void loadHolders()}
        />
      )}
    </>
  );
}
