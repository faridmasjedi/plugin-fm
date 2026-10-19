import { useEffect, useMemo, useState } from 'react';
import {
  checkCodeContent,
  codeKindOf,
  deleteFromOrg,
  deployZip,
  listCode,
  listMetadata,
  projectCodeIndex,
  projectCodePackage,
  quickDeploy,
  retrieveZip,
  type DeployOutcome,
  type ProjectInfo,
  type TestLevel,
} from '@nomadsf/core';
import { DataTable } from './DataTable';
import type { Studio } from '../context';
import { localAppBase, useProject } from '../project';

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
const LEVELS: Array<{ id: TestLevel; label: string }> = [
  { id: 'NoTestRun', label: 'No tests (sandboxes only)' },
  { id: 'RunSpecifiedTests', label: 'Specific test classes' },
  { id: 'RunLocalTests', label: 'All local tests' },
  { id: 'RunAllTestsInOrg', label: 'All tests in the org' },
];

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
 * Compare many metadata types of the project with the org, select rows, then restore them into
 * the project, download, delete from the org, or deploy them, with the test level you choose.
 */
export function ProjectCompare({
  studio,
  info,
  onOpenCode,
}: {
  studio: Studio;
  info: ProjectInfo;
  /** Opens the Code page (after project.openCodeItem). */
  onOpenCode?: () => void;
}) {
  const project = useProject();
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
  const [level, setLevel] = useState<TestLevel>('RunLocalTests');
  const [tests, setTests] = useState('');
  const [validateOnly, setValidateOnly] = useState(true);
  const [outcome, setOutcome] = useState<(DeployOutcome & { via: 'studio' | 'cli'; action: Action }) | null>(null);
  const production = studio.facts ? !studio.facts.isSandbox : false;

  useEffect(() => {
    setRows(null);
    setSelected(new Set());
  }, [info, studio.org.id]);

  const compare = async () => {
    setBusy(true);
    setOutcome(null);
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
    if (!rows || !project.source) return;
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
        const checked = await checkCodeContent(
          studio.client,
          project.source.fs,
          kind,
          items,
          projectCodeIndex(info, kind),
          (d, t) => setStatus(`Comparing ${kind} with the project… ${d}/${t}`)
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
  // Code deploys straight from the project in the browser; other types still need the CLI app
  const codeOnly = inProject.length > 0 && inProject.every((r) => codeKindOf(r.type));
  const canDeploy = codeOnly || project.localAppReady;
  const count = (where: Where): number => (rows ?? []).filter((r) => r.where === where).length;

  const restore = async () => {
    if (
      !studio.confirmChange(
        `Restore ${onlyOrg.length} component(s) from ${studio.org.label} into the project on this computer`
      )
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

  const run = async () => {
    if (!action) return;
    const items = action === 'delete' ? onlyOrg : inProject;
    const verb = validateOnly
      ? `Validate ${action === 'delete' ? 'deleting' : 'deploying'}`
      : action === 'delete'
      ? 'DELETE'
      : 'Deploy';
    if (
      !studio.confirmChange(
        `${verb} ${items.length} component(s) ${action === 'delete' ? 'from' : 'to'} ${studio.org.label} (${level})`
      )
    )
      return;
    setBusy(true);
    setOutcome(null);
    const runTests = tests.split(/[\s,]+/).filter(Boolean);
    try {
      let result: DeployOutcome;
      if (action === 'delete') {
        // Deleting needs no files: it runs from the browser in the app and the extension alike
        result = await deleteFromOrg(
          studio.client,
          items.map((r) => ({ type: r.type, fullName: r.name })),
          {
            checkOnly: validateOnly,
            testLevel: level,
            runTests,
            onProgress: (s, d, t) => setStatus(`${s} · ${d}/${t}`),
          }
        );
      } else if (codeOnly && project.source) {
        setStatus('Building the package from the project…');
        const pkg = await projectCodePackage(
          project.source.fs,
          info,
          items.map((r) => ({ type: r.type, name: r.name })),
          await studio.client.version()
        );
        result = await deployZip(studio.client, pkg.zipBase64, {
          checkOnly: validateOnly,
          testLevel: level,
          runTests,
          onProgress: (s, d, t) => setStatus(`${validateOnly ? 'Validation' : 'Deploy'} · ${s} · ${d}/${t}`),
        });
      } else {
        setStatus(`${validateOnly ? 'Validating' : 'Deploying'} with the Salesforce CLI… (this can take minutes)`);
        result = await post<DeployOutcome>(`${base}/api/org/deploy`, {
          org: await cliOrgFor(studio, base),
          members: items.map((r) => r.key),
          testLevel: level,
          tests: runTests,
          checkOnly: validateOnly,
        });
      }
      studio.logActivity(
        action === 'delete'
          ? validateOnly
            ? 'validate delete'
            : 'delete metadata'
          : validateOnly
          ? 'validate deploy'
          : 'deploy',
        {
          components: items.map((r) => r.key),
          testLevel: level,
          success: result.success,
          id: result.id,
        }
      );
      setOutcome({ ...result, via: action === 'delete' || codeOnly ? 'studio' : 'cli', action });
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const runQuickDeploy = async () => {
    if (!outcome) return;
    if (!studio.confirmChange(`Quick deploy validation ${outcome.id} to ${studio.org.label}`)) return;
    setBusy(true);
    setStatus('Quick deploy…');
    try {
      const result =
        outcome.via === 'studio'
          ? await quickDeploy(studio.client, outcome.id, { onProgress: (s) => setStatus(`Quick deploy · ${s}`) })
          : await post<DeployOutcome>(`${base}/api/org/deploy/quick`, {
              org: await cliOrgFor(studio, base),
              jobId: outcome.id,
            });
      studio.logActivity('quick deploy', { validation: outcome.id, success: result.success });
      setOutcome({ ...result, via: outcome.via, action: outcome.action });
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

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
      {status && <p className="muted">{status}</p>}

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
              Check content
            </button>
            <span className="muted">Code only for now: Apex, Visualforce, LWC and Aura.</span>
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
                {picked.length} selected · {onlyOrg.length} only in org · {inProject.length} in the project
              </span>
              <div className="form">
                {onOpenCode && picked.length === 1 && codeKindOf(picked[0].type) && (
                  <button className="primary" onClick={() => openInCode(picked[0])}>
                    Open in Code
                  </button>
                )}
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
                <button disabled={busy || !inOrg.length} onClick={() => void downloadZip()}>
                  Download zip ({inOrg.length})
                </button>
                <button
                  className="danger"
                  disabled={busy || !onlyOrg.length}
                  onClick={() => {
                    setAction('delete');
                    setOutcome(null);
                  }}
                >
                  Delete from org ({onlyOrg.length})…
                </button>
                <button
                  disabled={busy || !inProject.length || !canDeploy}
                  title={
                    codeOnly
                      ? 'Deploy the code from the project, straight from the browser'
                      : project.localAppReady
                      ? 'Deploy from the project with the Salesforce CLI'
                      : 'Code deploys from here; other metadata needs the NomadSF CLI app (sf fm dashboard)'
                  }
                  onClick={() => {
                    setAction('deploy');
                    setOutcome(null);
                  }}
                >
                  Deploy to org ({inProject.length})…
                </button>
              </div>
              {!project.localAppReady && (
                <p className="muted" style={{ margin: 0 }}>
                  Deploying code (Apex, Visualforce, LWC, Aura), Download and Delete work here; Restore, and deploying
                  other metadata, need the NomadSF CLI app on this computer.
                </p>
              )}
            </div>
          )}

          {action && (
            <div className={`card section deploy-panel ${action === 'delete' ? 'danger-zone' : ''}`}>
              <h3>
                {action === 'delete'
                  ? `Delete ${onlyOrg.length} component(s) from ${studio.org.label}`
                  : `Deploy ${inProject.length} component(s) from the project to ${studio.org.label}`}
              </h3>
              <div className="form">
                <label>
                  Tests
                  <select value={level} onChange={(e) => setLevel(e.target.value as TestLevel)}>
                    {LEVELS.map((l) => (
                      <option key={l.id} value={l.id} disabled={l.id === 'NoTestRun' && production}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
                {level === 'RunSpecifiedTests' && (
                  <label>
                    Test classes
                    <input
                      value={tests}
                      onChange={(e) => setTests(e.target.value)}
                      placeholder="AccountTest, OrderTest"
                      style={{ minWidth: 260 }}
                    />
                  </label>
                )}
                <label className="check">
                  <input type="checkbox" checked={validateOnly} onChange={(e) => setValidateOnly(e.target.checked)} />{' '}
                  Validate only (changes nothing)
                </label>
                <button className={validateOnly ? 'primary' : 'danger'} disabled={busy} onClick={() => void run()}>
                  {validateOnly ? 'Validate' : action === 'delete' ? 'Delete' : 'Deploy'}
                </button>
                <button disabled={busy} onClick={() => setAction(null)}>
                  Cancel
                </button>
              </div>
              {production && <p className="muted">Production org: tests must run; "No tests" is off.</p>}
            </div>
          )}

          {outcome && (
            <div className="card section">
              <h3>
                {outcome.success ? '✓' : '❌'}{' '}
                {outcome.checkOnly ? 'Validation' : outcome.action === 'delete' ? 'Delete' : 'Deploy'} {outcome.status}{' '}
                <span className="muted mono">{outcome.id}</span>
              </h3>
              <p className="muted" style={{ margin: 0 }}>
                {outcome.componentsDeployed}/{outcome.componentsTotal} components · {outcome.testsRun} tests run
                {outcome.errorMessage ? ` · ${outcome.errorMessage}` : ''}
              </p>
              {outcome.success && outcome.checkOnly && (
                <div className="form">
                  <button className="primary" disabled={busy} onClick={() => void runQuickDeploy()}>
                    Quick deploy this validation
                  </button>
                  <span className="muted">No second test run; possible for 10 days.</span>
                </div>
              )}
              {outcome.componentFailures.length > 0 && (
                <DataTable
                  columns={['type', 'name', 'line', 'problem']}
                  rows={outcome.componentFailures}
                  rowKey="__none"
                  name="deploy-component-failures"
                />
              )}
              {outcome.testFailures.length > 0 && (
                <DataTable
                  columns={['name', 'method', 'message']}
                  rows={outcome.testFailures}
                  rowKey="__none"
                  name="deploy-test-failures"
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
