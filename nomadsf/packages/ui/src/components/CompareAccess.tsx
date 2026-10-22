import { useEffect, useMemo, useState } from 'react';
import {
  accessOverview,
  comparePermissionSets,
  compareUsers,
  findSameUser,
  permissionHolders,
  searchUsers,
  type AccessOverviewRow,
  type Difference,
  type PermissionHolder,
  type SalesforceClient,
  type UserMatch,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { DataTable } from './DataTable';
import { OtherOrgSelect, useOtherOrg } from './OtherOrg';

type Mode = 'users' | 'sets' | 'all';
type Show = 'all' | AccessOverviewRow['status'];

/**
 * Two users, or two profiles / permission sets / groups: what one has that the other does not — in this org, or B
 * in another org. With another org, also every profile, permission set and group of both side by side.
 */
export function CompareAccess() {
  const { client, org } = useStudio();
  const otherOrg = useOtherOrg('compare.org');
  // B's org: this one, or the other once connected
  const clientB = otherOrg.other ? otherOrg.client : client;
  const labelB = otherOrg.other?.label ?? org.label;
  const [mode, setMode] = useState<Mode>(() => storage.get('compare.mode', 'users'));
  const [userA, setUserA] = useState<UserMatch | null>(null);
  const [userB, setUserB] = useState<UserMatch | null>(null);
  const [matched, setMatched] = useState('');
  const [holders, setHolders] = useState<PermissionHolder[]>([]);
  const [holdersB, setHoldersB] = useState<PermissionHolder[]>([]);
  const [setA, setSetA] = useState('');
  const [setB, setSetB] = useState('');
  const [diff, setDiff] = useState<Difference[] | null>(null);
  const [overview, setOverview] = useState<AccessOverviewRow[] | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [pair, setPair] = useState<AccessOverviewRow | null>(null);
  const [status, setStatus] = useState('');
  const shownMode: Mode = mode === 'all' && !otherOrg.other ? 'users' : mode;

  useEffect(() => {
    if (shownMode === 'sets' && holders.length === 0)
      permissionHolders(client)
        .then(setHolders)
        .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, shownMode, holders.length]);
  // B's list: this org's, or the other org's
  useEffect(() => {
    setHoldersB([]);
    setSetB('');
    if (shownMode !== 'sets' || !clientB) return;
    if (clientB === client) return setHoldersB(holders);
    permissionHolders(clientB)
      .then(setHoldersB)
      .catch((e: Error) => setStatus(`❌ ${labelB}: ${e.message}`));
  }, [client, clientB, shownMode, holders, labelB]);
  // Another org: B is the same user (by username) and the same profile / permission set (by API name)
  useEffect(() => {
    setUserB(null);
    setMatched('');
  }, [clientB]);
  useEffect(() => {
    if (!otherOrg.other || !clientB || !userA) return;
    setUserB(null);
    findSameUser(clientB, userA.Username)
      .then((u) => {
        setUserB(u);
        setMatched(u ? `matched by username` : `no user with username ${userA.Username} in ${labelB}`);
      })
      .catch(() => undefined);
  }, [otherOrg.other, clientB, userA, labelB]);
  useEffect(() => {
    if (!otherOrg.other) return;
    const api = holders.find((h) => h.id === setA)?.api;
    const same = api ? holdersB.find((h) => h.api === api) : undefined;
    setSetB(same?.id ?? '');
  }, [otherOrg.other, setA, holders, holdersB]);
  useEffect(() => {
    setDiff(null);
    setStatus('');
  }, [shownMode, userA, userB, setA, setB, clientB]);
  useEffect(() => {
    setOverview(null);
    setPair(null);
  }, [clientB]);

  const a = shownMode === 'users' ? userA?.Name : holders.find((h) => h.id === setA)?.name;
  const b = shownMode === 'users' ? userB?.Name : holdersB.find((h) => h.id === setB)?.name;
  const ready =
    Boolean(clientB) &&
    (shownMode === 'users' ? Boolean(userA && userB) : shownMode === 'sets' ? Boolean(setA && setB) : true);

  const compare = async () => {
    if (!clientB) return;
    setStatus(shownMode === 'all' ? `Reading every profile, permission set and group of both orgs…` : 'Comparing…');
    try {
      if (shownMode === 'all') {
        setPair(null);
        setOverview(await accessOverview(client, clientB));
      } else
        setDiff(
          shownMode === 'users'
            ? await compareUsers(client, userA!.Id, userB!.Id, clientB)
            : await comparePermissionSets(client, setA, setB, clientB)
        );
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const areas = useMemo(() => [...new Set((diff ?? []).map((d) => d.area))], [diff]);
  const orgsNote = otherOrg.other ? ` · A in ${org.label}, B in ${labelB}` : '';
  const modes: Array<[Mode, string]> = [
    ['users', 'Two users'],
    ['sets', 'Two profiles, permission sets or groups'],
    ...(otherOrg.other ? [['all', 'Every profile, permission set and group'] as [Mode, string]] : []),
  ];

  return (
    <div className="card section">
      <h3>Compare</h3>
      <div className="form">
        <div className="segmented" role="group" aria-label="Compare">
          {modes.map(([id, text]) => (
            <button
              key={id}
              className={shownMode === id ? 'active' : ''}
              onClick={() => {
                setMode(id);
                storage.set('compare.mode', id);
              }}
            >
              {text}
            </button>
          ))}
        </div>
        <OtherOrgSelect state={otherOrg} label="B in" />
      </div>
      {shownMode === 'users' && (
        <div className="form">
          <UserPicker
            label={otherOrg.other ? `A (${org.label})` : 'A'}
            client={client}
            value={userA}
            onChange={setUserA}
          />
          {clientB && (
            <UserPicker
              label={otherOrg.other ? `B (${labelB})` : 'B'}
              client={clientB}
              value={userB}
              onChange={(u) => {
                setUserB(u);
                setMatched('');
              }}
            />
          )}
          {matched && <span className="muted">{matched}</span>}
        </div>
      )}
      {shownMode === 'sets' && (
        <div className="form">
          {(
            [
              [otherOrg.other ? `A (${org.label})` : 'A', setA, setSetA, holders],
              [otherOrg.other ? `B (${labelB})` : 'B', setB, setSetB, holdersB],
            ] as const
          ).map(([label, value, set, list]) => (
            <label key={label}>
              {label}
              <select value={value} onChange={(e) => set(e.target.value)} style={{ minWidth: 300 }}>
                <option value="">Choose ({list.length})</option>
                {(['Profile', 'Permission set', 'Permission set group'] as const).map((k) => (
                  <optgroup key={k} label={`${k}s`}>
                    {list
                      .filter((h) => h.kind === k)
                      .map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
          ))}
          {otherOrg.other && setA && holdersB.length > 0 && !setB && (
            <span className="muted">not in {labelB} by the same API name — choose one</span>
          )}
        </div>
      )}
      {shownMode === 'all' && (
        <p className="muted">
          Profiles by name, permission sets and groups by API name. Counts the system permissions and objects whose
          access differs; permissions one org does not have at all (licenses, features) are left out.
        </p>
      )}
      <div className="form">
        <button className="primary" disabled={!ready} onClick={() => void compare()}>
          Compare
        </button>
        <span className="muted">{status}</span>
      </div>
      {shownMode !== 'all' &&
        diff &&
        (diff.length === 0 ? (
          <p className="good">
            ✓ {a} and {b} have the same{' '}
            {shownMode === 'users' ? 'access' : 'system permissions, object and field access'}.
          </p>
        ) : (
          <DataTable
            columns={['area', 'item', 'a', 'b']}
            rows={diff.map((d, i) => ({ ...d, key: i }))}
            rowKey="key"
            name={`${org.label}-compare`}
            note={
              <span>
                · A = {a}, B = {b}
                {orgsNote} · only the differences ({areas.join(', ')})
              </span>
            }
          />
        ))}
      {shownMode === 'all' && overview && clientB && (
        <Overview
          rows={overview}
          show={show}
          onShow={setShow}
          pair={pair}
          onPair={setPair}
          client={client}
          clientB={clientB}
          note={orgsNote}
        />
      )}
    </div>
  );
}

function Overview({
  rows,
  show,
  onShow,
  pair,
  onPair,
  client,
  clientB,
  note,
}: {
  rows: AccessOverviewRow[];
  show: Show;
  onShow: (s: Show) => void;
  pair: AccessOverviewRow | null;
  onPair: (r: AccessOverviewRow | null) => void;
  client: SalesforceClient;
  clientB: SalesforceClient;
  note: string;
}) {
  const { org } = useStudio();
  const [diff, setDiff] = useState<Difference[] | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    setDiff(null);
    setStatus('');
    if (!pair?.idA || !pair.idB) return;
    setStatus('Comparing…');
    comparePermissionSets(client, pair.idA, pair.idB, clientB)
      .then((d) => {
        setDiff(d);
        setStatus('');
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [pair, client, clientB]);
  const count = (s: Show): number => rows.filter((r) => s === 'all' || r.status === s).length;
  const shown = rows.filter((r) => show === 'all' || r.status === show);
  return (
    <>
      <div className="segmented" role="group" aria-label="Show">
        {(['all', 'only in A', 'only in B', 'different', 'same'] as Show[]).map((s) => (
          <button key={s} className={show === s ? 'active' : ''} onClick={() => onShow(s)}>
            {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)} ({count(s)})
          </button>
        ))}
      </div>
      <DataTable
        columns={['kind', 'name', 'status', 'systemPermissions', 'objectAccess']}
        rows={shown.map((r) => ({ ...r }))}
        rowKey="key"
        name={`${org.label}-access-compare`}
        selectedKey={pair?.key}
        onRowClick={(row) => onPair(rows.find((r) => r.key === row.key) ?? null)}
        note={<span>{note} · click one in both orgs for what differs</span>}
      />
      {pair && pair.idA && pair.idB && (
        <div className="section">
          <h4>
            {pair.kind} {pair.name}
          </h4>
          {status && <p className="muted">{status}</p>}
          {diff &&
            (diff.length === 0 ? (
              <p className="good">✓ The same system permissions, object and field access in both orgs.</p>
            ) : (
              <DataTable
                columns={['area', 'item', 'a', 'b']}
                rows={diff.map((d, i) => ({ ...d, key: i }))}
                rowKey="key"
                name={`${org.label}-${pair.name}-compare`}
                note={<span>{note} · only the differences</span>}
              />
            ))}
        </div>
      )}
    </>
  );
}

function UserPicker({
  label,
  client,
  value,
  onChange,
}: {
  label: string;
  client: SalesforceClient;
  value: UserMatch | null;
  onChange: (u: UserMatch | null) => void;
}) {
  const [text, setText] = useState('');
  const [matches, setMatches] = useState<UserMatch[]>([]);
  const find = async () => {
    const found = await searchUsers(client, text).catch(() => []);
    setMatches(found);
    if (found.length === 1) onChange(found[0]);
  };
  return (
    <label>
      {label}
      {value ? (
        <span className="form">
          <b>{value.Name}</b>
          <span className="muted">{value.Username}</span>
          <button onClick={() => onChange(null)}>Change</button>
        </span>
      ) : (
        <span className="form">
          <input
            placeholder="Name, username or email, Enter"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && text.trim() && void find()}
          />
          {matches.length > 1 && (
            <select value="" onChange={(e) => onChange(matches.find((m) => m.Id === e.target.value) ?? null)}>
              <option value="">{matches.length} users…</option>
              {matches.map((m) => (
                <option key={m.Id} value={m.Id}>
                  {m.Name} ({m.Username})
                </option>
              ))}
            </select>
          )}
        </span>
      )}
    </label>
  );
}
