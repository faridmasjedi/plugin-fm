import { useEffect, useState } from 'react';
import { checkOrg, type OrgCheck, type OrgChoice } from '../host';

const kindOf = (check: OrgCheck | undefined, org: OrgChoice): string => {
  if (check?.ok) {
    if (!check.facts.isSandbox)
      return /developer/i.test(check.facts.organizationType) ? 'Developer Edition' : 'Production';
    return org.type === 'Scratch' ? 'Scratch org' : 'Sandbox';
  }
  return org.type ?? '';
};

/**
 * Which org the Studio works on. In the extension: every org this browser is logged in to (its
 * own Salesforce login, no CLI); in the app: the orgs of the Salesforce CLI.
 */
export function OrgSettings({
  hostKind,
  orgs,
  orgId,
  onSwitchOrg,
  onRefreshOrgs,
}: {
  hostKind: 'app' | 'extension';
  orgs: OrgChoice[];
  orgId: string;
  onSwitchOrg: (id: string) => void;
  onRefreshOrgs: () => void;
}) {
  const [checks, setChecks] = useState<Record<string, OrgCheck>>({});

  // The extension checks each browser login (name, type, still valid?)
  useEffect(() => {
    if (hostKind !== 'extension') return;
    let canceled = false;
    for (const org of orgs) {
      void checkOrg(org).then((check) => !canceled && setChecks((all) => ({ ...all, [org.id]: check })));
    }
    return () => {
      canceled = true;
    };
  }, [hostKind, orgs]);

  const login = (url: string) => window.open(url, '_blank', 'noopener');

  return (
    <div className="card section">
      <h3>Org</h3>
      <p className="muted" style={{ margin: 0 }}>
        {hostKind === 'extension'
          ? 'Orgs you are logged in to in this browser. NomadSF uses that login; no CLI, nothing stored. To add one, log in to it in a new tab, then come back here.'
          : 'Orgs of the Salesforce CLI on this computer. Add one on the Orgs page of the NomadSF app (sf org login web).'}
      </p>
      {orgs.length === 0 ? (
        <p className="muted">No org yet.</p>
      ) : (
        <table className="org-list">
          <tbody>
            {orgs.map((org) => {
              const check = checks[org.id];
              const current = org.id === orgId;
              return (
                <tr key={org.id} className={current ? 'current' : ''}>
                  <td>
                    <b>{check?.ok ? check.facts.name : org.label}</b>
                    <div className="muted mono">{org.instanceUrl?.replace('https://', '') ?? org.id}</div>
                  </td>
                  <td>
                    {kindOf(check, org) && (
                      <span className={`pill ${kindOf(check, org) === 'Production' ? 'bad' : 'good'}`}>
                        {kindOf(check, org)}
                      </span>
                    )}
                  </td>
                  <td className="muted">
                    {hostKind === 'extension'
                      ? check
                        ? check.ok
                          ? '✓ logged in'
                          : `⚠ ${check.error}`
                        : 'checking…'
                      : org.type ?? ''}
                  </td>
                  <td>
                    {current ? (
                      <span className="pill">in use</span>
                    ) : check && !check.ok ? (
                      <button onClick={() => login(org.instanceUrl ?? `https://${org.id}`)}>Log in again ↗</button>
                    ) : (
                      <button className="primary" onClick={() => onSwitchOrg(org.id)}>
                        Use
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="form">
        {hostKind === 'extension' ? (
          <>
            <button onClick={() => login('https://login.salesforce.com')}>
              Log in to a production / developer org ↗
            </button>
            <button onClick={() => login('https://test.salesforce.com')}>Log in to a sandbox ↗</button>
          </>
        ) : (
          <a href="/#page=orgs">Connect an org in the NomadSF app ↗</a>
        )}
        <button onClick={onRefreshOrgs}>Refresh</button>
      </div>
    </div>
  );
}
