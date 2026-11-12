import { useState } from 'react';
import {
  copySheets,
  copyUsers,
  findUsers,
  fromCopySheets,
  managersFirst,
  planUsers,
  readTableFile,
  usersBundle,
  writeWorkbook,
  type AccessFile,
  type AccessPlan,
  type ApplyOutcome,
  type Row,
  type UserCopy,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { DataTable, download } from './DataTable';
import { Status } from '../statusLog';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Access › Users: several users in one workbook, for a sandbox refresh. Before: each user with their fields, profile,
 * role, manager, permission sets and groups, licenses, public groups and queues, and the files of those permission
 * sets and groups. After, in the new sandbox: who is found, who is created (under a username you can change), the
 * permission sets made from the workbook — then one confirmation does it all. The old sandbox is not needed.
 */
export function UsersWorkbook() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [typed, setTyped] = useState('');
  const [found, setFound] = useState<Row[] | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState<{ name: string; users: UserCopy[]; metadata: AccessFile[] } | null>(null);
  const [plan, setPlan] = useState<AccessPlan | null>(null);
  const [usernames, setUsernames] = useState<Record<string, string>>({});
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const find = async () => {
    const words = typed
      .split(/[\n,;]+/)
      .map((w) => w.trim())
      .filter(Boolean);
    if (!words.length) return;
    setBusy(true);
    setStatus('Finding the users…');
    try {
      const emails = words.filter((w) => w.includes('@'));
      const names = words.filter((w) => !w.includes('@'));
      const rows = [
        ...(emails.length ? await findUsers(client, { usernames: emails }) : []),
        ...(names.length ? await findUsers(client, { names }) : []),
      ];
      const unique = [...new Map(rows.map((r) => [String(r.Id), r])).values()];
      setFound(unique);
      setTicked(new Set(unique.map((r) => String(r.Id))));
      setStatus(unique.length ? '' : `No active user like that in ${org.label}.`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const ids = [...ticked];
    if (!ids.length) return;
    setBusy(true);
    try {
      const bundle = await usersBundle(client, ids, org.label, (done, total) =>
        setStatus(
          done < total ? `Reading the users… ${done + 1}/${total}` : 'Reading their permission sets and groups…'
        )
      );
      download(
        `${org.label}-users-${new Date().toLocaleDateString('en-CA')}.xlsx`,
        writeWorkbook(copySheets({ records: {}, ...bundle })),
        XLSX
      );
      logActivity('save users workbook', { users: bundle.users.length, metadata: bundle.metadata.length });
      setStatus(
        `✓ ${bundle.users.length} user(s) and ${bundle.metadata.length} permission set(s) and group(s) saved. Open it in the new sandbox after the refresh.`
      );
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const open = async (file: File) => {
    setBusy(true);
    setOpened(null);
    setPlan(null);
    setOutcome(null);
    try {
      const read = fromCopySheets(await readTableFile(file.name, new Uint8Array(await file.arrayBuffer())));
      if (!read.users.length) throw new Error('No users in this file: save one with "Save workbook" first.');
      const users = managersFirst(read.users);
      setOpened({ name: file.name, users, metadata: read.metadata });
      setStatus(`Finding the ${users.length} user(s) in ${org.label}…`);
      const p = await planUsers(client, users, org.label);
      setPlan(p);
      setUsernames(Object.fromEntries(p.users.filter((u) => !u.found).map((u) => [u.username, u.suggested])));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!opened || !plan) return;
    const create = plan.users.filter((u) => !u.found).length;
    const complete = plan.users.length - create;
    if (
      !(await confirmChange(
        `In ${org.label}, from ${
          opened.name
        }: create ${create} user(s), give ${complete} user(s) found the access they lack${
          plan.create.length ? `, and create ${plan.create.length} permission set(s) and group(s) from the file` : ''
        }. No welcome e-mail is sent.`
      ))
    )
      return;
    setBusy(true);
    setStatus('Creating and assigning…');
    try {
      const r = await copyUsers(client, opened.users, plan, {
        usernames,
        metadata: opened.metadata,
        targetLabel: org.label,
      });
      setOutcome(r);
      logActivity('users from workbook', { file: opened.name, done: r.done.length, failed: r.failed.length });
      setStatus(`✓ ${r.done.length} done${r.failed.length ? `, ❌ ${r.failed.length} failed (see below)` : ''}.`);
      setPlan(await planUsers(client, opened.users, org.label));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card section">
      <h3>Several users, for a sandbox refresh</h3>
      <p className="muted small">
        Before the refresh, save the users in one workbook: their fields, profile, role, manager, permission sets and
        groups, licenses, public groups and queues, with the permission sets and groups themselves. After it, open the
        workbook in the new sandbox: missing users are created, the others get back what they lack.
      </p>
      <div className="form">
        <textarea
          rows={2}
          style={{ minWidth: 380 }}
          placeholder="Names or usernames, one per line or comma separated"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        <button disabled={busy || !typed.trim()} onClick={() => void find()}>
          Find
        </button>
        {found && found.length > 0 && (
          <button className="primary" disabled={busy || !ticked.size} onClick={() => void save()}>
            Save workbook ({ticked.size})
          </button>
        )}
        <label className="file-button">
          Open a users workbook…
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
      </div>
      {status && <Status text={status} block />}
      {found && found.length > 0 && !opened && (
        <DataTable
          columns={['Name', 'Username', 'Profile.Name']}
          rows={found.map((r) => ({ ...r, Id: String(r.Id) }))}
          rowKey="Id"
          name="users-to-save"
          selected={ticked}
          onSelectedChange={setTicked}
        />
      )}
      {opened && plan && (
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
            note={
              <span>· from {opened.name} · managers first, so they exist before the people who report to them</span>
            }
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
          <div className="form">
            <button className="primary" disabled={busy} onClick={() => void apply()}>
              Create and assign…
            </button>
          </div>
        </>
      )}
      {outcome && (outcome.done.length > 0 || outcome.failed.length > 0) && (
        <DataTable
          columns={['result', 'what', 'why']}
          rows={[
            ...outcome.failed.map((f, i) => ({ k: `f${i}`, result: '❌', what: f.item, why: f.error })),
            ...outcome.done.map((d, i) => ({ k: `d${i}`, result: '✓', what: d, why: '' })),
          ]}
          rowKey="k"
          name="users-from-workbook-result"
        />
      )}
    </div>
  );
}
