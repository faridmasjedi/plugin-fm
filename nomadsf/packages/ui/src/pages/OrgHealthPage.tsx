import { useEffect, useState } from 'react';
import {
  licenseReport,
  licenseUsers,
  securityReport,
  type LicenseRow,
  type Row,
  type SecurityReport,
} from '@nomadsf/core';
import { TableTabs, type TableTab } from '../components/TableTabs';
import { DataTable, EmptyHint } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { Status } from '../statusLog';

type Tab = 'security' | 'licenses';

/** Org health: risky access in one report, and license usage with the users behind each license. */
export function OrgHealthPage() {
  const { client, org } = useStudio();
  const [tab, setTab] = useState<Tab>(() => storage.get('health.tab', 'security'));
  const [days, setDays] = useState(90);
  const [report, setReport] = useState<SecurityReport | null>(null);
  const [licenses, setLicenses] = useState<LicenseRow[] | null>(null);
  const [license, setLicense] = useState<LicenseRow | null>(null);
  const [licensed, setLicensed] = useState<Row[] | null>(null);
  const [status, setStatus] = useState('');

  const loadSecurity = async (d = days) => {
    setStatus('Checking access…');
    try {
      setReport(await securityReport(client, d));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  const loadLicenses = async () => {
    setStatus('Reading licenses…');
    try {
      setLicenses(await licenseReport(client));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    setReport(null);
    setLicenses(null);
    setLicense(null);
  }, [client]);
  useEffect(() => {
    if (tab === 'security' && !report) void loadSecurity();
    if (tab === 'licenses' && !licenses) void loadLicenses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, client, report, licenses]);
  useEffect(() => {
    setLicensed(null);
    if (!license) return;
    licenseUsers(client, license)
      .then(setLicensed)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, license]);

  const choose = (next: Tab) => {
    setTab(next);
    storage.set('health.tab', next);
  };
  /** One check of the security report: a tab with its count, its hint and its table. */
  const section = (title: string, hint: string, rows: Row[], columns: string[], name: string): TableTab => ({
    id: name,
    label: title,
    count: rows.length,
    content: (
      <div className="section">
        <p className="muted" style={{ margin: 0 }}>
          {hint}
        </p>
        {rows.length ? (
          <DataTable columns={columns} rows={rows} rowKey="__none" name={`${org.label}-${name}`} />
        ) : (
          <p className="good">✓ None.</p>
        )}
      </div>
    ),
  });

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Org health</h2>
        <span className="muted">Risky access and license usage on {org.label} (read-only)</span>
        <span className="grow" />
        <button onClick={() => void (tab === 'security' ? loadSecurity() : loadLicenses())}>Refresh</button>
      </div>
      <div className="tabs">
        {(
          [
            ['security', 'Security'],
            ['licenses', 'Licenses'],
          ] as Array<[Tab, string]>
        ).map(([id, text]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => choose(id)}>
            {text}
          </button>
        ))}
      </div>
      {status && <Status text={status} block />}

      {tab === 'security' && report && (
        <>
          <div className="form">
            <label>
              Not used for
              <select
                value={days}
                onChange={(e) => {
                  setDays(Number(e.target.value));
                  void loadSecurity(Number(e.target.value));
                }}
              >
                {[30, 60, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
            {report.notes.length > 0 && <span className="muted">Not available: {report.notes.join(' · ')}</span>}
          </div>
          <div className="metrics">
            <div className={`metric ${report.score !== undefined && report.score < 80 ? 'bad' : ''}`}>
              <b>{report.score ?? '—'}</b>Health Check score
            </div>
            <div className="metric">
              <b>{report.powerUsers.length}</b>users with powerful permissions
            </div>
            <div className="metric">
              <b>{report.dormant.length}</b>active users not logged in
            </div>
            <div className="metric">
              <b>{report.unusedPermissionSets.length}</b>unassigned permission sets
            </div>
            <div className="metric">
              <b>{report.staleTokens.length}</b>unused OAuth tokens
            </div>
          </div>
          <TableTabs
            tabs={[
              section(
                'Powerful permissions',
                'Active users with Modify All Data, View All Data, Manage Users, Author Apex, Customize Application or API Enabled — and what gives it to them.',
                report.powerUsers,
                ['Name', 'Username', 'Permissions', 'GrantedBy'],
                'powerful-permissions'
              ),
              section(
                `Not logged in for ${days} days`,
                'Active users who have not logged in (or never have): candidates to freeze or deactivate.',
                report.dormant,
                ['Name', 'Username', 'Profile.Name', 'LastLoginDate', 'CreatedDate'],
                'dormant-users'
              ),
              section(
                'Unassigned permission sets',
                'Permission sets (not from a package) that nobody has: candidates to remove.',
                report.unusedPermissionSets,
                ['Label', 'Name', 'CreatedDate', 'LastModifiedDate'],
                'unassigned-permission-sets'
              ),
              section(
                `OAuth tokens not used for ${days} days`,
                'Connected app sessions nobody uses: revoke them in Setup › Connected Apps OAuth Usage.',
                report.staleTokens,
                ['AppName', 'User.Name', 'User.Username', 'UseCount', 'LastUsedDate'],
                'stale-oauth'
              ),
              section(
                'Licenses held by inactive users',
                'Permission set licenses still assigned to deactivated users.',
                report.inactiveWithLicenses,
                ['Assignee.Name', 'Assignee.Username', 'PermissionSetLicense.MasterLabel'],
                'inactive-licenses'
              ),
              section(
                'Health Check risks',
                "Salesforce's own Security Health Check: settings below the standard.",
                report.risks,
                ['RiskType', 'Setting', 'SettingGroup', 'OrgValue', 'StandardValue'],
                'health-check'
              ),
            ]}
          />
        </>
      )}

      {tab === 'licenses' &&
        licenses &&
        (licenses.length === 0 ? (
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
    </div>
  );
}
