import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import {
  CODE_LAYOUT,
  checkCodeContent,
  createApexClass,
  createCode,
  deployZip,
  extractCode,
  isBundle,
  listCode,
  openCode,
  pairCodeFiles,
  pairsSame,
  projectCodeIndex,
  projectCodePackage,
  readProjectCode,
  saveApex,
  saveBundleFile,
  type CodeFile,
  type CodeItem,
  type CodeKind,
  type CompileProblem,
} from '@nomadsf/core';
import { AiAsk, AiExplain } from '../components/AiHelp';
import { CodeEditor } from '../components/CodeEditor';
import { ProjectCodeView, shownPair } from '../components/ProjectCodeView';
import { storage, useStudio } from '../context';
import { monaco } from '../monaco';
import { useProject } from '../project';
import { askConfirm, askText } from '../components/Dialogs';
import { MetadataSource } from '../components/MetadataSource';
import { Dependencies } from '../components/Dependencies';
import { Status } from '../statusLog';

const KINDS: Array<{ id: CodeKind; label: string; one: string }> = [
  { id: 'ApexClass', label: 'Classes', one: 'Apex class' },
  { id: 'ApexTrigger', label: 'Triggers', one: 'Apex trigger' },
  { id: 'ApexPage', label: 'VF pages', one: 'Visualforce page' },
  { id: 'ApexComponent', label: 'VF components', one: 'Visualforce component' },
  { id: 'LWC', label: 'LWC', one: 'Lightning web component' },
  { id: 'Aura', label: 'Aura', one: 'Aura component' },
];
const kindInfo = (id: CodeKind): (typeof KINDS)[number] => KINDS.find((k) => k.id === id) ?? KINDS[0];

/** Where a component is, once a project is open: both (same / different when checked), or one side only. */
type CodeStatus = 'same' | 'different' | 'in both' | 'only in org' | 'only in project';
type Show = 'all' | CodeStatus;
type View = 'org' | 'project' | 'compare';
const SHOW: Array<{ id: Show; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'different', label: 'Different' },
  { id: 'same', label: 'Same' },
  { id: 'in both', label: 'Not checked' },
  { id: 'only in org', label: 'Only in org' },
  { id: 'only in project', label: 'Only in project' },
];
const TAG: Record<CodeStatus, string> = {
  same: '=',
  different: '≠',
  'in both': '',
  'only in org': 'org',
  'only in project': 'project',
};
const projectOnlyId = (name: string): string => `project:${name}`;

/** Developer Console's editor: open, compile and save Apex, Visualforce, LWC and Aura source. */
function ApexCodePage({ onOther }: { onOther: () => void }) {
  const studio = useStudio();
  const { client, facts } = studio;
  const [kind, setKind] = useState<CodeKind>(() => storage.get('code.kind', 'ApexClass'));
  const [items, setItems] = useState<CodeItem[] | null>(null);
  const [filter, setFilter] = useState('');
  const [item, setItem] = useState<CodeItem | null>(null);
  // What the open component uses and what uses it
  const [showDeps, setShowDeps] = useState(false);
  const [files, setFiles] = useState<CodeFile[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<CompileProblem[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const editor = useRef<Parameters<OnMount>[0] | null>(null);
  // The project (folder, GitHub branch or the local app's) next to the org
  const project = useProject();
  const source = project.source;
  const index = useMemo(() => projectCodeIndex(project.info, kind), [project.info, kind]);
  const projectOpen = Boolean(project.info && source);
  const [checked, setChecked] = useState<Record<string, 'same' | 'different'>>({});
  const [show, setShow] = useState<Show>('all');
  const [projectFiles, setProjectFiles] = useState<CodeFile[] | null>(null);
  const [view, setView] = useState<View>('org');
  const [pairPath, setPairPath] = useState('');
  const projectLabel = source
    ? source.kind === 'github'
      ? `${source.repo ?? source.name} @ ${source.ref ?? ''}`
      : source.name
    : '';
  // Salesforce blocks Apex changes in production; Developer Edition orgs allow them
  const apexLocked = facts ? !facts.isSandbox && !/developer/i.test(facts.organizationType) : false;

  const load = useCallback(async () => {
    setItems(null);
    storage.set('code.kind', kind);
    try {
      setItems(await listCode(client, kind));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  }, [client, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  // Content checks belong to one kind, project and org
  useEffect(() => {
    setChecked({});
    setShow('all');
  }, [kind, project.info, client]);

  const dirty = files.filter((f) => drafts[f.id] !== undefined && drafts[f.id] !== f.source);

  const switchKind = async (next: CodeKind) => {
    if (next === kind || (dirty.length && !(await askConfirm('Discard unsaved changes?', { ok: 'Discard' })))) return;
    setKind(next);
    setItem(null);
    setFiles([]);
    setDrafts({});
    setProblems([]);
    setStatus('');
    setProjectFiles(null);
    setView('org');
  };

  /** Opens a component from the org, its project version too when the project has it. */
  const openItem = async (next: CodeItem, prefer?: View) => {
    if (dirty.length && !(await askConfirm('Discard unsaved changes?', { ok: 'Discard' }))) return;
    setStatus(`Opening ${next.name}…`);
    try {
      const inOrg = next.id !== projectOnlyId(next.name);
      const folders = index.get(next.name);
      const [orgFiles, fromProject] = await Promise.all([
        inOrg ? openCode(client, next) : Promise.resolve<CodeFile[]>([]),
        folders && source ? readProjectCode(source.fs, next.kind, next.name, folders) : Promise.resolve<CodeFile[]>([]),
      ]);
      const projectVersion = fromProject.length ? fromProject : null;
      setFiles(orgFiles);
      setItem(next);
      setFileIndex(0);
      setDrafts({});
      setProblems([]);
      setStatus('');
      setProjectFiles(projectVersion);
      setPairPath('');
      if (inOrg && projectVersion) {
        const same = pairsSame(pairCodeFiles(orgFiles, projectVersion));
        setChecked((c) => ({ ...c, [next.name]: same ? 'same' : 'different' }));
      }
      setView((current) => (!inOrg ? 'project' : !projectVersion ? 'org' : prefer ?? current));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  /** Same or different for every component in both the org and the project. */
  const checkContent = async () => {
    if (!source || !items) return;
    setBusy(true);
    try {
      const result = await checkCodeContent(client, source.fs, kind, items, index, (done, total) =>
        setStatus(`Comparing with the project… ${done}/${total}`)
      );
      setChecked(Object.fromEntries(result));
      const different = [...result.values()].filter((v) => v === 'different').length;
      setStatus(`✓ ${result.size} compared: ${different} different, ${result.size - different} the same.`);
      if (different) setShow('different');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // Compile problems as squiggles in the editor
  useEffect(() => {
    const model = editor.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'nomadsf',
      problems
        .filter((p) => p.line)
        .map((p) => ({
          severity: monaco.MarkerSeverity.Error,
          message: p.problem,
          startLineNumber: p.line!,
          startColumn: p.column ?? 1,
          endLineNumber: p.line!,
          endColumn: (p.column ?? 1) + 200,
        }))
    );
  }, [problems, fileIndex, files]);

  const compile = async (checkOnly: boolean) => {
    if (!item) return;
    const file = files[0];
    const body = drafts[file.id] ?? file.source;
    if (!checkOnly && !(await studio.confirmChange(`Save ${item.name} to ${studio.org.label}`))) return;
    setBusy(true);
    setStatus(checkOnly ? 'Compiling…' : 'Saving…');
    try {
      const result = await saveApex(client, item, body, {
        checkOnly,
        onWait: (seconds) => setStatus(`${checkOnly ? 'Compiling' : 'Saving'}… ${seconds} s`),
      });
      setProblems(result.problems);
      if (result.ok) {
        setStatus(checkOnly ? '✓ Compiles.' : '✓ Saved.');
        if (!checkOnly) {
          studio.logActivity('save code', { kind: item.kind, name: item.name });
          setFiles([{ ...file, source: body }]);
          setDrafts({});
        }
      } else {
        setStatus(`❌ ${result.state}: ${result.problems.length} problem(s)`);
      }
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const saveBundle = async () => {
    if (!item || !dirty.length) return;
    if (!(await studio.confirmChange(`Save ${dirty.length} file(s) of ${item.name} to ${studio.org.label}`))) return;
    setBusy(true);
    setStatus('Saving…');
    try {
      for (const file of dirty) {
        // eslint-disable-next-line no-await-in-loop
        await saveBundleFile(client, item.kind as 'LWC' | 'Aura', file.id, drafts[file.id]);
      }
      studio.logActivity('save code', { kind: item.kind, name: item.name, files: dirty.map((f) => f.path) });
      setFiles(files.map((f) => (drafts[f.id] !== undefined ? { ...f, source: drafts[f.id] } : f)));
      setDrafts({});
      setProblems([]);
      setStatus('✓ Saved.');
    } catch (e) {
      // LWC / Aura compile errors come back as the save error
      setProblems([{ problem: (e as Error).message }]);
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** Creates a new item of the current kind from a starter template and opens it. */
  const createNew = async () => {
    const info = kindInfo(kind);
    const name = (
      await askText(
        kind === 'LWC' ? `Name of the new ${info.one} (camelCase, e.g. accountCard):` : `Name of the new ${info.one}:`
      )
    )?.trim();
    if (!name) return;
    let sobject: string | undefined;
    if (kind === 'ApexTrigger') {
      sobject = (await askText(`Object the trigger ${name} runs on (API name, e.g. Account or Invoice__c):`))?.trim();
      if (!sobject) return;
    }
    if (!(await studio.confirmChange(`Create the ${info.one} ${name} in ${studio.org.label}`))) return;
    setStatus(`Creating ${name}…`);
    try {
      const created = await createCode(client, { kind, name, sobject });
      studio.logActivity('create code', { kind, name, sobject });
      await load();
      await openItem(created);
      setStatus(`✓ Created ${name}.`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  // A class the AI wrote from a description: shown (editable) before it is created
  const [aiDraft, setAiDraft] = useState<{ code: string; model: string } | null>(null);

  /** Creates a class the AI wrote (asks first, like every change). */
  const createAiClass = async (body: string) => {
    const name = /\bclass\s+(\w+)/i.exec(body)?.[1] ?? 'the test class';
    if (!(await studio.confirmChange(`Create the Apex class ${name} (written by AI) in ${studio.org.label}`))) return;
    setStatus(`Creating ${name}…`);
    try {
      const id = await createApexClass(client, body);
      studio.logActivity('create code', { kind: 'ApexClass', name, by: 'AI' });
      setKind('ApexClass');
      await load();
      await openItem({ id, name, kind: 'ApexClass' });
      setStatus(/@isTest/i.test(body) ? `✓ Created ${name}. Run it on the Apex tests page.` : `✓ Created ${name}.`);
      setAiDraft(null);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  // The org side shows unsaved edits too, so "Use project version" ends in "no differences"
  const pairs = useMemo(
    () =>
      projectFiles
        ? pairCodeFiles(
            files.map((f) => ({ ...f, source: drafts[f.id] ?? f.source })),
            projectFiles
          )
        : [],
    [files, drafts, projectFiles]
  );
  const inOrg = Boolean(item && item.id !== projectOnlyId(item.name));
  const projectExtra = pairs.filter((p) => p.status === 'only in project').length;

  /** Loads the project's version into the org editor as unsaved changes. */
  const useProjectVersion = () => {
    if (!projectFiles) return;
    const next = { ...drafts };
    let changed = 0;
    for (const p of pairCodeFiles(files, projectFiles)) {
      if (p.org && p.project && p.status === 'different') {
        next[p.org.id] = p.project.source;
        changed++;
      }
    }
    setDrafts(next);
    setView('org');
    setStatus(
      `Project version loaded into ${changed} file(s), not saved yet. ${
        item && isBundle(item.kind) ? 'Save' : 'Compile only, then Save'
      } to apply it to ${studio.org.label}.${
        projectExtra ? ` ${projectExtra} file(s) only in the project need "Deploy from project".` : ''
      }`
    );
  };

  /** Deploys the component from the project (new components, or bundles with new files). */
  const deployFromProject = async () => {
    if (!item || !source || !project.info) return;
    if (!(await studio.confirmChange(`Deploy ${item.name} from the project (${projectLabel}) to ${studio.org.label}`)))
      return;
    setBusy(true);
    setProblems([]);
    setStatus(`Deploying ${item.name} from the project…`);
    try {
      const pkg = await projectCodePackage(
        source.fs,
        project.info,
        [{ type: CODE_LAYOUT[item.kind].type, name: item.name }],
        await client.version()
      );
      const result = await deployZip(client, pkg.zipBase64, {
        testLevel: 'NoTestRun',
        onProgress: (s, done, total) => setStatus(`Deploying ${item.name}… ${s} ${done}/${total}`),
      });
      studio.logActivity('deploy from project', {
        kind: item.kind,
        name: item.name,
        id: result.id,
        success: result.success,
      });
      if (!result.success) {
        const failures: CompileProblem[] = result.componentFailures.map((f) => ({
          line: f.line,
          problem: `${f.name}: ${f.problem}`,
        }));
        setProblems(result.errorMessage ? [...failures, { problem: result.errorMessage }] : failures);
        setStatus(`❌ Deploy ${result.status}.`);
        return;
      }
      const list = await listCode(client, item.kind);
      setItems(list);
      const deployed = list.find((i) => i.name === item.name);
      if (deployed) await openItem(deployed, 'compare');
      setStatus(`✓ Deployed ${item.name} from the project.`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  // "Open in Code" from Project → Compare: switch to the kind, then open the component
  useEffect(() => {
    const pending = project.pendingCode;
    if (!pending) return;
    if (pending.kind !== kind) {
      switchKind(pending.kind);
      return;
    }
    // Wait for this kind's list (the previous kind's stays until the new one loads)
    if (!items || items.some((i) => i.kind !== kind)) return;
    project.openCodeItem(undefined);
    const found = items.find((i) => i.name === pending.name);
    void openItem(found ?? { id: projectOnlyId(pending.name), name: pending.name, kind }, 'compare');
    // openItem and switchKind change every render; the pending request drives this
  }, [project.pendingCode, kind, items]);

  const statusOf = (i: CodeItem): CodeStatus | undefined =>
    !projectOpen
      ? undefined
      : i.id === projectOnlyId(i.name)
      ? 'only in project'
      : index.has(i.name)
      ? checked[i.name] ?? 'in both'
      : 'only in org';
  const orgNames = new Set((items ?? []).map((i) => i.name));
  const entries: CodeItem[] = [
    ...(items ?? []),
    ...(projectOpen && items
      ? [...index.keys()].filter((n) => !orgNames.has(n)).map((n) => ({ id: projectOnlyId(n), name: n, kind }))
      : []),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const counts = new Map<Show, number>([['all', entries.length]]);
  for (const e of entries) {
    const st = statusOf(e);
    if (st) counts.set(st, (counts.get(st) ?? 0) + 1);
  }

  const file = files[fileIndex];
  const shown = entries.filter(
    (i) => i.name.toLowerCase().includes(filter.toLowerCase()) && (show === 'all' || statusOf(i) === show)
  );
  const itemStatus = item ? statusOf(item) : undefined;

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Code</h2>
        <div className="tabs">
          {KINDS.map((k) => (
            <button key={k.id} className={`tab ${kind === k.id ? 'active' : ''}`} onClick={() => switchKind(k.id)}>
              {k.label}
            </button>
          ))}
          <button
            className="tab"
            onClick={onOther}
            title="FlexiPages, flows, permission sets, layouts and every other type"
          >
            Other metadata
          </button>
        </div>
        <span className="grow" />
        <button
          disabled={apexLocked && !isBundle(kind)}
          title={`Create a ${kindInfo(kind).one} from a starter template`}
          onClick={() => void createNew()}
        >
          New {kindInfo(kind).one}
        </button>
        {item && inOrg && !isBundle(item.kind) && (
          <>
            <button
              disabled={busy}
              title="Compiles the code in the org to find errors, without saving anything"
              onClick={() => void compile(true)}
            >
              Compile only
            </button>
            <button
              className="primary"
              disabled={busy || apexLocked || !dirty.length}
              onClick={() => void compile(false)}
            >
              Save
            </button>
          </>
        )}
        {item && inOrg && isBundle(item.kind) && (
          <button className="primary" disabled={busy || !dirty.length} onClick={() => void saveBundle()}>
            Save {dirty.length || ''}
          </button>
        )}
      </div>
      {apexLocked && !isBundle(kind) && (
        <p className="muted">
          Production org: Salesforce only accepts Apex and Visualforce changes through a deployment. Opening and Compile
          only still work.
        </p>
      )}
      {status && <Status text={status} block />}
      {kind === 'ApexClass' && !apexLocked && (
        <AiAsk
          task="write-class"
          placeholder="✦ Describe a new class, e.g. AccountService with a method that closes opportunities older than a year"
          button="Write the class"
          what="your description"
          onAnswer={(answer) => setAiDraft({ code: `${extractCode(answer.text)}\n`, model: answer.model })}
        />
      )}
      {aiDraft && (
        <div className="card section ai-answer">
          <div className="toolbar">
            <b>✦ New class written by AI</b>
            <span className="muted">{aiDraft.model} · read and change it, nothing is created yet</span>
            <span className="grow" />
            <button className="primary" onClick={() => void createAiClass(aiDraft.code)}>
              Create this class…
            </button>
            <button onClick={() => setAiDraft(null)}>Discard</button>
          </div>
          <div className="editor-box">
            <CodeEditor language="apex" value={aiDraft.code} onChange={(code) => setAiDraft({ ...aiDraft, code })} />
          </div>
        </div>
      )}
      <div className="code-layout">
        <div className="card code-list">
          <input
            placeholder={`Filter ${entries.length || ''}`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {projectOpen && (
            <div className="code-project">
              <span className="muted" title={projectLabel}>
                vs project <b>{projectLabel}</b>
              </span>
              <div className="form">
                <select value={show} onChange={(e) => setShow(e.target.value as Show)}>
                  {SHOW.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label} ({counts.get(o.id) ?? 0})
                    </option>
                  ))}
                </select>
                <button
                  disabled={busy || !items || !index.size}
                  title="Compare the content of every component in both the org and the project"
                  onClick={() => void checkContent()}
                >
                  Compare content
                </button>
              </div>
            </div>
          )}
          {items === null && <p className="muted">Loading…</p>}
          <ul>
            {shown.map((i) => {
              const st = statusOf(i);
              return (
                <li key={i.id}>
                  <button
                    className={`${item?.id === i.id ? 'active' : ''} ${st === 'only in project' ? 'project-only' : ''}`}
                    onClick={() => void openItem(i)}
                    title={st ? `${st}${i.lastModified ? ` · ${i.lastModified}` : ''}` : i.lastModified}
                  >
                    {i.name}
                    {st && TAG[st] && <span className={`code-tag ${st.replace(/ /g, '-')}`}>{TAG[st]}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="card section">
          {item && projectFiles && (
            <div className="toolbar code-views">
              <div className="tabs">
                {(['org', 'project', 'compare'] as View[]).map((v) => (
                  <button
                    key={v}
                    className={`tab ${view === v ? 'active' : ''}`}
                    disabled={v !== 'project' && !inOrg}
                    onClick={() => setView(v)}
                  >
                    {v === 'org' ? `Org · ${studio.org.label}` : v === 'project' ? 'Project' : 'Compare'}
                  </button>
                ))}
              </div>
              {itemStatus && itemStatus !== 'in both' && (
                <span className={`code-tag ${itemStatus.replace(/ /g, '-')}`}>{itemStatus}</span>
              )}
              <span className="grow" />
              {inOrg && pairs.some((p) => p.org && p.project && p.status === 'different') && (
                <button
                  title="Put the project's code into the editor as unsaved changes; Save applies it"
                  onClick={useProjectVersion}
                >
                  Use project version
                </button>
              )}
              {(!inOrg || projectExtra > 0) && (
                <button
                  className="primary"
                  disabled={busy || apexLocked}
                  title={
                    apexLocked
                      ? 'Production: deploy with tests from Project → Compare'
                      : 'Deploy this component from the project (no tests run; sandboxes and developer orgs)'
                  }
                  onClick={() => void deployFromProject()}
                >
                  Deploy from project…
                </button>
              )}
            </div>
          )}
          {item && projectFiles && view !== 'org' ? (
            <ProjectCodeView
              pairs={pairs}
              view={view}
              labels={[studio.org.label, projectLabel]}
              path={shownPair(pairs, pairPath)?.path ?? ''}
              onPath={setPairPath}
            />
          ) : !file ? (
            <p className="muted">
              Open {/^[AEIOU]/.test(kindInfo(kind).one) ? 'an' : 'a'} {kindInfo(kind).one} on the left, or create a new
              one.
            </p>
          ) : (
            <>
              {files.length > 1 && (
                <div className="tabs">
                  {files.map((f, i) => (
                    <button
                      key={f.id}
                      className={`tab ${i === fileIndex ? 'active' : ''}`}
                      onClick={() => setFileIndex(i)}
                    >
                      {f.path.split('/').pop()}
                      {drafts[f.id] !== undefined && drafts[f.id] !== f.source ? ' •' : ''}
                    </button>
                  ))}
                </div>
              )}
              <div className="chips ai-tools">
                {inOrg && (
                  <button
                    className={showDeps ? 'primary' : ''}
                    title="What this uses, and what uses it (classes, triggers, flows, pages)"
                    onClick={() => setShowDeps(!showDeps)}
                  >
                    Dependencies
                  </button>
                )}
                <AiExplain
                  task="explain-code"
                  label="Explain"
                  what="this file"
                  getText={() => drafts[file.id] ?? file.source}
                  getExtra={() => `File: ${file.path}`}
                />
                <AiExplain
                  task="review-code"
                  label="Review"
                  what="this file"
                  getText={() => drafts[file.id] ?? file.source}
                  getExtra={() => `File: ${file.path}`}
                />
                {item?.kind === 'ApexClass' && !/@isTest/i.test(file.source) && (
                  <AiExplain
                    task="write-test"
                    label="Write test class"
                    what="this class"
                    getText={() => drafts[file.id] ?? file.source}
                    getExtra={() => `Class: ${item.name}`}
                    useCode={
                      apexLocked
                        ? undefined
                        : { label: 'Create this test class…', apply: (code) => void createAiClass(code) }
                    }
                  />
                )}
              </div>
              {showDeps && item && inOrg && (
                <div className="section">
                  <Dependencies id={item.id} name={item.name} />
                </div>
              )}
              <div className="editor-box tall">
                <CodeEditor
                  key={file.id}
                  language={file.language}
                  value={drafts[file.id] ?? file.source}
                  onChange={(v) => setDrafts((d) => ({ ...d, [file.id]: v }))}
                  onMount={(e) => {
                    editor.current = e;
                  }}
                />
              </div>
              {problems.length > 0 && (
                <div className="chips">
                  <AiExplain
                    task="explain-compile"
                    label="Explain these errors"
                    what="this file and its errors"
                    getText={() => drafts[file.id] ?? file.source}
                    getExtra={() =>
                      `Errors:\n${problems.map((p) => `${p.line ? `line ${p.line}: ` : ''}${p.problem}`).join('\n')}`
                    }
                    useCode={{
                      label: 'Use the fixed code',
                      apply: (code) => setDrafts((d) => ({ ...d, [file.id]: `${code}\n` })),
                    }}
                  />
                </div>
              )}
              {problems.length > 0 && (
                <ul className="problems">
                  {problems.map((p, i) => (
                    <li key={i}>
                      {p.line ? (
                        <button
                          className="link"
                          onClick={() => {
                            editor.current?.revealLineInCenter(p.line!);
                            editor.current?.setPosition({ lineNumber: p.line!, column: p.column ?? 1 });
                            editor.current?.focus();
                          }}
                        >
                          {p.line}:{p.column ?? 1}
                        </button>
                      ) : null}{' '}
                      {p.problem}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {(view !== 'org' || !file) && problems.length > 0 && (
            <ul className="problems">
              {problems.map((p, i) => (
                <li key={i}>
                  {p.line ? `${p.line}: ` : ''}
                  {p.problem}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Code: Apex, triggers, Visualforce, LWC and Aura with the project compare; "Other metadata" opens
 * any other type (FlexiPage, Flow, PermissionSet…) as its files.
 */
export function CodePage() {
  const [other, setOther] = useState<boolean>(() => storage.get('code.other', false));
  const show = (next: boolean) => {
    setOther(next);
    storage.set('code.other', next);
  };
  if (!other) return <ApexCodePage onOther={() => show(true)} />;
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Code</h2>
        <div className="tabs">
          {KINDS.map((k) => (
            <button
              key={k.id}
              className="tab"
              onClick={() => {
                storage.set('code.kind', k.id);
                show(false);
              }}
            >
              {k.label}
            </button>
          ))}
          <button className="tab active">Other metadata</button>
        </div>
      </div>
      <MetadataSource />
    </div>
  );
}
