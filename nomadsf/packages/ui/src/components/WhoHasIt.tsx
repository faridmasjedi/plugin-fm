import { useEffect, useMemo, useState } from 'react';
import { HOLDER_KINDS, holdersOf, usersWith, type Holder, type HolderKind, type Row } from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { DataTable, EmptyHint } from './DataTable';

/** Who has a permission set, group, license, profile, role, public group or queue. */
export function WhoHasIt() {
  const { client, org } = useStudio();
  const [kind, setKind] = useState<HolderKind>(() => storage.get('who.kind', 'permset'));
  const [holders, setHolders] = useState<Holder[] | null>(null);
  const [filter, setFilter] = useState('');
  const [holderId, setHolderId] = useState('');
  const [users, setUsers] = useState<Row[] | null>(null);
  const [activeOnly, setActiveOnly] = useState(true);
  const [status, setStatus] = useState('');

  useEffect(() => {
    setHolders(null);
    setHolderId('');
    setUsers(null);
    setStatus('');
    holdersOf(client, kind)
      .then(setHolders)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, kind]);

  useEffect(() => {
    setUsers(null);
    if (!holderId) return;
    setStatus('Reading users…');
    usersWith(client, { kind, id: holderId })
      .then((list) => {
        setUsers(list);
        setStatus('');
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, kind, holderId]);

  const shown = useMemo(
    () =>
      (holders ?? []).filter(
        (h) => !filter || `${h.label} ${h.detail ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())
      ),
    [holders, filter]
  );
  const holder = holders?.find((h) => h.id === holderId);
  const rows = (users ?? []).filter((u) => !activeOnly || u.IsActive !== false);
  const kindLabel = HOLDER_KINDS.find(([k]) => k === kind)?.[1] ?? '';

  return (
    <div className="card section">
      <h3>Who has it</h3>
      <div className="form">
        <label>
          Kind
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as HolderKind);
              storage.set('who.kind', e.target.value);
            }}
          >
            {HOLDER_KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select value={holderId} onChange={(e) => setHolderId(e.target.value)} style={{ minWidth: 320 }}>
          <option value="">{holders ? `Choose a ${kindLabel.toLowerCase()} (${shown.length})` : 'Loading…'}</option>
          {shown.map((h) => (
            <option key={h.id} value={h.id}>
              {h.label}
              {h.detail ? ` (${h.detail})` : ''}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active users
          only
        </label>
        <span className="muted">{status}</span>
      </div>
      {holder &&
        users &&
        (rows.length === 0 ? (
          <EmptyHint what="users" />
        ) : (
          <DataTable
            columns={[
              'Name',
              'Username',
              'Email',
              'IsActive',
              'Profile.Name',
              'UserRole.Name',
              'LastLoginDate',
              ...(kind === 'permset' || kind === 'group' ? ['ExpirationDate'] : []),
            ]}
            rows={rows}
            rowKey="Id"
            name={`${org.label}-${holder.label}-users`}
            note={
              <span>
                · users with {kindLabel.toLowerCase()} {holder.label}
                {kind === 'publicGroup' || kind === 'queue' ? ' (direct members)' : ''}
              </span>
            }
          />
        ))}
    </div>
  );
}
