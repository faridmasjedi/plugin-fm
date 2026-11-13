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
import { TableTabs } from '../components/TableTabs';
import { DataTable, EmptyHint } from '../components/DataTable';
import { ManagedList } from '../components/ManagedList';
import { storage, useStudio } from '../context';
import { Status } from '../statusLog';
import { ConfigItemView, useConfigItems } from './AppConfigPage';
import type { ConfigItem } from '@nomadsf/core';

type View = 'apps' | 'credentials' | 'users' | 'tokens';
/** One line of the app list: an app used here, defined here, or both. */
type AppRow = { key: string; name: string; kind: string; defined: string; usage?: OAuthApp; config?: ConfigItem };

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

/**
 * Org › Apps & credentials: every app the org uses or defines (connected apps, external client apps, OAuth-only apps
 * like Salesforce CLI) — who uses it, its tokens, its policies and who may use it, and, for an app defined here, every
 * setting to change — and the named and external credentials. Each count opens its list.
 */
export function ConnectedAppsPage() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [report, setReport] = useState<ConnectedAppsReport | null>(null);
  const [status, setStatus] = useState('');
  const [view, setView] = useState<View>(() => {
    const kept = storage.get<string>('apps.view3', 'apps');
    return (['apps', 'credentials', 'users', 'tokens'] as string[]).includes(kept) ? (kept as View) : 'apps';
  });
  const [chosen, setChosen] = useState('');
  const config = useConfigItems();
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
    setChosen('');
    setUserId('');
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const choose = (next: View) => {
    setView(next);
    setChosen('');
    setUserId('');
    setPicked(new Set());
    storage.set('apps.view3', next);
  };

  const appRows = useMemo((): AppRow[] => {
    const defined = (config.items ?? []).filter((i) => i.kind === 'Connected app' || i.kind === 'External client app');
    const used = report?.apps ?? [];
    const rows: AppRow[] = [];
    const taken = new Set<ConfigItem>();
    for (const u of used) {
      const c = defined.find((i) => [i.label, i.name].some((n) => n.toLowerCase() === u.name.toLowerCase()));
      if (c) taken.add(c);
      rows.push({
        key: `app:${u.name}`,
        name: u.name,
        kind: u.kind,
        defined: c ? 'this org' : 'elsewhere',
        usage: u,
        config: c,
      });
    }
    for (const c of defined.filter((i) => !taken.has(i)))
      rows.push({ key: `app:${c.label}`, name: c.label, kind: c.kind, defined: 'this org', config: c });
    return rows.sort((a, b) => a.name.localeCompare(b.name));
  }, [report, config.items]);
  const credentials = (config.items ?? []).filter(
    (i) => i.kind === 'Named credential' || i.kind === 'External credential'
  );
  const appRow = appRows.find((a) => a.key === chosen);
  const credential = credentials.find((c) => `cred:${c.kind}:${c.name}` === chosen);
  const app = appRow?.usage ?? null;
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

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Apps &amp; credentials</h2>
        <span className="muted">
          The apps {org.label} uses or defines, its credentials, and who connects with OAuth
        </span>
        <span className="grow" />
        <button
          onClick={() => {
            void load();
            void config.reload();
          }}
        >
          Refresh
        </button>
      </div>
      {status && <Status text={status} block />}
      {report && (
        <>
          <div className="metrics">
            {metric('apps', appRows.length, 'apps')}
            {metric('credentials', config.items === null ? 0 : credentials.length, 'credentials')}
            {metric('users', users.length, 'users with OAuth tokens')}
            {metric('tokens', tokens.length, 'OAuth tokens')}
          </div>

          {view === 'apps' &&
            (appRows.length === 0 ? (
              <EmptyHint what="apps" />
            ) : (
              <DataTable
                columns={['name', 'kind', 'defined', 'users', 'tokens', 'uses', 'lastUsed']}
                rows={appRows.map((r) => ({
                  key: r.key,
                  name: r.name,
                  kind: r.kind,
                  defined: r.defined,
                  users: r.usage?.users ?? '',
                  tokens: r.usage?.tokens ?? '',
                  uses: r.usage?.uses ?? '',
                  lastUsed: r.usage?.lastUsed ?? '',
                }))}
                rowKey="key"
                name={`${org.label}-apps`}
                selectedKey={chosen}
                onRowClick={(row) => {
                  setChosen(String(row.key));
                  setPicked(new Set());
                }}
                note={
                  <span>
                    · defined “this org”: every setting can be changed here; “elsewhere”: Salesforce or a package made
                    it (e.g. Salesforce CLI) · click an app for its users, policies and settings
                    {config.items === null ? ' · reading the settings…' : ''}
                  </span>
                }
              />
            ))}
          {view === 'apps' && appRow && (
            <div className="card section app-detail">
              <div className="item-head">
                <span className="pill">{appRow.kind}</span>
                <b>{appRow.name}</b>
                <span className="muted small">defined {appRow.defined}</span>
              </div>
              <TableTabs
                key={appRow.key}
                tabs={[
                  {
                    id: 'users',
                    label: 'Who uses it',
                    count: tokens.filter((t) => String(t.App).toLowerCase() === appRow.name.toLowerCase()).length,
                    content: tokenTable(
                      tokens.filter((t) => String(t.App).toLowerCase() === appRow.name.toLowerCase()),
                      `${org.label}-${appRow.name}-users`,
                      `who connected ${appRow.name}`
                    ),
                  },
                  ...(app?.id && app.kind === 'Connected app'
                    ? [{ id: 'policies', label: 'Policies & who may use it', content: <AppDetails appId={app.id} /> }]
                    : []),
                  {
                    id: 'settings',
                    label: appRow.config ? 'Settings' : 'Settings (elsewhere)',
                    count: appRow.config ? undefined : undefined,
                    content: appRow.config ? (
                      <ConfigItemView item={appRow.config} onDeployed={config.reload} />
                    ) : (
                      <p className="muted">
                        {appRow.name} is defined elsewhere (by Salesforce, a package or another org): its own settings
                        are not this org’s to change. What this org decides — who may use it, its policies — is under{' '}
                        {app?.id && app.kind === 'Connected app'
                          ? 'Policies & who may use it'
                          : 'Setup › Connected Apps › Manage'}
                        .
                      </p>
                    ),
                  },
                ]}
              />
            </div>
          )}

          {view === 'credentials' &&
            (config.items === null ? (
              <p className="muted">Reading the credentials…</p>
            ) : credentials.length === 0 ? (
              <EmptyHint what="named or external credentials" />
            ) : (
              <DataTable
                columns={['kind', 'label', 'name']}
                rows={credentials.map((c) => ({
                  key: `cred:${c.kind}:${c.name}`,
                  kind: c.kind,
                  label: c.label,
                  name: c.name,
                }))}
                rowKey="key"
                name={`${org.label}-credentials`}
                selectedKey={chosen}
                onRowClick={(row) => setChosen(String(row.key))}
                note={<span>· click one for every setting, to change · passwords and secrets stay in Setup</span>}
              />
            ))}
          {view === 'credentials' && credential && (
            <div className="card section app-detail">
              <div className="item-head">
                <span className="pill">{credential.kind}</span>
                <b>{credential.label}</b>
                <span className="muted small mono">{credential.name}</span>
              </div>
              <ConfigItemView
                key={`${credential.kind}:${credential.name}`}
                item={credential}
                onDeployed={config.reload}
              />
            </div>
          )}
          {config.error && <Status text={`❌ Settings could not be read: ${config.error}`} block />}

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
      <TableTabs
        tabs={[
          {
            id: 'settings',
            label: 'Settings',
            count: settings.length,
            content: (
              <>
                {!details ? (
                  <p className="muted">Reading…</p>
                ) : (
                  <DataTable
                    columns={['Setting', 'Value']}
                    rows={settings}
                    rowKey="Setting"
                    name={`app-${appId}-settings`}
                  />
                )}
              </>
            ),
          },
          {
            id: 'preauthorized',
            label: 'Pre-authorized profiles and permission sets',
            count: holders?.length,
            content: (
              <>
                <p className="muted">
                  Counts when the app's OAuth policy is "Admin approved users are pre-authorized"
                  {details && 'OptionsAllowAdminApprovedUsersOnly' in details
                    ? ` (here: ${
                        details.OptionsAllowAdminApprovedUsersOnly ? 'yes' : 'no — all users may self-authorize'
                      })`
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
            ),
          },
        ]}
      />
    </>
  );
}
