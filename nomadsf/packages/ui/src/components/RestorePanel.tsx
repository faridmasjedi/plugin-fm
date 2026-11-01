import { useEffect, useState } from 'react';
import {
  OLD_ID_FIELD,
  backupFileSource,
  backupFilesAt,
  backupStateAt,
  describeData,
  ensureOldIdFields,
  jobFolder,
  oldIdFieldStatus,
  previewRestore,
  removeOldIdFields,
  restoreRecords,
  restoreValues,
  toCsv,
  type BackupManifest,
  type BackupState,
  type DataField,
  type RestorePreview,
} from '@nomadsf/core';
import { DataTable, download as downloadFile } from './DataTable';
import { storage, useStudio } from '../context';
import { isLocked, jobSink, type JobRecord } from '../backups';
import { UnlockBackup } from './UnlockBackup';
import { Status } from '../statusLog';

const download = (name: string, text: string) => downloadFile(name, text, 'text/csv');

/** Backup Id -> new Id of records created again by restores, kept next to the backups. */
const RESTORED = 'restored-ids.json';

/**
 * Restore from a backup run into the job's org, for one or more objects: the records as they
 * were at that run, compared with the org now. Put back changed values (lookups to records
 * created again use their new Ids), or bring deleted records back with their relationships:
 * deleted parents too, recycle bin first (same Ids), the others created again (optionally
 * through the old-Id field), and the records still in the org pointed to them again.
 */
export function RestorePanel({
  job,
  run,
  manifest,
  onCopyElsewhere,
}: {
  job: JobRecord;
  run: string;
  manifest: BackupManifest;
  onCopyElsewhere?: () => void;
}) {
  const studio = useStudio();
  const objects = manifest.objects.filter((o) => !o.error).map((o) => o.name);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(objects.slice(0, 1)));
  const [state, setState] = useState<BackupState>();
  const [previews, setPreviews] = useState<RestorePreview[]>([]);
  const [orgFields, setOrgFields] = useState<Record<string, DataField[]>>({});
  const [restored, setRestored] = useState<Record<string, string>>({});
  const [pickChanged, setPickChanged] = useState<Set<string>>(new Set());
  const [pickDeleted, setPickDeleted] = useState<Set<string>>(new Set());
  const [withParents, setWithParents] = useState(true);
  const [oldIds, setOldIds] = useState(false);
  // Files and attachments of the records brought back, when the backup has them
  const hasFiles = Boolean(manifest.files || job.files?.files || job.files?.attachments);
  const [withFiles, setWithFiles] = useState(hasFiles);
  const [locked, setLocked] = useState(false);
  useEffect(() => {
    void isLocked(job).then(setLocked);
  }, [job.id, job.encryption]);
  const [fieldsUsed, setFieldsUsed] = useState<string[]>(() =>
    storage.get<string[]>(`restore.oldIdObjects.${job.org}`, [])
  );
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const sameOrg = studio.org.id === job.org;

  useEffect(() => {
    setState(undefined);
    setPreviews([]);
  }, [run, job.id]);
  useEffect(() => {
    setPreviews([]);
    setPickChanged(new Set());
    setPickDeleted(new Set());
  }, [chosen]);

  const act = async (what: string, fn: () => Promise<void>) => {
    setBusy(true);
    setStatus(what);
    try {
      await fn();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const sink = () => jobSink(job);
  const readRestored = async (): Promise<Record<string, string>> => {
    const text = await (await sink()).read(`${jobFolder(job)}/${RESTORED}`);
    return text ? (JSON.parse(text) as Record<string, string>) : {};
  };

  const compare = () =>
    act('Reading the backup…', async () => {
      const s = state ?? (await backupStateAt(await sink(), job, run));
      setState(s);
      const moved = await readRestored();
      setRestored(moved);
      const out: RestorePreview[] = [];
      const fields: Record<string, DataField[]> = {};
      for (const object of objects.filter((o) => chosen.has(o))) {
        setStatus(`Comparing ${object} with ${studio.org.label}…`);
        /* eslint-disable no-await-in-loop */
        fields[object] = await describeData(studio.client, object);
        out.push(
          await previewRestore(
            studio.client,
            s,
            object,
            fields[object],
            (d, t) => setStatus(`Comparing ${object}… ${d}/${t}`),
            moved
          )
        );
        /* eslint-enable no-await-in-loop */
      }
      setOrgFields(fields);
      setPreviews(out);
      setPickChanged(new Set());
      setPickDeleted(new Set());
      const changed = out.reduce((n, p) => n + p.changed.length, 0);
      const deleted = out.reduce((n, p) => n + p.deleted.length, 0);
      const bin = out.reduce((n, p) => n + p.deleted.filter((d) => d.inRecycleBin).length, 0);
      setStatus(
        `${changed} record(s) changed since the backup, ${deleted} deleted (${bin} still in the recycle bin), ${out.reduce(
          (n, p) => n + p.same,
          0
        )} the same.${
          s.runs.length > 1 ? ` The backup state combines ${s.runs.length} runs (last full + incremental).` : ''
        }`
      );
    });

  const changedRows = previews.flatMap((p) =>
    p.changed.flatMap((c) =>
      c.changes.map((x) => ({
        key: `${p.object}:${c.id}:${x.field}`,
        object: p.object,
        Id: c.id,
        field: x.field,
        backup: x.backup,
        now: x.now,
      }))
    )
  );
  const deletedRows = previews.flatMap((p) =>
    p.deleted.map((d) => {
      const row = state?.rows[p.object]?.get(d.id) ?? {};
      return {
        key: `${p.object}:${d.id}`,
        object: p.object,
        Id: d.id,
        Name: row.Name ?? row.Subject ?? row.LastName ?? '',
        'recycle bin': d.inRecycleBin ? 'yes (same Id)' : 'no (created again, new Id)',
      };
    })
  );

  const putBack = () =>
    act('', async () => {
      const picked = changedRows.filter((x) => pickChanged.has(x.key));
      const byObject = new Map<string, Map<string, Record<string, string>>>();
      for (const r of picked) {
        if (!byObject.has(r.object)) byObject.set(r.object, new Map());
        const records = byObject.get(r.object)!;
        records.set(r.Id, { ...(records.get(r.Id) ?? {}), [r.field]: r.backup });
      }
      const recordCount = [...byObject.values()].reduce((n, m) => n + m.size, 0);
      if (
        !(await studio.confirmChange(`Put back ${picked.length} value(s) on ${recordCount} record(s) from the backup`))
      )
        return;
      let updated = 0;
      const failures: Array<{ id: string; error: string }> = [];
      for (const [object, records] of byObject) {
        setStatus(`Putting values back on ${object}…`);
        // eslint-disable-next-line no-await-in-loop
        const result = await restoreValues(
          studio.client,
          object,
          [...records].map(([id, fields]) => ({ id, fields })),
          orgFields[object] ?? [],
          restored
        );
        updated += result.updated;
        failures.push(...result.failures);
      }
      studio.logActivity('restore values', {
        objects: [...byObject.keys()],
        records: recordCount,
        values: picked.length,
        failed: failures.length,
        run,
      });
      setStatus(
        `${failures.length ? '⚠' : '✓'} ${updated} record(s) restored${
          failures.length ? `, ${failures.length} failed: ${failures[0].error}` : ''
        }. Compare again to check.`
      );
      // The comparison is out of date now; it is not offered twice
      setPreviews([]);
    });

  const bringBack = () =>
    act('', async () => {
      if (!state) return;
      const picked: Record<string, string[]> = {};
      for (const r of deletedRows.filter((x) => pickDeleted.has(x.key))) (picked[r.object] ??= []).push(r.Id);
      const count = Object.values(picked).reduce((n, l) => n + l.length, 0);
      const extra = [
        withParents ? 'deleted records they point to come back too' : '',
        oldIds
          ? `${OLD_ID_FIELD} may be created on the objects created again (with the permission set NomadSF_Old_Ids for you)`
          : '',
      ]
        .filter(Boolean)
        .join('; ');
      if (
        !(await studio.confirmChange(
          `Bring back ${count} deleted record(s) from the backup${extra ? ` (${extra})` : ''}`
        ))
      )
        return;
      const result = await restoreRecords(studio.client, state, picked, {
        withParents,
        restoredIds: restored,
        oldIdField: oldIds,
        files:
          withFiles && hasFiles
            ? {
                choice: job.files ?? { files: true, attachments: true, maxMB: 25 },
                source: backupFileSource(
                  await sink(),
                  jobFolder(job),
                  await backupFilesAt(await sink(), jobFolder(job), state.runs)
                ),
              }
            : undefined,
        prepareOldIds: async (list) => {
          const ready = await ensureOldIdFields(studio.client, list, setStatus);
          const used = ready.filter((f) => f.status === 'ready').map((f) => f.object);
          const all = [...new Set([...fieldsUsed, ...used])];
          setFieldsUsed(all);
          storage.set(`restore.oldIdObjects.${job.org}`, all);
          return ready.filter((f) => f.status === 'unsupported').map((f) => f.object);
        },
        onProgress: setStatus,
      });
      // Keep backup Id -> new Id next to the backups, for later restores and copies
      const merged = { ...(await readRestored()), ...result.ids };
      await (await sink()).write(`${jobFolder(job)}/${RESTORED}`, JSON.stringify(merged, null, 2));
      setRestored(merged);
      const parents = Object.entries(result.parentsAdded)
        .map(([o, n]) => `${n} ${o}`)
        .join(', ');
      studio.logActivity('restore deleted', {
        picked: count,
        undeleted: result.undeleted,
        created: result.created,
        parents: result.parentsAdded,
        repointed: result.repointed,
        failed: result.failures.length,
        run,
      });
      setStatus(
        `${result.failures.length ? '⚠' : '✓'} ${result.undeleted} undeleted, ${result.created} created again${
          parents ? ` (with the deleted records they point to: ${parents})` : ''
        }, ${result.repointed} record(s) in the org pointed to them again${
          result.files ? `, ${result.files.files} file(s) and ${result.files.attachments} attachment(s) uploaded` : ''
        }${
          result.failures.length ? `, ${result.failures.length} failed: ${result.failures[0].error}` : ''
        }. Compare again to check.`
      );
      setPreviews([]);
      if (Object.keys(result.ids).length)
        download(
          `restored-ids-${run}.csv`,
          toCsv(
            ['backupId', 'newId'],
            Object.entries(result.ids).map(([backupId, newId]) => ({ backupId, newId }))
          )
        );
    });

  const removeFields = () =>
    act('', async () => {
      if (
        !(await studio.confirmChange(
          `Remove ${OLD_ID_FIELD} from ${fieldsUsed.join(', ')} and the permission set NomadSF_Old_Ids`
        ))
      )
        return;
      const status = await oldIdFieldStatus(studio.client, fieldsUsed);
      const done = await removeOldIdFields(
        studio.client,
        status.map((x) => x.object),
        setStatus
      );
      setFieldsUsed([]);
      storage.set(`restore.oldIdObjects.${job.org}`, []);
      studio.logActivity('remove old-id fields', { objects: done.removed });
      setStatus(`✓ Removed ${OLD_ID_FIELD} from ${done.removed.join(', ') || 'no object'}.`);
    });

  return (
    <div className="card section restore-panel">
      <h3>Restore from this backup</h3>
      {locked && <UnlockBackup job={job} onUnlocked={() => setLocked(false)} />}
      {!sameOrg ? (
        <p className="muted">
          This backup is of <b>{job.org}</b>. Switch the Studio to that org to restore into it
          {onCopyElsewhere ? ', or copy the records into another org with Migrate' : ''}.
        </p>
      ) : (
        <p className="muted help">
          Into <b>{studio.org.label}</b>: the records as they were at this run, compared with the org now. Nothing
          changes until you tick values or records and confirm with the org name.
        </p>
      )}
      <div className="restore-objects">
        <span className="muted">Objects:</span>
        {objects.map((o) => (
          <label key={o} className="check">
            <input
              type="checkbox"
              checked={chosen.has(o)}
              onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(o);
                else next.delete(o);
                setChosen(next);
              }}
            />{' '}
            {o}
          </label>
        ))}
      </div>
      <div className="form">
        <button
          className="primary"
          disabled={busy || !sameOrg || !chosen.size || locked}
          onClick={() => void compare()}
        >
          Compare with the org
        </button>
        {onCopyElsewhere && <button onClick={onCopyElsewhere}>Copy into another org…</button>}
      </div>
      {status && <Status text={status} block />}
      {previews.length > 0 && changedRows.length > 0 && (
        <>
          <h3>Changed since the backup ({new Set(changedRows.map((r) => `${r.object}:${r.Id}`)).size} records)</h3>
          <DataTable
            columns={['object', 'Id', 'field', 'backup', 'now']}
            groupBy="object"
            rows={changedRows}
            rowKey="key"
            name="restore-changed"
            selected={pickChanged}
            onSelectedChange={setPickChanged}
            note={<span>· tick the values to put back; lookups to records created again use their new Ids</span>}
          />
          <div className="form">
            <button className="danger" disabled={busy || !pickChanged.size} onClick={() => void putBack()}>
              Put back {pickChanged.size || ''} value{pickChanged.size === 1 ? '' : 's'}…
            </button>
          </div>
        </>
      )}
      {previews.length > 0 && deletedRows.length > 0 && (
        <>
          <h3>Deleted since the backup ({deletedRows.length})</h3>
          <DataTable
            columns={['object', 'Id', 'Name', 'recycle bin']}
            groupBy="object"
            rows={deletedRows}
            rowKey="key"
            name="restore-deleted"
            selected={pickDeleted}
            onSelectedChange={setPickDeleted}
            note={<span>· tick the records to bring back</span>}
          />
          <div className="form restore-options">
            <label className="check" title="A deleted Case's Account, that Account's parent… if they are deleted too">
              <input type="checkbox" checked={withParents} onChange={(e) => setWithParents(e.target.checked)} /> Bring
              back the deleted records they point to
            </label>
            <label
              className="check"
              title={`Creates ${OLD_ID_FIELD} (External ID) on the objects created again and loads through it with the Bulk API`}
            >
              <input type="checkbox" checked={oldIds} onChange={(e) => setOldIds(e.target.checked)} /> Keep the old Ids
              in the org
            </label>
            {hasFiles && (
              <label className="check" title="Files and attachments in the backup of the records created again">
                <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} /> With
                their files and attachments
              </label>
            )}
            <span className="grow" />
            <button className="danger" disabled={busy || !pickDeleted.size} onClick={() => void bringBack()}>
              Bring back {pickDeleted.size || ''} record{pickDeleted.size === 1 ? '' : 's'}…
            </button>
          </div>
          <p className="muted">
            From the recycle bin they keep their Ids. Others are created again with new Ids: lookups between them are
            rebuilt, and records still in the org that pointed to them (and lost the link) are pointed to the new ones.
          </p>
        </>
      )}
      {fieldsUsed.length > 0 && (
        <div className="form">
          <span className="muted">
            {OLD_ID_FIELD} is on {fieldsUsed.join(', ')} in this org.
          </span>
          <button className="danger" disabled={busy || !sameOrg} onClick={() => void removeFields()}>
            Remove the old-Id fields…
          </button>
        </div>
      )}
    </div>
  );
}
