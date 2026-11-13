import { useEffect, useMemo, useState } from 'react';
import {
  bulkAccess,
  bulkItems,
  findUsers,
  usersContaining,
  readTableFile,
  usersByValues,
  usersWhere,
  type BulkItem,
  type BulkKind,
  type BulkLine,
  type Row,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { Status } from '../statusLog';

type By = 'names' | 'usernames' | 'profile' | 'role' | 'query' | 'file';
const BY: Array<[By, string]> = [
  ['names', 'By name'],
  ['usernames', 'By username'],
  ['profile', 'By profile'],
  ['role', 'By role'],
  ['query', 'By a query'],
  ['file', 'From a CSV / Excel file'],
];
/** Conditions people often need, ready to change. */
const QUERY_EXAMPLES: Array<[string, string]> = [
  ["Profile.Name LIKE '%Sales%'", 'everyone whose profile has Sales in its name'],
  ["UserRole.Name = 'Support Manager'", 'one role'],
  ["Department = 'Finance' AND Title LIKE '%Analyst%'", 'two fields together'],
  ['CreatedDate = LAST_N_DAYS:30', 'users created in the last 30 days'],
  ['LastLoginDate < LAST_N_DAYS:90', 'no login for 90 days'],
  ["Email LIKE '%@acme.com'", 'an e-mail domain'],
];
/** A kind with more than this many items is searched, not listed. */
const LIST_ALL_UP_TO = 12;

const KINDS: BulkKind[] = ['Permission set', 'Permission set group', 'Public group', 'Queue'];
const RESULT_TONE: Record<BulkLine['result'], string> = {
  added: '✓ ',
  removed: '✓ ',
  'already had it': '',
  'did not have it': '',
  failed: '✗ ',
};

/**
 * Access › Assign in bulk: choose users (by name, username, profile, role, a query or a file), choose permission sets,
 * permission set groups, public groups and queues, then add them all or remove them all — once, after typing the org
 * name — with a line per user and item.
 */
export function BulkAccessPage() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [by, setBy] = useState<By>(() => storage.get<By>('bulk.by', 'names'));
  const [text, setText] = useState('');
  const [users, setUsers] = useState<Row[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [items, setItems] = useState<BulkItem[] | null>(null);
  const [kind, setKind] = useState<BulkKind>('Permission set');
  const [find, setFind] = useState('');
  const [chosen, setChosen] = useState<BulkItem[]>([]);
  const [expires, setExpires] = useState('');
  const [lines, setLines] = useState<BulkLine[] | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setItems(null);
    setChosen([]);
    setUsers([]);
    setLines(null);
    bulkItems(client)
      .then(setItems)
      .catch((e) => setStatus(`❌ ${(e as Error).message}`));
  }, [client]);

  const show = (list: Row[]) => {
    setUsers(list);
    setPicked(new Set(list.map((u) => String(u.Id))));
    setLines(null);
    setStatus(`${list.length} active user(s) found.`);
  };
  const findUsersNow = async () => {
    setStatus('Finding users…');
    try {
      const value = text.trim();
      show(
        by === 'query'
          ? await usersWhere(client, value)
          : by === 'names'
          ? await findUsers(client, { names: value.split(/[,;\n]+/).filter((n) => n.trim()) })
          : // Part of a username, profile or role is enough (any case); several separated by commas
            await usersContaining(
              client,
              by === 'usernames' ? 'Username' : by === 'profile' ? 'Profile.Name' : 'UserRole.Name',
              value.split(by === 'usernames' ? /[\s,;]+/ : /[,;\n]+/)
            )
      );
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  const fromFile = async (f: File) => {
    setStatus(`Reading ${f.name}…`);
    try {
      const table = (await readTableFile(f.name, new Uint8Array(await f.arrayBuffer()))).find((t) => t.columns.length);
      const col = (['Id', 'Username', 'Email'] as const).find((c) =>
        table?.columns.some((x) => x.toLowerCase() === c.toLowerCase())
      );
      if (!table || !col) throw new Error('The file needs an Id, Username or Email column.');
      const key = table.columns.find((x) => x.toLowerCase() === col.toLowerCase())!;
      show(
        await usersByValues(
          client,
          col,
          table.rows.map((r) => r[key] ?? '')
        )
      );
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const shown = useMemo(() => {
    const f = find.trim().toLowerCase();
    const have = new Set(chosen.map((c) => c.id));
    const ofKind = (items ?? []).filter((i) => i.kind === kind && !have.has(i.id));
    // A short list is shown whole; a long one (hundreds of permission sets) only as it is searched
    if (!f && ofKind.length > LIST_ALL_UP_TO) return [];
    return ofKind.filter((i) => !f || i.label.toLowerCase().includes(f)).slice(0, 25);
  }, [items, kind, find, chosen]);
  const count = (k: BulkKind) => (items ?? []).filter((i) => i.kind === k).length;

  const run = async (action: 'add' | 'remove') => {
    const people = users.filter((u) => picked.has(String(u.Id)));
    if (!people.length || !chosen.length) return;
    const what = chosen.map((c) => c.label).join(', ');
    if (
      !(await confirmChange(
        `${action === 'add' ? 'Give' : 'Take back'} ${chosen.length} item(s) (${what}) ${
          action === 'add' ? 'to' : 'from'
        } ${people.length} user(s) in ${org.label}.`
      ))
    )
      return;
    setBusy(true);
    setStatus(action === 'add' ? 'Adding…' : 'Removing…');
    try {
      const out = await bulkAccess(
        client,
        chosen,
        people.map((u) => ({ id: String(u.Id), name: String(u.Name ?? u.Username ?? u.Id) })),
        action,
        action === 'add' && expires ? expires : undefined
      );
      setLines(out);
      const tally = (r: BulkLine['result']) => out.filter((l) => l.result === r).length;
      const failed = tally('failed');
      setStatus(
        `${failed ? '⚠' : '✓'} ${action === 'add' ? `${tally('added')} added` : `${tally('removed')} removed`}, ${
          tally('already had it') + tally('did not have it')
        } left as they were${failed ? `, ${failed} failed (see the list)` : ''}.`
      );
      logActivity(`bulk-${action}`, { users: people.length, items: chosen.map((c) => `${c.kind}: ${c.label}`) });
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Assign in bulk</h2>
        <span className="muted">
          Permission sets, permission set groups, public groups and queues — to or from many users in {org.label}
        </span>
      </div>

      <div className="card section">
        <h3>1 · Users</h3>
        <div className="form">
          <div className="segmented" role="group" aria-label="Find users">
            {BY.map(([id, label]) => (
              <button
                key={id}
                className={by === id ? 'active' : ''}
                onClick={() => {
                  setBy(id);
                  storage.set('bulk.by', id);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        {by === 'file' ? (
          <div className="form">
            <label className="file-button">
              Choose the file…
              <input
                type="file"
                accept=".csv,.xlsx,.xls"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void fromFile(f);
                }}
              />
            </label>
            <span className="muted small">A column named Id, Username or Email</span>
          </div>
        ) : (
          <div className="form">
            <input
              className={by === 'query' ? 'mono grow' : 'grow'}
              placeholder={
                by === 'names'
                  ? 'Names or parts of names: Ann, Bob Ray'
                  : by === 'usernames'
                  ? 'Usernames or parts of them: ann.lee, @acme.com'
                  : by === 'profile'
                  ? 'Profile or part of it: Standard, Sales'
                  : by === 'role'
                  ? 'Role or part of it: Manager, Support'
                  : "Only the condition (after WHERE): Department = 'Sales'"
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void findUsersNow()}
            />
            <button onClick={() => void findUsersNow()} disabled={!text.trim()}>
              Find
            </button>
          </div>
        )}
        {by === 'query' && (
          <div className="query-examples">
            <span className="muted small">Only the condition on User — for example:</span>
            {QUERY_EXAMPLES.map(([q, what]) => (
              <button key={q} className="chip" title={what} onClick={() => setText(q)}>
                <span className="mono">{q}</span>
              </button>
            ))}
          </div>
        )}
        {users.length > 0 && (
          <DataTable
            columns={['Name', 'Username', 'Profile.Name', 'UserRole.Name']}
            rows={users}
            name="users"
            selected={picked}
            onSelectedChange={setPicked}
          />
        )}
      </div>

      <div className="card section">
        <h3>2 · What to give or take back</h3>
        {items === null ? (
          <p className="muted">Reading permission sets, groups and queues…</p>
        ) : (
          <>
            <div className="form">
              <div className="segmented" role="group" aria-label="Kind">
                {KINDS.map((k) => (
                  <button
                    key={k}
                    className={kind === k ? 'active' : ''}
                    onClick={() => {
                      // Another kind: a fresh search (what was typed for permission sets rarely names a queue)
                      setKind(k);
                      setFind('');
                    }}
                  >
                    {k}s ({count(k)})
                  </button>
                ))}
              </div>
            </div>
            <div className="form">
              <input
                className="grow"
                placeholder={`Find ${kind.toLowerCase()}s by name`}
                value={find}
                onChange={(e) => setFind(e.target.value)}
              />
            </div>
            {shown.length > 0 ? (
              <ul className="bulk-matches" role="listbox" aria-label={`${kind}s`}>
                {shown.map((i) => (
                  <li key={i.id}>
                    <button onClick={() => setChosen([...chosen, i])}>
                      <span className="bulk-plus">+</span> {i.label}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">
                {find.trim()
                  ? 'Nothing else matches.'
                  : `Type part of a name to find one of the ${count(kind)} ${kind.toLowerCase()}s.`}
              </p>
            )}
            {find.trim() && shown.length === 25 && (
              <p className="muted small">The first 25 matches — type more to narrow them.</p>
            )}
            {chosen.length > 0 && (
              <>
                <h4>Chosen ({chosen.length})</h4>
                <div className="bulk-pick">
                  {chosen.map((c) => (
                    <button
                      key={c.id}
                      className="chip on"
                      title="Remove from the list"
                      onClick={() => setChosen(chosen.filter((x) => x.id !== c.id))}
                    >
                      <span className="muted small">{c.kind}</span> {c.label} ×
                    </button>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>

      <div className="card section">
        <h3>3 · Add or remove</h3>
        <div className="form">
          <label>
            Expires (optional, permission sets and their groups)
            <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </label>
        </div>
        <div className="form">
          <button className="primary" disabled={busy || !picked.size || !chosen.length} onClick={() => void run('add')}>
            Add {chosen.length || ''} to {picked.size || ''} user(s)…
          </button>
          <button disabled={busy || !picked.size || !chosen.length} onClick={() => void run('remove')}>
            Remove {chosen.length || ''} from {picked.size || ''} user(s)…
          </button>
          <Status text={status} />
        </div>
        {lines && (
          <DataTable
            columns={['user', 'kind', 'item', 'result', 'error']}
            rows={lines.map((l) => ({ ...l, result: `${RESULT_TONE[l.result]}${l.result}`, error: l.error ?? '' }))}
            name="bulk-access"
          />
        )}
      </div>
    </div>
  );
}
