import { Select } from '../components/Select';
import { useEffect, useMemo, useState } from 'react';
import {
  SECURITY_TILES,
  describeGlobal,
  findUsers,
  objectSharing,
  type ObjectSharing,
  type SObjectSummary,
  type SharingTarget,
  securityTimeline,
  whoCanSee,
  whoCanUse,
  findRecords,
  lookupFields,
  query,
  type AccessStep,
  type LookupField,
  type RecordPick,
  type TileValue,
  type TimelineKind,
  type TimelineRow,
} from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { activityLog, storage, useStudio } from '../context';
import { Status } from '../statusLog';
import { objectChoices } from '../components/ObjectOptions';
import { ComboInput } from '../components/ComboInput';
import { MemberNode } from './AccessManagePages';

// ---------- Security › Dashboard ----------

type TileState = TileValue | { error: string } | undefined;

/** Tiles of small checks, each read on its own when the page opens; a click opens the tool it comes from. */
export function SecurityDashboardPage({ onOpen }: { onOpen: (tool: string, set?: Record<string, string>) => void }) {
  const { client, org } = useStudio();
  const [values, setValues] = useState<Record<string, TileState>>({});
  const [round, setRound] = useState(0);
  useEffect(() => {
    setValues({});
    let canceled = false;
    for (const tile of SECURITY_TILES)
      tile
        .read(client)
        .then((v) => !canceled && setValues((all) => ({ ...all, [tile.id]: v })))
        .catch((e: Error) => !canceled && setValues((all) => ({ ...all, [tile.id]: { error: e.message } })));
    return () => {
      canceled = true;
    };
  }, [client, round]);
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Security dashboard</h2>
        <span className="muted">{org.label} at a glance — click a tile for the details</span>
        <span className="grow" />
        <button onClick={() => setRound(round + 1)}>Refresh</button>
      </div>
      <div className="sec-tiles">
        {SECURITY_TILES.map((t) => {
          const v = values[t.id];
          const failed = v && 'error' in v;
          const shown = v && !failed ? (v as TileValue) : undefined;
          return (
            <button
              key={t.id}
              className={`sec-tile ${shown?.level ?? ''}`}
              title={failed ? (v as { error: string }).error : undefined}
              onClick={() => onOpen(t.tool, t.set)}
            >
              <span className="sec-tile-label">{t.label}</span>
              <b className="sec-tile-value">{!v ? '…' : failed ? '?' : shown!.value}</b>
              <span className="muted small">
                {!v ? 'reading…' : failed ? 'could not be read (permission?)' : shown!.detail}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Security › Timeline ----------

const KINDS: TimelineKind[] = ['Setup', 'Login', 'Component', 'NomadSF'];

/**
 * What happened in the org, in one table, newest first: setup changes, logins, components last changed, and what
 * was done with NomadSF. Read when you press Show; filter by who, what and kind like any table.
 */
export function TimelinePage() {
  const { client, org } = useStudio();
  const [days, setDays] = useState(7);
  const [kinds, setKinds] = useState<Set<TimelineKind>>(() => {
    // The dashboard can open it on one kind (Setup changes)
    const only = storage.get<string>('timeline.kinds', '');
    storage.set('timeline.kinds', '');
    return new Set(only ? (only.split(',') as TimelineKind[]) : KINDS);
  });
  const [rows, setRows] = useState<TimelineRow[] | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const show = async () => {
    setBusy(true);
    setRows(null);
    setStatus('Reading what happened…');
    try {
      const activity = activityLog.list().filter((a) => a.org === org.label || a.org === org.id);
      const t = await securityTimeline(client, { days, kinds: [...kinds], activity });
      setRows(t.rows);
      setStatus(t.notes.length ? `Not read: ${t.notes.join(' · ')}` : `✓ ${t.rows.length.toLocaleString()} events.`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Timeline</h2>
        <span className="muted">Everything that happened in {org.label}, in one place</span>
      </div>
      <div className="form">
        <label>
          Last
          <Select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[1, 7, 30, 90].map((d) => (
              <option key={d} value={d}>
                {d} day(s)
              </option>
            ))}
          </Select>
        </label>
        {KINDS.map((k) => (
          <label key={k} className="check">
            <input
              type="checkbox"
              checked={kinds.has(k)}
              onChange={(e) => {
                const next = new Set(kinds);
                if (e.target.checked) next.add(k);
                else next.delete(k);
                setKinds(next);
              }}
            />{' '}
            {k === 'Setup'
              ? 'Setup changes'
              : k === 'Login'
              ? 'Logins'
              : k === 'Component'
              ? 'Components changed'
              : 'Done with NomadSF'}
          </label>
        ))}
        <button className="primary" disabled={busy || !kinds.size} onClick={() => void show()}>
          Show
        </button>
      </div>
      {status && <Status text={status} block />}
      {rows &&
        (rows.length === 0 ? (
          <EmptyHint what="events in these days" />
        ) : (
          <DataTable
            columns={['when', 'who', 'kind', 'what', 'detail']}
            rows={rows.map((r, i) => ({ ...r, __k: i }))}
            rowKey="__k"
            name={`${org.label}-timeline`}
            groupBy={undefined}
            note={<span>· newest first; Filters for a person, a component or a kind</span>}
          />
        ))}
      <p className="muted small">
        For API calls, Apex and page views as well, see <b>Event logs</b> (orgs with Event Monitoring).
      </p>
    </div>
  );
}

// ---------- Security › Who can see this record? ----------

type UserPick = { Id: string; Name: string; Username: string };

/** What is checked: one record, or — without a record — an object, a field, or a class, page or custom permission. */
type WhoWhat = 'record' | 'object' | 'field' | 'meta';
type MetaKind = 'ApexClass' | 'ApexPage' | 'CustomPermission';
const META_KINDS: Array<[MetaKind, string]> = [
  ['ApexClass', 'Apex class'],
  ['ApexPage', 'Visualforce page'],
  ['CustomPermission', 'Custom permission'],
];
type WhoResult = { what: string; can: Array<[string, boolean]>; steps: AccessStep[]; note?: string };

/**
 * A user and something in the org: what Salesforce lets them do with it, and why, step by step. A record (by its
 * Id, a link, or found by name in an object), or without a record an object, a field, or an Apex class, Visualforce
 * page or custom permission. Read only.
 */
export function WhoCanSeePage() {
  const { client, org } = useStudio();
  const [typed, setTyped] = useState('');
  const [users, setUsers] = useState<UserPick[]>([]);
  const [user, setUser] = useState<UserPick | null>(null);
  const [what, setWhat] = useState<WhoWhat>(() => storage.get<WhoWhat>('whocansee.what', 'record'));
  const [objects, setObjects] = useState<SObjectSummary[]>([]);
  const [object, setObject] = useState('');
  const [recordText, setRecordText] = useState('');
  const [records, setRecords] = useState<RecordPick[]>([]);
  const [recordId, setRecordId] = useState('');
  const [fields, setFields] = useState<LookupField[]>([]);
  const [field, setField] = useState('');
  const [metaKind, setMetaKind] = useState<MetaKind>('ApexClass');
  const [metaNames, setMetaNames] = useState<string[]>([]);
  const [metaName, setMetaName] = useState('');
  const [result, setResult] = useState<WhoResult | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const choose = (w: WhoWhat) => {
    setWhat(w);
    setResult(null);
    setStatus('');
    storage.set('whocansee.what', w);
  };
  useEffect(() => {
    describeGlobal(client)
      .then((list) => setObjects(list.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => undefined);
  }, [client]);
  const objectName = objects.find((o) => o.name.toLowerCase() === object.trim().toLowerCase())?.name ?? '';

  useEffect(() => {
    if (typed.trim().length < 2 || user) return undefined;
    const t = setTimeout(
      () =>
        void findUsers(client, { names: [typed.trim()] })
          .then((list) => setUsers(list.slice(0, 20) as unknown as UserPick[]))
          .catch(() => setUsers([])),
      300
    );
    return () => clearTimeout(t);
  }, [typed, client, user]);

  // A record: an Id or a link is used as it is; with an object chosen, its records whose name holds the text
  const typedId = useMemo(
    () => recordText.match(/\b([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)\b/g)?.find((t) => /\d/.test(t)) ?? '',
    [recordText]
  );
  useEffect(() => {
    setRecords([]);
    if (what !== 'record' || !objectName || typedId) return undefined;
    const t = setTimeout(
      () =>
        void findRecords(client, objectName, recordText)
          .then(setRecords)
          .catch(() => setRecords([])),
      350
    );
    return () => clearTimeout(t);
  }, [what, objectName, recordText, typedId, client]);
  useEffect(() => setRecordId(typedId), [typedId]);

  useEffect(() => {
    setFields([]);
    if (what !== 'field' || !objectName) return;
    lookupFields(client, objectName)
      .then(setFields)
      .catch(() => setFields([]));
  }, [what, objectName, client]);

  useEffect(() => {
    setMetaNames([]);
    if (what !== 'meta') return;
    const name = metaKind === 'CustomPermission' ? 'DeveloperName' : 'Name';
    query(client, `SELECT ${name} FROM ${metaKind} ORDER BY ${name}`, { maxRows: 5000 })
      .then((r) => setMetaNames(r.rows.map((row) => String(row[name]))))
      .catch(() => setMetaNames([]));
  }, [what, metaKind, client]);

  const ready =
    !!user &&
    (what === 'record'
      ? !!recordId
      : what === 'object'
      ? !!objectName
      : what === 'field'
      ? !!objectName && !!field.trim()
      : !!metaName.trim());

  const check = async () => {
    if (!user) return;
    setBusy(true);
    setResult(null);
    setStatus('Checking…');
    try {
      if (what === 'record') {
        const r = await whoCanSee(client, user.Id, recordId);
        const picked = records.find((x) => x.Id === recordId);
        setResult({
          what: `${r.object}${picked ? ` ${picked.Name}` : ''}`,
          can: [
            ['Read', r.read],
            ['Edit', r.edit],
            ['Delete', r.delete],
            ['Transfer', r.transfer],
          ],
          steps: r.steps,
          note: r.editNeeds,
        });
      } else
        setResult(
          await whoCanUse(
            client,
            user.Id,
            what === 'object'
              ? { kind: 'object', object: objectName }
              : what === 'field'
              ? { kind: 'field', object: objectName, field: field.trim() }
              : { kind: metaKind, name: metaName.trim() }
          )
        );
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const objectBox = (placeholder: string) => (
    <ComboInput
      options={objectChoices(objects)}
      placeholder={placeholder}
      value={object}
      style={{ minWidth: 220 }}
      onChange={(e) => {
        setObject(e.target.value);
        setResult(null);
      }}
    />
  );

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Who can see this?</h2>
        <span className="muted">
          A user and a record, object, field or class in {org.label}: what they can do, and why
        </span>
      </div>
      <div className="form">
        {user ? (
          <span className="who-user">
            <b>{user.Name}</b>
            <span className="muted">{user.Username}</span>
            <button
              onClick={() => {
                setUser(null);
                setResult(null);
              }}
            >
              Change
            </button>
          </span>
        ) : (
          <span className="who-pick">
            <input
              style={{ minWidth: 260 }}
              placeholder="User: name, username or email"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
            />
            {users.length > 0 && (
              <Select
                value=""
                onChange={(e) => {
                  setUser(users.find((u) => u.Id === e.target.value) ?? null);
                  setUsers([]);
                }}
              >
                <option value="">{users.length} user(s)…</option>
                {users.map((u) => (
                  <option key={u.Id} value={u.Id}>
                    {u.Name} — {u.Username}
                  </option>
                ))}
              </Select>
            )}
          </span>
        )}
      </div>
      <div className="form">
        <div className="segmented" role="group" aria-label="What to check">
          {(
            [
              ['record', 'A record'],
              ['object', 'An object'],
              ['field', 'A field'],
              ['meta', 'A class, page or permission'],
            ] as const
          ).map(([id, label]) => (
            <button key={id} className={what === id ? 'active' : ''} onClick={() => choose(id)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="form">
        {what === 'record' && (
          <>
            {objectBox('Object (to find by name)')}
            <input
              style={{ minWidth: 260 }}
              placeholder={objectName ? `${objectName}: a name, an Id or a link` : 'Record Id or a Salesforce link'}
              value={recordText}
              onChange={(e) => {
                setRecordText(e.target.value);
                setResult(null);
              }}
            />
            {!typedId && records.length > 0 && (
              <Select value={recordId} onChange={(e) => setRecordId(e.target.value)}>
                <option value="">{records.length} record(s)…</option>
                {records.map((r) => (
                  <option key={r.Id} value={r.Id}>
                    {r.Name} — {r.Id}
                  </option>
                ))}
              </Select>
            )}
          </>
        )}
        {what === 'object' && objectBox('Object')}
        {what === 'field' && (
          <>
            {objectBox('Object')}
            <ComboInput
              options={fields.map((f) => ({ value: f.name, label: `${f.label} (${f.name})` }))}
              placeholder={objectName ? 'Field' : 'Choose the object first'}
              disabled={!objectName}
              value={field}
              style={{ minWidth: 220 }}
              onChange={(e) => {
                setField(e.target.value);
                setResult(null);
              }}
            />
          </>
        )}
        {what === 'meta' && (
          <>
            <Select
              value={metaKind}
              onChange={(e) => {
                setMetaKind(e.target.value as MetaKind);
                setMetaName('');
                setResult(null);
              }}
            >
              {META_KINDS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </Select>
            <ComboInput
              options={metaNames.map((n) => ({ value: n }))}
              placeholder="Name"
              value={metaName}
              style={{ minWidth: 240 }}
              onChange={(e) => {
                setMetaName(e.target.value);
                setResult(null);
              }}
            />
          </>
        )}
        <button className="primary" disabled={busy || !ready} onClick={() => void check()}>
          Check
        </button>
      </div>
      {status && <Status text={status} block />}
      {result && user && (
        <div className="card section who-result">
          <div className="who-verdict">
            <b>{user.Name}</b> can, on {result.what}:
            {result.can.map(([label, ok]) => (
              <span key={label} className={`pill ${ok ? 'good' : 'bad'}`}>
                {label} {ok ? '✓' : '✗'}
              </span>
            ))}
          </div>
          <h4>Why</h4>
          <ol className="who-steps">
            {result.steps.map((s, i) => (
              <li key={i} className={s.applies ? 'applies' : ''}>
                <span className="pill">{s.area}</span> {s.text}
              </li>
            ))}
          </ol>
          {result.note && <p className="note">→ {result.note}</p>}
          <p className="muted small">
            {what === 'record'
              ? "The answer is Salesforce's own (UserRecordAccess); the steps explain it. Territories and implicit sharing (a parent's sharing for its children) also count and are not listed one by one."
              : 'From the profile, permission sets and permission set groups of the user. Which records they see also depends on sharing: check one record for that.'}
          </p>
        </div>
      )}
    </div>
  );
}

// ---------- Security › Sharing ----------

/**
 * How an object's records are shared, as a tree: org-wide defaults, the role hierarchy, then each sharing rule —
 * which records, with whom, how — where a group or role opens to the people inside. Read when you press Show.
 */
/** "Group Sales Leads", "Role and subordinates Support Manager", "All internal users". */
const targetText = (t: SharingTarget): string =>
  t.kind === 'allInternalUsers'
    ? 'All internal users'
    : `${t.member?.Kind ?? t.kind.replace(/([A-Z])/g, ' $1').toLowerCase()} ${t.name}`.trim();

export function SharingPage() {
  const { client, org } = useStudio();
  const [objects, setObjects] = useState<SObjectSummary[]>([]);
  const [typed, setTyped] = useState(() => storage.get('sharing.object', ''));
  const [result, setResult] = useState<ObjectSharing | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'tree' | 'table'>(() => storage.get<'tree' | 'table'>('sharing.view', 'tree'));
  const pick = (v: 'tree' | 'table') => {
    setView(v);
    storage.set('sharing.view', v);
  };
  useEffect(() => {
    describeGlobal(client)
      .then((list) => setObjects(list.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => undefined);
  }, [client]);
  const show = async () => {
    const name = objects.find((o) => o.name.toLowerCase() === typed.trim().toLowerCase())?.name ?? typed.trim();
    setBusy(true);
    setResult(null);
    setStatus(`Reading how ${name} is shared…`);
    try {
      const r = await objectSharing(client, name);
      setResult(r);
      storage.set('sharing.object', name);
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const who = (t: SharingTarget, key: string) =>
    t.member ? (
      <MemberNode key={key} member={t.member} path={[]} />
    ) : (
      <div className="auto-node-row">
        <span className="auto-node-toggle">·</span>
        <span className="pill">{t.kind === 'allInternalUsers' ? 'Everyone' : t.kind || 'Unknown'}</span>
        <b>{t.kind === 'allInternalUsers' ? 'All internal users' : t.name}</b>
      </div>
    );
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Sharing</h2>
        <span className="muted">How an object's records are shared in {org.label}, as a tree or a table</span>
      </div>
      <div className="form">
        <ComboInput
          options={objectChoices(objects)}
          placeholder="Object, e.g. Case"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void show()}
        />
        <button className="primary" disabled={busy || !typed.trim()} onClick={() => void show()}>
          Show
        </button>
      </div>
      {status && <Status text={status} block />}
      {result && (
        <div className="tabs">
          {(
            [
              ['tree', 'Tree'],
              ['table', 'Table'],
            ] as Array<['tree' | 'table', string]>
          ).map(([id, label]) => (
            <button key={id} className={`tab ${view === id ? 'active' : ''}`} onClick={() => pick(id)}>
              {label}
            </button>
          ))}
        </div>
      )}
      {result && view === 'table' && (
        <div className="section">
          <p>
            <b>{result.object}</b> defaults: inside the company <b>{result.internal}</b> · outside (portals, Experience
            Cloud) <b>{result.external}</b>
          </p>
          {result.rules.length === 0 ? (
            <p className="muted small">{result.note ?? 'No sharing rules.'}</p>
          ) : (
            <DataTable
              columns={['Rule', 'Kind', 'Which records', 'Shared with', 'Access']}
              rows={result.rules.map((r) => ({
                Rule: r.label,
                Kind: r.kind,
                'Which records': r.from ? `owned by ${targetText(r.from)}` : r.which,
                'Shared with': targetText(r.to),
                Access: r.access,
              }))}
              rowKey="Rule"
              name={`sharing-${result.object}`}
              note={<span>· open the Tree to see the people inside a group or role</span>}
            />
          )}
        </div>
      )}
      {result && view === 'tree' && (
        <div className="card section sharing-tree">
          <div className="auto-node-row">
            <span className="pill">Default</span>
            <b>{result.object}</b>
            <span>
              inside the company: <b>{result.internal}</b> · outside (portals, Experience Cloud):{' '}
              <b>{result.external}</b>
            </span>
          </div>
          <div className="auto-node-children">
            <div className="auto-node-row">
              <span className="pill">Roles</span>
              <span className="muted">users above a record's owner in the role hierarchy see it too</span>
            </div>
            {result.rules.length === 0 && <p className="muted small">{result.note ?? 'No sharing rules.'}</p>}
            {result.rules.map((r) => (
              <div key={r.name} className="auto-node sharing-rule">
                <div className="auto-node-row">
                  <span className="pill">{r.kind} rule</span>
                  <b>{r.label}</b>
                  <span className="muted small">{r.which}</span>
                  <span className="pill good">{r.access}</span>
                </div>
                <div className="auto-node-children">
                  {r.from && (
                    <>
                      <span className="muted small">records owned by</span>
                      {who(r.from, `${r.name}-from`)}
                    </>
                  )}
                  <span className="muted small">shared with</span>
                  {who(r.to, `${r.name}-to`)}
                </div>
              </div>
            ))}
          </div>
          <p className="muted small">
            ▸ opens a group or role to the people inside. Manual shares, teams and territories are per record: see{' '}
            <b>Who can see</b>.
          </p>
        </div>
      )}
    </div>
  );
}
