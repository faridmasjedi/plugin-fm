import { useEffect, useMemo, useState } from 'react';
import {
  copyUsers,
  managersFirst,
  planUsers,
  type AccessFile,
  type AccessPlan,
  type ApplyOutcome,
  type UserCopy,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { SchemaGaps } from './SchemaGaps';
import { DataTable } from './DataTable';
import { Status } from '../statusLog';

/**
 * Several users from a workbook into the org on screen, in one go: who is found (they get the access they lack), who
 * is created (under a username you can change), the permission sets and groups made from the workbook, and what the
 * org lacks for them (objects, fields, classes: deploy those first). Tick the users; one confirmation does it all.
 */
export function UsersFromWorkbook({
  users: given,
  metadata,
  source,
}: {
  users: UserCopy[];
  metadata: AccessFile[];
  /** Where they come from (the file's name). */
  source: string;
}) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const users = useMemo(() => managersFirst(given), [given]);
  const [plan, setPlan] = useState<AccessPlan | null>(null);
  const [usernames, setUsernames] = useState<Record<string, string>>({});
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(given.map((u) => u.username)));
  const [toCreate, setToCreate] = useState<AccessFile[]>([]);
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setStatus(`Finding the ${users.length} user(s) in ${org.label}…`);
    try {
      const p = await planUsers(client, users, org.label);
      setPlan(p);
      setUsernames((now) => ({
        ...Object.fromEntries(p.users.filter((u) => !u.found).map((u) => [u.username, u.suggested])),
        ...now,
      }));
      setStatus('');
      setToCreate(metadata.filter((m) => p.create.some((c) => c.type === m.type && c.name === m.name)));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, users]);

  const apply = async () => {
    if (!plan) return;
    const chosen = users.filter((u) => ticked.has(u.username));
    const chosenPlan = { ...plan, users: plan.users.filter((u) => ticked.has(u.username)) };
    const create = chosenPlan.users.filter((u) => !u.found).length;
    if (
      !chosen.length ||
      !(await confirmChange(
        `In ${org.label}, from ${source}: create ${create} user(s), give ${
          chosen.length - create
        } user(s) found the access they lack${
          plan.create.length ? `, creating the permission sets and groups they need from the file` : ''
        }. No welcome e-mail is sent.`
      ))
    )
      return;
    setBusy(true);
    setStatus('Creating and assigning…');
    try {
      const r = await copyUsers(client, chosen, chosenPlan, { usernames, metadata, targetLabel: org.label });
      setOutcome(r);
      logActivity('users from workbook', { file: source, done: r.done.length, failed: r.failed.length });
      setStatus(`✓ ${r.done.length} done${r.failed.length ? `, ❌ ${r.failed.length} failed (see below)` : ''}.`);
      await load();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card section">
      {status && <Status text={status} block />}
      {plan && (
        <>
          <DataTable
            columns={['user', `in ${org.label}`, 'create as', 'access']}
            rows={plan.users.map((u) => ({
              user: u.username,
              [`in ${org.label}`]: u.found ? 'found: gets what they lack' : 'not here: created',
              'create as': u.found ? '' : usernames[u.username] ?? u.suggested,
              access: u.access,
            }))}
            rowKey="user"
            name="users-from-workbook"
            selected={ticked}
            onSelectedChange={setTicked}
            renderCell={(column, row) => {
              const u = plan.users.find((x) => x.username === row.user);
              if (column !== 'create as' || !u || u.found) return undefined;
              return (
                <input
                  style={{ minWidth: 280 }}
                  value={usernames[u.username] ?? u.suggested}
                  title="Usernames are unique across every Salesforce org"
                  onChange={(e) => setUsernames({ ...usernames, [u.username]: e.target.value.trim() })}
                />
              );
            }}
            note={<span>· from {source} · managers first, so they exist before the people who report to them</span>}
          />
          {(plan.create.length > 0 || plan.noLicense.length > 0) && (
            <p className="muted small">
              {plan.create.length > 0 && (
                <>
                  Made from the workbook first:{' '}
                  <b>
                    {plan.create
                      .map((c) => `${c.type === 'PermissionSet' ? 'permission set' : 'group'} ${c.name}`)
                      .join(', ')}
                  </b>
                  .{' '}
                </>
              )}
              {plan.noLicense.length > 0 && (
                <span className="bad">
                  Not in {org.label} (cannot be made, those assignments fail): {plan.noLicense.join(', ')}.
                </span>
              )}
            </p>
          )}
          {/* What the org needs before the permission sets go in: deploy it from here */}
          <SchemaGaps
            target={{ id: org.id, label: org.label, client }}
            files={toCreate}
            onChanged={() => void load()}
          />
          <div className="form">
            <button className="primary" disabled={busy || !ticked.size} onClick={() => void apply()}>
              Create or complete {ticked.size} user(s)…
            </button>
          </div>
          {outcome && outcome.failed.length > 0 && (
            <ul className="bad small">
              {outcome.failed.map((f) => (
                <li key={f.item}>
                  {f.item}: {f.error}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
