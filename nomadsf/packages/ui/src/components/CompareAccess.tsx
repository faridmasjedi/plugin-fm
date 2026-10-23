import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  accessOverview,
  applyAccessChanges,
  describeChange,
  type AccessChange,
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
import { askTyped } from './Dialogs';
import { orgFacts } from '../host';

type Kind = PermissionHolder['kind'];
type Mode = 'users' | Kind | 'all';
const KINDS: Array<[Kind, string]> = [
  ['Profile', 'Profiles'],
  ['Permission set', 'Permission sets'],
  ['Permission set group', 'Permission set groups'],
];
type Show = 'all' | AccessOverviewRow['status'];

/** Org to org: A's and B's org (B's connection null until ready). */
export type OrgSides = { clientA: SalesforceClient; labelA: string; clientB: SalesforceClient | null; labelB: string };

/**
 * Two users, or two profiles / permission sets / groups: what one has that the other does not — in this org, or
 * (between) A in one org and B in another, with every profile, permission set and group of both side by side.
 */
export function CompareAccess({ between }: { between?: OrgSides }) {
  const studio = useStudio();
  const client = between?.clientA ?? studio.client;
  const labelA = between?.labelA ?? studio.org.label;
  const clientB = between ? between.clientB : client;
  const labelB = between?.labelB ?? labelA;
  const other = Boolean(between);
  const [mode, setMode] = useState<Mode>(() => {
    const saved = storage.get<string>('compare.mode', 'users');
    return saved === 'sets' ? 'Profile' : (saved as Mode);
  });
  const [filter, setFilter] = useState('');
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
  const shownMode: Mode = mode === 'all' && !other ? 'users' : mode;
  // Profiles, permission sets or permission set groups
  const kind = KINDS.some(([k]) => k === shownMode) ? (shownMode as Kind) : null;

  useEffect(() => {
    // Loaded up front: the tabs show how many there are
    if (holders.length === 0)
      permissionHolders(client)
        .then(setHolders)
        .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, holders.length]);
  // B's list: this org's, or the other org's
  useEffect(() => {
    setHoldersB([]);
    setSetB('');
    if (!kind || !clientB) return;
    if (clientB === client) return setHoldersB(holders);
    permissionHolders(clientB)
      .then(setHoldersB)
      .catch((e: Error) => setStatus(`❌ ${labelB}: ${e.message}`));
  }, [client, clientB, kind, holders, labelB]);
  useEffect(() => {
    setSetA('');
    setSetB('');
    setFilter('');
  }, [kind]);
  // Another org: B is the same user (by username) and the same profile / permission set (by API name)
  useEffect(() => {
    setUserB(null);
    setMatched('');
  }, [clientB]);
  useEffect(() => {
    if (!other || !clientB || !userA) return;
    setUserB(null);
    findSameUser(clientB, userA.Username)
      .then((u) => {
        setUserB(u);
        setMatched(u ? `matched by username` : `no user with username ${userA.Username} in ${labelB}`);
      })
      .catch(() => undefined);
  }, [other, clientB, userA, labelB]);
  useEffect(() => {
    if (!other) return;
    const api = holders.find((h) => h.id === setA)?.api;
    const same = api ? holdersB.find((h) => h.api === api) : undefined;
    setSetB(same?.id ?? '');
  }, [other, setA, holders, holdersB]);
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
    Boolean(clientB) && (shownMode === 'users' ? Boolean(userA && userB) : kind ? Boolean(setA && setB) : true);

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
  const orgsNote = other ? ` · A in ${labelA}, B in ${labelB}` : '';
  const count = (k: Kind): string => {
    const n = holders.filter((h) => h.kind === k).length;
    return n ? ` (${n})` : '';
  };
  const modes: Array<[Mode, string]> = [
    ['users', 'Two users'],
    ...KINDS.map(([k, label]) => [k, `${label}${count(k)}`] as [Mode, string]),
    ...(other ? [['all', 'Everything'] as [Mode, string]] : []),
  ];
  const matching = (list: PermissionHolder[]): PermissionHolder[] =>
    list.filter((h) => h.kind === kind && (!filter || h.name.toLowerCase().includes(filter.trim().toLowerCase())));

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
      </div>
      {shownMode === 'users' && (
        <div className="form">
          <UserPicker label={other ? `A (${labelA})` : 'A'} client={client} value={userA} onChange={setUserA} />
          {clientB && (
            <UserPicker
              label={other ? `B (${labelB})` : 'B'}
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
      {kind && (
        <div className="form">
          <label>
            Filter
            <input placeholder="Name…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </label>
          {(
            [
              [other ? `A (${labelA})` : 'A', setA, setSetA, holders],
              [other ? `B (${labelB})` : 'B', setB, setSetB, holdersB],
            ] as const
          ).map(([label, value, set, list]) => (
            <label key={label}>
              {label}
              <select value={value} onChange={(e) => set(e.target.value)} style={{ minWidth: 300 }}>
                <option value="">Choose ({matching(list).length})</option>
                {/* The chosen one stays listed while the filter hides it */}
                {[...matching(list), ...list.filter((h) => h.id === value && !matching(list).includes(h))].map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {other && setA && holdersB.length > 0 && !setB && (
            <span className="muted">not in {labelB} by the same API name — choose one</span>
          )}
        </div>
      )}
      {shownMode === 'all' && (
        <p className="muted">
          Every profile, permission set and permission set group of both orgs: profiles by name, permission sets and
          groups by API name. Counts the system permissions and objects whose access differs; permissions one org does
          not have at all (licenses, features) are left out.
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
          <DiffTable
            diff={diff}
            name={`${labelA}-compare`}
            note={
              <span>
                · A = {a}, B = {b}
                {orgsNote} · only the differences ({areas.join(', ')})
              </span>
            }
            copy={
              other && clientB && kind && kind !== 'Permission set group'
                ? {
                    clientB,
                    idB: setB,
                    what: `${a} (${labelA}) into ${b} (${labelB})`,
                    labelB,
                    onCopied: () => void compare(),
                  }
                : undefined
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
          labelB={labelB}
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
  labelB,
  note,
}: {
  rows: AccessOverviewRow[];
  show: Show;
  onShow: (s: Show) => void;
  pair: AccessOverviewRow | null;
  onPair: (r: AccessOverviewRow | null) => void;
  client: SalesforceClient;
  clientB: SalesforceClient;
  labelB: string;
  note: string;
}) {
  const { org } = useStudio();
  const [diff, setDiff] = useState<Difference[] | null>(null);
  const [status, setStatus] = useState('');
  // Bumped after copying into B: compares again
  const [refresh, setRefresh] = useState(0);
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
  }, [pair, client, clientB, refresh]);
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
              <DiffTable
                diff={diff}
                name={`${org.label}-${pair.name}-compare`}
                note={<span>{note} · only the differences</span>}
                copy={
                  pair.kind !== 'Permission set group'
                    ? {
                        clientB,
                        idB: pair.idB,
                        what: `${pair.kind.toLowerCase()} ${pair.name} into ${labelB}`,
                        labelB,
                        onCopied: () => setRefresh((n) => n + 1),
                      }
                    : undefined
                }
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
  const [matches, setMatches] = useState<UserMatch[] | null>(null);
  // Searches while you type (Enter picks the only match)
  useEffect(() => {
    setMatches(null);
    const term = text.trim();
    if (term.length < 2) return;
    let canceled = false;
    const timer = setTimeout(() => {
      searchUsers(client, term)
        .then((found) => !canceled && setMatches(found))
        .catch(() => !canceled && setMatches([]));
    }, 350);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [client, text]);
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
            placeholder="Name, username or email"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && matches?.length === 1 && onChange(matches[0])}
          />
          {matches &&
            (matches.length === 0 ? (
              <span className="muted">no user found</span>
            ) : (
              <select value="" onChange={(e) => onChange(matches.find((m) => m.Id === e.target.value) ?? null)}>
                <option value="">
                  {matches.length} user{matches.length === 1 ? '' : 's'} — choose…
                </option>
                {matches.map((m) => (
                  <option key={m.Id} value={m.Id}>
                    {m.Name} ({m.Username})
                  </option>
                ))}
              </select>
            ))}
        </span>
      )}
    </label>
  );
}

/**
 * The differences; comparing permission sets or profiles of two orgs, tick some and copy A's access into B
 * (system permissions, object and field access — B's name is asked first).
 */
function DiffTable({
  diff,
  name,
  note,
  copy,
}: {
  diff: Difference[];
  name: string;
  note: ReactNode;
  copy?: { clientB: SalesforceClient; idB: string; what: string; labelB: string; onCopied: () => void };
}) {
  const { logActivity } = useStudio();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');
  useEffect(() => setPicked(new Set()), [diff]);
  const canCopy = Boolean(copy && diff.some((d) => d.change));
  const run = async () => {
    if (!copy) return;
    const changes = [...picked].map((k) => diff[Number(k)]?.change).filter((c): c is AccessChange => Boolean(c));
    if (!changes.length) return;
    const production = await orgFacts(copy.clientB)
      .then((f) => !f.isSandbox)
      .catch(() => false);
    const shown = changes.slice(0, 12).map((c) => `• ${describeChange(c)}`);
    const ok = await askTyped(
      `Copy ${changes.length} permission(s) of ${copy.what}:\n${shown.join('\n')}${
        changes.length > shown.length ? `\n… and ${changes.length - shown.length} more` : ''
      }${production ? `\n\n⚠ ${copy.labelB} is a PRODUCTION org.` : ''}`,
      copy.labelB,
      { ok: 'Copy', danger: production }
    );
    if (!ok) return;
    setStatus('Copying…');
    try {
      const result = await applyAccessChanges(copy.clientB, copy.idB, changes);
      logActivity('copy permissions', { into: copy.labelB, applied: result.applied, failed: result.failures.length });
      setStatus(
        result.failures.length
          ? `✓ ${result.applied} copied. ❌ ${result.failures.length} failed: ${result.failures
              .map((f) => `${f.change} (${f.error})`)
              .join('; ')}`
          : `✓ ${result.applied} copied into ${copy.labelB}.`
      );
      copy.onCopied();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  return (
    <>
      <DataTable
        columns={['area', 'item', 'a', 'b']}
        rows={diff.map((d, i) => ({ area: d.area, item: d.item, a: d.a, b: d.b, key: i }))}
        rowKey="key"
        name={name}
        note={note}
        selected={canCopy ? picked : undefined}
        onSelectedChange={canCopy ? setPicked : undefined}
      />
      {canCopy && (
        <div className="form">
          <button className="primary" disabled={picked.size === 0} onClick={() => void run()}>
            Copy A&apos;s access into B ({picked.size})…
          </button>
          <span className="muted">{status || 'tick the differences to make B like A'}</span>
        </div>
      )}
    </>
  );
}
