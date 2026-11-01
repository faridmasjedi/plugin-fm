import { useEffect, useState } from 'react';
import { appUsersInBoth, compareConnectedApps, type AppComparison, type AppUser } from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { UserComparison } from '../components/UserComparison';
import { OrgPairBar, usePairClients } from '../pair';
import { Status } from '../statusLog';

type Show = 'all' | AppComparison['status'];

/** Org to org › Connected apps: which apps exist in A and B, and for apps in both their settings and who may use them. */
export function OrgAppsPage() {
  const { a, b, clientA, clientB, error } = usePairClients();
  const [apps, setApps] = useState<AppComparison[] | null>(null);
  const [status, setStatus] = useState('');
  const [show, setShow] = useState<Show>('all');
  const [chosen, setChosen] = useState('');
  // Who uses the chosen app in A and B, and one person picked to compare
  const [users, setUsers] = useState<AppUser[] | null>(null);
  const [person, setPerson] = useState<AppUser | null>(null);
  useEffect(() => {
    setUsers(null);
    setPerson(null);
    if (!chosen || !clientA || !clientB) return;
    appUsersInBoth(clientA, clientB, chosen)
      .then(setUsers)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [clientA, clientB, chosen]);

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
      {status && <Status text={status} block />}
      {apps && (
        <>
          <div className="segmented" role="group" aria-label="Show">
            {(['all', 'only in A', 'only in B', 'different', 'same', 'not read in A', 'not read in B'] as Show[])
              .filter((s) => !s.startsWith('not read') || count(s) > 0)
              .map((s) => (
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
                · A = {a?.label}, B = {b?.label} · click an app for its users in both orgs (and, when in both, its
                settings)
              </span>
            }
          />
          {app && (
            <div className="section">
              <h3>{app.name}</h3>
              <h4>Users in A and B</h4>
              {!users ? (
                <p className="muted">Reading the OAuth users of both orgs…</p>
              ) : users.length === 0 ? (
                <EmptyHint what="users of this app (OAuth tokens)" />
              ) : (
                <DataTable
                  columns={['Name', 'in', 'usernameA', 'usernameB', 'usesA', 'usesB', 'lastUsedA', 'lastUsedB']}
                  rows={users.map((u) => ({ ...u, key: `${u.idA}|${u.idB}` }))}
                  rowKey="key"
                  name={`${app.name}-users-a-b`}
                  selectedKey={person ? `${person.idA}|${person.idB}` : undefined}
                  onRowClick={(row) => setPerson(users.find((u) => `${u.idA}|${u.idB}` === row.key) ?? null)}
                  note={
                    <span>
                      · people who connected the app with OAuth, matched by username · click one in both to compare them
                    </span>
                  }
                />
              )}
              {person && person.in !== 'both' && (
                <p className="muted">
                  {person.Name} uses {app.name}{' '}
                  {person.in === 'only in A' ? `only in ${a?.label}` : `only in ${b?.label}`}: nobody to compare with.
                  Org to org › Access finds them in the other org by username.
                </p>
              )}
              {person && person.in === 'both' && clientA && clientB && (
                <UserComparison
                  key={`${person.idA}-${person.idB}`}
                  client={clientA}
                  clientB={clientB}
                  userA={person.idA}
                  userB={person.idB}
                  labelA={`${person.Name} (${a?.label ?? 'A'})`}
                  labelB={`${person.Name} (${b?.label ?? 'B'})`}
                  orgB={b?.label ?? 'B'}
                  twoOrgs
                />
              )}
              {(app.status === 'only in A' || app.status === 'only in B') && (
                <p className="muted">The app itself is {app.status}: no settings to compare.</p>
              )}
            </div>
          )}
          {app && (app.status === 'not read in A' || app.status === 'not read in B') && (
            <p className="muted">
              {app.name} could not be compared: the {app.status === 'not read in A' ? 'A' : 'B'} org did not let us read
              its list of {(app.status === 'not read in A' ? app.kindB : app.kindA) || 'apps'} ({status || 'see above'}
              ).
            </p>
          )}
          {app && (app.status === 'same' || app.status === 'different') && (
            <div className="section">
              <h4>The app in A and in B</h4>
              <p className="muted">
                Its OAuth settings (admin-approved users only, refresh-token and session policies, start URL…) and the
                profiles and permission sets pre-authorized to use it, side by side.
              </p>
              {app.differences.length ? (
                <DataTable
                  columns={['area', 'item', 'a', 'b']}
                  groupBy="area"
                  rows={app.differences.map((d, i) => ({ ...d, key: i }))}
                  rowKey="key"
                  name={`${app.name}-compare`}
                  note={<span>· only the differences</span>}
                />
              ) : (
                <p className="good">
                  ✓ {app.name} has the same settings in both orgs, and the same profiles and permission sets may use it.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
