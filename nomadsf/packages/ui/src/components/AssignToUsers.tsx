import { useState } from 'react';
import { assignAccess, findUsers, type AccessTarget, type Row } from '@nomadsf/core';
import { Select } from './Select';
import { DataTable } from './DataTable';
import { useStudio } from '../context';
import { Status } from '../statusLog';

type By = 'names' | 'usernames' | 'profile' | 'role' | 'publicGroup';
const BY_LABEL: Record<By, string> = {
  names: 'Names (all or part of a name, comma or new line: Ann, Bob Ray)',
  usernames: 'Usernames (comma or new line)',
  profile: 'Profile name',
  role: 'Role name',
  publicGroup: 'Public group (API or label name)',
};

/** Assign a permission set or group to users found by name, username, profile, role or public group. */
export function AssignToUsers({ target, onAssigned }: { target: AccessTarget; onAssigned?: () => void }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [by, setBy] = useState<By>('names');
  const [value, setValue] = useState('');
  const [expires, setExpires] = useState('');
  const [users, setUsers] = useState<Row[]>([]);
  const [userSel, setUserSel] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');

  const find = async () => {
    try {
      const list = await findUsers(
        client,
        by === 'usernames'
          ? { usernames: value.split(/[\s,;]+/).filter(Boolean) }
          : by === 'names'
          ? { names: value.split(/[,;\n]+/).filter((n) => n.trim()) }
          : { [by]: value.trim() }
      );
      setUsers(list);
      setUserSel(new Set(list.map((u) => String(u.Id))));
      setStatus(`${list.length} active user(s) found.`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const assign = async () => {
    if (userSel.size === 0) return;
    if (!(await confirmChange(`Assign "${target.label}" to ${userSel.size} user(s) in ${org.label}.`))) return;
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
      onAssigned?.();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div className="section">
      <div className="form">
        <label>
          Find users by
          <Select value={by} onChange={(e) => setBy(e.target.value as By)}>
            {(Object.keys(BY_LABEL) as By[]).map((b) => (
              <option key={b} value={b}>
                {BY_LABEL[b].split(' (')[0]}
              </option>
            ))}
          </Select>
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
        <Status text={status} />
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
  );
}
