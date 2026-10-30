import { useEffect, useState } from 'react';
import { checkOrg, type HostKind, type OrgCheck, type OrgChoice } from '../host';
import { call } from '../embed';
import { Status } from '../statusLog';

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
 * own Salesforce login, no CLI); in the app: the orgs of the Salesforce CLI; in VS Code: the
 * CLI's logins, read by the extension (logging in there needs no CLI either).
 */
export function OrgSettings({
  hostKind,
  orgs,
  orgId,
  onSwitchOrg,
  onRefreshOrgs,
}: {
  hostKind: HostKind;
  orgs: OrgChoice[];
  orgId: string;
  onSwitchOrg: (id: string) => void;
  onRefreshOrgs: () => void;
}) {
  const [checks, setChecks] = useState<Record<string, OrgCheck>>({});

  // The extension and VS Code check each login (name, type, still valid?)
  useEffect(() => {
    if (hostKind === 'app') return;
    let canceled = false;
    for (const org of orgs) {
      void checkOrg(org).then((check) => !canceled && setChecks((all) => ({ ...all, [org.id]: check })));
    }
    return () => {
      canceled = true;
    };
  }, [hostKind, orgs]);

  const [loginError, setLoginError] = useState('');
  const login = (url: string, alias?: string) => {
    if (hostKind !== 'vscode') {
      window.open(url, '_blank', 'noopener');
      return;
    }
    // VS Code: the browser login of the Salesforce CLI, run by the extension (asks an alias for a new org)
    setLoginError('');
    call<string | null>('login', url, alias).then(
      (username) => username && onRefreshOrgs(),
      (e: Error) => setLoginError(e.message)
    );
  };

  return (
    <div className="card section">
      <h3>Org</h3>
      <p className="muted" style={{ margin: 0 }}>
        {hostKind === 'extension'
          ? 'Orgs you are logged in to in this browser. NomadSF uses that login; no CLI, nothing stored. To add one, log in to it in a new tab, then come back here.'
          : hostKind === 'vscode'
          ? 'Orgs logged in to with the Salesforce CLI on this computer (the CLI itself is not needed). Log in to one below in your browser; the CLI and other tools see it too.'
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
                    {hostKind !== 'app'
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
                      <button onClick={() => login(org.instanceUrl ?? `https://${org.id}`, org.label)}>
                        Log in again ↗
                      </button>
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
        {hostKind !== 'app' ? (
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
      <Status text={loginError} kind="problem" block />
    </div>
  );
}
