import { useEffect, useState } from 'react';
import {
  backupStateAt,
  describeData,
  previewRestore,
  restoreDeleted,
  restoreValues,
  toCsv,
  type BackupManifest,
  type BackupState,
  type RestorePreview,
} from '@nomadsf/core';
import { DataTable } from './DataTable';
import { useStudio } from '../context';
import { backupFolder, folderSink, type JobRecord } from '../backups';

const download = (name: string, text: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
};

/**
 * Restore from a backup run into the job's org: the records as they were at that run, compared
 * with the org now; tick the values to put back, or the deleted records to bring back
 * (undeleted from the recycle bin when they are still there, else created again).
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
  const [object, setObject] = useState(objects[0] ?? '');
  const [state, setState] = useState<BackupState>();
  const [preview, setPreview] = useState<RestorePreview>();
  const [pickChanged, setPickChanged] = useState<Set<string>>(new Set());
  const [pickDeleted, setPickDeleted] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const sameOrg = studio.org.id === job.org;

  useEffect(() => {
    setState(undefined);
    setPreview(undefined);
  }, [run, job.id]);
  useEffect(() => {
    setPreview(undefined);
    setPickChanged(new Set());
    setPickDeleted(new Set());
  }, [object]);

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

  const compare = () =>
    act('Reading the backup…', async () => {
      const handle = await backupFolder(job.id);
      if (!handle) throw new Error('The folder of this backup is not available.');
      const s = state ?? (await backupStateAt(folderSink(handle), job, run));
      setState(s);
      setStatus(`Comparing ${object} with ${studio.org.label}…`);
      const fields = await describeData(studio.client, object);
      const p = await previewRestore(studio.client, s, object, fields, (d, t) =>
        setStatus(`Comparing ${object} with ${studio.org.label}… ${d}/${t}`)
      );
      setPreview(p);
      setPickChanged(new Set());
      setPickDeleted(new Set());
      const bin = p.deleted.filter((d) => d.inRecycleBin).length;
      setStatus(
        `${p.changed.length} changed since the backup, ${p.deleted.length} deleted (${bin} still in the recycle bin), ${
          p.same
        } the same.${
          s.runs.length > 1 ? ` The backup state combines ${s.runs.length} runs (last full + incremental).` : ''
        }`
      );
    });

  const changedRows = (preview?.changed ?? []).flatMap((c) =>
    c.changes.map((x) => ({ key: `${c.id}:${x.field}`, Id: c.id, field: x.field, backup: x.backup, now: x.now }))
  );
  const deletedRows = (preview?.deleted ?? []).map((d) => {
    const row = state?.rows[object]?.get(d.id) ?? {};
    return {
      Id: d.id,
      Name: row.Name ?? '',
      'recycle bin': d.inRecycleBin ? 'yes (same Id)' : 'no (created again, new Id)',
    };
  });

  const putBack = () =>
    act('', async () => {
      const byId = new Map<string, Record<string, string>>();
      for (const r of changedRows.filter((x) => pickChanged.has(x.key)))
        byId.set(r.Id, { ...(byId.get(r.Id) ?? {}), [r.field]: r.backup });
      if (
        !studio.confirmChange(
          `Put back ${pickChanged.size} value(s) on ${byId.size} ${object} record(s) from the backup`
        )
      )
        return;
      setStatus('Putting values back…');
      const result = await restoreValues(
        studio.client,
        object,
        [...byId].map(([id, fields]) => ({ id, fields })),
        await describeData(studio.client, object)
      );
      studio.logActivity('restore values', {
        object,
        records: byId.size,
        values: pickChanged.size,
        failed: result.failures.length,
        run,
      });
      setStatus(
        `${result.failures.length ? '⚠' : '✓'} ${result.updated} record(s) restored${
          result.failures.length ? `, ${result.failures.length} failed: ${result.failures[0].error}` : ''
        }. Compare again to check.`
      );
      // The comparison is out of date now; it is not offered twice
      setPreview(undefined);
    });

  const bringBack = () =>
    act('', async () => {
      if (!state || !preview) return;
      const picked = preview.deleted.filter((d) => pickDeleted.has(d.id));
      if (!studio.confirmChange(`Bring back ${picked.length} deleted ${object} record(s) from the backup`)) return;
      const result = await restoreDeleted(
        studio.client,
        state,
        { [object]: picked },
        { [object]: await describeData(studio.client, object) },
        setStatus
      );
      const created = result.load?.objects[0]?.created ?? 0;
      const failures = [
        ...result.undeleteFailures.map((f) => ({ id: f.id, error: f.error })),
        ...(result.load?.failures ?? []).map((f) => ({ id: f.sourceId, error: f.error })),
      ];
      studio.logActivity('restore deleted', {
        object,
        undeleted: result.undeleted,
        created,
        failed: failures.length,
        run,
      });
      setStatus(
        `${failures.length ? '⚠' : '✓'} ${result.undeleted} undeleted, ${created} created again${
          failures.length ? `, ${failures.length} failed: ${failures[0].error}` : ''
        }. Compare again to check.`
      );
      setPreview(undefined);
      if (result.load && Object.keys(result.load.ids).length)
        download(
          `${object}-restored-ids.csv`,
          toCsv(
            ['backupId', 'newId'],
            Object.entries(result.load.ids).map(([backupId, newId]) => ({ backupId, newId }))
          )
        );
    });

  return (
    <div className="card section restore-panel">
      <h3>Restore from this backup</h3>
      {!sameOrg ? (
        <p className="muted">
          This backup is of <b>{job.org}</b>. Switch the Studio to that org to restore into it
          {onCopyElsewhere ? ', or copy the records into another org with Migrate' : ''}.
        </p>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Into <b>{studio.org.label}</b>: the records as they were at this run, compared with the org now. Nothing
          changes until you tick values or records and confirm with the org name.
        </p>
      )}
      <div className="form">
        <label>
          Object
          <select value={object} onChange={(e) => setObject(e.target.value)}>
            {objects.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <button className="primary" disabled={busy || !sameOrg || !object} onClick={() => void compare()}>
          Compare with the org
        </button>
        {onCopyElsewhere && <button onClick={onCopyElsewhere}>Copy into another org…</button>}
      </div>
      {status && <p className="muted">{status}</p>}
      {preview && changedRows.length > 0 && (
        <>
          <h3>Changed since the backup ({preview.changed.length} records)</h3>
          <DataTable
            columns={['Id', 'field', 'backup', 'now']}
            rows={changedRows}
            rowKey="key"
            name={`${object}-changed`}
            selected={pickChanged}
            onSelectedChange={setPickChanged}
            note={<span>· tick the values to put back</span>}
          />
          <div className="form">
            <button className="danger" disabled={busy || !pickChanged.size} onClick={() => void putBack()}>
              Put back {pickChanged.size || ''} value{pickChanged.size === 1 ? '' : 's'}…
            </button>
          </div>
        </>
      )}
      {preview && deletedRows.length > 0 && (
        <>
          <h3>Deleted since the backup ({deletedRows.length})</h3>
          <DataTable
            columns={['Id', 'Name', 'recycle bin']}
            rows={deletedRows}
            rowKey="Id"
            name={`${object}-deleted`}
            selected={pickDeleted}
            onSelectedChange={setPickDeleted}
            note={<span>· records not in the recycle bin get new Ids; lookups between them are rebuilt</span>}
          />
          <div className="form">
            <button className="danger" disabled={busy || !pickDeleted.size} onClick={() => void bringBack()}>
              Bring back {pickDeleted.size || ''} record{pickDeleted.size === 1 ? '' : 's'}…
            </button>
          </div>
        </>
      )}
    </div>
  );
}
