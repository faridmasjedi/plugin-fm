import { useEffect, useMemo, useState } from 'react';
import {
  apexSourcesFromOrg,
  compareTypeWithProject,
  describeGlobal,
  describeMetadata,
  folderBytes,
  listMetadata,
  makeZip,
  parseMetadataDraft,
  type MetadataDraft,
  normalizeXml,
  packageXml,
  pairCodeFiles,
  projectComponentFiles,
  projectMetadataZip,
  projectTests,
  retrieveComponent,
  testsForPackage,
  type CodeFile,
  type ComponentFile,
  type MetadataComponent,
  type MetadataType,
  type ProjectSide,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { useProject } from '../project';
import { AiAsk, AiExplain } from './AiHelp';
import { AiMetadataDraft } from './AiMetadataDraft';
import { CodeEditor } from './CodeEditor';
import { SHOW, TAG, type CodeStatus, type Show } from './codeStatus';
import { Dependencies } from './Dependencies';
import { ProjectDependencies } from './ProjectDependencies';
import { ProjectCodeView } from './ProjectCodeView';
import { ReleasePanel } from './ReleasePanel';
import { Status } from '../statusLog';

type View = 'org' | 'project' | 'compare' | 'deps';

/** Types people open most, first in the list. */
const COMMON = [
  'FlexiPage',
  'Flow',
  'PermissionSet',
  'PermissionSetGroup',
  'Layout',
  'CustomObject',
  'CustomMetadata',
  'CustomLabels',
  'EmailTemplate',
  'QuickAction',
  'GlobalValueSet',
  'CustomApplication',
  'CustomTab',
  'Report',
  'Dashboard',
  'StaticResource',
  'NamedCredential',
  'RemoteSiteSetting',
  'Profile',
];

const languageOf = (path: string): 'javascript' | 'html' | 'css' | 'json' | 'xml' =>
  /\.(js|cmp\.js)$/.test(path)
    ? 'javascript'
    : /\.html?$/.test(path)
    ? 'html'
    : /\.css$/.test(path)
    ? 'css'
    : /\.json$/.test(path)
    ? 'json'
    : 'xml';

/** The language for the Code views' file pairs (no plain text there). */
const codeLanguageOf = (path: string): CodeFile['language'] => languageOf(path);

/**
 * Any metadata component (FlexiPage, Flow, permission set, layout…), the same way Code shows Apex and LWC: the org's
 * list with what is only in the project, "Compare content" for a whole type, the org's files (edited in place), the
 * project's version and the difference; validated, deployed or quick deployed — your edits or the project's version —
 * with the shared panel; and what it uses and what uses it.
 */
export function MetadataSource({ initial }: { initial?: { type: string; fullName: string } }) {
  const { client, org } = useStudio();
  const project = useProject();
  const [types, setTypes] = useState<MetadataType[]>([]);
  const [type, setType] = useState(() => initial?.type ?? storage.get('code.metaType', 'FlexiPage'));
  const [members, setMembers] = useState<MetadataComponent[] | null>(null);
  const [filter, setFilter] = useState('');
  const [show, setShow] = useState<Show>('all');
  // The component open: from the org (with its record), or only in the project
  const [chosen, setChosen] = useState<{ name: string; member?: MetadataComponent } | null>(null);
  const [files, setFiles] = useState<ComponentFile[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fileIndex, setFileIndex] = useState(0);
  const [view, setView] = useState<View>('org');
  const [pairPath, setPairPath] = useState('');
  // The project's version of the open component (undefined: not read yet)
  const [inProject, setInProject] = useState<{ files: CodeFile[]; problem?: string }>();
  const [checked, setChecked] = useState<Record<string, 'same' | 'different'>>({});
  // Validate / deploy: your edits (the org's files) or the project's version
  const [release, setRelease] = useState<'edits' | 'project' | null>(null);
  const [status, setStatus] = useState('');
  // A new component the AI wrote (shown before it is created), and a reload of the list after one is
  const [aiDraft, setAiDraft] = useState<{ draft: MetadataDraft; model: string } | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);

  const projectOpen = Boolean(project.source && project.info);
  const projectSide = (): ProjectSide | undefined =>
    project.source && project.info
      ? {
          fs: project.source.fs,
          info: project.info,
          readBytes: project.source.handle ? (path) => folderBytes(project.source!.handle!, path) : undefined,
        }
      : undefined;
  // The project's components of this type
  const projectNames = useMemo(() => {
    const names = new Set<string>();
    for (const dir of project.info?.packageDirectories ?? [])
      for (const t of dir.types) if (t.type === type) t.names.forEach((n) => names.add(n));
    return names;
  }, [project.info, type]);

  useEffect(() => {
    describeMetadata(client)
      .then((list) => setTypes(list))
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client]);

  useEffect(() => {
    storage.set('code.metaType', type);
    setMembers(null);
    setChosen(null);
    setChecked({});
    if (!types.length) return;
    const info = types.find((t) => t.xmlName === type);
    if (!info) return;
    listMetadata(client, type, info.inFolder)
      .then((list) => {
        const sorted = list
          .filter((m) => !m.type || m.type === type)
          .sort((a, b) => a.fullName.localeCompare(b.fullName));
        setMembers(sorted);
        const first =
          initial && initial.type === type ? sorted.find((m) => m.fullName === initial.fullName) : undefined;
        if (first) setChosen({ name: first.fullName, member: first });
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
    // `initial` only matters the first time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, type, types, reload]);

  // A new component: its org files (when it is in the org); the project's version is read when a view needs it
  useEffect(() => {
    setFiles(null);
    setDrafts({});
    setFileIndex(0);
    setInProject(undefined);
    setRelease(null);
    setPairPath('');
    if (!chosen) return;
    if (!chosen.member) {
      setView('project');
      return;
    }
    setView((v) => (v === 'deps' ? 'org' : v));
    setStatus(`Retrieving ${chosen.name}…`);
    retrieveComponent(client, chosen.member.type || type, chosen.name)
      .then((f) => {
        setFiles(f);
        setStatus('');
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
    // `type` is read from the component
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, chosen]);

  const name = chosen?.name ?? '';
  const inOrg = Boolean(chosen?.member);
  const hasProjectVersion = projectOpen && projectNames.has(name);

  useEffect(() => {
    const side = projectSide();
    if (!chosen || inProject || !side || !projectNames.has(chosen.name)) return;
    if (view !== 'project' && view !== 'compare' && release !== 'project') return;
    let canceled = false;
    void (async () => {
      try {
        const found = await projectComponentFiles(side, { type, name: chosen.name }, await client.version());
        if (!canceled) setInProject(found);
      } catch (e) {
        if (!canceled) setInProject({ files: [], problem: (e as Error).message });
      }
    })();
    return () => {
      canceled = true;
    };
    // projectSide reads project, which is a dependency
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, view, release, inProject, project, projectNames, client, type]);

  const typeList = useMemo(() => {
    const names = types.map((t) => t.xmlName);
    return [...COMMON.filter((c) => names.includes(c)), ...names.filter((n) => !COMMON.includes(n)).sort()];
  }, [types]);

  const statusOf = (entry: { name: string; member?: MetadataComponent }): CodeStatus | undefined =>
    !projectOpen
      ? undefined
      : !entry.member
      ? 'only in project'
      : projectNames.has(entry.name)
      ? checked[entry.name] ?? 'in both'
      : 'only in org';
  const orgNames = new Set((members ?? []).map((m) => m.fullName));
  const entries = [
    ...(members ?? []).map((m) => ({ name: m.fullName, member: m as MetadataComponent | undefined })),
    ...(projectOpen && members
      ? [...projectNames].filter((n) => !orgNames.has(n)).map((n) => ({ name: n, member: undefined }))
      : []),
  ].sort((a, b) => a.name.localeCompare(b.name));
  const counts = new Map<Show, number>([['all', entries.length]]);
  for (const e of entries) {
    const st = statusOf(e);
    if (st) counts.set(st, (counts.get(st) ?? 0) + 1);
  }
  const needle = filter.trim().toLowerCase();
  const shown = entries.filter(
    (e) => (!needle || e.name.toLowerCase().includes(needle)) && (show === 'all' || statusOf(e) === show)
  );
  const chosenStatus = chosen ? statusOf(chosen) : undefined;

  const changed = Object.entries(drafts).filter(([path, text]) => files?.find((f) => f.path === path)?.text !== text);
  const current = files?.[fileIndex];
  const orgCode: CodeFile[] = (files ?? [])
    .filter((f) => f.text !== null)
    .map((f) => ({ id: f.path, path: f.path, language: codeLanguageOf(f.path), source: f.text ?? '' }));
  // XML laid out the same way on both sides (a compact project file and the org's expanded one)
  const laidOut = (list: CodeFile[]): CodeFile[] =>
    list.map((f) => (f.language === 'xml' ? { ...f, source: normalizeXml(f.source) } : f));
  const pairs = inProject ? pairCodeFiles(laidOut(orgCode), laidOut(inProject.files)) : [];

  /** "Compare content": every component of this type in both, same or different. */
  const checkContent = async (): Promise<void> => {
    const side = projectSide();
    if (!side) return;
    const both = (members ?? []).map((m) => m.fullName).filter((n) => projectNames.has(n));
    setBusy(true);
    try {
      const result = await compareTypeWithProject(client, side, type, both, (s) => setStatus(s));
      setChecked(Object.fromEntries(result));
      const different = [...result.values()].filter((v) => v === 'different').length;
      setStatus(`✓ ${result.size} ${type} compared: ${different} different.`);
      if (different) setShow('different');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  /** The package for the panel: the org's files with your edits, or the project's version. */
  const build = async () => {
    const version = await client.version();
    if (release === 'project') {
      const side = projectSide();
      if (!side) throw new Error('Open a project first (Release › Project).');
      return projectMetadataZip({ ...side, deploy: [{ type, name }], apiVersion: version });
    }
    if (!files) throw new Error('The files are not retrieved yet.');
    if (files.some((f) => f.text === null))
      throw new Error('This component has binary files: deploy it from the project.');
    return {
      zip: makeZip([
        { path: 'package.xml', content: packageXml([{ type, fullName: name }], version) },
        ...files.map((f) => ({ path: f.path, content: drafts[f.path] ?? f.text ?? '' })),
      ]),
    };
  };

  const findTests = async () =>
    release === 'project' && project.source && project.info
      ? projectTests(project.source.fs, project.info, [{ type, name }])
      : testsForPackage(await apexSourcesFromOrg(client), [{ type, name }]);

  return (
    <div className="metadata-source">
      <div className="form">
        <label>
          Type
          <select
            value={type}
            onChange={(e) => {
              // Another type: nothing of the last one stays open
              setChosen(null);
              setFiles(null);
              setStatus('');
              setShow('all');
              setType(e.target.value);
            }}
            style={{ minWidth: 220 }}
          >
            {typeList.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
      </div>
      {status && <Status text={status} block />}
      <AiAsk
        key={`new:${type}`}
        task="write-metadata"
        placeholder={`✦ Describe a new ${type}, e.g. ${
          type === 'PermissionSet'
            ? 'read access to Account and Contact for the sales team'
            : type === 'CustomObject'
            ? 'a field Customer_Tier__c (picklist Gold, Silver, Bronze) on Account'
            : 'what it should hold and do'
        }`}
        button={`Write the ${type}`}
        what="your description"
        build={async () => ({
          kind: type,
          apiVersion: await client.version(),
          schema: `Objects: ${(await describeGlobal(client).catch(() => []))
            .map((o) => o.name)
            .join(', ')
            .slice(0, 20_000)}`,
        })}
        onAnswer={(answer) => setAiDraft({ draft: parseMetadataDraft(answer.text), model: answer.model })}
      />
      {aiDraft && (
        <AiMetadataDraft
          draft={aiDraft.draft}
          model={aiDraft.model}
          onChange={(draft) => setAiDraft({ ...aiDraft, draft })}
          onDiscard={() => setAiDraft(null)}
          onDone={() => {
            setAiDraft(null);
            setReload(reload + 1);
          }}
        />
      )}
      {type === 'Profile' && (
        <p className="muted">
          A profile file holds only the settings that go with the other components in the same retrieve: to change a
          profile, use Access › Permissions.
        </p>
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
              <span className="muted" title={project.source?.name}>
                vs project <b>{project.source?.name}</b>
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
                  disabled={busy || !members || !(members ?? []).some((m) => projectNames.has(m.fullName))}
                  title={`Compare the content of every ${type} in both the org and the project`}
                  onClick={() => void checkContent()}
                >
                  Compare content
                </button>
              </div>
            </div>
          )}
          {members === null && <p className="muted">Loading…</p>}
          <ul>
            {shown.map((e) => {
              const st = statusOf(e);
              return (
                <li key={`${e.member ? 'org' : 'project'}:${e.name}`}>
                  <button
                    className={`${chosen?.name === e.name ? 'active' : ''} ${
                      st === 'only in project' ? 'project-only' : ''
                    }`}
                    onClick={() => setChosen(e)}
                    title={`${e.name}${st ? ` · ${st}` : ''}${e.member?.fileName ? `\n${e.member.fileName}` : ''}`}
                  >
                    {e.name}
                    {st && TAG[st] && <span className={`code-tag ${st.replace(/ /g, '-')}`}>{TAG[st]}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        <div className="card section">
          {chosen ? (
            <>
              <div className="toolbar code-views">
                <div className="tabs">
                  {(['org', 'project', 'compare', 'deps'] as View[]).map((v) => (
                    <button
                      key={v}
                      className={`tab ${view === v ? 'active' : ''}`}
                      disabled={
                        (v === 'org' && !inOrg) ||
                        (v === 'compare' && (!inOrg || !hasProjectVersion)) ||
                        (v === 'project' && !hasProjectVersion) ||
                        (v === 'deps' && !chosen.member?.id && !hasProjectVersion)
                      }
                      title={
                        v === 'deps'
                          ? chosen.member?.id || hasProjectVersion
                            ? 'What it uses and what uses it (in the org, and in the project)'
                            : 'Salesforce gives no Id for this type'
                          : v !== 'org' && !projectOpen
                          ? 'Open a project first (Release › Project)'
                          : undefined
                      }
                      onClick={() => setView(v)}
                    >
                      {v === 'org'
                        ? `Org · ${org.label}`
                        : v === 'project'
                        ? 'Project'
                        : v === 'compare'
                        ? 'Compare'
                        : 'Dependencies'}
                    </button>
                  ))}
                </div>
                {chosenStatus && chosenStatus !== 'in both' && (
                  <span className={`code-tag ${chosenStatus.replace(/ /g, '-')}`}>{chosenStatus}</span>
                )}
                <span className="grow" />
                {view === 'org' && files && (
                  <>
                    <button disabled={!changed.length} onClick={() => setDrafts({})}>
                      Undo
                    </button>
                    <button
                      className={release === 'edits' ? 'primary active' : 'primary'}
                      onClick={() => setRelease(release === 'edits' ? null : 'edits')}
                      title="Validate, deploy or quick deploy the org's files with your edits, with the tests you choose"
                    >
                      {changed.length ? `Save ${changed.length} edited file(s)…` : 'Validate / deploy…'}
                    </button>
                  </>
                )}
                {hasProjectVersion && (
                  <button
                    className={release === 'project' ? 'primary active' : view === 'org' ? '' : 'primary'}
                    onClick={() => setRelease(release === 'project' ? null : 'project')}
                    title="Validate, deploy or quick deploy the project's version, with the tests you choose"
                  >
                    Deploy from project…
                  </button>
                )}
              </div>
              <p className="muted code-meta">
                <b>{name}</b> {chosen.member?.lastModifiedByName ? `· ${chosen.member.lastModifiedByName} ` : ''}
                {chosen.member?.lastModifiedDate ? `· ${chosen.member.lastModifiedDate.slice(0, 10)}` : ''}
                {chosen.member?.manageableState && chosen.member.manageableState !== 'unmanaged'
                  ? ` · ${chosen.member.manageableState}`
                  : ''}
              </p>
              {view === 'org' && files && files.some((f) => f.text !== null) && (
                <AiAsk
                  key={`change:${type}:${name}`}
                  task="change-metadata"
                  placeholder={`✦ Describe a change to ${name}, e.g. ${
                    type === 'Layout' ? 'add the field Phone under Name' : 'what to add, remove or change'
                  }`}
                  button="Change it"
                  what={`the files of ${name}`}
                  build={async () => ({
                    type,
                    name,
                    text: files
                      .filter((f) => f.text !== null)
                      .map((f) => `${f.path}:\n${drafts[f.path] ?? f.text}`)
                      .join('\n\n'),
                  })}
                  onAnswer={(answer) => {
                    const changed = parseMetadataDraft(answer.text).files.filter((f) =>
                      files.some((o) => o.path === f.path)
                    );
                    if (!changed.length) throw new Error('The AI changed none of these files; try rephrasing.');
                    setDrafts({ ...drafts, ...Object.fromEntries(changed.map((f) => [f.path, f.content])) });
                    setFileIndex(
                      Math.max(
                        0,
                        files.findIndex((f) => f.path === changed[0].path)
                      )
                    );
                    setStatus(
                      `✦ ${changed.length} file(s) changed by AI (${answer.model}), not saved: read them (•), then Save or Undo.`
                    );
                  }}
                />
              )}
              {release && (
                <ReleasePanel
                  key={`${release}:${type}:${name}`}
                  deployCount={1}
                  removeCount={0}
                  from={release === 'project' ? `the project (${type} ${name})` : `the org's ${name} with your edits`}
                  build={build}
                  findTests={findTests}
                  zipName={`${name.replace(/[^\w.-]+/g, '_')}.zip`}
                  onDone={(outcome) => {
                    if (outcome.success && !outcome.checkOnly && release === 'edits' && files) {
                      setFiles(files.map((f) => ({ ...f, text: drafts[f.path] ?? f.text })));
                      setDrafts({});
                    }
                  }}
                />
              )}
              {view === 'deps' ? (
                <>
                  {chosen.member?.id && (
                    <>
                      <h4 className="deps-where">In {org.label}</h4>
                      <Dependencies id={chosen.member.id} name={name} />
                    </>
                  )}
                  {hasProjectVersion && (
                    <>
                      <h4 className="deps-where">In the project</h4>
                      <ProjectDependencies type={type} name={name} />
                    </>
                  )}
                </>
              ) : view === 'project' || view === 'compare' ? (
                !inProject ? (
                  <p className="muted">Reading the project…</p>
                ) : inProject.problem ? (
                  <p className="muted">Not read from the project: {inProject.problem}.</p>
                ) : (
                  <ProjectCodeView
                    key={`${view}:${name}`}
                    pairs={pairs}
                    view={view}
                    labels={[org.label, `project ${project.source?.name ?? ''}`]}
                    path={pairPath}
                    onPath={setPairPath}
                  />
                )
              ) : !files ? null : (
                <>
                  {files.length > 1 && (
                    <div className="tabs">
                      {files.map((f, i) => (
                        <button
                          key={f.path}
                          className={`tab ${i === fileIndex ? 'active' : ''}`}
                          onClick={() => setFileIndex(i)}
                        >
                          {f.path.split('/').pop()}
                          {drafts[f.path] !== undefined && drafts[f.path] !== f.text ? ' •' : ''}
                        </button>
                      ))}
                    </div>
                  )}
                  {current && current.text !== null && (
                    <div className="chips ai-tools">
                      <AiExplain
                        key={`explain:${current.path}`}
                        task="explain-code"
                        label="Explain"
                        what="this file"
                        getText={() => drafts[current.path] ?? current.text ?? ''}
                        getExtra={() => `${type} ${name} · file: ${current.path}`}
                      />
                      <AiExplain
                        key={`review:${current.path}`}
                        task="review-code"
                        label="Review"
                        what="this file"
                        getText={() => drafts[current.path] ?? current.text ?? ''}
                        getExtra={() => `${type} ${name} · file: ${current.path}`}
                      />
                    </div>
                  )}
                  {current && current.text === null ? (
                    <p className="muted">
                      {current.path}: a binary file ({current.size.toLocaleString()} bytes), not shown.
                    </p>
                  ) : (
                    current && (
                      <div className="editor-box tall">
                        <CodeEditor
                          key={`org:${name}:${current.path}`}
                          language={languageOf(current.path)}
                          value={drafts[current.path] ?? current.text ?? ''}
                          onChange={(v) => setDrafts({ ...drafts, [current.path]: v })}
                          readOnly={chosen.member?.manageableState === 'installed' && type !== 'Layout'}
                        />
                      </div>
                    )
                  )}
                </>
              )}
            </>
          ) : (
            members && <p className="muted">Choose a {type} on the left.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/** One component's files, read-only (Release › Metadata: what you are about to package). */
export function ComponentPreview({ type, fullName, onClose }: { type: string; fullName: string; onClose: () => void }) {
  const { client } = useStudio();
  const [files, setFiles] = useState<ComponentFile[] | null>(null);
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState('');
  useEffect(() => {
    setFiles(null);
    setIndex(0);
    setStatus(`Retrieving ${fullName}…`);
    retrieveComponent(client, type, fullName)
      .then((f) => {
        setFiles(f);
        setStatus('');
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, type, fullName]);
  const current = files?.[index];
  return (
    <div className="section component-preview">
      <div className="form">
        <b>
          {type} · {fullName}
        </b>
        <span className="muted">{status || 'read-only · to change it: Develop › Code › Other metadata'}</span>
        <span className="grow" />
        <button onClick={onClose}>Close</button>
      </div>
      {files && files.length > 1 && (
        <div className="tabs">
          {files.map((f, i) => (
            <button key={f.path} className={`tab ${i === index ? 'active' : ''}`} onClick={() => setIndex(i)}>
              {f.path.split('/').pop()}
            </button>
          ))}
        </div>
      )}
      {current &&
        (current.text === null ? (
          <p className="muted">
            {current.path}: a binary file ({current.size.toLocaleString()} bytes), not shown.
          </p>
        ) : (
          <div className="editor-box">
            <CodeEditor language={languageOf(current.path)} value={current.text} readOnly />
          </div>
        ))}
    </div>
  );
}
