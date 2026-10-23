import { useEffect, useMemo, useState } from 'react';
import {
  HOLDER_KINDS,
  holdersOf,
  sameHolder,
  usersWith,
  usersWithInBoth,
  type Holder,
  type HolderKind,
  type Row,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { DataTable, EmptyHint } from './DataTable';
import type { OrgSides } from './CompareAccess';

/** Assigned users: the users of a permission set, group, license, profile, role, public group or queue — in this org, or in two orgs. */
export function WhoHasIt({ between }: { between?: OrgSides }) {
  const studio = useStudio();
  const client = between?.clientA ?? studio.client;
  const labelA = between?.labelA ?? studio.org.label;
  const clientB = between?.clientB ?? null;
  const isBetween = Boolean(between);
  const [holdersB, setHoldersB] = useState<Holder[] | null>(null);
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
    setHoldersB(null);
    if (!clientB) return;
    holdersOf(clientB, kind)
      .then(setHoldersB)
      .catch((e: Error) => setStatus(`❌ ${between?.labelB}: ${e.message}`));
  }, [clientB, kind, between?.labelB]);

  const holder = holders?.find((h) => h.id === holderId);
  // The same one in the other org, by API name (profiles by name)
  const holderB = holder && holdersB ? sameHolder(holdersB, holder) : undefined;

  useEffect(() => {
    setUsers(null);
    if (!holder || (isBetween && !holdersB)) return;
    setStatus('Reading users…');
    (clientB ? usersWithInBoth(client, holder, clientB, holderB) : usersWith(client, holder))
      .then((list) => {
        setUsers(list);
        setStatus('');
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, clientB, holder, holderB, holdersB, isBetween]);

  const shown = useMemo(
    () =>
      (holders ?? []).filter(
        (h) => !filter || `${h.label} ${h.detail ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase())
      ),
    [holders, filter]
  );
  const both = Boolean(clientB);
  const rows = (users ?? []).filter((u) =>
    !activeOnly ? true : both ? u.activeA === true || u.activeB === true : u.IsActive !== false
  );
  const kindLabel = HOLDER_KINDS.find(([k]) => k === kind)?.[1] ?? '';

  return (
    <div className="card section">
      <h3>Assigned users</h3>
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
            columns={
              both
                ? ['Name', 'in', 'usernameA', 'usernameB', 'activeA', 'activeB', 'profileA', 'profileB']
                : [
                    'Name',
                    'Username',
                    'Email',
                    'IsActive',
                    'Profile.Name',
                    'UserRole.Name',
                    'LastLoginDate',
                    ...(kind === 'permset' || kind === 'group' ? ['ExpirationDate'] : []),
                  ]
            }
            rows={rows}
            rowKey="Id"
            name={`${labelA}-${holder.label}-users`}
            note={
              <span>
                · users with {kindLabel.toLowerCase()} {holder.label}
                {kind === 'publicGroup' || kind === 'queue' ? ' (direct members)' : ''}
                {both &&
                  ` · A = ${labelA}, B = ${between?.labelB}${
                    holderB ? '' : ` (not in B by the same API name)`
                  } · users matched by username`}
              </span>
            }
          />
        ))}
    </div>
  );
}
