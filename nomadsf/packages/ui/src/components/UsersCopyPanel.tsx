import { useEffect, useState } from 'react';
import {
  accessFiles,
  copyUsers,
  planUsers,
  type AccessFile,
  type AccessPlan,
  type SalesforceClient,
  type UserCopy,
} from '@nomadsf/core';
import { useStudio } from '../context';

/**
 * Migrate › Users from a basket: each user found in B gets the permission sets, groups and licenses
 * picked for them; a user B lacks is created under a username of its own. Permission sets and
 * groups B lacks are made first, from A (or from the saved workbook).
 */
export function UsersCopyPanel({
  users,
  metadata,
  sourceClient,
  target,
}: {
  users: UserCopy[];
  /** From a saved workbook; otherwise read from A when needed. */
  metadata: AccessFile[];
  sourceClient?: () => Promise<SalesforceClient>;
  target?: { id: string; label: string };
}) {
  const { clientFor, confirmChange, logActivity } = useStudio();
  const [plan, setPlan] = useState<AccessPlan | null>(null);
  const [usernames, setUsernames] = useState<Record<string, string>>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPlan(null);
    setStatus('');
    if (!target) return;
    let canceled = false;
    void clientFor(target.id)
      .then((c) => planUsers(c, users, target.label))
      .then((p) => {
        if (canceled) return;
        setPlan(p);
        setUsernames(Object.fromEntries(p.users.filter((u) => !u.found).map((u) => [u.username, u.suggested])));
      })
      .catch((e: Error) => !canceled && setStatus(`❌ ${e.message}`));
    return () => {
      canceled = true;
    };
  }, [clientFor, users, target]);

  const copy = async () => {
    if (!plan || !target) return;
    const creating = plan.users.filter((u) => !u.found).length;
    if (
      !(await confirmChange(
        `In ${target.label}: ${creating ? `create ${creating} user(s), ` : ''}give ${
          users.length
        } user(s) the access picked${
          plan.create.length ? `, and create ${plan.create.map((c) => c.name).join(', ')}` : ''
        }.`
      ))
    )
      return;
    setBusy(true);
    try {
      let files = metadata;
      if (plan.create.length && !files.length && sourceClient) {
        setStatus('Reading the permission sets and groups from A…');
        files = await accessFiles(await sourceClient(), {
          permissionSets: plan.create.filter((c) => c.type === 'PermissionSet').map((c) => c.name),
          groups: plan.create.filter((c) => c.type === 'PermissionSetGroup').map((c) => c.name),
        });
      }
      setStatus('Copying the users…');
      const targetClient = await clientFor(target.id);
      const out = await copyUsers(targetClient, users, plan, { usernames, metadata: files, targetLabel: target.label });
      logActivity('copy users', { target: target.label, done: out.done.length, failed: out.failed.length });
      setStatus(
        `✓ ${out.done.join(' · ')}${
          out.failed.length ? ` ❌ ${out.failed.map((f) => `${f.item}: ${f.error}`).join('; ')}` : ''
        }`
      );
      setPlan(await planUsers(targetClient, users, target.label));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const picked = (u: UserCopy) =>
    u.lines
      .filter((l) => !['info', 'field', 'lookup'].includes(l.Section))
      .map((l) => l.Name)
      .join(', ') || 'no access picked';

  return (
    <div className="card section">
      <h3>Users and their access</h3>
      {!target ? (
        <p className="muted">Choose B to see who is there already.</p>
      ) : !plan ? (
        <p className="muted">{status || `Looking for the users in ${target.label}…`}</p>
      ) : (
        <>
          <table className="edit-table">
            <thead>
              <tr>
                <th>User</th>
                <th>In {target.label}</th>
                <th>Access picked</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const p = plan.users.find((x) => x.username === u.username);
                return (
                  <tr key={u.username}>
                    <td>{u.username}</td>
                    <td>
                      {p?.found ? (
                        <span className="good">✓ there: only the access is added</span>
                      ) : (
                        <span className="lookup-edit">
                          create as{' '}
                          <input
                            style={{ minWidth: 300 }}
                            title="Usernames are unique across every Salesforce org"
                            value={usernames[u.username] ?? ''}
                            onChange={(e) => setUsernames({ ...usernames, [u.username]: e.target.value.trim() })}
                          />
                        </span>
                      )}
                    </td>
                    <td className="muted">{picked(u)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {plan.create.length > 0 && (
            <p className="muted">
              Not in {target.label}, created first from {metadata.length ? 'the workbook' : 'A'}:{' '}
              {plan.create
                .map((c) => `${c.type === 'PermissionSet' ? 'permission set' : 'group'} ${c.name}`)
                .join(', ')}
            </p>
          )}
          {plan.noLicense.length > 0 && (
            <p className="bad">
              Licenses {target.label} does not have (those assignments will fail): {plan.noLicense.join(', ')}
            </p>
          )}
          <div className="form">
            <button className="primary" disabled={busy} onClick={() => void copy()}>
              Copy the users…
            </button>
            <span className="muted">{status || 'Copy the users before the records, so their records find them.'}</span>
          </div>
        </>
      )}
    </div>
  );
}
