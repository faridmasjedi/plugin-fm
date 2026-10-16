import { useEffect, useMemo, useState } from 'react';
import {
  assignAccess,
  assignments,
  auditTrail,
  findUsers,
  listPermissionSets,
  loginHistory,
  removeAccess,
  type AccessTarget,
  type QueryResult,
  type Row,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { useStudio } from '../context';

type By = 'usernames' | 'profile' | 'role' | 'publicGroup';
const BY_LABEL: Record<By, string> = {
  usernames: 'Usernames (comma or new line)',
  profile: 'Profile name',
  role: 'Role name',
  publicGroup: 'Public group (API or label name)',
};

export function AccessPage() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const instanceUrl = org.instanceUrl;

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

  // ---------- permission sets ----------
  const [targets, setTargets] = useState<AccessTarget[]>([]);
  const [filter, setFilter] = useState('');
  const [targetId, setTargetId] = useState('');
  const [assigned, setAssigned] = useState<QueryResult | null>(null);
  const [assignedSel, setAssignedSel] = useState<Set<string>>(new Set());
  const [by, setBy] = useState<By>('usernames');
  const [value, setValue] = useState('');
  const [expires, setExpires] = useState('');
  const [users, setUsers] = useState<Row[]>([]);
  const [userSel, setUserSel] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');

  useEffect(() => {
    listPermissionSets(client)
      .then(setTargets)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client]);
  const target = targets.find((t) => t.id === targetId);
  const shown = useMemo(
    () => targets.filter((t) => !filter || `${t.label} ${t.name}`.toLowerCase().includes(filter.toLowerCase())),
    [targets, filter]
  );

  const loadAssigned = async (t = target) => {
    if (!t) return;
    try {
      setAssigned(await assignments(client, t));
      setAssignedSel(new Set());
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  // Reload the assignees whenever another permission set is chosen
  useEffect(() => {
    void loadAssigned();
  }, [targetId]);

  const find = async () => {
    try {
      const list = await findUsers(
        client,
        by === 'usernames' ? { usernames: value.split(/[\s,;]+/).filter(Boolean) } : { [by]: value.trim() }
      );
      setUsers(list);
      setUserSel(new Set(list.map((u) => String(u.Id))));
      setStatus(`${list.length} active user(s) found.`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const assign = async () => {
    if (!target || userSel.size === 0) return;
    if (!confirmChange(`Assign "${target.label}" to ${userSel.size} user(s) in ${org.label}.`)) return;
    try {
      const r = await assignAccess(client, target, [...userSel], expires || undefined);
      setStatus(
        `Assigned ${r.assigned}, already had it ${r.skipped}.${
          r.errors.length ? ` Errors: ${r.errors.join('; ')}` : ''
        }`
      );
      logActivity('assign-access', {
        target: target.name,
        kind: target.kind,
        assigned: r.assigned,
        skipped: r.skipped,
        errors: r.errors.length,
      });
      await loadAssigned();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const remove = async () => {
    if (!target || assignedSel.size === 0) return;
    if (!confirmChange(`Remove "${target.label}" from ${assignedSel.size} user(s) in ${org.label}.`)) return;
    try {
      const r = await removeAccess(client, [...assignedSel]);
      setStatus(`Removed ${r.removed}.${r.errors.length ? ` Errors: ${r.errors.join('; ')}` : ''}`);
      logActivity('remove-access', {
        target: target.name,
        kind: target.kind,
        removed: r.removed,
        errors: r.errors.length,
      });
      await loadAssigned();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Users &amp; access</h2>
        <span className="muted">on {org.label}</span>
      </div>

      <div className="grid2">
        <div className="card form">
          <h3 style={{ margin: 0, width: '100%' }}>Login history</h3>
          <label>
            Last
            <select value={loginDays} onChange={(e) => setLoginDays(Number(e.target.value))}>
              {[1, 7, 30, 90, 180].map((d) => (
                <option key={d} value={d}>
                  {d} day(s)
                </option>
              ))}
            </select>
          </label>
          <button className="primary" onClick={() => void load('Login history', () => loginHistory(client, loginDays))}>
            Load
          </button>
        </div>
        <div className="card form">
          <h3 style={{ margin: 0, width: '100%' }}>Setup audit trail</h3>
          <label>
            Last
            <select value={auditDays} onChange={(e) => setAuditDays(Number(e.target.value))}>
              {[7, 30, 90, 180].map((d) => (
                <option key={d} value={d}>
                  {d} days
                </option>
              ))}
            </select>
          </label>
          <button
            className="primary"
            onClick={() => void load('Setup audit trail', () => auditTrail(client, auditDays))}
          >
            Load
          </button>
        </div>
      </div>
      {logStatus && <p className="muted">{logStatus}</p>}
      {log && (
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

      <div className="card section">
        <h3>Permission sets &amp; groups</h3>
        <div className="form">
          <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={{ minWidth: 340 }}>
            <option value="">Choose a permission set or group ({targets.length})</option>
            {shown.map((t) => (
              <option key={t.id} value={t.id}>
                {t.kind === 'group' ? '▣ ' : ''}
                {t.label} ({t.name})
              </option>
            ))}
          </select>
        </div>
        {status && (
          <p className="muted" style={{ margin: 0 }}>
            {status}
          </p>
        )}
        {target && (
          <div className="grid2">
            <div className="section">
              <h3>Assigned ({assigned?.rows.length ?? 0})</h3>
              {assigned && (
                <DataTable
                  columns={[
                    'Assignee.Name',
                    'Assignee.Username',
                    'Assignee.Profile.Name',
                    'Assignee.IsActive',
                    'ExpirationDate',
                  ]}
                  rows={assigned.rows}
                  name={`${target.name}-assignments`}
                  selected={assignedSel}
                  onSelectedChange={setAssignedSel}
                />
              )}
              <div className="form">
                <button className="danger" disabled={assignedSel.size === 0} onClick={() => void remove()}>
                  Remove {assignedSel.size || ''} selected…
                </button>
              </div>
            </div>
            <div className="section">
              <h3>Assign to users</h3>
              <div className="form">
                <label>
                  Find users by
                  <select value={by} onChange={(e) => setBy(e.target.value as By)}>
                    {(Object.keys(BY_LABEL) as By[]).map((b) => (
                      <option key={b} value={b}>
                        {BY_LABEL[b].split(' (')[0]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Expires (optional)
                  <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
                </label>
              </div>
              <label className="muted" style={{ fontSize: 12.5 }}>
                {BY_LABEL[by]}
                <textarea rows={2} value={value} onChange={(e) => setValue(e.target.value)} />
              </label>
              <div className="form">
                <button onClick={() => void find()}>Find users</button>
                <button className="primary" disabled={userSel.size === 0} onClick={() => void assign()}>
                  Assign to {userSel.size || ''} selected…
                </button>
              </div>
              {users.length > 0 && (
                <DataTable
                  columns={['Name', 'Username', 'Profile.Name']}
                  rows={users}
                  name="users"
                  selected={userSel}
                  onSelectedChange={setUserSel}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
