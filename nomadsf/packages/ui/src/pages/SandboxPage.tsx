import { useMemo, useState } from 'react';
import {
  SANDBOX_CHECKLIST,
  SANDBOX_LABELS,
  SANDBOX_SHEETS,
  isSandboxWorkbook,
  readTableFile,
  sandboxAbout,
  sandboxAfter,
  sandboxBefore,
  sandboxRestore,
  fromCopySheets,
  invalidEmails,
  fixEmails,
  searchUsers,
  query,
  soqlText,
  type Row,
  writeWorkbook,
  type FileTable,
  type SandboxItem,
  type SandboxSection,
  type UserMatch,
} from '@nomadsf/core';
import { DataTable, download } from '../components/DataTable';
import { UsersFromWorkbook } from '../components/UsersFromWorkbook';
import { storage, useStudio } from '../context';
import { Status } from '../statusLog';

type Tab = 'before' | 'after' | 'checklist';

/**
 * Compare & move › Sandbox refresh. Before: save what a refresh replaces with production's, in one workbook. After:
 * open it in the refreshed sandbox, see what changed, put back what the API allows (it asks first), and go through
 * the Setup checklist. The refresh itself is started in Setup › Sandboxes, never here.
 */
export function SandboxPage() {
  const [tab, setTab] = useState<Tab>(() => storage.get('sandbox.tab', 'before'));
  const choose = (t: Tab) => {
    setTab(t);
    storage.set('sandbox.tab', t);
  };
  const { org } = useStudio();
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Sandbox refresh</h2>
        <span className="muted">
          Before: save what a refresh replaces. After: compare and put it back. The refresh itself is started in Setup.
        </span>
      </div>
      <div className="tabs" role="tablist">
        {(
          [
            ['before', `1 · Before the refresh (in ${org.label})`],
            ['after', '2 · After the refresh'],
            ['checklist', '3 · Setup checklist'],
          ] as Array<[Tab, string]>
        ).map(([id, label]) => (
          <button key={id} role="tab" className={`tab ${tab === id ? 'active' : ''}`} onClick={() => choose(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === 'before' && <Before />}
      {tab === 'after' && <After />}
      {tab === 'checklist' && <Checklist />}
    </div>
  );
}

/** Before: the users to keep, then one workbook of everything. */
function Before() {
  const studio = useStudio();
  const { client, org } = studio;
  const [typed, setTyped] = useState('');
  const [by, setBy] = useState<'name' | 'query' | 'file'>('name');
  const [where, setWhere] = useState("Profile.Name LIKE '%Integration%'");
  const [found, setFound] = useState<UserMatch[]>([]);
  const [users, setUsers] = useState<UserMatch[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const find = async () => {
    try {
      setFound(await searchUsers(client, typed));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  /** Adds users, each once. */
  const add = (list: UserMatch[]) => {
    const known = new Set(users.map((u) => u.Id));
    const next = [...users, ...list.filter((u) => !known.has(u.Id))];
    setUsers(next);
    setStatus(`${next.length - users.length} user(s) added.`);
  };
  const asMatch = (r: Row): UserMatch => r as unknown as UserMatch;
  const USER_FIELDS = 'Id, Name, Username, Email, IsActive, Profile.Name';
  // The users a query finds (a WHERE clause on User)
  const fromQuery = async () => {
    try {
      if (/;|\bLIMIT\b/i.test(where)) throw new Error('Only the condition, without LIMIT or ;');
      const r = await query(client, `SELECT ${USER_FIELDS} FROM User WHERE ${where} ORDER BY Name`, { maxRows: 2000 });
      if (!r.rows.length) throw new Error('No user matches.');
      add(r.rows.map(asMatch));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  // The users of a CSV or Excel file: a column Id, Username or Email
  const fromFile = async (f: File) => {
    try {
      const table = (await readTableFile(f.name, new Uint8Array(await f.arrayBuffer()))).find((t) => t.columns.length);
      if (!table) throw new Error(`No table in ${f.name}.`);
      const col = ['Id', 'Username', 'Email'].find((c) =>
        table.columns.some((x) => x.toLowerCase() === c.toLowerCase())
      );
      if (!col) throw new Error('The file needs a column Id, Username or Email.');
      const key = table.columns.find((x) => x.toLowerCase() === col.toLowerCase())!;
      const values = [...new Set(table.rows.map((r) => (r[key] ?? '').trim()).filter(Boolean))];
      const rows: Row[] = [];
      for (let i = 0; i < values.length; i += 200) {
        const list = values
          .slice(i, i + 200)
          .map((v) => `'${soqlText(v)}'`)
          .join(', ');
        // eslint-disable-next-line no-await-in-loop
        rows.push(
          ...(await query(client, `SELECT ${USER_FIELDS} FROM User WHERE ${col} IN (${list})`, { maxRows: 2000 })).rows
        );
      }
      add(rows.map(asMatch));
      if (rows.length < values.length) setStatus(`${rows.length} of ${values.length} found in ${org.label}.`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  const save = async () => {
    setBusy(true);
    setStatus('Reading remote sites, credentials, certificates, custom settings, scheduled Apex and the users…');
    try {
      const sheets = await sandboxBefore(client, { userIds: users.map((u) => u.Id), orgLabel: org.label });
      download(
        `${org.label}-before-refresh-${new Date().toLocaleDateString('en-CA')}.xlsx`,
        writeWorkbook(sheets),
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      const count = (section: SandboxSection) =>
        sheets.find((x) => x.name === SANDBOX_SHEETS[section])?.rows.length ?? 0;
      studio.logActivity('sandbox before refresh', { users: users.length });
      setStatus(
        `✓ Saved: ${users.length} user(s), ${(Object.keys(SANDBOX_LABELS) as SandboxSection[])
          .map((k) => `${count(k)} ${SANDBOX_LABELS[k].toLowerCase()}`)
          .join(', ')}. Keep the file: open it in “After the refresh”.`
      );
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
    setBusy(false);
  };

  return (
    <div className="card section">
      <p className="note">
        Do this in the sandbox <b>before</b> you refresh it. The workbook keeps what the refresh replaces with
        production’s: remote sites, named and external credentials, certificates (names), custom setting values,
        scheduled Apex — and the users you add below with their profile, role, permission sets and groups (integration
        users, testers…). Secrets are never readable: the checklist covers them.
      </p>
      <h3>Users to keep</h3>
      <div className="form">
        <div className="segmented" role="group" aria-label="Find users by">
          {(
            [
              ['name', 'By name'],
              ['query', 'By a query'],
              ['file', 'From a CSV / Excel file'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={by === id ? 'active' : ''} onClick={() => setBy(id)}>
              {label}
            </button>
          ))}
        </div>
        {by === 'name' && (
          <>
            <input
              placeholder="Name, username or e-mail"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void find()}
            />
            <button onClick={() => void find()}>Find</button>
          </>
        )}
        {by === 'query' && (
          <>
            <span className="mono muted">SELECT … FROM User WHERE</span>
            <input
              className="mono"
              style={{ minWidth: 380 }}
              value={where}
              onChange={(e) => setWhere(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void fromQuery()}
            />
            <button onClick={() => void fromQuery()}>Add them all</button>
          </>
        )}
        {by === 'file' && (
          <label className="file-button">
            Choose the file…
            <input
              type="file"
              accept=".csv,.xlsx,text/csv"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void fromFile(f);
              }}
            />
          </label>
        )}
      </div>
      {by === 'query' && (
        <p className="muted small">
          e.g. <code>Profile.Name = &apos;Integration User&apos;</code> ·{' '}
          <code>UserType = &apos;Standard&apos; AND IsActive = true AND Department = &apos;QA&apos;</code>
        </p>
      )}
      {by === 'file' && <p className="muted small">A column named Id, Username or Email; one user per row.</p>}
      {found.length > 0 && (
        <div className="chips">
          {found
            .filter((f) => !users.some((u) => u.Id === f.Id))
            .slice(0, 20)
            .map((f) => (
              <button key={f.Id} className="chip" onClick={() => setUsers([...users, f])}>
                + {f.Name} <span className="muted">{f.Username}</span>
              </button>
            ))}
        </div>
      )}
      {users.length > 0 ? (
        <div className="chips">
          <span className="muted">{users.length} user(s):</span>
          {users.length > 1 && (
            <button className="link" onClick={() => setUsers([])}>
              take all out
            </button>
          )}
          {users.map((u) => (
            <button
              key={u.Id}
              className="chip on"
              title="Take out"
              onClick={() => setUsers(users.filter((x) => x.Id !== u.Id))}
            >
              {u.Name} ✕
            </button>
          ))}
        </div>
      ) : (
        <p className="muted">No users yet (optional).</p>
      )}
      <div className="form">
        <button className="primary" disabled={busy} onClick={() => void save()}>
          Save the workbook
        </button>
        <Status text={status} />
      </div>
    </div>
  );
}

const STATE_TEXT: Record<SandboxItem['state'], string> = {
  same: '✓ same',
  different: '≠ different',
  missing: '✕ missing',
};

/** After: the workbook next to this org, what to put back, and its users. */
function After() {
  const studio = useStudio();
  const { client, org } = studio;
  const [file, setFile] = useState<File | null>(null);
  const [tables, setTables] = useState<FileTable[] | null>(null);
  const [items, setItems] = useState<SandboxItem[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [onlyChanged, setOnlyChanged] = useState(true);
  const [status, setStatus] = useState('');
  // A value changed before it is put back (a custom setting value, a remote site's URL, a job's schedule), by item
  const [edits, setEdits] = useState<Record<string, string>>({});
  // Kept users whose e-mail the refresh ended with ".invalid"
  const [emails, setEmails] = useState<Row[] | null>(null);

  const keyOf = (i: SandboxItem) => `${i.section}|${i.key}`;
  const valueOf = (i: SandboxItem) => edits[keyOf(i)] ?? String(i.edit ? i.row[i.edit.field] ?? '' : '');
  const tick = (key: string, on: boolean) => {
    const next = new Set(ticked);
    if (on) next.add(key);
    else next.delete(key);
    setTicked(next);
  };
  const open = async (f: File) => {
    setFile(null);
    setItems(null);
    setStatus(`Reading ${f.name}…`);
    try {
      const read = await readTableFile(f.name, new Uint8Array(await f.arrayBuffer()));
      if (!isSandboxWorkbook(read)) throw new Error('This is not a workbook saved in “Before the refresh”.');
      setFile(f);
      setTables(read);
      setStatus(`Comparing with ${org.label}…`);
      const found = await sandboxAfter(client, read);
      setItems(found);
      setEdits({});
      setTicked(new Set(found.filter((i) => i.restorable && i.state !== 'same').map(keyOf)));
      setStatus('');
      setEmails(null);
      const kept = fromCopySheets(read.filter((t) => t.columns.length)).users;
      if (kept.length)
        void invalidEmails(client, kept)
          .then(setEmails)
          .catch(() => setEmails([]));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  const restore = async () => {
    // The chosen items, with the values as edited
    const list = (items ?? [])
      .filter((i) => ticked.has(keyOf(i)))
      .map((i) => (i.edit ? { ...i, row: { ...i.row, [i.edit.field]: valueOf(i) } } : i));
    if (!list.length || !(await studio.confirmChange(`Put back ${list.length} item(s) in ${org.label}`))) return;
    setStatus(`Putting back ${list.length} item(s)…`);
    const r = await sandboxRestore(client, list);
    studio.logActivity('sandbox after refresh', { restored: r.done.length, failed: r.failed.length });
    setStatus(
      r.failed.length
        ? `Done: ${r.done.length}. ❌ ${r.failed.map((f) => `${f.item}: ${f.error}`).join('; ')}`
        : `✓ Put back ${r.done.length}.`
    );
    if (tables) {
      const again = await sandboxAfter(client, tables);
      setItems(again);
      setEdits({});
      setTicked(new Set(again.filter((i) => i.restorable && i.state !== 'same').map(keyOf)));
    }
  };
  const fixAll = async () => {
    if (
      !emails?.length ||
      !(await studio.confirmChange(`Set back ${emails.length} e-mail address(es) in ${org.label}`))
    )
      return;
    const r = await fixEmails(client, emails);
    studio.logActivity('sandbox after refresh', { emailsFixed: r.done });
    setStatus(
      r.errors.length ? `E-mails: ${r.done} set. ❌ ${r.errors.join('; ')}` : `✓ ${r.done} e-mail(s) set back.`
    );
    setEmails(emails.filter((e) => r.errors.some((x) => x.startsWith(String(e.Username)))));
  };

  const about = tables ? sandboxAbout(tables) : null;
  // The users kept in the workbook, with the files of their permission sets and groups
  const kept = useMemo(() => (tables ? fromCopySheets(tables.filter((t) => t.columns.length)) : null), [tables]);
  // The items shown, by section, in the order of the workbook
  const sections = useMemo(() => {
    const shown = (items ?? []).filter((i) => !onlyChanged || i.state !== 'same' || ticked.has(keyOf(i)));
    return (Object.keys(SANDBOX_LABELS) as SandboxSection[])
      .map((section) => ({ section, list: shown.filter((i) => i.section === section) }))
      .filter((g) => g.list.length);
  }, [items, onlyChanged, ticked]);

  return (
    <>
      <div className="card section">
        <p className="note">
          Do this in the sandbox <b>after</b> the refresh, with the workbook saved before it. Nothing changes until you
          tick what to put back and type the org name.
        </p>
        <div className="form">
          <label className="file-button">
            {file ? 'Open another workbook…' : 'Open the workbook…'}
            <input
              type="file"
              accept=".xlsx"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void open(f);
              }}
            />
          </label>
          {file && (
            <span>
              <b>{file.name}</b>
              {about && (
                <span className="muted">
                  {' '}
                  · saved in {about.org} {about.saved ? `on ${about.saved.slice(0, 10)}` : ''}
                </span>
              )}
            </span>
          )}
          <Status text={status} />
        </div>
      </div>
      {items && (
        <div className="card section">
          <h3>Settings and jobs</h3>
          <label className="check">
            <input type="checkbox" checked={onlyChanged} onChange={(e) => setOnlyChanged(e.target.checked)} /> Only what
            changed ({items.filter((i) => i.state !== 'same').length} of {items.length})
          </label>
          {sections.length ? (
            sections.map(({ section, list }) => {
              const can = list.filter((i) => i.restorable);
              const on = can.filter((i) => ticked.has(keyOf(i))).length;
              return (
                <div key={section} className="after-group">
                  <h4>
                    {can.length > 0 && (
                      <input
                        type="checkbox"
                        aria-label={`All ${SANDBOX_LABELS[section]}`}
                        checked={on === can.length}
                        ref={(el) => {
                          if (el) el.indeterminate = on > 0 && on < can.length;
                        }}
                        onChange={(e) => {
                          const next = new Set(ticked);
                          for (const i of can) {
                            if (e.target.checked) next.add(keyOf(i));
                            else next.delete(keyOf(i));
                          }
                          setTicked(next);
                        }}
                      />
                    )}{' '}
                    {SANDBOX_LABELS[section]} <span className="muted">({list.length})</span>
                  </h4>
                  <div className="table-scroll">
                    <table className="after-table">
                      <thead>
                        <tr>
                          <th />
                          <th>name</th>
                          <th>before</th>
                          <th>now in {org.label}</th>
                          <th>put back as</th>
                          <th>state</th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((i) => {
                          const k = keyOf(i);
                          return (
                            <tr key={k} className={ticked.has(k) ? 'picked' : ''}>
                              <td>
                                {i.restorable && (
                                  <input
                                    type="checkbox"
                                    aria-label={`Put back ${i.label}`}
                                    checked={ticked.has(k)}
                                    onChange={(e) => tick(k, e.target.checked)}
                                  />
                                )}
                              </td>
                              <td className="name">{i.label}</td>
                              <td>{i.before}</td>
                              <td>{i.now || <span className="muted">—</span>}</td>
                              <td>
                                {i.restorable && i.edit ? (
                                  <input
                                    className="mono"
                                    aria-label={`New ${i.edit.label} of ${i.label}`}
                                    value={valueOf(i)}
                                    onChange={(e) => {
                                      setEdits({ ...edits, [k]: e.target.value });
                                      tick(k, true);
                                    }}
                                  />
                                ) : i.restorable ? (
                                  <span className="muted">as saved</span>
                                ) : (
                                  <span className="muted">by hand: {i.how ?? 'Setup'}</span>
                                )}
                              </td>
                              <td>{STATE_TEXT[i.state]}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })
          ) : (
            <p className="good">✓ Everything is as it was.</p>
          )}
          <div className="form">
            <button className="primary" disabled={!ticked.size} onClick={() => void restore()}>
              Put back {ticked.size || ''} ticked…
            </button>
          </div>
        </div>
      )}
      {emails && emails.length > 0 && (
        <div className="card section">
          <h3>E-mails the refresh changed</h3>
          <p className="muted">
            A refresh adds “.invalid” to every e-mail so the sandbox never mails real people. These kept users need
            theirs back (Salesforce may send them a confirmation).
          </p>
          <DataTable
            columns={['Name', 'Username', 'Email', 'Fixed']}
            rows={emails}
            rowKey="Id"
            name={`${org.label}-invalid-emails`}
          />
          <div className="form">
            <button className="primary" onClick={() => void fixAll()}>
              Set back {emails.length} e-mail(s)…
            </button>
          </div>
        </div>
      )}
      {kept && kept.users.length > 0 && (
        <div className="section">
          <h3>Users ({kept.users.length})</h3>
          <UsersFromWorkbook key={file?.name} users={kept.users} metadata={kept.metadata} source={file?.name ?? ''} />
        </div>
      )}
    </>
  );
}

/** What only Setup can do, ticked off as you go (kept in this browser). */
function Checklist() {
  const [done, setDone] = useState<Set<number>>(() => new Set(storage.get<number[]>('sandbox.checklist', [])));
  const flip = (i: number) => {
    const next = new Set(done);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    setDone(next);
    storage.set('sandbox.checklist', [...next]);
  };
  return (
    <div className="card section">
      <p className="note">After every refresh, by hand in Setup (the API cannot read or set these):</p>
      <ul className="checklist">
        {SANDBOX_CHECKLIST.map((c, i) => (
          <li key={c.what}>
            <label className="check">
              <input type="checkbox" checked={done.has(i)} onChange={() => flip(i)} /> {c.what}{' '}
              <span className="muted">— {c.where}</span>
            </label>
          </li>
        ))}
      </ul>
      <button onClick={() => (setDone(new Set()), storage.set('sandbox.checklist', []))}>Start again</button>
    </div>
  );
}
