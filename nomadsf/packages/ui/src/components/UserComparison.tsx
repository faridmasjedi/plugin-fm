import { useEffect, useMemo, useState } from 'react';
import {
  accessFromText,
  compareUsersFully,
  holderAccess,
  mergeAccess,
  mergeShares,
  userSharing,
  type AccessChange,
  type Difference,
  type MergedSection,
  type SalesforceClient,
  type UserComparison as Comparison,
  type UserItem,
  type UserSharing,
} from '@nomadsf/core';
import { storage } from '../context';
import { TableTabs } from './TableTabs';
import { DataTable, EmptyHint } from './DataTable';
import { DiffTable } from './DiffTable';
import { Status } from '../statusLog';

type Tab = 'details' | 'profile' | 'sets' | 'groups' | 'queues' | 'role' | 'oauth' | 'logins';
const TABS: Array<[Tab, string]> = [
  ['details', 'Details'],
  ['profile', 'Profile'],
  ['sets', 'Permission sets'],
  ['groups', 'Permission set groups'],
  ['queues', 'Groups & queues'],
  ['role', 'Role'],
  ['oauth', 'OAuth apps'],
  ['logins', 'Login history'],
];

type Sides = {
  client: SalesforceClient;
  clientB: SalesforceClient;
  labelA: string;
  labelB: string;
  /** B's org (its name is typed to copy into it). */
  orgB: string;
  twoOrgs: boolean;
};

/**
 * Two users side by side — in one org, or A and B in two orgs — in tabs: details, profile, permission sets and
 * groups (everything each allows), groups & queues and what is shared with them, role and its sharing, OAuth apps,
 * login history. Each tab reads what it needs when opened.
 */
export function UserComparison({ userA, userB, ...sides }: Sides & { userA: string; userB: string }) {
  const { client, clientB, labelA, labelB } = sides;
  const [result, setResult] = useState<Comparison | null>(null);
  const [status, setStatus] = useState('Comparing the two users…');
  const [tab, setTab] = useState<Tab>(() => storage.get('users.tab', 'details'));
  const [sharing, setSharing] = useState<{ a: UserSharing; b: UserSharing } | null>(null);
  const [sharingStatus, setSharingStatus] = useState('');

  useEffect(() => {
    let canceled = false;
    setResult(null);
    setSharing(null);
    setSharingStatus('');
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

  // Groups & queues and Role read what is shared with each user (once)
  const needsSharing = tab === 'queues' || tab === 'role';
  useEffect(() => {
    if (!needsSharing || sharing || sharingStatus) return;
    setSharingStatus('Reading what is shared with them…');
    Promise.all([userSharing(client, userA), userSharing(clientB, userB)])
      .then(([a, b]) => {
        setSharing({ a, b });
        setSharingStatus('');
      })
      .catch((e: Error) => setSharingStatus(`❌ ${e.message}`));
  }, [needsSharing, sharing, sharingStatus, client, clientB, userA, userB]);

  if (!result) return <Status text={status} block />;
  const note = ` · A = ${labelA}, B = ${labelB}`;
  const items = (area: UserItem['area']) => result.items.filter((i) => i.area === area);
  // Unknown ("not read in A/B") is not a difference
  const differences = (list: UserItem[]) =>
    list.filter((i) => (i.in === 'only in A' || i.in === 'only in B' || i.a !== i.b) && !i.in.startsWith('not read'))
      .length;
  const badge: Partial<Record<Tab, number>> = {
    details: result.details.filter((d) => !d.same).length + result.permissions.length,
    sets: differences(items('Permission set')),
    groups: differences(items('Permission set group')),
    queues: differences(items('Group / queue')),
    oauth: differences(items('OAuth app')),
  };
  const profile = items('Profile')[0];

  return (
    <div className="user-comparison">
      {(result.notesA.length > 0 || result.notesB.length > 0) && (
        <div className="callout">
          <b>Not everything could be read</b> — shown as <b>?</b>, and not counted as a difference.
          {(
            [
              ['A', labelA, result.notesA],
              ['B', labelB, result.notesB],
            ] as const
          ).map(
            ([side, who, notes]) =>
              notes.length > 0 && (
                <div key={side} className="muted">
                  {side} ({who}): {notes.join(' · ')}
                </div>
              )
          )}
        </div>
      )}
      <div className="tabs">
        {TABS.map(([id, text]) => (
          <button
            key={id}
            className={`tab ${tab === id ? 'active' : ''}`}
            onClick={() => {
              setTab(id);
              storage.set('users.tab', id);
            }}
          >
            {text}
            {badge[id] ? <span className="count-badge">{badge[id]}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'details' && <DetailsTab result={result} note={note} />}
      {tab === 'profile' &&
        (profile ? (
          <>
            <p>
              A: <b>{profile.a}</b> · B: <b>{profile.b}</b>
            </p>
            <AccessCompare
              key={`${profile.idA}-${profile.idB}`}
              idA={profile.idA}
              idB={profile.idB}
              what={`profile ${profile.item}`}
              sides={sides}
            />
          </>
        ) : (
          <EmptyHint what="profile" />
        ))}
      {tab === 'sets' && <HolderTab list={items('Permission set')} sides={sides} what="permission set" />}
      {tab === 'groups' && <HolderTab list={items('Permission set group')} sides={sides} what="permission set group" />}
      {tab === 'queues' && (
        <>
          {sharingStatus && <Status text={sharingStatus} block />}
          <TableTabs
            tabs={[
              {
                id: 'groups',
                label: 'Groups & queues they are in',
                content: <ItemTable list={items('Group / queue')} note={note} name="users-groups" />,
              },
              ...(sharing
                ? [
                    {
                      id: 'queues',
                      label: 'Queues and their objects',
                      content: (
                        <DataTable
                          columns={['queue', 'a', 'b']}
                          rows={mergeQueues(sharing.a.queues, sharing.b.queues)}
                          rowKey="queue"
                          name="users-queues"
                          note={<span>{note}</span>}
                        />
                      ),
                    },
                    {
                      id: 'groupShares',
                      label: 'Shared with their groups & queues',
                      content: (
                        <SharesTable
                          a={sharing.a.groupShares}
                          b={sharing.b.groupShares}
                          note={note}
                          name="users-group-shares"
                        />
                      ),
                    },
                    {
                      id: 'userShares',
                      label: 'Shared with them directly',
                      content: (
                        <SharesTable
                          a={sharing.a.userShares}
                          b={sharing.b.userShares}
                          note={note}
                          name="users-user-shares"
                        />
                      ),
                    },
                  ]
                : []),
            ]}
          />
          {sharing && <SharingNotes sharing={sharing} />}
        </>
      )}
      {tab === 'role' && (
        <>
          {sharingStatus && <Status text={sharingStatus} block />}
          {sharing && (
            <>
              <TableTabs
                tabs={[
                  {
                    id: 'role',
                    label: 'Role',
                    content: (
                      <DataTable
                        columns={['field', 'a', 'b', 'differs']}
                        rows={roleRows(sharing.a, sharing.b)}
                        rowKey="field"
                        name="users-role"
                        note={<span>{note}</span>}
                      />
                    ),
                  },
                  {
                    id: 'roleShares',
                    label: 'Shared with their role',
                    content: (
                      <SharesTable
                        a={sharing.a.roleShares}
                        b={sharing.b.roleShares}
                        note={note}
                        name="users-role-shares"
                      />
                    ),
                  },
                ]}
              />
              <p className="muted">Users also see the records of the users below them in the role hierarchy.</p>
              <SharingNotes sharing={sharing} />
            </>
          )}
        </>
      )}
      {tab === 'oauth' && <ItemTable list={items('OAuth app')} note={note} name="users-oauth" />}
      {tab === 'logins' && (
        <div className="grid2">
          {(
            [
              [labelA, result.loginsA],
              [labelB, result.loginsB],
            ] as const
          ).map(([who, rows]) => (
            <div key={who}>
              <b>{who}</b>
              {rows.length === 0 ? (
                <EmptyHint what="logins" />
              ) : (
                <DataTable
                  columns={['LoginTime', 'Status', 'SourceIp', 'Application', 'Browser', 'Platform']}
                  rows={rows.map((r, i) => ({ ...r, key: i }))}
                  rowKey="key"
                  name={`users-logins-${who}`}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DetailsTab({ result, note }: { result: Comparison; note: string }) {
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const details = result.details.filter((d) => !differencesOnly || !d.same);
  return (
    <>
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
      <h4>User &amp; system permissions that differ (from the profile, permission sets and groups)</h4>
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
    </>
  );
}

function ItemTable({ list, note, name }: { list: UserItem[]; note: string; name: string }) {
  return list.length === 0 ? (
    <EmptyHint what="items" />
  ) : (
    <DataTable
      columns={['item', 'in', 'a', 'b']}
      rows={list.map((i) => ({ ...i, key: i.item }))}
      rowKey="key"
      name={name}
      note={<span>{note}</span>}
    />
  );
}

/** Permission sets or groups of the two users: choose one to see everything it allows, A beside B. */
function HolderTab({ list, sides, what }: { list: UserItem[]; sides: Sides; what: string }) {
  const [chosen, setChosen] = useState<UserItem | null>(list[0] ?? null);
  if (list.length === 0) return <EmptyHint what={`${what}s`} />;
  return (
    <>
      <DataTable
        columns={['item', 'in', 'a', 'b']}
        rows={list.map((i) => ({ ...i, key: i.item }))}
        rowKey="key"
        name={`users-${what}s`}
        selectedKey={chosen?.item}
        onRowClick={(row) => setChosen(list.find((i) => i.item === row.key) ?? null)}
        note={<span>· click one to see everything it allows</span>}
      />
      {chosen && (
        <>
          <h4>
            {chosen.item}{' '}
            <span className="muted">
              ({chosen.in === 'both' ? 'both have it' : `only ${chosen.in === 'only in A' ? 'A' : 'B'} has it`})
            </span>
          </h4>
          <AccessCompare
            key={`${chosen.idA}-${chosen.idB}`}
            idA={chosen.idA}
            idB={chosen.idB}
            what={`${what} ${chosen.item}`}
            sides={sides}
            canCopy={what === 'permission set'}
          />
        </>
      )}
    </>
  );
}

const COPYABLE = ['Object access', 'Field access', 'User & system permissions'];

/** Everything two holders allow (or one, when only one user has it), section by section. */
function AccessCompare({
  idA,
  idB,
  what,
  sides,
  canCopy = true,
}: {
  idA?: string;
  idB?: string;
  what: string;
  sides: Sides;
  canCopy?: boolean;
}) {
  const { client, clientB, labelA, labelB, orgB, twoOrgs } = sides;
  const [sections, setSections] = useState<MergedSection[] | null>(null);
  const [status, setStatus] = useState('Reading what it allows…');
  const [shown, setShown] = useState('Object access');
  const [differencesOnly, setDifferencesOnly] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const both = Boolean(idA && idB);
  useEffect(() => {
    let canceled = false;
    setStatus('Reading what it allows…');
    Promise.all([idA ? holderAccess(client, idA) : undefined, idB ? holderAccess(clientB, idB) : undefined])
      .then(([a, b]) => {
        if (canceled) return;
        setSections(mergeAccess(a, b));
        setStatus('');
      })
      .catch((e: Error) => !canceled && setStatus(`❌ ${e.message}`));
    return () => {
      canceled = true;
    };
  }, [client, clientB, idA, idB, refresh]);
  const section = sections?.find((s) => s.title === shown) ?? sections?.[0];
  // A side that could not be read: show the other side's rows (as ?) instead of "no differences"
  const unreadable = Boolean(section?.noteA || section?.noteB);
  const rows = useMemo(
    () => (section?.rows ?? []).filter((r) => !both || !differencesOnly || r.differs || unreadable),
    [section, differencesOnly, both, unreadable]
  );
  if (!sections || !section) return <Status text={status} block />;
  const copyable = twoOrgs && canCopy && both && !unreadable && COPYABLE.includes(section.title);
  const diffs: Difference[] = copyable
    ? rows.map((r) => ({
        area: section.title,
        item: r.item,
        a: r.a || '—',
        b: r.b || '—',
        change: changeFor(section.title, r),
      }))
    : [];
  const note = <span>{` · A = ${labelA}, B = ${labelB}`}</span>;
  return (
    <div className="access-compare section">
      <div className="segmented wrap" role="group" aria-label="Section">
        {sections.map((s) => (
          <button key={s.title} className={section.title === s.title ? 'active' : ''} onClick={() => setShown(s.title)}>
            {s.title}
            {s.noteA || s.noteB
              ? ' (?)'
              : both
              ? ` (${s.rows.filter((r) => r.differs).length} ≠)`
              : ` (${s.rows.length})`}
          </button>
        ))}
      </div>
      {both && (
        <label className="check">
          <input type="checkbox" checked={differencesOnly} onChange={(e) => setDifferencesOnly(e.target.checked)} />{' '}
          Differences only
        </label>
      )}
      {(section.noteA || section.noteB) && (
        <p className="muted">
          Not read{section.noteA ? ` in A: ${section.noteA}` : ''}
          {section.noteB ? ` in B: ${section.noteB}` : ''}
        </p>
      )}
      {unreadable && (
        <p className="bad-text">
          Can't compare {section.title.toLowerCase()}: {section.noteA ? 'A' : 'B'} could not be read (see above). Shown
          as ?.
        </p>
      )}
      {rows.length === 0 ? (
        !unreadable && (
          <p className="good">✓ {both ? `No differences in ${section.title.toLowerCase()}.` : 'Nothing here.'}</p>
        )
      ) : copyable ? (
        <DiffTable
          diff={diffs}
          name={`${what}-${section.title}`}
          note={note}
          copy={{
            clientB,
            idB: idB!,
            what: `${what} (${section.title.toLowerCase()}) into ${labelB}`,
            labelB: orgB,
            onCopied: () => setRefresh((n) => n + 1),
          }}
        />
      ) : (
        <DataTable
          columns={['item', 'a', 'b', 'differs']}
          rows={rows.map((r) => ({ ...r, differs: r.differs ? '≠' : '' }))}
          rowKey="key"
          name={`${what}-${section.title}`}
          note={note}
        />
      )}
    </div>
  );
}

/** What makes B like A for one row of object, field or system access. */
function changeFor(title: string, r: MergedSection['rows'][number]): AccessChange | undefined {
  if (title === 'Object access') return { kind: 'object', object: r.key, access: accessFromText(r.a) };
  if (title === 'Field access') return { kind: 'field', field: r.key, read: Boolean(r.a), edit: r.a.includes('Edit') };
  if (title === 'User & system permissions')
    return { kind: 'system', api: r.key.replace(/^Permissions/, ''), label: r.item, enabled: r.a === '✓' };
  return undefined;
}

function SharesTable({
  a,
  b,
  note,
  name,
}: {
  a: UserSharing['userShares'];
  b: UserSharing['userShares'];
  note: string;
  name: string;
}) {
  const rows = mergeShares(a, b);
  return rows.length === 0 ? (
    <p className="muted">None.</p>
  ) : (
    <DataTable
      columns={['object', 'reason', 'a', 'b']}
      groupBy="object"
      rows={rows.map((r, i) => ({ ...r, key: i }))}
      rowKey="key"
      name={name}
      note={<span>{note} · records</span>}
    />
  );
}

function SharingNotes({ sharing }: { sharing: { a: UserSharing; b: UserSharing } }) {
  const notes = [...new Set([...sharing.a.notes, ...sharing.b.notes])];
  return (
    <p className="muted">
      Counted for Accounts, Opportunities, Cases, Contacts and Leads.
      {notes.length > 0 && ` Not read: ${notes.join(' · ')}`}
    </p>
  );
}

function mergeQueues(a: UserSharing['queues'], b: UserSharing['queues']) {
  const map = new Map<string, { queue: string; a: string; b: string }>();
  for (const q of a) map.set(String(q.queue), { queue: String(q.queue), a: String(q.objects) || '✓', b: '' });
  for (const q of b) {
    const k = String(q.queue);
    map.set(k, { ...(map.get(k) ?? { queue: k, a: '' }), b: String(q.objects) || '✓' });
  }
  return [...map.values()];
}

function roleRows(a: UserSharing, b: UserSharing) {
  const rows: Array<{ field: string; a: string; b: string }> = [
    { field: 'Role', a: a.role?.name ?? '—', b: b.role?.name ?? '—' },
    { field: 'Role hierarchy', a: a.role?.path ?? '—', b: b.role?.path ?? '—' },
    ...[...new Set([...Object.keys(a.role?.settings ?? {}), ...Object.keys(b.role?.settings ?? {})])].map((k) => ({
      field: k,
      a: String(a.role?.settings[k] ?? ''),
      b: String(b.role?.settings[k] ?? ''),
    })),
  ];
  return rows.map((r) => ({ ...r, differs: r.a !== r.b ? '≠' : '' }));
}
