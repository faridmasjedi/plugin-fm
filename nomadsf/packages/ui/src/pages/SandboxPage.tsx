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
  searchUsers,
  writeWorkbook,
  type FileTable,
  type SandboxItem,
  type SandboxSection,
  type UserMatch,
} from '@nomadsf/core';
import { DataTable, download } from '../components/DataTable';
import { SavedCopy } from '../components/SavedCopy';
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
        <input
          placeholder="Name, username or e-mail"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void find()}
        />
        <button onClick={() => void find()}>Find</button>
      </div>
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

  const keyOf = (i: SandboxItem) => `${i.section}|${i.key}`;
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
      setTicked(new Set(found.filter((i) => i.restorable && i.state !== 'same').map(keyOf)));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  const restore = async () => {
    const list = (items ?? []).filter((i) => ticked.has(keyOf(i)));
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
      setTicked(new Set(again.filter((i) => i.restorable && i.state !== 'same').map(keyOf)));
    }
  };

  const about = tables ? sandboxAbout(tables) : null;
  const rows = useMemo(
    () =>
      (items ?? [])
        .filter((i) => !onlyChanged || i.state !== 'same')
        .map((i) => ({
          key: keyOf(i),
          what: SANDBOX_LABELS[i.section],
          name: i.label,
          before: i.before,
          now: i.now,
          state: STATE_TEXT[i.state],
          action: i.state === 'same' ? '' : i.restorable ? 'NomadSF puts it back' : `by hand: ${i.how ?? 'Setup'}`,
        })),
    [items, onlyChanged]
  );

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
          {rows.length ? (
            <DataTable
              columns={['what', 'name', 'before', 'now', 'state', 'action']}
              rows={rows}
              rowKey="key"
              name={`${org.label}-after-refresh`}
              groupBy="what"
              selected={ticked}
              onSelectedChange={(next) =>
                // Only what NomadSF can put back can be ticked
                setTicked(
                  new Set(
                    [...next].filter((k) => items.some((i) => keyOf(i) === k && i.restorable && i.state !== 'same'))
                  )
                )
              }
              note={<span>· before = the workbook, now = {org.label}</span>}
            />
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
      {file && items && tables?.some((t) => t.name === 'NomadSF users') && (
        <div className="section">
          <h3>Users</h3>
          <SavedCopy key={file.name + file.size} file={file} usersOnly onClose={() => undefined} />
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
