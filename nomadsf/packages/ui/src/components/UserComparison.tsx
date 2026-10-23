import { useEffect, useState } from 'react';
import {
  comparePermissionSets,
  compareUsersFully,
  type Difference,
  type SalesforceClient,
  type UserComparison as Comparison,
  type UserItem,
} from '@nomadsf/core';
import { DataTable, EmptyHint } from './DataTable';
import { DiffTable } from './DiffTable';

type Show = 'all' | UserItem['in'];

/**
 * Two users side by side — in one org, or A and B in two orgs: their details, everything they have (profile,
 * permission sets, groups, licenses, groups & queues, OAuth apps) and how each one's access differs, the user and
 * system permissions that differ, and their last 10 logins.
 */
export function UserComparison({
  client,
  clientB,
  userA,
  userB,
  labelA,
  labelB,
  orgB,
  twoOrgs,
}: {
  client: SalesforceClient;
  clientB: SalesforceClient;
  userA: string;
  userB: string;
  /** How A and B are named in notes (the users, and their orgs with two orgs). */
  labelA: string;
  labelB: string;
  /** B's org (its name is typed to copy into it). */
  orgB: string;
  twoOrgs: boolean;
}) {
  const [result, setResult] = useState<Comparison | null>(null);
  const [status, setStatus] = useState('Comparing the two users…');
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [show, setShow] = useState<Show>('all');
  const [chosen, setChosen] = useState<UserItem | null>(null);
  const [access, setAccess] = useState<Difference[] | null>(null);
  const [accessStatus, setAccessStatus] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let canceled = false;
    setResult(null);
    setChosen(null);
    setStatus('Comparing the two users…');
    compareUsersFully(client, userA, userB, clientB)
      .then((r) => {
        if (canceled) return;
        setResult(r);
        setStatus('');
      })
      .catch((e: Error) => !canceled && setStatus(`❌ ${e.message}`));
    return () => {
      canceled = true;
    };
  }, [client, clientB, userA, userB]);

  // How the chosen profile / permission set / group differs between the two users
  useEffect(() => {
    setAccess(null);
    setAccessStatus('');
    if (!chosen?.idA || !chosen.idB) return;
    let canceled = false;
    setAccessStatus('Comparing their access…');
    comparePermissionSets(client, chosen.idA, chosen.idB, clientB)
      .then((d) => {
        if (canceled) return;
        setAccess(d);
        setAccessStatus('');
      })
      .catch((e: Error) => !canceled && setAccessStatus(`❌ ${e.message}`));
    return () => {
      canceled = true;
    };
  }, [chosen, client, clientB, refresh]);

  if (!result) return <p className="muted">{status}</p>;
  const note = ` · A = ${labelA}, B = ${labelB}`;
  const details = result.details.filter((d) => !differencesOnly || !d.same);
  const count = (s: Show): number => result.items.filter((i) => s === 'all' || i.in === s).length;
  const items = result.items.filter((i) => show === 'all' || i.in === show);
  const chosenKey = chosen ? `${chosen.area}:${chosen.item}` : undefined;

  return (
    <div className="user-comparison">
      <h4>Details</h4>
      <label className="check">
        <input type="checkbox" checked={differencesOnly} onChange={(e) => setDifferencesOnly(e.target.checked)} />{' '}
        Differences only ({result.details.filter((d) => !d.same).length})
      </label>
      <DataTable
        columns={['field', 'a', 'b', 'differs']}
        rows={details.map((d) => ({ ...d, differs: d.same ? '' : '≠' }))}
        rowKey="field"
        name="users-details"
        note={<span>{note}</span>}
      />

      <h4>Profile, permission sets, groups, licenses, groups &amp; queues, OAuth apps</h4>
      <div className="segmented" role="group" aria-label="Show">
        {(['all', 'both', 'only in A', 'only in B'] as Show[]).map((s) => (
          <button key={s} className={show === s ? 'active' : ''} onClick={() => setShow(s)}>
            {s === 'all' ? 'All' : s === 'both' ? 'Both' : s[0].toUpperCase() + s.slice(1)} ({count(s)})
          </button>
        ))}
      </div>
      <DataTable
        columns={['area', 'item', 'in', 'a', 'b']}
        rows={items.map((i) => ({ ...i, key: `${i.area}:${i.item}` }))}
        rowKey="key"
        name="users-assigned"
        selectedKey={chosenKey}
        onRowClick={(row) => setChosen(items.find((i) => `${i.area}:${i.item}` === row.key) ?? null)}
        note={<span>{note} · click a profile, permission set or group both have to see how their access differs</span>}
      />
      {chosen &&
        (chosen.idA && chosen.idB ? (
          <div className="section">
            <h4>
              {chosen.area} {chosen.item}: access
            </h4>
            {accessStatus && <p className="muted">{accessStatus}</p>}
            {access &&
              (access.length === 0 ? (
                <p className="good">✓ The same system permissions, object and field access.</p>
              ) : (
                <DiffTable
                  diff={access}
                  name={`users-${chosen.item}-access`}
                  note={<span>{note} · only the differences</span>}
                  copy={
                    twoOrgs && chosen.area !== 'Permission set group'
                      ? {
                          clientB,
                          idB: chosen.idB,
                          what: `${chosen.area.toLowerCase()} ${chosen.item} into ${labelB}`,
                          labelB: orgB,
                          onCopied: () => setRefresh((n) => n + 1),
                        }
                      : undefined
                  }
                />
              ))}
          </div>
        ) : (
          <p className="muted">
            {chosen.area === 'License' || chosen.area === 'Group / queue' || chosen.area === 'OAuth app'
              ? `${chosen.area}s have no access of their own to compare.`
              : chosen.in === 'only in A' || chosen.in === 'only in B'
              ? `Only ${chosen.in === 'only in A' ? 'A' : 'B'} has ${chosen.item}: nothing to compare it with.`
              : `The access of ${chosen.item} could not be read in ${chosen.idA ? 'B' : 'A'}.`}
          </p>
        ))}

      <h4>User &amp; system permissions that differ (from every source)</h4>
      {result.permissions.length === 0 ? (
        <p className="good">✓ The same user and system permissions.</p>
      ) : (
        <DataTable
          columns={['item', 'a', 'b']}
          rows={result.permissions.map((p, i) => ({ ...p, key: i }))}
          rowKey="key"
          name="users-permissions"
          note={<span>{note}</span>}
        />
      )}

      <h4>Last 10 logins</h4>
      <div className="grid2">
        {(
          [
            ['A', result.loginsA],
            ['B', result.loginsB],
          ] as const
        ).map(([side, rows]) => (
          <div key={side}>
            <b>{side}</b>
            {rows.length === 0 ? (
              <EmptyHint what="logins" />
            ) : (
              <DataTable
                columns={['LoginTime', 'Status', 'SourceIp', 'Application', 'Browser', 'Platform']}
                rows={rows.map((r, i) => ({ ...r, key: i }))}
                rowKey="key"
                name={`users-logins-${side}`}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
