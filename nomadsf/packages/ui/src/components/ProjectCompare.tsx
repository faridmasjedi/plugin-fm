import { useEffect, useMemo, useState } from 'react';
import {
  checkCodeContent,
  codeKindOf,
  destructiveZip,
  folderBytes,
  fromBase64,
  listCode,
  listMetadata,
  projectCodeIndex,
  projectMetadataZip,
  projectTests,
  retrieveZip,
  type ProjectFs,
  type ProjectInfo,
} from '@nomadsf/core';
import { DataTable } from './DataTable';
import { ReleasePanel } from './ReleasePanel';
import type { Studio } from '../context';
import { localAppBase, useProject } from '../project';
import { Status } from '../statusLog';

type Where = 'only in org' | 'only in project' | 'both' | 'different' | 'same';
type CompareRow = { key: string; type: string; name: string; where: Where };
type Action = 'delete' | 'deploy';

const FOLDER_BASED = new Set(['Report', 'Dashboard', 'Document', 'EmailTemplate']);
const CODE_TYPE = {
  ApexClass: 'ApexClass',
  ApexTrigger: 'ApexTrigger',
  ApexPage: 'ApexPage',
  ApexComponent: 'ApexComponent',
  LWC: 'LightningComponentBundle',
  Aura: 'AuraDefinitionBundle',
} as const;
const inBoth = (where: Where): boolean => where === 'both' || where === 'different' || where === 'same';

const post = async <T,>(url: string, body: unknown): Promise<T> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fm-dashboard': '1' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as T & { error?: string };
  if (!res.ok || json.error) throw new Error(json.error ?? res.statusText);
  return json;
};

/** The CLI alias of the Studio's org (the app's org id, or the CLI org with the same instance in the extension). */
async function cliOrgFor(studio: Studio, base: string): Promise<string> {
  if (studio.hostKind === 'app') return studio.org.id;
  const orgs = (await (await fetch(`${base}/api/orgs`)).json()) as Array<{
    alias?: string;
    username: string;
    instanceUrl?: string;
  }>;
  const host = (url?: string): string =>
    url ? new URL(url).host.replace('.lightning.force.com', '.my.salesforce.com') : '';
  const match = orgs.find((o) => host(o.instanceUrl) === host(studio.org.instanceUrl));
  if (!match) throw new Error('This org is not logged in to the Salesforce CLI on this computer (sf org login web).');
  return match.alias ?? match.username;
}

/**
 * Compare many metadata types of the project with the org, select rows, then restore them into the project, download,
 * delete them from the org, or deploy them — every type, converted in the browser — with the shared validate / deploy /
 * quick deploy panel (test levels, dependent tests).
 */
export function ProjectCompare({
  studio,
  info,
  onOpenCode,
  branch,
}: {
  studio: Studio;
  info: ProjectInfo;
  /** Opens the Code page (after project.openCodeItem). */
  onOpenCode?: () => void;
  /** A branch of the folder's history instead of the folder as it is (Compare & package › Branch ↔ Org). */
  branch?: { name: string; fs: ProjectFs; readBytes: (path: string) => Promise<Uint8Array> };
}) {
  const project = useProject();
  // Where the files come from: the branch, or the project as it is (its bytes from the folder when it is one)
  const fs = branch?.fs ?? project.source?.fs;
  const handle = project.source?.handle;
  const readBytes = branch?.readBytes ?? (handle ? (path: string) => folderBytes(handle, path) : undefined);
  const fromLabel = branch ? `the branch ${branch.name}` : `the project ${info.name}`;
  const base = localAppBase(studio.hostKind);
  const types = useMemo(() => {
    const byType = new Map<string, Set<string>>();
    for (const dir of info.packageDirectories)
      for (const t of dir.types) {
        if (!byType.has(t.type)) byType.set(t.type, new Set());
        t.names.forEach((n) => byType.get(t.type)!.add(n));
      }
    return [...byType].map(([type, names]) => ({ type, names })).sort((a, b) => a.type.localeCompare(b.type));
  }, [info]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [rows, setRows] = useState<CompareRow[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Which rows the table shows: all, or one of the three groups (the tiles above it)
  const [show, setShow] = useState<'all' | Where>('all');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [forceignore, setForceignore] = useState('.forceignore');

  useEffect(() => {
    setRows(null);
    setSelected(new Set());
  }, [info, studio.org.id]);

  const compare = async () => {
    setBusy(true);
    setAction(null);
    const out: CompareRow[] = [];
    let managed = 0;
    const list = types.filter((t) => chosen.has(t.type));
    try {
      for (const [i, t] of list.entries()) {
        setStatus(`Listing ${t.type} in ${studio.org.label}… ${i + 1}/${list.length}`);
        // eslint-disable-next-line no-await-in-loop
        const listed = (await listMetadata(studio.client, t.type, FOLDER_BASED.has(t.type))).filter(
          (c) => c.type === t.type
        );
        // Components of installed packages (or another namespace, e.g. Salesforce's own) are not yours to restore or delete
        const own = listed.filter(
          (c) =>
            (!c.manageableState || c.manageableState === 'unmanaged') &&
            (!c.namespacePrefix || c.namespacePrefix === info.namespace)
        );
        managed += listed.length - own.length;
        const inOrg = new Set(own.map((c) => c.fullName));
        for (const name of new Set([...inOrg, ...t.names])) {
          const where: Where =
            inOrg.has(name) && t.names.has(name) ? 'both' : inOrg.has(name) ? 'only in org' : 'only in project';
          out.push({ key: `${t.type}:${name}`, type: t.type, name, where });
        }
      }
      setRows(out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)));
      setShow('all');
      setSelected(new Set());
      setStatus(
        managed
          ? `${managed} component(s) of installed packages or other namespaces left out (not yours to restore or delete).`
          : ''
      );
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** Code in both places: same or different (other types need the source format converter). */
  const checkContent = async () => {
    if (!rows || !fs) return;
    setBusy(true);
    try {
      const result = new Map<string, 'same' | 'different'>();
      const kinds = [...new Set(rows.filter((r) => inBoth(r.where)).map((r) => r.type))]
        .map((t) => codeKindOf(t))
        .filter((k) => k !== undefined);
      for (const kind of kinds) {
        setStatus(`Comparing ${kind} with the project…`);
        /* eslint-disable no-await-in-loop */
        const items = await listCode(studio.client, kind);
        const checked = await checkCodeContent(studio.client, fs, kind, items, projectCodeIndex(info, kind), (d, t) =>
          setStatus(`Comparing ${kind} with the project… ${d}/${t}`)
        );
        /* eslint-enable no-await-in-loop */
        for (const [name, v] of checked) result.set(`${CODE_TYPE[kind]}:${name}`, v);
      }
      setRows(rows.map((r) => (result.has(r.key) && inBoth(r.where) ? { ...r, where: result.get(r.key)! } : r)));
      const different = [...result.values()].filter((v) => v === 'different').length;
      const notCode = rows.filter((r) => r.where === 'both' && !codeKindOf(r.type)).length;
      setStatus(
        `✓ ${result.size} code component(s) compared: ${different} different.${
          notCode ? ` ${notCode} other component(s) are not compared yet (only code for now).` : ''
        }`
      );
      if (different) setShow('different');
      setSelected(new Set());
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const openInCode = (row: CompareRow) => {
    const kind = codeKindOf(row.type);
    if (!kind || !onOpenCode) return;
    project.openCodeItem({ kind, name: row.name });
    onOpenCode();
  };

  const picked = (rows ?? []).filter((r) => selected.has(r.key));
  const onlyOrg = picked.filter((r) => r.where === 'only in org');
  const inProject = picked.filter((r) => r.where !== 'only in org');
  const inOrg = picked.filter((r) => r.where !== 'only in project');
  const count = (where: Where): number => (rows ?? []).filter((r) => r.where === where).length;

  /** A deployable zip that deletes the components only in the org: empty package.xml + destructiveChanges.xml. */
  const downloadDeletePackage = async () => {
    const zip = destructiveZip(
      onlyOrg.map((r) => ({ type: r.type, fullName: r.name })),
      await studio.client.version()
    );
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([fromBase64(zip)], { type: 'application/zip' }));
    a.download = `delete-${studio.org.label}-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    setStatus(`✓ Delete package for ${onlyOrg.length} component(s): package.xml + destructiveChanges.xml.`);
  };

  const restore = async () => {
    if (
      !(await studio.confirmChange(
        `Restore ${onlyOrg.length} component(s) from ${studio.org.label} into the project on this computer`
      ))
    )
      return;
    setBusy(true);
    setStatus('Restoring into the project…');
    try {
      const org = await cliOrgFor(studio, base);
      const result = await post<{ files: unknown[]; error?: string }>(`${base}/api/org/retrieve`, {
        org,
        members: onlyOrg.map((r) => r.key),
      });
      studio.logActivity('restore', { components: onlyOrg.length, files: result.files.length });
      setStatus(`✓ Restored ${result.files.length} file(s) into the project. Refreshing…`);
      await project.refresh();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const downloadZip = async () => {
    setBusy(true);
    try {
      const result = await retrieveZip(
        studio.client,
        inOrg.map((r) => ({ type: r.type, fullName: r.name })),
        { onProgress: (s) => setStatus(`Retrieving… ${s}`) }
      );
      if (!result.zipFile) throw new Error(result.errorMessage ?? 'The retrieve returned no zip.');
      const bytes = Uint8Array.from(atob(result.zipFile), (c) => c.charCodeAt(0));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
      a.download = `${info.name}-${studio.org.label}.zip`;
      a.click();
      setStatus(`✓ Downloaded ${inOrg.length} component(s).`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** The package for the panel: what is in the project to deploy, or what is only in the org to delete. */
  const build = async (removeWhen: 'pre' | 'post') => {
    if (!fs) throw new Error('Open the project first');
    return projectMetadataZip({
      fs,
      info,
      deploy: action === 'deploy' ? inProject.map((r) => ({ type: r.type, name: r.name })) : [],
      remove: action === 'delete' ? onlyOrg.map((r) => ({ type: r.type, name: r.name })) : [],
      removeWhen,
      apiVersion: await studio.client.version(),
      forceignore,
      readBytes,
    });
  };

  /** Every row that differs: only in one place, or different. */
  const addAllDifferences = () =>
    setSelected(new Set((rows ?? []).filter((r) => r.where !== 'same' && r.where !== 'both').map((r) => r.key)));

  return (
    <div className="card section project-compare">
      <h3>Compare with {studio.org.label}</h3>
      <div className="form">
        <span className="muted">Metadata types:</span>
        <button onClick={() => setChosen(new Set(types.map((t) => t.type)))}>All</button>
        <button onClick={() => setChosen(new Set())}>None</button>
        <button className="primary" disabled={!chosen.size || busy} onClick={() => void compare()}>
          Compare {chosen.size || ''} type{chosen.size === 1 ? '' : 's'}
        </button>
      </div>
      <div className="field-checks">
        {types.map((t) => (
          <label key={t.type} className="check">
            <input
              type="checkbox"
              checked={chosen.has(t.type)}
              onChange={(e) => {
                const next = new Set(chosen);
                if (e.target.checked) next.add(t.type);
                else next.delete(t.type);
                setChosen(next);
              }}
            />{' '}
            {t.type} <span className="muted">({t.names.size})</span>
          </label>
        ))}
      </div>
      {status && <Status text={status} block />}

      {rows && (
        <>
          <div className="metrics">
            {(
              [
                ['all', 'All', rows.length],
                ['both', 'in both, not checked', count('both')],
                ['different', 'different', count('different')],
                ['same', 'same', count('same')],
                ['only in org', 'only in org', count('only in org')],
                ['only in project', 'only in project', count('only in project')],
              ] as Array<['all' | Where, string, number]>
            )
              .filter(([id, , n]) => n > 0 || id === 'all' || id === 'both' || id.startsWith('only'))
              .map(([id, label, n]) => (
                <button
                  key={id}
                  className={`metric filter ${show === id ? 'active' : ''} ${
                    (id.startsWith('only') || id === 'different') && n ? 'bad' : ''
                  }`}
                  onClick={() => {
                    setShow(id);
                    // Nothing hidden stays selected
                    setSelected(new Set());
                  }}
                >
                  <b>{n}</b>
                  {label}
                </button>
              ))}
          </div>
          <div className="form">
            <button
              disabled={busy || !rows.some((r) => inBoth(r.where) && codeKindOf(r.type))}
              title="Compare the content of code (Apex, Visualforce, LWC, Aura) that is in both"
              onClick={() => void checkContent()}
            >
              Compare content
            </button>
            <span className="muted">Code only for now: Apex, Visualforce, LWC and Aura.</span>
            <button
              disabled={busy || !rows.some((r) => r.where !== 'same' && r.where !== 'both')}
              title="Tick every row only in the org, only in the project, or different"
              onClick={() => {
                setShow('all');
                addAllDifferences();
              }}
            >
              Add all differences
            </button>
            <label title="Files it names stay out of the package, like the CLI's deploy">
              .forceignore
              <input value={forceignore} onChange={(e) => setForceignore(e.target.value)} style={{ width: 140 }} />
            </label>
          </div>
          <DataTable
            columns={['type', 'name', 'where']}
            rows={show === 'all' ? rows : rows.filter((r) => r.where === show)}
            rowKey="key"
            name={`${info.name}-compare`}
            selected={selected}
            onSelectedChange={setSelected}
            note={<span>· tick rows to act on them</span>}
          />

          {picked.length > 0 && (
            <div className="compare-actions">
              <span className="muted">
                {picked.length} selected · {onlyOrg.length} only in org · {inProject.length} in{' '}
                {branch ? branch.name : 'the project'}
              </span>
              <div className="form">
                {onOpenCode && picked.length === 1 && codeKindOf(picked[0].type) && (
                  <button className="primary" onClick={() => openInCode(picked[0])}>
                    Open in Code
                  </button>
                )}
                {!branch && (
                  <button
                    disabled={busy || !onlyOrg.length || !project.localAppReady}
                    title={
                      project.localAppReady
                        ? 'Retrieve into the project on this computer'
                        : 'Needs the NomadSF CLI app (sf fm dashboard)'
                    }
                    onClick={() => void restore()}
                  >
                    Restore into project ({onlyOrg.length})
                  </button>
                )}
                <button disabled={busy || !inOrg.length} onClick={() => void downloadZip()}>
                  Download zip ({inOrg.length})
                </button>
                <button
                  disabled={busy || !onlyOrg.length}
                  title="A zip to deploy later that deletes these from the org: an empty package.xml and destructiveChanges.xml"
                  onClick={() => void downloadDeletePackage()}
                >
                  Download delete package ({onlyOrg.length})
                </button>
                <button
                  className="danger"
                  disabled={busy || !onlyOrg.length}
                  title="Delete these from the org: validate first, with the tests you choose"
                  onClick={() => setAction('delete')}
                >
                  Delete from org ({onlyOrg.length})…
                </button>
                <button
                  disabled={busy || !inProject.length || !fs}
                  title="Every type, converted in the browser: validate, deploy or quick deploy"
                  onClick={() => setAction('deploy')}
                >
                  Deploy to org ({inProject.length})…
                </button>
              </div>
            </div>
          )}

          {action && picked.length > 0 && (
            <div className={action === 'delete' ? 'danger-zone' : ''}>
              <ReleasePanel
                studio={studio}
                key={`${action}:${[...selected].sort().join(',')}:${forceignore}`}
                deployCount={action === 'deploy' ? inProject.length : 0}
                removeCount={action === 'delete' ? onlyOrg.length : 0}
                from={action === 'deploy' ? fromLabel : `the comparison with ${fromLabel}`}
                build={build}
                findTests={
                  action === 'deploy' && fs
                    ? () =>
                        projectTests(
                          fs,
                          info,
                          inProject.map((r) => ({ type: r.type, name: r.name }))
                        )
                    : undefined
                }
                targetId={studio.org.id}
                zipName={`${info.name}-${action}-${studio.org.label}.zip`}
              />
              <div className="form">
                <button disabled={busy} onClick={() => setAction(null)}>
                  Close
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
