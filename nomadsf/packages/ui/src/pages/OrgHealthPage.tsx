import { useEffect, useState } from 'react';
import { Select } from '../components/Select';
import { securityReport, type Row, type SecurityReport } from '@nomadsf/core';
import { TableTabs, type TableTab } from '../components/TableTabs';
import { DataTable } from '../components/DataTable';
import { useStudio } from '../context';
import { Status } from '../statusLog';

/** Org health: risky access in one report (license usage is in Org › Licenses). */
export function OrgHealthPage() {
  const { client, org } = useStudio();
  const [days, setDays] = useState(90);
  const [report, setReport] = useState<SecurityReport | null>(null);
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
  useEffect(() => {
    setReport(null);
  }, [client]);
  useEffect(() => {
    if (!report) void loadSecurity();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, report]);

  // The check shown below: a tile or a tab chooses it
  const [check, setCheck] = useState('powerful-permissions');
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
        <span className="muted">Risky access on {org.label} (read-only); license usage is in Org › Licenses</span>
        <span className="grow" />
        <button onClick={() => void loadSecurity()}>Refresh</button>
      </div>
      {status && <Status text={status} block />}

      {report && (
        <>
          <div className="form">
            <label>
              Not used for
              <Select
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
              </Select>
            </label>
            {report.notes.length > 0 && <span className="muted">Not available: {report.notes.join(' · ')}</span>}
          </div>
          <div className="metrics">
            {(
              [
                [
                  'health-check',
                  report.score ?? '—',
                  'Health Check score',
                  report.score !== undefined && report.score < 80,
                ],
                ['powerful-permissions', report.powerUsers.length, 'users with powerful permissions', false],
                ['dormant-users', report.dormant.length, 'active users not logged in', false],
                ['unassigned-permission-sets', report.unusedPermissionSets.length, 'unassigned permission sets', false],
                ['stale-oauth', report.staleTokens.length, 'unused OAuth tokens', false],
              ] as Array<[string, number | string, string, boolean]>
            ).map(([id, value, label, bad]) => (
              <button
                key={id}
                className={`metric filter ${check === id ? 'active' : ''} ${bad ? 'bad' : ''}`}
                title="Show them below"
                onClick={() => setCheck(id)}
              >
                <b>{value}</b>
                {label}
              </button>
            ))}
          </div>
          <TableTabs
            active={check}
            onChange={setCheck}
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
    </div>
  );
}
