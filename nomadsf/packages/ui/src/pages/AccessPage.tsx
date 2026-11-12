import { useState, type ReactNode } from 'react';
import { Select } from '../components/Select';
import { auditTrail, loginHistory, type QueryResult } from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { PermissionsExplorer } from '../components/PermissionsExplorer';
import { UserSnapshot } from '../components/UserSnapshot';
import { UserEditor } from '../components/UserEditor';
import { WhoHasIt } from '../components/WhoHasIt';
import { CompareAccess } from '../components/CompareAccess';
import { storage, useStudio } from '../context';
import { NewPermissionSet } from './AccessManagePages';
import { Status } from '../statusLog';

/** A tool of the Access hub: its title, what it is about, then the tool. */
function AccessTool({ title, about, children }: { title: string; about: string; children: ReactNode }) {
  const { org } = useStudio();
  return (
    <div className="page">
      <div className="toolbar">
        <h2>{title}</h2>
        <span className="muted">
          {about} on {org.label}
        </span>
      </div>
      {children}
    </div>
  );
}

type UsersTab = 'find' | 'snapshot' | 'holders';

/** Access › Users: find a user, edit them and everything they have; or restore one from a snapshot file. */
export function UsersPage() {
  const [tab, setTab] = useState<UsersTab>(() => storage.get<UsersTab>('users.page', 'find'));
  const pick = (t: UsersTab) => {
    setTab(t);
    storage.set('users.page', t);
  };
  return (
    <AccessTool title="Users" about="a user and everything they have">
      <div className="tabs" role="tablist">
        {(
          [
            ['find', 'Find a user'],
            ['snapshot', 'Restore from a snapshot'],
            ['holders', 'Users of a role, license or group'],
          ] as Array<[UsersTab, string]>
        ).map(([id, label]) => (
          <button key={id} role="tab" className={`tab ${tab === id ? 'active' : ''}`} onClick={() => pick(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'find' && <UserEditor />}
      {tab === 'snapshot' && <UserSnapshot />}
      {/* Profiles, permission sets and groups show their users in Access sets */}
      {tab === 'holders' && <WhoHasIt kinds={['role', 'license', 'publicGroup', 'queue']} />}
    </AccessTool>
  );
}

/**
 * Access › Access sets: a profile, permission set or permission set group in one place: what it allows (and editing
 * it), who has it, and assigning it. Creating a permission set or group starts here too.
 */
export function AccessSetsPage() {
  const [created, setCreated] = useState(0);
  return (
    <AccessTool title="Access sets" about="profiles, permission sets and groups: what each allows, who has it">
      {/* Creating one is its own job: a box of its own, closed until you open it */}
      <details className="card section create-box">
        <summary>
          <b>+ New permission set or group</b>{' '}
          <span className="muted">a permission set, or a group of permission sets</span>
        </summary>
        <NewPermissionSet onCreated={() => setCreated((n) => n + 1)} />
      </details>
      <PermissionsExplorer reloadKey={created} />
    </AccessTool>
  );
}

/** Access › Compare: two users, profiles, permission sets or groups. */
export function ComparePage() {
  return (
    <AccessTool title="Compare" about="two users, profiles, permission sets or groups">
      <CompareAccess />
    </AccessTool>
  );
}

/** Access › Logins & audit: login history and the setup audit trail. */
export function LoginsAuditPage() {
  const { client, org } = useStudio();
  const instanceUrl = org.instanceUrl;
  type Tab = 'login' | 'audit';
  const [tab, setTab] = useState<Tab>(() => storage.get('audit.tab', 'login'));

  // ---------- login history / audit trail ----------
  const [log, setLog] = useState<{ title: string; result: QueryResult } | null>(null);
  const [logStatus, setLogStatus] = useState('');
  const [loginDays, setLoginDays] = useState(7);
  const [auditDays, setAuditDays] = useState(30);
  const load = async (title: string, fn: () => Promise<QueryResult>) => {
    setLogStatus(`Loading ${title.toLowerCase()}…`);
    try {
      setLog({ title, result: await fn() });
      setLogStatus('');
    } catch (e) {
      setLogStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <AccessTool title="Logins & audit" about="login history and the setup audit trail">
      <div className="tabs">
        {(
          [
            ['login', 'Login history'],
            ['audit', 'Setup audit trail'],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            className={`tab ${tab === id ? 'active' : ''}`}
            onClick={() => {
              setTab(id);
              storage.set('audit.tab', id);
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'login' && (
        <>
          <div className="card form">
            <h3 style={{ margin: 0, width: '100%' }}>Login history</h3>
            <label>
              Last
              <Select value={loginDays} onChange={(e) => setLoginDays(Number(e.target.value))}>
                {[1, 7, 30, 90, 180].map((d) => (
                  <option key={d} value={d}>
                    {d} day(s)
                  </option>
                ))}
              </Select>
            </label>
            <button
              className="primary"
              onClick={() => void load('Login history', () => loginHistory(client, loginDays))}
            >
              Load
            </button>
          </div>
          {logStatus && <Status text={logStatus} block />}
          {log && log.title === 'Login history' && log.result.rows.length === 0 && <EmptyHint what="entries" />}
          {log && log.title === 'Login history' && (
            <div className="card section">
              <h3>{log.title}</h3>
              <DataTable
                columns={log.result.columns}
                rows={log.result.rows}
                name={`${org.label}-${log.title}`}
                instanceUrl={instanceUrl}
                rowKey="__none"
              />
            </div>
          )}
        </>
      )}
      {tab === 'audit' && (
        <>
          <div className="card form">
            <h3 style={{ margin: 0, width: '100%' }}>Setup audit trail</h3>
            <label>
              Last
              <Select value={auditDays} onChange={(e) => setAuditDays(Number(e.target.value))}>
                {[7, 30, 90, 180].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </Select>
            </label>
            <button
              className="primary"
              onClick={() => void load('Setup audit trail', () => auditTrail(client, auditDays))}
            >
              Load
            </button>
          </div>
          {logStatus && <Status text={logStatus} block />}
          {log && log.title === 'Setup audit trail' && log.result.rows.length === 0 && <EmptyHint what="entries" />}
          {log && log.title === 'Setup audit trail' && (
            <div className="card section">
              <h3>{log.title}</h3>
              <DataTable
                columns={log.result.columns}
                rows={log.result.rows}
                name={`${org.label}-${log.title}`}
                instanceUrl={instanceUrl}
                rowKey="__none"
              />
            </div>
          )}
        </>
      )}
    </AccessTool>
  );
}
