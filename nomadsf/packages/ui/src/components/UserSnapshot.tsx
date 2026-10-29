import { useState } from 'react';
import {
  applySnapshot,
  createUserFromSnapshot,
  diffSnapshot,
  parseSnapshot,
  snapshotCsv,
  snapshotUser,
  suggestUsername,
  takeUserSnapshot,
  type SnapshotDifference,
  type SnapshotLine,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { DataTable, download } from './DataTable';

/**
 * Access › Users: a user "all together" in one CSV (fields, profile, role, manager, permission sets,
 * groups, licenses, public groups and queues), and, in any org, the differences with that file —
 * then make the user the same again. The CSV can be edited in Excel first.
 */
export function UserSnapshot({ userId, username }: { userId?: string; username?: string }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [kept, setKept] = useState<{ name: string; lines: SnapshotLine[] } | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [diff, setDiff] = useState<SnapshotDifference[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  // The snapshot's user is not in this org: create them under a username of their own
  const [missing, setMissing] = useState<{ username: string } | null>(null);

  const save = async () => {
    if (!userId) return;
    setStatus('Reading the user…');
    try {
      const lines = await takeUserSnapshot(client, userId, org.label);
      download(
        `${username ?? 'user'}-snapshot-${new Date().toLocaleDateString('en-CA')}.csv`,
        snapshotCsv(lines),
        'text/csv'
      );
      setStatus(`✓ Snapshot of ${username} saved (${lines.length} lines).`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const compareWith = async (lines: SnapshotLine[], name: string, found?: string) => {
    setKept({ name, lines });
    setDiff(null);
    setMissing(null);
    setStatus('Finding the user in this org…');
    try {
      const id = found ?? userId ?? (await snapshotUser(client, lines));
      if (!id) {
        setMissing({ username: suggestUsername(lines, org.label) });
        setStatus(`No user like ${lines.find((l) => l.Name === 'user')?.Value ?? '?'} in ${org.label}.`);
        return;
      }
      setTarget(id);
      setStatus('Comparing…');
      const d = diffSnapshot(lines, await takeUserSnapshot(client, id, org.label));
      setDiff(d);
      setPicked(new Set(d.filter((x) => !x.extra && !x.checkOnly && x.name !== 'Username').map((x) => x.key)));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const create = async () => {
    if (!kept || !missing) return;
    const of = (section: string) => kept.lines.filter((l) => l.Section === section).length;
    const profile = kept.lines.find((l) => l.Section === 'lookup' && l.Name === 'ProfileId')?.Value ?? '?';
    if (
      !(await confirmChange(
        `Create the user ${missing.username} in ${org.label} from ${kept.name}: profile ${profile}, ${of(
          'permissionSet'
        )} permission set(s), ${of('permissionSetGroup')} group(s), ${of('license')} license(s), ${of(
          'group'
        )} public group(s) and queue(s). No welcome e-mail is sent.`
      ))
    )
      return;
    setBusy(true);
    setStatus('Creating the user…');
    try {
      const { id, outcome } = await createUserFromSnapshot(client, kept.lines, missing.username, org.label);
      logActivity('create user from snapshot', {
        user: missing.username,
        file: kept.name,
        done: outcome.done.length,
        failed: outcome.failed.length,
      });
      await compareWith(kept.lines, kept.name, id);
      setStatus(
        `✓ Created ${missing.username} (${id}): ${outcome.done.length} done.${
          outcome.failed.length ? ` ❌ ${outcome.failed.map((f) => `${f.item}: ${f.error}`).join('; ')}` : ''
        }`
      );
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!diff || !target) return;
    // Apps are to check only: only the user can connect one
    const chosen = diff.filter((d) => picked.has(d.key) && !d.checkOnly);
    const removes = chosen.filter((d) => d.extra).length;
    if (
      !(await confirmChange(
        `Make the user in ${org.label} match ${kept?.name}: ${chosen.length - removes} change(s)${
          removes ? ` and ${removes} removal(s)` : ''
        }`
      ))
    )
      return;
    setBusy(true);
    setStatus('Applying…');
    try {
      const r = await applySnapshot(client, target, chosen);
      logActivity('apply user snapshot', {
        user: target,
        file: kept?.name,
        done: r.done.length,
        failed: r.failed.length,
      });
      setStatus(
        `✓ ${r.done.length} done.${
          r.failed.length ? ` ❌ ${r.failed.map((f) => `${f.item}: ${f.error}`).join('; ')}` : ''
        }`
      );
      if (kept) await compareWith(kept.lines, kept.name);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card section user-snapshot">
      <div className="form">
        <b>Snapshot</b>
        {userId && (
          <button
            title="Everything about this user in one CSV, to keep or to restore in another org"
            onClick={() => void save()}
          >
            Save snapshot (CSV)
          </button>
        )}
        <label className="file-button">
          {userId ? 'Compare this user with a snapshot…' : 'Compare a snapshot with this org…'}
          <input
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              void f.text().then((text) => {
                try {
                  void compareWith(parseSnapshot(text), f.name);
                } catch (err) {
                  setStatus(`❌ ${(err as Error).message}`);
                }
              });
            }}
          />
        </label>
        <span className="muted">{status}</span>
      </div>
      {missing && kept && (
        <div className="form">
          <span>Create them here as</span>
          <input
            style={{ minWidth: 340 }}
            value={missing.username}
            title="Usernames are unique across every Salesforce org: the snapshot's own is taken"
            onChange={(e) => setMissing({ username: e.target.value.trim() })}
          />
          <button className="primary" disabled={busy || !missing.username} onClick={() => void create()}>
            Create the user…
          </button>
          <span className="muted">
            with the snapshot's fields, profile, role, manager, permission sets, licenses, groups and queues
          </span>
        </div>
      )}
      {diff &&
        (diff.length === 0 ? (
          <p className="good">✓ The user matches {kept?.name}: the same fields, profile, role, access and groups.</p>
        ) : (
          <>
            <DataTable
              columns={['section', 'name', 'snapshot', 'org', 'action']}
              rows={diff.map((d) => ({ ...d }))}
              rowKey="key"
              name="snapshot-differences"
              selected={picked}
              onSelectedChange={(next) =>
                setPicked(new Set([...next].filter((k) => !diff.find((d) => d.key === k)?.checkOnly)))
              }
              note={
                <span>
                  · snapshot = {kept?.name}, org = {org.label} now · lookups by name · removals (only in the org) are
                  not ticked · apps (connected apps the user signs in to) are to check only: the user connects them
                </span>
              }
            />
            <div className="form">
              <button className="primary" disabled={busy || !picked.size} onClick={() => void apply()}>
                Make the user match the snapshot ({picked.size})…
              </button>
            </div>
          </>
        ))}
    </div>
  );
}
