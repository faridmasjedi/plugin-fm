import { useEffect, useState } from 'react';
import {
  deleteByIds,
  idleLicenses,
  licenseReport,
  licenseUsers,
  setActive,
  setFrozen,
  userLogin,
  type LicenseRow,
  type Row,
} from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { Status } from '../statusLog';

type Tab = 'usage' | 'idle' | 'frozen' | 'inactive';
type Idle = Awaited<ReturnType<typeof idleLicenses>>;

/**
 * Org › Licenses: how many of each license are used, and who holds one without using it — no login for a while,
 * frozen but still active, or deactivated with a permission set license still assigned. Freeing one asks first.
 */
export function LicensesPage() {
  const studio = useStudio();
  const { client, org } = studio;
  const [tab, setTab] = useState<Tab>(() => storage.get('licenses.tab', 'usage'));
  const [licenses, setLicenses] = useState<LicenseRow[] | null>(null);
  const [license, setLicense] = useState<LicenseRow | null>(null);
  const [licensed, setLicensed] = useState<Row[] | null>(null);
  const [days, setDays] = useState(90);
  const [idle, setIdle] = useState<Idle | null>(null);
  const [picked, setPicked] = useState<Row | null>(null);
  const [status, setStatus] = useState('');

  const loadUsage = () => {
    setLicenses(null);
    licenseReport(client)
      .then(setLicenses)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  };
  const loadIdle = (d = days) => {
    setIdle(null);
    setPicked(null);
    idleLicenses(client, d)
      .then(setIdle)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  };
  useEffect(() => {
    setLicense(null);
    setStatus('');
    loadUsage();
    loadIdle();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  useEffect(() => {
    setLicensed(null);
    if (!license) return;
    licenseUsers(client, license)
      .then(setLicensed)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, license]);

  const choose = (t: Tab) => {
    setTab(t);
    setPicked(null);
    storage.set('licenses.tab', t);
  };

  // Every change asks for the org name first, then reads the lists again
  const change = async (text: string, action: () => Promise<unknown>) => {
    if (!(await studio.confirmChange(`${text} in ${org.label}`))) return;
    setStatus(`${text}…`);
    try {
      await action();
      studio.logActivity('licenses', { what: text });
      setStatus(`✓ ${text}.`);
      loadIdle();
      loadUsage();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  const freeze = (u: Row) =>
    void change(`Freeze ${String(u.Name)}`, async () => {
      const login = await userLogin(client, String(u.Id));
      if (!login) throw new Error('This user has no login record to freeze.');
      await setFrozen(client, login.id, true);
    });
  const unfreeze = (u: Row) =>
    void change(`Unfreeze ${String(u.Name)}`, () => setFrozen(client, String(u.UserLoginId), false));
  const deactivate = (u: Row) =>
    void change(`Deactivate ${String(u.Name)} (frees their user license)`, () =>
      setActive(client, String(u.Id), false)
    );
  const removeLicense = (r: Row) =>
    void change(
      `Remove ${String(r['PermissionSetLicense.MasterLabel'])} from ${String(r['Assignee.Name'])}`,
      async () => {
        const out = await deleteByIds(client, [String(r.Id)]);
        if (out.errors.length) throw new Error(out.errors.join('; '));
      }
    );

  const tabs: Array<[Tab, string, number | undefined]> = [
    ['usage', 'Usage', licenses?.length],
    ['idle', `No login for ${days} days`, idle?.notLoggingIn.length],
    ['frozen', 'Frozen but active', idle?.frozen.length],
    ['inactive', 'Held by inactive users', idle?.heldByInactive.length],
  ];

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Licenses</h2>
        <span className="muted">How many are used on {org.label}, and who holds one without using it</span>
        <span className="grow" />
        <button
          onClick={() => {
            loadUsage();
            loadIdle();
          }}
        >
          Refresh
        </button>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(([id, label, count]) => (
          <button key={id} role="tab" className={`tab ${tab === id ? 'active' : ''}`} onClick={() => choose(id)}>
            {label}
            {count !== undefined && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </div>
      {status && <Status text={status} block />}

      {tab === 'usage' &&
        (!licenses ? (
          <p className="muted">Reading licenses…</p>
        ) : licenses.length === 0 ? (
          <EmptyHint what="licenses" />
        ) : (
          <>
            <DataTable
              columns={['kind', 'name', 'status', 'used', 'total', 'percent', 'expires']}
              rows={licenses.map((l) => ({ ...l, key: `${l.kind}:${l.id}` }))}
              rowKey="key"
              name={`${org.label}-licenses`}
              selectedKey={license ? `${license.kind}:${license.id}` : undefined}
              onRowClick={(row) => setLicense(licenses.find((l) => `${l.kind}:${l.id}` === row.key) ?? null)}
              note={<span>· click a license to see who uses it</span>}
            />
            {license && (
              <div className="section">
                <h3>
                  {license.name} · {license.used} of {license.total} used
                </h3>
                {licensed === null ? (
                  <p className="muted">Reading users…</p>
                ) : licensed.length === 0 ? (
                  <EmptyHint what="users" />
                ) : (
                  <DataTable
                    columns={['Name', 'Username', 'Profile.Name', 'UserRole.Name', 'LastLoginDate']}
                    rows={licensed}
                    rowKey="Id"
                    name={`${org.label}-${license.name}-users`}
                    note={
                      <span>
                        ·{' '}
                        {license.kind === 'User license'
                          ? 'active users whose profile uses this license'
                          : 'users assigned this license'}
                      </span>
                    }
                  />
                )}
              </div>
            )}
          </>
        ))}

      {tab === 'idle' && (
        <>
          <div className="form">
            <label>
              No login for
              <input
                type="number"
                min={1}
                max={3650}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                onKeyDown={(e) => e.key === 'Enter' && loadIdle()}
                style={{ width: 90 }}
              />
            </label>
            <span className="muted">days (or never)</span>
            <button onClick={() => loadIdle()}>Show</button>
          </div>
          <UsersTable
            rows={idle?.notLoggingIn}
            columns={['Name', 'Username', 'Profile.Name', 'Profile.UserLicense.Name', 'LastLoginDate', 'CreatedDate']}
            name={`${org.label}-no-login`}
            note="active users who hold a user license"
            picked={picked}
            onPick={setPicked}
            actions={(u) => (
              <>
                <button onClick={() => freeze(u)}>Freeze…</button>
                <button className="danger" onClick={() => deactivate(u)}>
                  Deactivate…
                </button>
              </>
            )}
          />
        </>
      )}

      {tab === 'frozen' && (
        <UsersTable
          rows={idle?.frozen}
          columns={['Name', 'Username', 'Profile.Name', 'Profile.UserLicense.Name', 'LastLoginDate']}
          name={`${org.label}-frozen`}
          note="frozen users are still active: each one still uses a user license"
          picked={picked}
          onPick={setPicked}
          actions={(u) => (
            <>
              <button onClick={() => unfreeze(u)}>Unfreeze…</button>
              <button className="danger" onClick={() => deactivate(u)}>
                Deactivate…
              </button>
            </>
          )}
        />
      )}

      {tab === 'inactive' && (
        <UsersTable
          rows={idle?.heldByInactive}
          columns={['Assignee.Name', 'Assignee.Username', 'PermissionSetLicense.MasterLabel']}
          name={`${org.label}-held-by-inactive`}
          note="permission set licenses still assigned to deactivated users"
          picked={picked}
          onPick={setPicked}
          actions={(r) => (
            <button className="danger" onClick={() => removeLicense(r)}>
              Remove the license…
            </button>
          )}
        />
      )}
    </div>
  );
}

/** A list of users; click one for what can be done with them. */
function UsersTable({
  rows,
  columns,
  name,
  note,
  picked,
  onPick,
  actions,
}: {
  rows: Row[] | undefined;
  columns: string[];
  name: string;
  note: string;
  picked: Row | null;
  onPick: (r: Row | null) => void;
  actions: (r: Row) => React.ReactNode;
}) {
  if (!rows) return <p className="muted">Reading…</p>;
  if (!rows.length) return <EmptyHint what="users here" />;
  const label = (r: Row) => String(r.Name ?? r['Assignee.Name'] ?? '');
  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey="Id"
        name={name}
        selectedKey={picked ? String(picked.Id) : undefined}
        onRowClick={(r) => onPick(rows.find((x) => x.Id === r.Id) ?? null)}
        note={<span>· {note} · click one to act</span>}
      />
      {picked && (
        <div className="form user-actions">
          <b>{label(picked)}</b>
          <span className="muted">{String(picked.Username ?? picked['Assignee.Username'] ?? '')}</span>
          <span className="grow" />
          {actions(picked)}
        </div>
      )}
    </>
  );
}
