import { useEffect, useState } from 'react';
import {
  connectedAppPicks,
  findUsers,
  integrationCheck,
  type CheckArea,
  type ConnectedAppPick,
  type IntegrationFinding,
} from '@nomadsf/core';
import { Select } from '../components/Select';
import { useStudio } from '../context';
import { Status } from '../statusLog';

type UserPick = { Id: string; Name: string; Username: string };
const AREAS: CheckArea[] = ['User', 'Permissions', 'Logins', 'Connected app', 'Certificates', 'Endpoints'];
const ICON: Record<IntegrationFinding['level'], string> = { ok: '✓', warn: '⚠', bad: '✗', info: 'ℹ' };

/**
 * Security › Integration check: an integration user (and its connected app) checked from end to end — the user, its
 * API permission, its recent logins with Salesforce's reason for each failure, the app's policy and tokens, the
 * certificates and endpoints — each problem with what to do. Read only.
 */
export function IntegrationCheckPage() {
  const { client, org } = useStudio();
  const [typed, setTyped] = useState('');
  const [users, setUsers] = useState<UserPick[]>([]);
  const [user, setUser] = useState<UserPick | null>(null);
  const [apps, setApps] = useState<ConnectedAppPick[]>([]);
  const [appId, setAppId] = useState('');
  const [days, setDays] = useState('30');
  const [found, setFound] = useState<IntegrationFinding[] | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setApps([]);
    connectedAppPicks(client)
      .then(setApps)
      .catch(() => setApps([]));
  }, [client]);
  useEffect(() => {
    if (typed.trim().length < 2 || user) return undefined;
    const t = setTimeout(
      () =>
        void findUsers(client, { names: [typed.trim()] })
          .then((list) => setUsers(list.slice(0, 20) as unknown as UserPick[]))
          .catch(() => setUsers([])),
      300
    );
    return () => clearTimeout(t);
  }, [typed, client, user]);

  const check = async () => {
    if (!user) return;
    setBusy(true);
    setFound(null);
    setStatus('Checking…');
    try {
      setFound(await integrationCheck(client, user.Id, { appId: appId || undefined, days: Number(days) }));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const problems = found?.filter((f) => f.level === 'bad').length ?? 0;
  const warnings = found?.filter((f) => f.level === 'warn').length ?? 0;

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Integration check</h2>
        <span className="muted">
          Why an integration fails in {org.label}: its user, logins, connected app and certificates
        </span>
      </div>
      <div className="form">
        {user ? (
          <span className="who-user">
            <b>{user.Name}</b>
            <span className="muted">{user.Username}</span>
            <button
              onClick={() => {
                setUser(null);
                setFound(null);
              }}
            >
              Change
            </button>
          </span>
        ) : (
          <span className="who-pick">
            <input
              style={{ minWidth: 320 }}
              placeholder="Integration user: name, username or email"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
            {users.length > 0 && (
              <Select
                value=""
                onChange={(e) => {
                  setUser(users.find((u) => u.Id === e.target.value) ?? null);
                  setUsers([]);
                }}
              >
                <option value="">{users.length} user(s)…</option>
                {users.map((u) => (
                  <option key={u.Id} value={u.Id}>
                    {u.Name} — {u.Username}
                  </option>
                ))}
              </Select>
            )}
          </span>
        )}
      </div>
      <div className="form">
        <label>
          Connected app
          <Select value={appId} onChange={(e) => setAppId(e.target.value)}>
            <option value="">Any (not checked)</option>
            {apps.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </label>
        <label>
          Logins of the last
          <Select value={days} onChange={(e) => setDays(e.target.value)}>
            {['7', '30', '90'].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </Select>
        </label>
        <button className="primary" disabled={busy || !user} onClick={() => void check()}>
          Check
        </button>
      </div>
      {status && <Status text={status} block />}
      {found && (
        <div className="card section">
          <p className={`integration-summary ${problems ? 'bad' : warnings ? 'warn' : 'good'}`}>
            {problems
              ? `${problems} problem(s) that can stop the integration${warnings ? `, ${warnings} to watch` : ''}.`
              : warnings
              ? `Nothing blocking; ${warnings} to watch.`
              : 'Nothing found that would stop it.'}
          </p>
          {AREAS.filter((a) => found.some((f) => f.area === a)).map((area) => (
            <div key={area} className="integration-area">
              <h4>{area}</h4>
              <ul>
                {found
                  .filter((f) => f.area === area)
                  .map((f, i) => (
                    <li key={i} className={`finding ${f.level}`}>
                      <span className="finding-icon">{ICON[f.level]}</span>
                      <span>
                        {f.text}
                        {f.fix && <span className="finding-fix">→ {f.fix}</span>}
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
          <p className="muted small">
            Read from the org only. The caller’s own side (its URL, key file, network) is not visible from here: a login
            that never shows up in Logins never reached Salesforce.
          </p>
        </div>
      )}
    </div>
  );
}
