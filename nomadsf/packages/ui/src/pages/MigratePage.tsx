import { useEffect, useMemo, useState } from 'react';
import {
  backupCandidates,
  MAX_UPLOAD_MB,
  OLD_ID_FIELD,
  backupFileSource,
  backupFilesAt,
  backupStateAt,
  capacityWarnings,
  copyFiles,
  countFiles,
  jobFolder,
  orgCapacity,
  orgFileSource,
  completeParents,
  ensureOldIdFields,
  loadWithOldIds,
  oldIdFieldStatus,
  removeOldIdFields,
  describeBoth,
  describeData,
  explainFailures,
  gatherRows,
  getUserInfo,
  linkReport,
  matchInTarget,
  orgMaps,
  planMigration,
  readIndex,
  runMigration,
  sameOrgMaps,
  toCsv,
  undoLoad,
  type BackupState,
  type DataField,
  type DataObject,
  type FileSource,
  type LinkStatus,
  type OldIdStatus,
  type LoadResult,
  type MaskRule,
  type MigrateObject,
  type MigratePlan,
  type OrgMaps,
  type RowSource,
  type SalesforceClient,
  type SourceRow,
} from '@nomadsf/core';
import { AiExplain } from '../components/AiHelp';
import { ChildObjects } from '../components/ChildObjects';
import { UnlockBackup } from '../components/UnlockBackup';
import { DataTable, download as downloadFile } from '../components/DataTable';
import { ObjectPicker } from '../components/ObjectPicker';
import { storage, useStudio } from '../context';
import { orgFacts, type OrgChoice, type OrgFacts } from '../host';
import { backupFolder, backupJobs, bigStore, isLocked, jobSink, type JobRecord } from '../backups';
import { ObjectSettings } from './BackupPage';
import { askTyped } from '../components/Dialogs';
import { OrgPairBar, usePair } from '../pair';
import { MigrateComposer } from '../components/MigrateComposer';
import { FilesSourcePanel } from '../components/FilesSourcePanel';

type SourceChoice =
  | { kind: 'org'; org: string }
  | { kind: 'backup'; jobId: string; folder: string }
  /** Tables from a file (Excel, CSV, ⤓ zip), each matched to an object. */
  | { kind: 'files' };
/** A failed record: where it came from, Salesforce's error, and what it means. */
const FAILURE_COLUMNS = ['object', 'sourceId', 'Error code', 'What it means', 'Error message', 'Error fields'];

type LastCopy = { at: string; source: string; created: LoadResult['created']; records: number };

const download = (name: string, text: string) => downloadFile(name, text, 'text/csv');

/**
 * Copy records from one org (or a backup) into another: objects with a condition and a field
 * choice, "related only" to seed a sandbox with a consistent slice, masking of personal data,
 * owners matched by username and record types by name. The plan shows the load order, the
 * fields that cannot be copied and how many records will go; a second run updates instead of
 * duplicating; the last copy can be undone.
 */
export function MigratePage({
  orgs,
  clientFor,
}: {
  orgs: OrgChoice[];
  clientFor: (org: string) => Promise<SalesforceClient>;
}) {
  const studio = useStudio();
  // From org A (or a backup) into org B of the Org to org hub
  const [pair, setPair] = usePair();
  const [backup, setBackup] = useState<Exclude<SourceChoice, { kind: 'org' }> | null>(() => {
    const from = storage.get<{ jobId: string; folder: string } | undefined>('migrate.from', undefined);
    if (!from) return null;
    storage.set('migrate.from', undefined);
    return { kind: 'backup', ...from };
  });
  const source = useMemo<SourceChoice>(() => backup ?? { kind: 'org', org: pair.a }, [backup, pair.a]);
  const setSource = (next: SourceChoice) => {
    if (next.kind !== 'org') return setBackup(next);
    setBackup(null);
    setPair({ a: next.org, b: pair.b === next.org ? '' : pair.b });
  };
  const targetId = pair.b;
  const [facts, setFacts] = useState<{ source?: OrgFacts; target?: OrgFacts }>({});
  const [candidates, setCandidates] = useState<DataObject[] | null>(null);
  const [sourceClient, setSourceClient] = useState<SalesforceClient>();
  const [state, setState] = useState<BackupState>();
  const [backupRuns, setBackupRuns] = useState<string[]>([]);
  const [chosen, setChosen] = useState<MigrateObject[]>([]);
  const [open, setOpen] = useState('');
  const [fields, setFields] = useState<Record<string, DataField[]>>({});
  const [fieldFilter, setFieldFilter] = useState('');
  const [mask, setMask] = useState(false);
  const [maskTouched, setMaskTouched] = useState(false);
  const [overrides, setOverrides] = useState<Record<string, Record<string, MaskRule | 'none'>>>({});
  const [plan, setPlan] = useState<MigratePlan>();
  const [maps, setMaps] = useState<OrgMaps>();
  const [keepIds, setKeepIds] = useState(false);
  const [lockedJob, setLockedJob] = useState<JobRecord>();
  const [unlockedAt, setUnlockedAt] = useState(0);
  // Files and attachments of the copied records
  const [withFiles, setWithFiles] = useState(() => storage.get('migrate.files', false));
  const [maxMB, setMaxMB] = useState(() => storage.get('migrate.filesMB', 25));
  const [fileCount, setFileCount] = useState<{ files: number; attachments: number; bytes: number; tooLarge: number }>();
  const [warnings, setWarnings] = useState<string[]>([]);
  // Keeping every link: parents brought along, links to records already in the target
  const [withParents, setWithParents] = useState(() => storage.get('migrate.parents', true));
  const [matchRules, setMatchRules] = useState<Record<string, string>>({});
  const [matchOptions, setMatchOptions] = useState<Record<string, string[]>>({});
  const [matched, setMatched] = useState<Record<string, string>>({});
  const [links, setLinks] = useState<LinkStatus[]>([]);
  const [broughtParents, setBroughtParents] = useState<Record<string, number>>({});
  // Id maps are kept per source org (whichever way it was chosen) and target
  const [idsKey, setIdsKey] = useState('');
  // Keeping the old Ids in the target org (NomadSF_Old_Id__c, Bulk API upserts)
  const [oldIds, setOldIds] = useState(() => storage.get('migrate.oldIds', false));
  const [fieldStatus, setFieldStatus] = useState<OldIdStatus[]>([]);
  const [fieldsUsed, setFieldsUsed] = useState<string[]>([]);
  useEffect(
    () => setFieldsUsed(targetId ? storage.get<string[]>(`migrate.oldIdObjects.${targetId}`, []) : []),
    [targetId]
  );
  const [rows, setRows] = useState<Record<string, SourceRow[]>>();
  const [result, setResult] = useState<LoadResult>();
  const [last, setLast] = useState<LastCopy>();
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const target = orgs.find((o) => o.id === targetId);
  // One function per target: the files panel reads B's objects again only when B changes
  const filesTarget = useMemo(() => (targetId ? () => clientFor(targetId) : undefined), [targetId, clientFor]);
  const sourceKey =
    source.kind === 'org' ? `org:${source.org}` : source.kind === 'backup' ? `backup:${source.jobId}` : 'files';
  const job = source.kind === 'backup' ? backupJobs.list().find((j) => j.id === source.jobId) : undefined;
  const targetProduction = facts.target ? !facts.target.isSandbox : false;
  const sourceProduction =
    source.kind === 'org'
      ? facts.source
        ? !facts.source.isSandbox
        : false
      : state
      ? !state.manifest.org.isSandbox
      : false;
  const sameOrg = source.kind === 'org' && source.org === targetId;

  // Any change to the choice makes the plan stale
  useEffect(() => {
    setPlan(undefined);
    setRows(undefined);
  }, [source, targetId, chosen, mask, overrides]);
  // How links are kept changed: the plan stays visible but must be checked again before copying
  const [stale, setStale] = useState(false);
  useEffect(() => {
    if (plan) setStale(true);
  }, [withParents, matchRules, oldIds, withFiles, maxMB]);

  // What can be copied: the source org's objects, or the objects of the backup
  useEffect(() => {
    setCandidates(null);
    setState(undefined);
    setChosen([]);
    setResult(undefined);
    let canceled = false;
    void (async () => {
      try {
        if (source.kind === 'org') {
          const client = await clientFor(source.org);
          setSourceClient(client);
          const [list, f] = await Promise.all([
            client.rest<{ sobjects: DataObject[] }>('GET', '/sobjects'),
            orgFacts(client),
          ]);
          if (canceled) return;
          setFacts((x) => ({ ...x, source: f }));
          setCandidates(backupCandidates(list.sobjects));
        } else if (source.kind === 'files') {
          // The tables come from Use these files (below)
          setStatus('');
        } else {
          const handle = await backupFolder(source.jobId);
          const theJob = backupJobs.list().find((j) => j.id === source.jobId);
          if (!handle || !theJob) throw new Error('The folder of this backup is not available on this computer.');
          if (await isLocked(theJob)) {
            setLockedJob(theJob);
            return;
          }
          setLockedJob(undefined);
          const sink = await jobSink(theJob);
          const index = await readIndex(sink, theJob);
          if (canceled) return;
          setBackupRuns((index?.runs ?? []).map((r) => r.folder));
          setStatus('Reading the backup…');
          const s = await backupStateAt(sink, theJob, source.folder);
          if (canceled) return;
          setState(s);
          setStatus('');
          setCandidates(
            Object.keys(s.rows)
              .sort()
              .map((name) => ({ name, label: name, custom: name.endsWith('__c'), queryable: true }))
          );
        }
      } catch (e) {
        if (!canceled) setStatus(`❌ ${(e as Error).message}`);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [JSON.stringify(source), clientFor, unlockedAt]);

  // The target: production or not, and its last copy (for undo)
  useEffect(() => {
    setFacts((x) => ({ ...x, target: undefined }));
    setLast(undefined);
    if (!targetId) return;
    let canceled = false;
    void (async () => {
      try {
        const f = await orgFacts(await clientFor(targetId));
        if (!canceled) setFacts((x) => ({ ...x, target: f }));
        const l = await bigStore.get<LastCopy>(`migrate.last.${targetId}`);
        if (!canceled) setLast(l);
      } catch (e) {
        if (!canceled) setStatus(`❌ ${(e as Error).message}`);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [targetId, clientFor]);

  // Masking on by default when production data goes somewhere else
  useEffect(() => {
    if (!maskTouched) setMask(sourceProduction && !targetProduction);
  }, [sourceProduction, targetProduction, maskTouched]);

  const isChosen = (name: string) => chosen.some((c) => c.name === name);
  // For the child objects panel: where the rows come from, and which objects can be copied
  const childSource = useMemo<(RowSource & { schema?: Record<string, DataField[]> }) | undefined>(
    () =>
      source.kind === 'org'
        ? sourceClient && { kind: 'org', client: sourceClient }
        : state && { kind: 'backup', rows: state.rows, schema: state.schema },
    [source.kind, sourceClient, state]
  );
  const allowed = useMemo(() => new Set((candidates ?? []).map((c) => c.name)), [candidates]);
  /** Children follow the lookups they were added through (Contact via AccountId), not every lookup. */
  const addChildren = (names: string[], via: Record<string, string[]> = {}) => {
    setChosen((list) => [
      ...list.map((c) =>
        names.includes(c.name) && c.relatedOnly && c.via
          ? { ...c, via: [...new Set([...c.via, ...(via[c.name] ?? [])])] }
          : c
      ),
      ...names
        .filter((n) => !list.some((c) => c.name === n))
        .map((name) => ({ name, relatedOnly: true, via: via[name]?.length ? via[name] : undefined })),
    ]);
    setOpen('');
    setStatus(`✓ Added ${names.join(', ')} as Related only: only records linked to the copied records come along.`);
  };
  const settingsOf = (name: string): MigrateObject => chosen.find((c) => c.name === name) ?? { name };
  const setSettings = (name: string, patch: Partial<MigrateObject>) =>
    setChosen((list) => list.map((c) => (c.name === name ? { ...c, ...patch } : c)));
  const toggle = (name: string, on: boolean) =>
    setChosen((list) => (on ? [...list, { name, relatedOnly: list.length > 0 }] : list.filter((c) => c.name !== name)));
  /** Adds an object whose records are copied only when other copied records point to them. */
  const addReferenced = (name: string) =>
    setChosen((list) =>
      list.some((c) => c.name === name)
        ? list.map((c) => (c.name === name ? { ...c, onlyReferenced: true, relatedOnly: false } : c))
        : [...list, { name, onlyReferenced: true }]
    );

  /** An object's fields from the source (for its settings, and the composer's lookups). */
  const loadFields = async (name: string) => {
    if (fields[name]) return;
    try {
      const list =
        source.kind !== 'org' ? state?.schema[name] ?? [] : await describeData(await clientFor(source.org), name);
      setFields((f) => ({ ...f, [name]: list }));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  const openSettings = async (name: string) => {
    setOpen(open === name ? '' : name);
    setFieldFilter('');
    await loadFields(name);
  };

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

  const check = () =>
    act('Reading both orgs…', async () => {
      if (!target) throw new Error('Choose the target org.');
      const targetClient = await clientFor(target.id);
      const sourceClient = source.kind === 'org' ? await clientFor(source.org) : undefined;
      const names = chosen.map((c) => c.name);
      const schemas = await describeBoth(sourceClient ?? state!.schema, targetClient, names);
      const p = planMigration(chosen, schemas, { mask, maskOverrides: overrides });
      setStatus('Matching users, record types and queues…');
      const me = await getUserInfo(targetClient);
      const m = sourceClient
        ? await orgMaps(sourceClient, targetClient, {
            sourceSandbox: Boolean(facts.source?.isSandbox),
            targetSandbox: Boolean(facts.target?.isSandbox),
            defaultOwner: me.userId,
          })
        : { ...sameOrgMaps(), defaultOwner: me.userId };
      // A backup of this same org: lookups and owners outside the copy keep their Ids
      setKeepIds(!sourceClient && state!.manifest.org.id.slice(0, 15) === me.organizationId.slice(0, 15));
      setStatus('Counting the records to copy…');
      const rowSource: RowSource = sourceClient
        ? { kind: 'org', client: sourceClient }
        : { kind: 'backup', rows: state!.rows };
      const gathered = await gatherRows(rowSource, p, (object, n) => setStatus(`Records to copy: ${object} ${n}`));
      // Key prefixes (001 = Account…) tell which object a polymorphic lookup points to
      const prefixes = Object.fromEntries(
        (
          await targetClient.rest<{ sobjects: Array<{ name: string; keyPrefix?: string | null }> }>('GET', '/sobjects')
        ).sobjects
          .filter((o) => o.keyPrefix)
          .map((o) => [o.keyPrefix!, o.name])
      );
      const added = withParents
        ? await completeParents(rowSource, p, gathered, {
            prefixes,
            onProgress: (object, n) => setStatus(`Bringing the records they point to: ${object} +${n}`),
          })
        : {};
      const sourceOrgId = sourceClient ? (await getUserInfo(sourceClient)).organizationId : state!.manifest.org.id;
      const key = `migrate.ids.${sourceOrgId.slice(0, 15)}.${target.id}`;
      const stored = (await bigStore.get<Record<string, string>>(key)) ?? {};
      const rules = Object.entries(matchRules)
        .filter(([, by]) => by && by !== 'none')
        .map(([object, by]) => ({ object, by }));
      if (rules.length) setStatus('Looking for the linked records in the target…');
      const found = rules.length
        ? await matchInTarget(rowSource, targetClient, p, gathered, rules, prefixes)
        : { ids: {}, stats: {} };
      const report = linkReport(p, gathered, { ...stored, ...found.ids }, prefixes);
      // Fields to match records that are not copied: Name, external Ids, unique fields
      const outside = [...new Set(report.filter((l) => !l.inCopy && !l.to.includes(' / ')).map((l) => l.to))];
      const options: Record<string, string[]> = {};
      for (const object of outside) {
        // eslint-disable-next-line no-await-in-loop
        const fieldsOf = await describeData(targetClient, object).catch(() => [] as DataField[]);
        options[object] = fieldsOf
          .filter((x) => (x.externalId || x.unique || x.name === 'Name') && x.type !== 'reference' && x.type !== 'id')
          .map((x) => x.name);
      }
      setMatchOptions(options);
      setMatched(found.ids);
      setLinks(report);
      setBroughtParents(added);
      setIdsKey(key);
      setFieldStatus(oldIds ? await oldIdFieldStatus(targetClient, p.order) : []);
      // Files of the records to copy, and whether the target has room for everything
      const recordCount = Object.values(gathered).reduce((n, r) => n + r.length, 0);
      let counted: typeof fileCount;
      if (withFiles) {
        setStatus('Counting the files and attachments of the records…');
        counted = await countFiles(
          await filesSource(),
          Object.values(gathered).flatMap((list) => list.map((r) => r.Id)),
          { files: true, attachments: true, maxMB }
        );
      }
      setFileCount(counted);
      setWarnings(
        capacityWarnings(await orgCapacity(targetClient).catch(() => ({})), {
          records: recordCount,
          fileBytes: counted?.bytes ?? 0,
          files: (counted?.files ?? 0) + (counted?.attachments ?? 0),
          bulk: oldIds,
        })
      );
      setPlan(p);
      setStale(false);
      setMaps(m);
      setRows(gathered);
      const total = Object.values(gathered).reduce((n, r) => n + r.length, 0);
      const lost = report.reduce((n, l) => n + l.empty, 0);
      const brought = Object.values(added).reduce((n, x) => n + x, 0);
      setStatus(
        `${total.toLocaleString()} record(s) ready to copy${
          brought ? ` (${brought} added because copied records point to them)` : ''
        }. ${lost ? `⚠ ${lost} link(s) would be empty: see Links below.` : '✓ Every link between records is kept.'}`
      );
    });

  const copy = () =>
    act('', async () => {
      if (!plan || !rows || !maps || !target) return;
      const total = Object.values(rows).reduce((n, r) => n + r.length, 0);
      const warn = targetProduction ? `\n\n⚠ ${target.label} is a PRODUCTION org.` : '';
      const toCreate = fieldStatus.filter((f) => f.status === 'create').map((f) => f.object);
      const setup =
        oldIds && toCreate.length
          ? `\n\nThis first creates the field ${OLD_ID_FIELD} (text, External ID, unique) on ${toCreate.join(
              ', '
            )} and the permission set NomadSF_Old_Ids (assigned to you) in ${target.label}.`
          : '';
      const ok = await askTyped(
        `Copy ${total} record(s) of ${plan.order.length} object(s) into ${target.label}${
          mask ? ' (masked)' : ''
        }.${setup}${warn}`,
        target.label,
        { ok: 'Copy', danger: targetProduction }
      );
      if (!ok) return;
      const targetClient = await clientFor(target.id);
      const known = { ...((await bigStore.get<Record<string, string>>(idsKey)) ?? {}), ...matched };
      const progress = (s: {
        object: string;
        index: number;
        total: number;
        phase: string;
        done: number;
        rows: number;
      }) => setStatus(`${s.object} (${s.index + 1}/${s.total}) · ${s.phase} · ${s.done}/${s.rows}`);
      // The Id map is saved as the copy goes: an interrupted copy, run again, updates instead of duplicating
      const saveIds = (ids: Record<string, string>) =>
        bigStore.set(idsKey, { ...known, ...ids }).catch(() => undefined);
      let out: LoadResult;
      if (oldIds) {
        const ready = await ensureOldIdFields(targetClient, plan.order, setStatus);
        const used = ready.filter((f) => f.status === 'ready').map((f) => f.object);
        const all = [...new Set([...fieldsUsed, ...used])];
        setFieldsUsed(all);
        storage.set(`migrate.oldIdObjects.${target.id}`, all);
        setFieldStatus(ready);
        out = await loadWithOldIds(
          targetClient,
          plan.objects.map((o) => ({
            name: o.name,
            source: plan.schemas[o.name].source,
            target: plan.schemas[o.name].target,
            mask: o.mask,
          })),
          rows,
          {
            maps,
            known,
            keepUnmapped: keepIds,
            withoutField: ready.filter((f) => f.status === 'unsupported').map((f) => f.object),
            onProgress: progress,
            onIds: saveIds,
          }
        );
      } else {
        out = await runMigration(targetClient, plan, rows, {
          maps,
          known,
          keepUnmapped: keepIds,
          onProgress: progress,
          onIds: saveIds,
        });
      }
      // Then the files and attachments of the copied records
      let filesNote = '';
      if (withFiles) {
        const loaded = new Set(Object.values(rows).flatMap((list) => list.map((r) => r.Id)));
        const recordIds = Object.fromEntries(Object.entries(out.ids).filter(([oldId]) => loaded.has(oldId)));
        const copied = await copyFiles(await filesSource(), targetClient, recordIds, {
          choice: { files: true, attachments: true, maxMB },
          known,
          onProgress: setStatus,
        });
        out = {
          ...out,
          ids: { ...out.ids, ...copied.ids },
          created: [...copied.created, ...out.created],
          failures: [
            ...out.failures,
            ...copied.failures.map((f) => ({ object: 'File', sourceId: f.id, error: `${f.name}: ${f.error}` })),
          ],
        };
        filesNote = ` · ${copied.files} file(s), ${copied.links} extra link(s), ${copied.attachments} attachment(s)${
          copied.skipped.length ? `, ${copied.skipped.length} skipped (too large)` : ''
        }`;
      }
      await bigStore.set(idsKey, out.ids);
      const created = out.objects.reduce((n, o) => n + o.created, 0);
      // Undo removes what a copy created; a copy that only updated keeps the earlier one
      if (created > 0) {
        const copyRecord: LastCopy = {
          at: new Date().toISOString(),
          source: idsKey,
          created: out.created,
          records: created,
        };
        await bigStore.set(`migrate.last.${target.id}`, copyRecord);
        setLast(copyRecord);
      }
      setResult(out);
      studio.logActivity('migrate data', {
        source: sourceKey,
        target: target.label,
        created,
        updated: out.objects.reduce((n, o) => n + o.updated, 0),
        failed: out.failures.length,
        masked: mask,
      });
      setStatus(
        `${out.failures.length ? '⚠' : '✓'} ${created} created, ${out.objects.reduce(
          (n, o) => n + o.updated,
          0
        )} updated${filesNote}${out.failures.length ? `, ${out.failures.length} failed (see below)` : ''}.`
      );
    });

  /** Where the files come from: the source org, or the backup run. */
  const filesSource = async (): Promise<FileSource> => {
    if (source.kind === 'org') return orgFileSource(await clientFor(source.org));
    if (source.kind === 'files')
      throw new Error(
        'Salesforce Files and attachments come from an org or a backup, not from spreadsheets: untick them.'
      );
    const theJob = backupJobs.list().find((j) => j.id === source.jobId)!;
    const sink = await jobSink(theJob);
    return backupFileSource(sink, jobFolder(theJob), await backupFilesAt(sink, jobFolder(theJob), state?.runs ?? []));
  };

  const removeFields = () =>
    act('', async () => {
      if (!target) return;
      const ok = await askTyped(
        `Remove ${OLD_ID_FIELD} (and its values) from ${fieldsUsed.join(
          ', '
        )} and the permission set NomadSF_Old_Ids in ${
          target.label
        }? Re-runs then create new records instead of updating.`,
        target.label,
        { ok: 'Remove', danger: true }
      );
      if (!ok) return;
      const done = await removeOldIdFields(await clientFor(target.id), fieldsUsed, setStatus);
      setFieldsUsed([]);
      storage.set(`migrate.oldIdObjects.${target.id}`, []);
      setFieldStatus([]);
      studio.logActivity('remove old-id fields', { target: target.label, objects: done.removed });
      setStatus(`✓ Removed ${OLD_ID_FIELD} from ${done.removed.join(', ') || 'no object'} and the permission set.`);
    });

  const undo = () =>
    act('', async () => {
      if (!last || !target) return;
      const ok = await askTyped(
        `Delete the ${last.records} record(s) the copy of ${new Date(last.at).toLocaleString()} created in ${
          target.label
        }?`,
        target.label,
        { ok: 'Delete', danger: true }
      );
      if (!ok) return;
      const out = await undoLoad(await clientFor(target.id), last.created, (o) => setStatus(`Deleting ${o}…`));
      await bigStore.remove(`migrate.last.${target.id}`);
      // Records deleted: the next copy creates them again
      const key = last.source.startsWith('migrate.ids.') ? last.source : `migrate.ids.${last.source}.${target.id}`;
      const ids = (await bigStore.get<Record<string, string>>(key)) ?? {};
      const gone = new Set(last.created.flatMap((c) => c.ids));
      await bigStore.set(key, Object.fromEntries(Object.entries(ids).filter(([, t]) => !gone.has(t))));
      setLast(undefined);
      studio.logActivity('undo migrate', { target: target.label, deleted: out.deleted, failed: out.failed.length });
      setStatus(
        `${out.failed.length ? '⚠' : '✓'} ${out.deleted} deleted${
          out.failed.length ? `, ${out.failed.length} could not be deleted: ${out.failed[0].error}` : ''
        }.`
      );
    });

  const planRows = useMemo(
    () =>
      plan?.objects.map((o, i) => ({
        step: i + 1,
        object: o.name,
        records: rows?.[o.name]?.length ?? 0,
        fields: o.fields.write.length,
        'not in target': o.fields.missing.join(', '),
        'set after': (plan.deferred[o.name] ?? []).join(', '),
        masked: Object.entries(o.mask)
          .map(([f, r]) => `${f} (${r})`)
          .join(', '),
        'which records': o.onlyReferenced
          ? 'pointed to by copied records'
          : o.relatedOnly
          ? `related (via ${(o.via ?? o.links.map((l) => l.field)).join(', ') || '—'})`
          : o.where
          ? 'condition'
          : 'all',
        limit: o.limit ? `newest ${o.limit}` : '',
        added: broughtParents[o.name] ?? 0,
      })) ?? [],
    [plan, rows, broughtParents]
  );

  return (
    <div className="page data-page migrate-page">
      <div className="toolbar">
        <h2>Migrate</h2>
        <span className="muted">Copy records between orgs, or from a backup, with their relationships</span>
      </div>
      <OrgPairBar labelA="A — copy from" labelB="B — copy into" />
      <div className="card section">
        <h3 className="step-title">
          <span className="step">1</span> From and into
        </h3>
        <div className="form">
          <label>
            From
            <select
              value={source.kind === 'org' ? `org:${source.org}` : source.kind}
              onChange={(e) => {
                const v = e.target.value;
                if (v === 'files') setSource({ kind: 'files' });
                else if (v === 'backup') {
                  const first = backupJobs.list()[0];
                  if (first) setSource({ kind: 'backup', jobId: first.id, folder: '' });
                } else setSource({ kind: 'org', org: v.slice(4) });
              }}
            >
              <option value={`org:${pair.a}`}>A — {orgs.find((o) => o.id === pair.a)?.label}</option>
              {backupJobs.list().length > 0 && <option value="backup">A backup…</option>}
              <option value="files">Files (Excel, CSV or zip)…</option>
            </select>
          </label>
          {source.kind === 'backup' && (
            <>
              <label>
                Backup
                <select
                  value={source.jobId}
                  onChange={(e) => setSource({ kind: 'backup', jobId: e.target.value, folder: '' })}
                >
                  {backupJobs.list().map((j) => (
                    <option key={j.id} value={j.id}>
                      {j.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                As of run
                <select value={source.folder} onChange={(e) => setSource({ ...source, folder: e.target.value })}>
                  <option value="">Choose…</option>
                  {[...backupRuns].reverse().map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
              </label>
            </>
          )}
          <span className="arrow">→</span>
          <span>
            Into{'\u00a0'}
            <b>{target ? `B — ${target.label}` : 'B (choose it above)'}</b>
          </span>
          {facts.target && (
            <span className={`pill ${targetProduction ? 'bad' : 'good'}`}>
              {targetProduction ? 'Production' : 'Sandbox'}
            </span>
          )}
        </div>
        {source.kind === 'files' && (
          <FilesSourcePanel
            targetClient={filesTarget}
            onUse={(s, objects, notes) => {
              setState(s);
              setChosen([]);
              setCandidates(
                objects.map((name) => ({ name, label: name, custom: name.endsWith('__c'), queryable: true }))
              );
              setStatus(notes.length ? `Using the files. ${notes.join(' · ')}` : '✓ Using the files.');
            }}
          />
        )}
        {source.kind === 'backup' && job && state && (
          <p className="muted" style={{ margin: 0 }}>
            {job.name}: {state.manifest.org.name} as of {new Date(state.manifest.finishedAt).toLocaleString()} (
            {state.runs.length} run
            {state.runs.length === 1 ? '' : 's'} combined).
          </p>
        )}
        {sameOrg && <p className="bad">Choose two different orgs.</p>}
        {lockedJob && <UnlockBackup job={lockedJob} onUnlocked={() => setUnlockedAt(Date.now())} />}
      </div>

      <div className="card section">
        <h3 className="step-title">
          <span className="step">2</span> What to copy
        </h3>
        <p className="muted help">
          Tick objects in any order; NomadSF loads parents first. <b>Related only</b> takes just the records that point
          to records of the objects before it (e.g. 100 Accounts, then their Contacts and Opportunities).
        </p>
        <h4>Plan</h4>
        <MigrateComposer
          chosen={chosen}
          fields={fields}
          loadFields={loadFields}
          setSettings={setSettings}
          remove={(name) => setChosen((list) => list.filter((c) => c.name !== name))}
          addParent={(name) => {
            addReferenced(name);
            setStatus(`✓ Added ${name}: only the records the copied ones point to come along.`);
          }}
          backup={source.kind !== 'org'}
          renderFields={(name) => (
            <ObjectSettings
              settings={settingsOf(name)}
              fields={fields[name]}
              filter={fieldFilter}
              onFilter={setFieldFilter}
              onChange={(patch) => setSettings(name, patch)}
              noCondition
            />
          )}
          renderChildren={(name, close) =>
            childSource && (
              <ChildObjects
                parent={name}
                parentWhere={source.kind === 'org' ? settingsOf(name).where : undefined}
                source={childSource}
                allowed={allowed}
                isChosen={isChosen}
                onAdd={(names, via) => {
                  addChildren(names, via);
                  close();
                }}
                onClose={close}
              />
            )
          }
        />
        <h4>Objects</h4>
        <ObjectPicker
          objects={candidates}
          purpose="copy"
          chosenCount={chosen.length}
          isChosen={isChosen}
          onToggle={toggle}
          onApply={(picks, replace) =>
            setChosen((list) => {
              const merged = replace ? picks : [...list.filter((c) => !picks.some((p) => p.name === c.name)), ...picks];
              // A backup has no SOQL: conditions are dropped
              return merged.map((p) => (source.kind !== 'org' ? { ...p, where: undefined } : p));
            })
          }
          renderTags={(o) => {
            if (!isChosen(o.name)) return null;
            const settings = settingsOf(o.name);
            return (
              <>
                {settings.where && (
                  <span className="backup-tag" title={settings.where}>
                    where
                  </span>
                )}
                {settings.fields && settings.fields.mode !== 'all' && <span className="backup-tag">fields</span>}
              </>
            );
          }}
          renderActions={(o) =>
            isChosen(o.name) && (
              <>
                <select
                  className="records-choice"
                  title="Which records of this object are copied"
                  value={
                    settingsOf(o.name).onlyReferenced
                      ? 'referenced'
                      : settingsOf(o.name).relatedOnly
                      ? 'related'
                      : 'all'
                  }
                  onChange={(e) =>
                    setSettings(o.name, {
                      relatedOnly: e.target.value === 'related',
                      onlyReferenced: e.target.value === 'referenced',
                    })
                  }
                >
                  <option value="all">All{source.kind === 'org' ? ' (or condition)' : ''}</option>
                  <option value="related">Related only</option>
                  <option value="referenced">Only those pointed to</option>
                </select>
                <button
                  className="link"
                  onClick={() => setOpen(open === `children:${o.name}` ? '' : `children:${o.name}`)}
                >
                  Children…
                </button>
                <button className="link" onClick={() => void openSettings(o.name)}>
                  {open === o.name ? 'Close' : 'Settings'}
                </button>
              </>
            )
          }
          renderSettings={(o) =>
            isChosen(o.name) &&
            (open === `children:${o.name}`
              ? childSource && (
                  <ChildObjects
                    parent={o.name}
                    parentWhere={source.kind === 'org' ? settingsOf(o.name).where : undefined}
                    source={childSource}
                    allowed={allowed}
                    isChosen={isChosen}
                    onAdd={addChildren}
                    onClose={() => setOpen('')}
                  />
                )
              : open === o.name && (
                  <ObjectSettings
                    settings={settingsOf(o.name)}
                    fields={fields[o.name]}
                    filter={fieldFilter}
                    onFilter={setFieldFilter}
                    onChange={(patch) => setSettings(o.name, patch)}
                    noCondition={source.kind !== 'org'}
                  />
                ))
          }
        />
      </div>

      <div className="card section">
        <h3 className="step-title">
          <span className="step">3</span> Check and copy
        </h3>
        <div className="form">
          <label className="check">
            <input
              type="checkbox"
              checked={mask}
              onChange={(e) => {
                setMask(e.target.checked);
                setMaskTouched(true);
              }}
            />{' '}
            Mask personal data (e-mails, phones, people's names, streets)
          </label>
          <label
            className="check"
            title="A Case's Account, an Account's parent… are copied too, so every lookup between copied objects keeps its record"
          >
            <input
              type="checkbox"
              checked={withParents}
              onChange={(e) => {
                setWithParents(e.target.checked);
                storage.set('migrate.parents', e.target.checked);
              }}
            />{' '}
            Bring the records they point to (keeps every link)
          </label>
          <label
            className="check"
            title={`Creates ${OLD_ID_FIELD} (External ID) on the objects in the target and upserts on it with the Bulk API: for large volumes, safe re-runs, and to see where each record came from`}
          >
            <input
              type="checkbox"
              checked={oldIds}
              onChange={(e) => {
                setOldIds(e.target.checked);
                storage.set('migrate.oldIds', e.target.checked);
              }}
            />{' '}
            Keep the old Ids in the target org
          </label>
          <label
            className="check"
            title="Salesforce Files (with who they are shared with) and attachments of the copied records"
          >
            <input
              type="checkbox"
              checked={withFiles}
              onChange={(e) => {
                setWithFiles(e.target.checked);
                storage.set('migrate.files', e.target.checked);
              }}
            />{' '}
            Copy files and attachments, up to
            <input
              type="number"
              min={1}
              max={MAX_UPLOAD_MB}
              style={{ width: 56, margin: '0 4px' }}
              value={maxMB}
              onChange={(e) => {
                const v = Math.min(MAX_UPLOAD_MB, Math.max(1, Number(e.target.value) || 1));
                setMaxMB(v);
                storage.set('migrate.filesMB', v);
              }}
            />
            MB each
          </label>
          {sourceProduction && !mask && <span className="bad">Production data unmasked</span>}
          <span className="grow" />
          <button
            disabled={busy || !chosen.length || !target || sameOrg || (source.kind !== 'org' && !state)}
            onClick={() => void check()}
          >
            Check plan
          </button>
          <button
            className={targetProduction ? 'danger' : 'primary'}
            disabled={busy || !plan || !rows || stale}
            onClick={() => void copy()}
          >
            Copy{' '}
            {rows
              ? Object.values(rows)
                  .reduce((n, r) => n + r.length, 0)
                  .toLocaleString()
              : ''}{' '}
            records…
          </button>
          {last && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => void undo()}
              title={`Copy of ${new Date(last.at).toLocaleString()}`}
            >
              Undo last copy ({last.records})…
            </button>
          )}
        </div>
        {status && <p className="muted">{status}</p>}
        {oldIds && fieldStatus.length > 0 && (
          <p className="muted old-ids">
            <b>{OLD_ID_FIELD}</b>:{' '}
            {(['ready', 'create', 'unsupported'] as const)
              .map((k) => [k, fieldStatus.filter((f) => f.status === k).map((f) => f.object)] as const)
              .filter(([, list]) => list.length)
              .map(([k, list]) =>
                k === 'ready'
                  ? `ready on ${list.join(', ')}`
                  : k === 'create'
                  ? `will be created on ${list.join(', ')} (with the permission set NomadSF_Old_Ids for you)`
                  : `not possible on ${list.join(', ')} (custom fields not allowed; the in-browser Id map is used)`
              )
              .join(' · ')}
          </p>
        )}
        {fieldsUsed.length > 0 && target && (
          <div className="form">
            <span className="muted">
              {OLD_ID_FIELD} is on {fieldsUsed.join(', ')} in a target: keep it for re-runs, or remove it when the data
              is final.
            </span>
            <button className="danger" disabled={busy} onClick={() => void removeFields()}>
              Remove the old-Id fields…
            </button>
          </div>
        )}
        {plan && (
          <>
            {fileCount && (
              <p className="muted">
                Files: {fileCount.files} file(s) and {fileCount.attachments} attachment(s),{' '}
                {(fileCount.bytes / (1024 * 1024)).toFixed(1)} MB
                {fileCount.tooLarge ? ` · ${fileCount.tooLarge} larger than ${maxMB} MB are skipped` : ''}.
              </p>
            )}
            {warnings.length > 0 && (
              <ul className="capacity-warnings">
                {warnings.map((w) => (
                  <li key={w}>⚠ {w}</li>
                ))}
              </ul>
            )}
            {plan.missingObjects.length > 0 && (
              <p className="bad">Not in the target, left out: {plan.missingObjects.join(', ')}</p>
            )}
            {maps && (
              <p className="muted" style={{ margin: 0 }}>
                Owners: {maps.users.size} user(s) matched by username, others get you as owner · {maps.recordTypes.size}{' '}
                record type(s) and {maps.queues.size} queue(s) matched by name.{' '}
                {keepIds
                  ? 'The backup is of this org: lookups and owners outside the copy keep their Ids.'
                  : 'See Links below for every lookup between records.'}
              </p>
            )}
            <DataTable
              columns={[
                'step',
                'object',
                'records',
                'which records',
                'limit',
                'added',
                'fields',
                'not in target',
                'set after',
                'masked',
              ]}
              rows={planRows}
              rowKey="object"
              name="migration-plan"
            />
            {links.length > 0 && (
              <div className="links-panel">
                <h4>
                  Links between records{' '}
                  <span className={links.some((l) => l.empty) ? 'bad' : 'good'}>
                    {links.reduce((n, l) => n + l.linked + l.matched, 0)} kept ·{' '}
                    {links.reduce((n, l) => n + l.empty, 0)} would be empty
                  </span>
                </h4>
                <table className="links-table">
                  <thead>
                    <tr>
                      <th>Lookup</th>
                      <th>Points to</th>
                      <th>With a value</th>
                      <th>To a copied record</th>
                      <th>To a record in the target</th>
                      <th>Empty</th>
                      <th>Keep them by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {links.map((l) => (
                      <tr key={`${l.object}.${l.field}.${l.to}`} className={l.empty ? 'lost' : ''}>
                        <td className="mono">
                          {l.object}.{l.field}
                        </td>
                        <td>{l.to}</td>
                        <td>{l.withValue}</td>
                        <td>{l.linked}</td>
                        <td>{l.matched}</td>
                        <td>{l.empty || '—'}</td>
                        <td>
                          {!l.empty ? (
                            <span className="good">✓ kept</span>
                          ) : l.inCopy ? (
                            withParents ? (
                              <span className="muted">
                                {source.kind === 'files' ? 'not in the files' : 'not in the source any more (deleted?)'}
                              </span>
                            ) : (
                              <button className="link" onClick={() => setWithParents(true)}>
                                Bring the records they point to
                              </button>
                            )
                          ) : l.to.includes(' / ') ? (
                            <span className="muted">copy the objects it points to</span>
                          ) : (
                            <span className="link-fix">
                              <select
                                value={matchRules[l.to] ?? 'none'}
                                onChange={(e) => setMatchRules((x) => ({ ...x, [l.to]: e.target.value }))}
                              >
                                <option value="none">Leave empty</option>
                                <option value="id">Same Id in the target</option>
                                {(matchOptions[l.to] ?? []).map((field) => (
                                  <option key={field} value={field}>
                                    Same {field} in the target
                                  </option>
                                ))}
                              </select>
                              <button className="link" onClick={() => addReferenced(l.to)}>
                                or copy these {l.to} records
                              </button>
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {stale && <p className="bad">Changed how links are kept: press Check plan again before copying.</p>}
              </div>
            )}
            {plan.objects.some((o) => Object.keys(o.mask).length) && (
              <div className="form">
                <span className="muted">Unmask a field:</span>
                {plan.objects.flatMap((o) =>
                  Object.keys(o.mask).map((field) => (
                    <button
                      key={`${o.name}.${field}`}
                      className="link"
                      onClick={() =>
                        setOverrides((x) => ({ ...x, [o.name]: { ...(x[o.name] ?? {}), [field]: 'none' } }))
                      }
                    >
                      {o.name}.{field} ✕
                    </button>
                  ))
                )}
              </div>
            )}
          </>
        )}
        {result && (
          <>
            <DataTable
              columns={['name', 'rows', 'created', 'updated', 'failed', 'empty lookups']}
              rows={result.objects.map((o) => ({
                ...o,
                'empty lookups': Object.entries(o.dropped)
                  .map(([f, n]) => `${f}: ${n}`)
                  .join(', '),
              }))}
              rowKey="name"
              name="migration-result"
            />
            {result.failures.length > 0 && (
              <>
                <div className="form chips">
                  <b>{result.failures.length} failed</b>
                  <AiExplain
                    task="explain-load-failures"
                    label="Explain these failures"
                    what="the failed records' errors (object, source Id, message)"
                    getText={() => toCsv(['object', 'sourceId', 'error'], result.failures.slice(0, 300))}
                    getExtra={() => `Target org: ${target?.label ?? ''}. ${result.failures.length} failures in total.`}
                  />
                  <button
                    onClick={() =>
                      download(
                        'migration-failures.csv',
                        toCsv(FAILURE_COLUMNS, explainFailures(result.failures, 'error'))
                      )
                    }
                  >
                    Download failures
                  </button>
                </div>
                <DataTable
                  columns={FAILURE_COLUMNS}
                  rows={explainFailures(result.failures.slice(0, 500), 'error')}
                  rowKey="sourceId"
                  name="migration-failures"
                />
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
