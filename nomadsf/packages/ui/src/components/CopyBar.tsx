import { useEffect, useState } from 'react';
import {
  accessFiles,
  accessNames,
  copyObjects,
  copySheets,
  copyUsers,
  describeData,
  explainError,
  filesAsSource,
  planUsers,
  prepareCopy,
  readPicked,
  runCopy,
  undoLoad,
  writeWorkbook,
  type AccessFile,
  type AccessPlan,
  type CopyPick,
  type FileTable,
  type LoadResult,
  type SalesforceClient,
  type UserCopy,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { askTyped } from './Dialogs';
import { download } from './DataTable';
import { Status } from '../statusLog';

/** What is ticked: records of this org (by condition), or rows of a saved copy; and a user, if any. */
export type CopyWhat = {
  records: { kind: 'org'; picks: CopyPick[] } | { kind: 'file'; tables: FileTable[] };
  user?: UserCopy;
  /** From a saved copy: the permission sets and groups to make where they are missing. */
  metadata?: AccessFile[];
  /** The file name to save under (an org's tree only). */
  saveAs?: string;
};

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * Under the tree: choose the org, Copy (it asks with the org name typed, then can be undone), or
 * Save as Excel to copy it later from Record › Open a saved copy.
 */
export function CopyBar({ what }: { what: CopyWhat }) {
  const { client, org, orgs, clientFor, facts, logActivity } = useStudio();
  // Every change is in the other org: its name is typed to confirm
  const confirmIn = (label: string, message: string, ok: string) => askTyped(message, label, { ok, danger: true });
  const [targetId, setTargetId] = useState('');
  const [mask, setMask] = useState(() => (facts ? !facts.isSandbox : true));
  const [userPlan, setUserPlan] = useState<AccessPlan | null>(null);
  const [username, setUsername] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{ target: string; created: LoadResult['created'] } | null>(null);
  const target = orgs.find((o) => o.id === targetId);
  const records =
    what.records.kind === 'org'
      ? what.records.picks.length
      : what.records.tables.reduce((n, t) => n + t.rows.length, 0);
  const nothing = !records && !what.user;

  // A user: are they in the target already, and what is missing there (again when the ticks change)
  const userKey = what.user
    ? `${what.user.username}|${what.user.lines
        .filter((l) => !['info', 'field', 'lookup'].includes(l.Section))
        .map((l) => `${l.Section}:${l.Name}`)
        .join(',')}`
    : '';
  useEffect(() => {
    setUserPlan(null);
    if (!what.user || !target) return;
    let canceled = false;
    void clientFor(target.id)
      .then((c) => planUsers(c, [what.user!], target.label))
      .then((p) => {
        if (canceled) return;
        setUserPlan(p);
        setUsername((now) => now || (p.users[0]?.suggested ?? ''));
      })
      .catch((e: Error) => !canceled && setStatus(`❌ ${e.message}`));
    return () => {
      canceled = true;
    };
    // what.user is new on every tick; its username and access are what matter
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userKey, target, clientFor]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const copy = () =>
    run(async () => {
      if (!target) return;
      const targetClient = await clientFor(target.id);
      const done: string[] = [];
      if (what.user && userPlan) {
        const found = userPlan.users[0]?.found;
        if (
          !(await confirmIn(
            target.label,
            `${found ? `Give ${what.user.username}` : `Create ${username} and give them`} the ticked access in ${
              target.label
            }${userPlan.create.length ? `, creating ${userPlan.create.map((c) => c.name).join(', ')}` : ''}.`,
            'Copy'
          ))
        )
          return;
        let files = what.metadata ?? [];
        if (userPlan.create.length && !files.length && what.records.kind === 'org') {
          setStatus('Reading the permission sets and groups to create…');
          files = await accessFiles(client, {
            permissionSets: userPlan.create.filter((c) => c.type === 'PermissionSet').map((c) => c.name),
            groups: userPlan.create.filter((c) => c.type === 'PermissionSetGroup').map((c) => c.name),
          });
        }
        setStatus('Copying the user…');
        const out = await copyUsers(targetClient, [what.user], userPlan, {
          usernames: { [what.user.username]: username },
          metadata: files,
          targetLabel: target.label,
        });
        logActivity('copy user', { target: target.label, done: out.done.length, failed: out.failed.length });
        done.push(...out.done, ...out.failed.map((f) => `❌ ${f.item}: ${f.error}`));
        setUserPlan(await planUsers(targetClient, [what.user], target.label));
      }
      if (records) {
        setStatus('Reading the records…');
        const source: SalesforceClient | null = what.records.kind === 'org' ? client : null;
        let prepared;
        if (what.records.kind === 'org')
          prepared = await prepareCopy(
            { kind: 'org', client: source! },
            targetClient,
            copyObjects(what.records.picks),
            {
              mask,
              onProgress: (object, n) => setStatus(`Reading ${object}: ${n}`),
            }
          );
        else {
          const tables = what.records.tables.filter((t) => t.rows.length);
          const schemas = Object.fromEntries(
            await Promise.all(tables.map(async (t) => [t.name, await describeData(targetClient, t.name)] as const))
          );
          const file = filesAsSource(
            tables.map((t) => ({ ...t, object: t.name })),
            schemas
          );
          prepared = await prepareCopy(
            { kind: 'file', schema: file.schema, rows: file.rows },
            targetClient,
            tables.map((t) => ({ name: t.name })),
            { mask }
          );
        }
        const summary = prepared.counts.map((c) => `${c.records} ${c.object}`).join(', ');
        if (
          !(await confirmIn(target.label, `Copy ${summary} into ${target.label}${mask ? ' (masked)' : ''}.`, 'Copy'))
        ) {
          setStatus(done.join(' · '));
          return;
        }
        setStatus('Copying…');
        const result = await runCopy(targetClient, prepared, (p) => setStatus(`${p.object}: ${p.done} of ${p.rows}`));
        logActivity('copy records', { target: target.label, records: summary, failed: result.failures.length });
        const created = result.objects.reduce((n, o) => n + o.created, 0);
        done.push(
          `✓ ${created} created`,
          ...result.failures.slice(0, 5).map((f) => {
            const meaning = explainError(f.error).meaning;
            return `❌ ${f.object} ${f.sourceId}: ${f.error}${meaning ? ` — ${meaning}` : ''}`;
          }),
          ...(result.failures.length > 5 ? [`… ${result.failures.length - 5} more failed`] : [])
        );
        setLast(created ? { target: target.id, created: result.created } : null);
      }
      setStatus(done.join(' · '));
    });

  const undo = () =>
    run(async () => {
      if (!last) return;
      const label = orgs.find((o) => o.id === last.target)?.label ?? last.target;
      const n = last.created.reduce((s, c) => s + c.ids.length, 0);
      if (!(await confirmIn(label, `Delete the ${n} record(s) this copy created in ${label}.`, 'Delete'))) return;
      const r = await undoLoad(await clientFor(last.target), last.created);
      logActivity('undo copy', { target: label, deleted: r.deleted });
      setLast(null);
      setStatus(`✓ ${r.deleted} deleted${r.failed.length ? `, ❌ ${r.failed.length} failed` : ''}.`);
    });

  const save = () =>
    run(async () => {
      if (what.records.kind !== 'org') return;
      setStatus('Reading the records…');
      const rows = await readPicked(client, what.records.picks);
      const users = what.user ? [what.user] : [];
      if (users.length) setStatus('Reading the permission sets and groups…');
      const metadata = users.length ? await accessFiles(client, accessNames(users)) : [];
      download(
        `${what.saveAs ?? 'copy'}.xlsx`.replace(/[\\/:*?"<>|]/g, '_'),
        writeWorkbook(copySheets({ records: rows, users, metadata })),
        XLSX
      );
      setStatus('✓ Saved. Record › Open a saved copy… copies it into any org.');
    });

  const found = userPlan?.users[0]?.found;
  return (
    <div className="copy-bar">
      <div className="form">
        <b>Copy into</b>
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
          <option value="">Choose an org…</option>
          {orgs
            .filter((o) => o.id !== org.id || what.records.kind === 'file')
            .map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
        </select>
        {records > 0 && (
          <label className="check" title="E-mails, phones, people's names and streets become fake values">
            <input type="checkbox" checked={mask} onChange={(e) => setMask(e.target.checked)} /> Mask personal data
          </label>
        )}
        <button
          className="primary"
          disabled={busy || nothing || !target || (Boolean(what.user) && !userPlan)}
          onClick={() => void copy()}
        >
          Copy
        </button>
        {what.records.kind === 'org' && (
          <button disabled={busy || nothing} onClick={() => void save()}>
            Save as Excel
          </button>
        )}
        {last && (
          <button className="danger" disabled={busy} onClick={() => void undo()}>
            Undo this copy
          </button>
        )}
      </div>
      {what.user && target && userPlan && (
        <p className="muted">
          {found ? (
            <>
              ✓ {what.user.username} is in {target.label}: only the ticked access is added.
            </>
          ) : (
            <span className="lookup-edit">
              Not in {target.label}: created as{' '}
              <input style={{ minWidth: 300 }} value={username} onChange={(e) => setUsername(e.target.value.trim())} />
            </span>
          )}
          {userPlan.create.length > 0 && ` Created there first: ${userPlan.create.map((c) => c.name).join(', ')}.`}
          {userPlan.noLicense.length > 0 && ` ${target.label} has no ${userPlan.noLicense.join(', ')} license.`}
        </p>
      )}
      {status && <Status text={status} block />}
    </div>
  );
}
