import { useEffect, useMemo, useState } from 'react';
import {
  CompareEngine,
  analyzeProject,
  checkComponentsWithOrg,
  isRemoval,
  componentFilePaths,
  projectSideFiles,
  pairCodeFiles,
  refProjectFs,
  unifiedDiff,
  type OrgCheck,
  type CompareHow,
  type ProjectFs,
  type ProjectInfo,
  type ComparedPackage,
  type PackageComponent,
  type PackageFile,
  type PackageFileGroup,
} from '@nomadsf/core';
import { AiExplain } from '../components/AiHelp';
import { CodeDiff } from '../components/CodeDiff';
import type { CodeEditorProps } from '../components/CodeEditor';
import { askConfirm } from '../components/Dialogs';
import { download } from '../components/DataTable';
import { GroupedActions } from '../components/GroupedActions';
import { PackageContents, type ComponentCode } from '../components/PackageContents';
import { ProjectCodeView } from '../components/ProjectCodeView';
import { ProjectCompare } from '../components/ProjectCompare';
import { ReleasePanel } from '../components/ReleasePanel';
import { storage, useStudio } from '../context';
import { detectHost } from '../host';
import { OrgComparePage } from './OrgComparePage';
import { useProject } from '../project';
import { Status } from '../statusLog';

/**
 * Compare & package: what a branch brings into another, read like a pull request (Source into Target), as a
 * Salesforce package — the components (labels one by one, object fields as their own types, a folder component deployed
 * whole when one of its files changes), every changed file in its list, and package.xml / destructiveChanges.xml to
 * download. Read from the project folder's git history in this browser or VS Code: no CLI, nothing written to the folder
 * (only, when asked, renamed-away files into .forceignore). Moved from NomadSF Release Hub.
 */

type Change = PackageComponent['change'];
type Mode = 'branches' | 'manifest' | 'branch-org' | 'org-org';
const MODES: Array<{ id: Mode; label: string; needsFolder: boolean }> = [
  { id: 'branches', label: 'Branch ↔ Branch', needsFolder: true },
  { id: 'manifest', label: 'From a manifest', needsFolder: true },
  { id: 'branch-org', label: 'Branch ↔ Org', needsFolder: true },
  { id: 'org-org', label: 'Org ↔ Org', needsFolder: false },
];

const HOW: Array<{ id: CompareHow; label: string; hint: string }> = [
  {
    id: 'merge-base',
    label: 'Like a pull request',
    hint: 'What Source added since it branched from Target. Changes made on Target since then are left out.',
  },
  {
    id: 'direct',
    label: 'Everything that differs',
    hint: 'Target as it is now against Source: also undoes what Target has and Source does not.',
  },
];
const CHANGES: Change[] = ['added', 'changed', 'deleted', 'unchanged', 'only in target'];
const CHANGE_TONE: Record<Change, string> = {
  added: 'good',
  changed: 'warn',
  deleted: 'bad',
  unchanged: '',
  'only in target': 'bad',
};
/** The offered components (other labels) you added: what the engine sends besides the package's own. */
const included = (pkg: ComparedPackage, excluded: Set<string>): string[] =>
  pkg.optional.filter((k) => !excluded.has(k));
const STATUS_TONE: Record<PackageFile['status'], string> = { A: 'good', M: 'warn', D: 'bad' };
const FILE_GROUPS: Array<{ group: PackageFileGroup; label: string; hint: string; always?: boolean }> = [
  { group: 'deploy', label: 'Changed / added', hint: 'go into package.xml', always: true },
  { group: 'destructive', label: 'Deleted', hint: 'go into destructiveChanges.xml', always: true },
  { group: 'ignoredDeploy', label: 'Ignored by .forceignore — changed / added', hint: 'left out', always: true },
  { group: 'ignoredDestructive', label: 'Ignored by .forceignore — deleted', hint: 'left out', always: true },
  { group: 'notMetadata', label: 'Not Salesforce metadata', hint: 'left out' },
];

const keyOf = (c: { type: string; name: string }): string => `${c.type}:${c.name}`;
const languageOf = (path: string): CodeEditorProps['language'] => {
  if (/\.(cls|trigger)$/.test(path)) return 'apex';
  if (path.endsWith('.js')) return 'javascript';
  if (/\.(html|page|component|cmp|app)$/.test(path)) return 'html';
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.xml')) return 'xml';
  return 'plaintext';
};

export function PackagePage() {
  const project = useProject();
  const studio = useStudio();
  const handle = project.source?.kind === 'folder' ? project.source.handle : undefined;
  const engine = useMemo(() => (handle ? new CompareEngine(handle) : undefined), [handle]);
  const [refs, setRefs] = useState<Refs>();
  const [branch, setBranch] = useState('');
  const [error, setError] = useState('');
  // What to compare: two branches, a manifest with the files of a branch, a branch with an org, or two orgs
  const [mode, setMode] = useState<Mode>(() => {
    const kept = storage.get<string>('compare.mode', 'branches');
    return MODES.some((m) => m.id === kept) ? (kept as Mode) : 'branches';
  });
  // Every mode opened keeps its own comparison while another is shown; the others start fresh
  const [visited, setVisited] = useState<Set<Mode>>(() => new Set([mode]));
  const chooseMode = (next: Mode): void => {
    setMode(next);
    setVisited(new Set([...visited, next]));
    storage.set('compare.mode', next);
  };

  // Branches and tags of the folder
  useEffect(() => {
    setRefs(undefined);
    if (!engine) return;
    let canceled = false;
    void (async () => {
      try {
        const [all, current] = await Promise.all([engine.refs(), engine.currentBranch()]);
        if (canceled) return;
        setRefs(all);
        setBranch(current);
      } catch (e) {
        if (!canceled) setError(`❌ ${(e as Error).message}`);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [engine]);

  const hasFolder = Boolean(project.source && handle && engine);
  const modeSwitch = (
    <div className="segmented" role="group" aria-label="What to compare">
      {MODES.map((m) => (
        <button
          key={m.id}
          className={mode === m.id ? 'active' : ''}
          disabled={m.needsFolder && !hasFolder}
          title={m.needsFolder && !hasFolder ? 'Open the project folder first' : undefined}
          onClick={() => chooseMode(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="page compare-page">
      <div className="toolbar">
        <h2>Compare &amp; package</h2>
        <span className="muted">
          {hasFolder
            ? `${project.source!.name}${
                branch ? ` · on ${branch}` : ''
              } · read from git, nothing is written to the folder`
            : 'what a branch brings into another, as package.xml and destructiveChanges.xml'}
        </span>
      </div>
      <div className="card section">
        <h3>1 · Compare</h3>
        {modeSwitch}
        {error && <Status text={error} block />}
      </div>
      {!hasFolder && mode !== 'org-org' && (
        <div className="card section">
          <p>
            This reads the project's git history: open the project <b>folder</b> (the repository with
            sfdx-project.json).
            {project.source?.kind === 'github' &&
              ' A GitHub project is read without its history, so it cannot be compared here yet.'}
          </p>
          {project.needsPermission ? (
            <button className="primary" onClick={() => void project.reconnectFolder()}>
              Allow reading the folder again
            </button>
          ) : (
            project.canPickFolder && (
              <button className="primary" onClick={() => void project.pickFolder()}>
                Open the project folder…
              </button>
            )
          )}
        </div>
      )}
      {[...visited]
        .filter((m) => m === 'org-org' || hasFolder)
        .map((m) => (
          <div key={`${m}:${handle?.name ?? ''}`} className="compare-mode" hidden={m !== mode}>
            {m === 'org-org' ? (
              <div className="card section">
                <OrgComparePage orgs={studio.orgs} embedded />
              </div>
            ) : (
              <ModePanel mode={m} engine={engine!} refs={refs} branch={branch} />
            )}
          </div>
        ))}
    </div>
  );
}

type Refs = { branches: string[]; remoteBranches: string[]; tags: string[] };

/** One mode of Compare & package with its own comparison (Branch ↔ Branch, manifest, Branch ↔ Org). */
function ModePanel({
  mode,
  engine,
  refs,
  branch,
}: {
  mode: Exclude<Mode, 'org-org'>;
  engine: CompareEngine;
  refs?: Refs;
  branch: string;
}) {
  const studio = useStudio();
  const [sourceRef, setSourceRef] = useState('');
  const [targetRef, setTargetRef] = useState('');
  const [how, setHow] = useState<CompareHow>(() =>
    storage.get<string>('compare.how', 'merge-base') === 'direct' ? 'direct' : 'merge-base'
  );
  const [forceignore, setForceignore] = useState('');
  // Branch ↔ Org: the branch read as a project
  const [branchProject, setBranchProject] = useState<{
    name: string;
    fs: ProjectFs;
    readBytes: (path: string) => Promise<Uint8Array>;
    info: ProjectInfo;
  }>();
  const [manifest, setManifest] = useState<{ name: string; xml: string }>();
  const [destructive, setDestructive] = useState<{ name: string; xml: string }>();
  const [pkg, setPkg] = useState<ComparedPackage>();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [kept, setKept] = useState<Set<string>>(new Set()); // renamed-away components added to .forceignore
  const [changes, setChanges] = useState<Set<Change>>(new Set());
  const [filter, setFilter] = useState('');
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const [diff, setDiff] = useState<{ path: string; before: string; after: string }>();
  // From a manifest: each component checked against an org ('' = not checked), and the one opened
  const [checkOrgId, setCheckOrgId] = useState(studio.org.id);
  const [checks, setChecks] = useState<{ org: string; ref: string; byKey: Map<string, OrgCheck> }>();
  const [openCheck, setOpenCheck] = useState<string>();
  const [checkPath, setCheckPath] = useState('');

  // Source = the branch checked out, Target = where branches usually go
  useEffect(() => {
    if (!refs) return;
    setSourceRef((v) => v || branch || refs.branches[0] || '');
    setTargetRef(
      (v) => v || (['develop', 'main', 'master'].find((b) => b !== branch && refs.branches.includes(b)) ?? '')
    );
  }, [refs, branch]);

  const compare = async (): Promise<void> => {
    if (!sourceRef || !targetRef) {
      setStatus('⚠ Choose Source and Target.');
      return;
    }
    setBusy(true);
    setStatus('Reading the git history of both sides…');
    setDiff(undefined);
    try {
      const result = await engine.compare({ source: sourceRef, target: targetRef, how, forceignore });
      setPkg(result);
      setExcluded(new Set(result.optional));
      setKept(new Set());
      setChanges(new Set());
      setFilter('');
      setOpenFiles(new Set());
      setStatus(`✓ ${result.components.length} component(s) between ${result.target} and ${result.source}.`);
    } catch (e) {
      setPkg(undefined);
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const fromManifest = async (): Promise<void> => {
    if (!manifest) {
      setStatus('⚠ Choose the package.xml.');
      return;
    }
    if (!sourceRef) {
      setStatus('⚠ Choose the branch the files come from.');
      return;
    }
    setBusy(true);
    setStatus('Reading the manifest and the branch…');
    setDiff(undefined);
    try {
      const result = await engine.fromManifest({
        ref: sourceRef,
        packageXml: manifest.xml,
        destructiveXml: destructive?.xml,
        forceignore,
      });
      setPkg(result);
      setExcluded(new Set(result.optional));
      setKept(new Set());
      setChanges(new Set());
      setFilter('');
      setChecks(undefined);
      setOpenCheck(undefined);
      const missing = result.components.filter((c) => c.note).length;
      const done = `✓ ${result.components.length} component(s) from ${manifest.name}${
        missing ? `; ${missing} not in ${sourceRef} (named in the list)` : ''
      }.`;
      setStatus(done);
      // Every component against the org chosen: the branch's version and the org's, file by file
      const target = studio.orgs.find((o) => o.id === checkOrgId);
      if (target) {
        const client = await detectHost().client(target);
        const { fs, readBytes } = await refProjectFs(engine.repo, sourceRef);
        const info = await analyzeProject(fs);
        const byKey = await checkComponentsWithOrg(
          client,
          { fs, info, readBytes },
          result.components.map((c) => ({ type: c.type, name: c.name })),
          (s2) => setStatus(`${done} ${s2}`)
        );
        setChecks({ org: target.label, ref: sourceRef, byKey });
        const differ = [...byKey.values()].filter((c) => c.status === 'different').length;
        const onlyOrg = [...byKey.values()].filter((c) => c.status === 'only in org').length;
        setStatus(
          `${done} Against ${target.label}: ${differ} different${
            onlyOrg ? `, ${onlyOrg} only in the org` : ''
          }. Click a name to see it.`
        );
      }
    } catch (e) {
      setPkg(undefined);
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const readBranch = async (): Promise<void> => {
    if (!sourceRef) {
      setStatus('⚠ Choose the branch.');
      return;
    }
    setBusy(true);
    setStatus(`Reading ${sourceRef} from git…`);
    try {
      const { fs, readBytes } = await refProjectFs(engine.repo, sourceRef);
      const info = await analyzeProject(fs);
      setBranchProject({ name: sourceRef, fs, readBytes, info });
      const total = info.packageDirectories.reduce((n, d) => n + d.total, 0);
      setStatus(`✓ ${total} component(s) in ${sourceRef}: choose types below and compare with ${studio.org.label}.`);
    } catch (e) {
      setBranchProject(undefined);
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const readFile =
    (set: (f: { name: string; xml: string } | undefined) => void) =>
    async (e: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = e.target.files?.[0];
      set(file ? { name: file.name, xml: await file.text() } : undefined);
    };

  const refSelect = (value: string, set: (v: string) => void, label: string) => (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(e) => set(e.target.value)}>
        <option value="">Choose…</option>
        {refs &&
          (
            [
              ['Branches', refs.branches],
              ['Remote branches', refs.remoteBranches],
              ['Tags', refs.tags],
            ] as Array<[string, string[]]>
          )
            .filter(([, list]) => list.length)
            .map(([group, list]) => (
              <optgroup key={group} label={group}>
                {list.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </optgroup>
            ))}
      </select>
    </label>
  );

  return (
    <>
      <div className="card section">
        {mode === 'branch-org' ? (
          <div className="compare-go">
            {refSelect(sourceRef, setSourceRef, 'Branch')}
            <span className="muted compare-hint">
              compared with <b>{studio.org.label}</b> (the org at the top) — every type, then validate, deploy or quick
              deploy what differs
            </span>
            <button className="primary" disabled={busy || !refs} onClick={() => void readBranch()}>
              {busy ? 'Reading…' : 'Read the branch'}
            </button>
          </div>
        ) : mode === 'manifest' ? (
          <div className="compare-manifest">
            <label>
              <span>package.xml</span>
              <input type="file" accept=".xml" onChange={(e) => void readFile(setManifest)(e)} />
            </label>
            <label>
              <span>
                destructiveChanges.xml <i>optional</i>
              </span>
              <input type="file" accept=".xml" onChange={(e) => void readFile(setDestructive)(e)} />
            </label>
            {refSelect(sourceRef, setSourceRef, 'The files come from')}
            <label>
              <span>Check against</span>
              <select value={checkOrgId} onChange={(e) => setCheckOrgId(e.target.value)}>
                <option value="">Don't check an org</option>
                {studio.orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <>
            <div className="compare-refs">
              {refSelect(sourceRef, setSourceRef, 'Source — the branch with the changes')}
              <button
                className="swap"
                title="Swap Source and Target"
                aria-label="Swap Source and Target"
                onClick={() => {
                  setSourceRef(targetRef);
                  setTargetRef(sourceRef);
                }}
              >
                ⇄
              </button>
              {refSelect(targetRef, setTargetRef, 'Target — where they go')}
            </div>
            <fieldset className="compare-how">
              <legend>How</legend>
              {HOW.map((h) => (
                <label key={h.id} className="check" title={h.hint}>
                  <input
                    type="radio"
                    name="compare-how"
                    checked={how === h.id}
                    onChange={() => {
                      setHow(h.id);
                      storage.set('compare.how', h.id);
                    }}
                  />
                  <span>
                    {h.label} <span className="muted">— {h.hint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </>
        )}
        {mode !== 'branch-org' && (
          <div className="compare-go">
            <label>
              <span>.forceignore</span>
              <input value={forceignore} placeholder=".forceignore" onChange={(e) => setForceignore(e.target.value)} />
            </label>
            <span className="grow" />
            <button
              className="primary"
              disabled={busy || !refs}
              onClick={() => void (mode === 'manifest' ? fromManifest() : compare())}
            >
              {busy ? 'Reading…' : mode === 'manifest' ? 'Read the manifest' : 'Compare'}
            </button>
          </div>
        )}
        {status && <Status text={status} block />}
      </div>

      {mode === 'branch-org' && branchProject && (
        <ProjectCompare key={branchProject.name} studio={studio} info={branchProject.info} branch={branchProject} />
      )}

      {pkg && (mode === 'branches' || mode === 'manifest') && (
        <PackageCard
          pkg={pkg}
          engine={engine}
          excluded={excluded}
          setExcluded={setExcluded}
          kept={kept}
          setKept={setKept}
          changes={changes}
          setChanges={setChanges}
          filter={filter}
          setFilter={setFilter}
          openFiles={openFiles}
          setOpenFiles={setOpenFiles}
          diffView={
            diff && (
              <div className="compare-diff package-code">
                <div className="form">
                  <h3 className="grow">{diff.path}</h3>
                  <button onClick={() => setDiff(undefined)}>Close</button>
                </div>
                <div className="chips ai-tools">
                  <AiExplain
                    key={diff.path}
                    task="explain-diff"
                    label="Explain the difference"
                    what="the difference of this file (a diff between the two branches)"
                    getText={() => unifiedDiff(diff.before, diff.after, [pkg.target, pkg.source])}
                    getExtra={() => `File: ${diff.path}`}
                  />
                </div>
                <div className="compare-diff-editor">
                  <CodeDiff
                    original={diff.before}
                    modified={diff.after}
                    language={languageOf(diff.path)}
                    labels={[`${pkg.target} (Target)`, `${pkg.source} (Source)`]}
                  />
                </div>
              </div>
            )
          }
          showDiff={async (path) => {
            try {
              setDiff({ path, ...(await engine.texts(pkg.id, path)) });
            } catch (e) {
              setStatus(`❌ ${(e as Error).message}`);
            }
          }}
          checks={checks && { org: checks.org, byKey: checks.byKey }}
          loadCode={async (c) => {
            const key = `${c.type}:${c.name}`;
            const checked = checks?.byKey.get(key);
            if (checked)
              return {
                before: checked.org.length ? checked.org : undefined,
                after: checked.repo.length ? checked.repo : undefined,
                labels: [checks!.org, checks!.ref],
              };
            const ref = pkg.source;
            const { fs, readBytes } = await refProjectFs(engine.repo, ref);
            const files = (
              await projectSideFiles({ fs, info: await analyzeProject(fs), readBytes }, [c], pkg.apiVersion)
            ).get(key);
            return { after: files ?? [], labels: ['', ref] };
          }}
          openCheck={openCheck}
          onOpenCheck={(key) => {
            setOpenCheck(key === openCheck ? undefined : key);
            setCheckPath('');
          }}
        />
      )}

      {pkg && checks && openCheck && checks.byKey.get(openCheck) && (
        <div className="card section compare-diff">
          <div className="form">
            <h3 className="grow">
              {openCheck.replace(':', ' ')}
              <span className="muted">
                {'\u00a0·\u00a0'}
                {checks.ref} ↔ {checks.org} · {checks.byKey.get(openCheck)!.status}
              </span>
            </h3>
            <button onClick={() => setOpenCheck(undefined)}>Close</button>
          </div>
          <ProjectCodeView
            key={openCheck}
            pairs={pairCodeFiles(checks.byKey.get(openCheck)!.org, checks.byKey.get(openCheck)!.repo)}
            view="compare"
            labels={[checks.org, checks.ref]}
            path={checkPath}
            onPath={setCheckPath}
          />
        </div>
      )}

      {pkg && pkg.components.length > 0 && (mode === 'branches' || mode === 'manifest') && (
        <ReleasePanel
          from={pkg.source}
          deployCount={pkg.components.filter((c) => !isRemoval(c.change) && !excluded.has(keyOf(c))).length}
          removeCount={pkg.components.filter((c) => isRemoval(c.change) && !excluded.has(keyOf(c))).length}
          build={async (removeWhen) => {
            const built = await engine.metadataZip(pkg.id, {
              exclude: [...excluded],
              include: included(pkg, excluded),
              removeWhen,
            });
            return { zip: built.zip, notConverted: built.notConverted };
          }}
          findTests={() => engine.findTests(pkg.id, [...excluded], included(pkg, excluded))}
          zipName={`${pkg.source.replace(/[^\w.-]+/g, '-')}-deployable.zip`}
        />
      )}
    </>
  );
}

/** What the org has of a component of the manifest (for a deletion: whether there is anything to delete). */
function orgPill(change: Change, status: OrgCheck['status'] | undefined): React.ReactNode {
  if (!status) return <span className="muted">—</span>;
  if (isRemoval(change))
    return status === 'only in org' || status === 'same' || status === 'different' ? (
      <span className="pill">in the org</span>
    ) : (
      <span className="pill warn">not in the org</span>
    );
  const tone: Record<OrgCheck['status'], string> = {
    same: 'good',
    different: 'warn',
    'not in org': '',
    'only in org': 'warn',
    'in neither': 'bad',
  };
  const label: Record<OrgCheck['status'], string> = {
    same: 'same',
    different: 'different',
    'not in org': 'new to the org',
    'only in org': 'only in the org',
    'in neither': 'in neither',
  };
  return <span className={`pill ${tone[status]}`}>{label[status]}</span>;
}

function PackageCard(props: {
  pkg: ComparedPackage;
  engine: CompareEngine;
  excluded: Set<string>;
  setExcluded: (s: Set<string>) => void;
  kept: Set<string>;
  setKept: (s: Set<string>) => void;
  changes: Set<Change>;
  setChanges: (s: Set<Change>) => void;
  filter: string;
  setFilter: (s: string) => void;
  openFiles: Set<string>;
  setOpenFiles: (s: Set<string>) => void;
  showDiff: (path: string) => Promise<void>;
  /** The file opened from the list, shown under it. */
  diffView?: React.ReactNode;
  /** From a manifest: each component against an org, and the one opened (its diff below the card). */
  checks?: { org: string; byKey: Map<string, OrgCheck> };
  openCheck?: string;
  onOpenCheck?: (key: string) => void;
  /** From a manifest: a component's code (the branch's, and the org's when checked). */
  loadCode?: (c: { type: string; name: string }) => Promise<ComponentCode>;
}) {
  const { pkg, engine, excluded, setExcluded, kept, setKept, changes, setChanges, filter, setFilter } = props;
  const [status, setStatus] = useState('');
  const components = pkg.components;
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = components.filter(
    (c) =>
      (!changes.size || changes.has(c.change)) &&
      words.every((w) => `${c.type} ${c.name} ${c.change}`.toLowerCase().includes(w))
  );
  const count = (change: Change): number => components.filter((c) => c.change === change).length;
  const changeOf = new Map(components.map((c) => [keyOf(c), c.change]));
  const kept2 = components.filter((c) => !excluded.has(keyOf(c)));
  const deploy = kept2.filter((c) => !isRemoval(c.change));
  const remove = kept2.filter((c) => isRemoval(c.change));
  const toggle = (key: string, on: boolean): void => {
    const next = new Set(excluded);
    if (on) next.delete(key);
    else next.add(key);
    setExcluded(next);
  };
  const summary = (list: PackageComponent[]): string => {
    const byType = new Map<string, number>();
    for (const c of list) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
    return [...byType]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([type, n]) => `${n} ${type}`)
      .join(', ');
  };
  const renameNote = (c: PackageComponent): string | undefined => {
    for (const r of pkg.renames) {
      if (keyOf(r.from) === keyOf(c)) return `renamed → ${r.to.name}`;
      if (keyOf(r.to) === keyOf(c)) return `renamed from ${r.from.name}`;
    }
    return undefined;
  };

  const save = async (files: boolean): Promise<void> => {
    try {
      const { bytes, name } = await engine.download(pkg.id, {
        files,
        exclude: [...excluded],
        include: included(pkg, excluded),
      });
      download(name, bytes, 'application/zip');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const keepForGood = async (r: ComparedPackage['renames'][number]): Promise<void> => {
    const ok = await askConfirm(
      `Keep ${r.from.name} for good? These lines go into ${
        pkg.forceignore
      } in your project, so later packages leave them out too (commit the change yourself):\n\n${r.from.files.join(
        '\n'
      )}`,
      { ok: `Add to ${pkg.forceignore}` }
    );
    if (!ok) return;
    try {
      const added = await engine.ignoreRenamed(pkg.id, r.from.files);
      setExcluded(new Set([...excluded, keyOf(r.from)]));
      setKept(new Set([...kept, keyOf(r.from)]));
      setStatus(
        added.length ? `✓ Added to ${pkg.forceignore}: ${added.length} line(s).` : `✓ Already in ${pkg.forceignore}.`
      );
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div className="card section">
      <div className="form">
        <h3 className="grow">2 · Package</h3>
        <span className="muted">
          {pkg.target === 'manifest'
            ? `from a manifest · files of ${pkg.source} (${pkg.refB.slice(0, 7)})`
            : `${pkg.source} → into ${pkg.target} · ${pkg.refA.slice(0, 7)}..${pkg.refB.slice(0, 7)}`}
        </span>
      </div>
      {!components.length ? (
        <p className="muted">No metadata to deploy or delete between them.</p>
      ) : (
        <>
          <div className="form">
            <span className="muted">In the manifest:</span>
            <span className="pill good">{deploy.length} to deploy</span>
            {remove.length > 0 && <span className="pill bad">{remove.length} to delete</span>}
            {excluded.size > 0 && <span className="pill">{components.length - kept2.length} left out</span>}
          </div>
          <div className="form">
            <span className="muted">Show:</span>
            <div className="segmented" role="group" aria-label="Show">
              <button className={!changes.size ? 'active' : ''} onClick={() => setChanges(new Set())}>
                All {components.length}
              </button>
              {CHANGES.filter((c) => count(c)).map((change) => (
                <button
                  key={change}
                  className={changes.has(change) ? 'active' : ''}
                  onClick={() => {
                    const next = new Set(changes);
                    if (next.has(change)) next.delete(change);
                    else next.add(change);
                    // every change chosen is the same as all
                    setChanges(CHANGES.every((c) => !count(c) || next.has(c)) ? new Set() : next);
                  }}
                >
                  {change[0].toUpperCase() + change.slice(1)} {count(change)}
                </button>
              ))}
            </div>
            <input
              className="grow"
              type="search"
              placeholder="Filter: type, name, added…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>

          {pkg.renames.length > 0 && (
            <div className="compare-renames">
              <p>
                <b>Renamed ({pkg.renames.length})</b>{' '}
                <span className="muted">
                  — the new one is deployed; the old one is deleted from the org unless you keep it.
                </span>
              </p>
              {pkg.renames.map((r) => {
                const key = keyOf(r.from);
                const now = kept.has(key) ? 'ignore' : excluded.has(key) ? 'keep' : 'delete';
                return (
                  <div key={key} className="compare-rename">
                    <span>
                      <span className="muted">{r.from.type}</span> <b>{r.from.name}</b> → <b>{r.to.name}</b>
                    </span>
                    <div className="segmented" role="group" aria-label={`Old ${r.from.name}`}>
                      <button className={now === 'delete' ? 'active' : ''} onClick={() => toggle(key, true)}>
                        Delete old
                      </button>
                      <button
                        className={now === 'keep' ? 'active' : ''}
                        title="Leave it out of this package only"
                        onClick={() => toggle(key, false)}
                      >
                        Keep old
                      </button>
                      <button
                        className={now === 'ignore' ? 'active' : ''}
                        disabled={now === 'ignore'}
                        title="Leave it out, and add its files to .forceignore so later packages leave it alone too"
                        onClick={() => void keepForGood(r)}
                      >
                        {now === 'ignore' ? 'In .forceignore ✓' : 'Keep + add to .forceignore'}
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <GroupedActions
            rows={shown.map((c) => ({ ...c, key: keyOf(c), status: c.change }))}
            actions={
              new Map(
                components
                  .filter((c) => !excluded.has(keyOf(c)))
                  .map((c) => [keyOf(c), isRemoval(c.change) ? ('delete' as const) : ('deploy' as const)])
              )
            }
            onActions={(next) => {
              const out = new Set(excluded);
              for (const c of shown) {
                if (next.has(keyOf(c))) out.delete(keyOf(c));
                else out.add(keyOf(c));
              }
              setExcluded(out);
            }}
            // What changed decides it: a deleted component can only be deleted, the others only deployed
            allowed={(c, a) => (a === 'delete') === isRemoval(c.change)}
            tone={(st) => CHANGE_TONE[st as Change] ?? ''}
            hideFilter
            renderName={(c) => {
              const key = keyOf(c);
              const note = renameNote(c);
              return (
                <>
                  {props.checks?.byKey.has(key) ? (
                    <button
                      className={`link ${props.openCheck === key ? 'active' : ''}`}
                      title="The branch's version and the org's, side by side"
                      onClick={() => props.onOpenCheck?.(key)}
                    >
                      {c.name}
                    </button>
                  ) : (
                    c.name
                  )}
                  {note && <div className="muted small">{note}</div>}
                  {c.note && <div className="warn-text small">⚠ {c.note}</div>}
                </>
              );
            }}
            extra={props.checks ? (c) => orgPill(c.change, props.checks!.byKey.get(keyOf(c))?.status) : undefined}
          />

          {pkg.target === 'manifest' ? (
            <PackageContents
              deploy={deploy}
              remove={remove}
              loadCode={props.loadCode}
              statusOf={(c) => {
                const st = props.checks?.byKey.get(keyOf(c))?.status;
                return st === 'not in org' ? 'A' : st === 'same' || st === 'different' ? 'M' : '•';
              }}
              listFiles={async (list) => {
                const { fs } = await refProjectFs(engine.repo, pkg.source);
                return componentFilePaths(fs, await analyzeProject(fs), list);
              }}
            />
          ) : (
            <div className="compare-summary">
              <p>
                <b>package.xml</b> {summary(deploy) || '—'}
              </p>
              {remove.length > 0 && (
                <p>
                  <b>destructiveChanges.xml</b> {summary(remove)}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {pkg.target !== 'manifest' && (
        <FileGroups
          {...props}
          // "Show: Deleted" (or Added, Changed) shows only the files of those components
          only={
            changes.size ? (f) => f.components.some((k) => changes.has(changeOf.get(k) ?? ('' as Change))) : undefined
          }
        />
      )}
      {props.diffView}

      <div className="form">
        <button className="primary" disabled={!deploy.length && !remove.length} onClick={() => void save(false)}>
          ⤓ Manifest (.zip)
        </button>
        <button disabled={!deploy.length} onClick={() => void save(true)}>
          ⤓ With the changed files (.zip)
        </button>
        <span className="muted">package.xml and destructiveChanges.xml in manifest/</span>
      </div>
      {status && <Status text={status} block />}
    </div>
  );
}

/** Every changed file in its list: what goes into each manifest, what .forceignore keeps out, what is not metadata. */
function FileGroups({
  pkg,
  excluded,
  openFiles,
  setOpenFiles,
  showDiff,
  only,
}: {
  pkg: ComparedPackage;
  /** The files to list (the components shown); all when undefined. */
  only?: (f: PackageFile) => boolean;
  excluded: Set<string>;
  openFiles: Set<string>;
  setOpenFiles: (s: Set<string>) => void;
  showDiff: (path: string) => Promise<void>;
}) {
  const open = (group: string): boolean =>
    openFiles.has(`closed:${group}`) ? false : openFiles.has(group) || group === 'deploy' || group === 'destructive';
  return (
    <div className="compare-files">
      <h4>Files</h4>
      {FILE_GROUPS.map(({ group, label, hint, always }) => {
        const list = pkg.files.filter((f) => f.group === group && (!only || only(f)));
        if (!list.length && !always) return null;
        return (
          <details
            key={group}
            className="compare-file-group"
            open={open(group)}
            onToggle={(e) => {
              const next = new Set(openFiles);
              next.delete(group);
              next.delete(`closed:${group}`);
              next.add((e.target as HTMLDetailsElement).open ? group : `closed:${group}`);
              setOpenFiles(next);
            }}
          >
            <summary>
              <b>{label}</b>{' '}
              <span
                className={`pill ${
                  list.length ? (group === 'destructive' ? 'bad' : group === 'deploy' ? 'good' : '') : ''
                }`}
              >
                {list.length}
              </span>{' '}
              <span className="muted">— {hint}</span>
            </summary>
            {list.length ? (
              <div className="compare-file-rows">
                {list.map((f) => {
                  const out = f.components.length > 0 && f.components.every((k) => excluded.has(k));
                  return (
                    <div key={`${f.group}:${f.path}`} className={`compare-file-row${out ? ' off' : ''}`}>
                      <span
                        className={`pill ${STATUS_TONE[f.status]}`}
                        title={{ A: 'added', M: 'changed', D: 'deleted' }[f.status]}
                      >
                        {f.status}
                      </span>
                      <button className="link mono" title="Show the diff" onClick={() => void showDiff(f.path)}>
                        {f.path}
                      </button>
                      {f.labels ? (
                        <span className="compare-labels">
                          {(
                            [
                              ['added', f.labels.added, 'good'],
                              ['changed', f.labels.changed, 'warn'],
                              ['removed', f.labels.removed, 'bad'],
                            ] as Array<[string, string[] | undefined, string]>
                          )
                            .filter(([, names]) => names?.length)
                            .map(([what, names, tone]) => (
                              <span key={what} className="compare-label-group">
                                <span className="muted small">{what}:</span>
                                {names?.map((n) => (
                                  <span
                                    key={n}
                                    className={`pill ${tone}${excluded.has(`CustomLabel:${n}`) ? ' struck' : ''}`}
                                  >
                                    {n}
                                  </span>
                                ))}
                              </span>
                            ))}
                        </span>
                      ) : (
                        <span className="muted small">
                          {[
                            f.components.length === 1 ? f.components[0].replace(':', ' ') : '',
                            f.note,
                            out ? 'left out' : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted small">None.</p>
            )}
          </details>
        );
      })}
    </div>
  );
}
