import { useEffect, useMemo, useState } from 'react';
import {
  apexSourcesFromOrg,
  describeMetadata,
  folderBytes,
  listMetadata,
  makeZip,
  packageXml,
  projectMetadataZip,
  projectTests,
  readZip,
  retrieveComponent,
  testsForPackage,
  type ComponentFile,
  type MetadataComponent,
  type MetadataType,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { useProject } from '../project';
import { CodeDiff } from './CodeDiff';
import { CodeEditor } from './CodeEditor';
import { Dependencies } from './Dependencies';
import { ReleasePanel } from './ReleasePanel';
import { Status } from '../statusLog';

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

/** The project's version of a component, in the retrieve's (Metadata API) paths so it pairs with the org's files. */
async function projectVersion(
  project: ReturnType<typeof useProject>,
  type: string,
  name: string,
  apiVersion: string
): Promise<{ files: ComponentFile[]; problem?: string }> {
  if (!project.source || !project.info) return { files: [], problem: 'Open a project first (Release › Project).' };
  const { fs, handle } = project.source;
  const built = await projectMetadataZip({
    fs,
    info: project.info,
    deploy: [{ type, name }],
    apiVersion,
    readBytes: handle ? (path) => folderBytes(handle, path) : undefined,
  });
  if (built.notConverted.length) return { files: [], problem: `Not in the project: ${built.notConverted[0].reason}.` };
  const files: ComponentFile[] = [];
  for (const [path, bytes] of await readZip(built.zip)) {
    if (path === 'package.xml') continue;
    const text = new TextDecoder().decode(bytes);
    files.push({ path, text: text.includes('\u0000') ? null : text, size: bytes.length });
  }
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}

/**
 * Any metadata component (FlexiPage, Flow, permission set, layout…): its files from the org, edited in place; the
 * project's version and how it differs; validated, deployed or quick deployed — your edits or the project's version —
 * with the shared panel (tests, dependent tests); and what it uses and what uses it.
 */
export function MetadataSource({ initial }: { initial?: { type: string; fullName: string } }) {
  const { client } = useStudio();
  const project = useProject();
  const [types, setTypes] = useState<MetadataType[]>([]);
  const [type, setType] = useState(() => initial?.type ?? storage.get('code.metaType', 'FlexiPage'));
  const [members, setMembers] = useState<MetadataComponent[] | null>(null);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<MetadataComponent | null>(null);
  const [files, setFiles] = useState<ComponentFile[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fileIndex, setFileIndex] = useState(0);
  const [view, setView] = useState<'source' | 'project' | 'compare' | 'deps'>('source');
  // The project's version of the chosen component (undefined: not read yet)
  const [inProject, setInProject] = useState<{ files: ComponentFile[]; problem?: string }>();
  const [comparePath, setComparePath] = useState('');
  // Validate / deploy: your edits (the org's files) or the project's version
  const [release, setRelease] = useState<'edits' | 'project' | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    describeMetadata(client)
      .then((list) => setTypes(list))
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client]);

  useEffect(() => {
    storage.set('code.metaType', type);
    setMembers(null);
    setChosen(null);
    if (!types.length) return;
    const info = types.find((t) => t.xmlName === type);
    if (!info) return;
    listMetadata(client, type, info.inFolder)
      .then((list) => {
        const sorted = list.sort((a, b) => a.fullName.localeCompare(b.fullName));
        setMembers(sorted);
        if (initial && initial.type === type) setChosen(sorted.find((m) => m.fullName === initial.fullName) ?? null);
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
    // `initial` only matters the first time
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, type, types]);

  useEffect(() => {
    setFiles(null);
    setDrafts({});
    setFileIndex(0);
    setInProject(undefined);
    setRelease(null);
    if (!chosen) return;
    setStatus(`Retrieving ${chosen.fullName}…`);
    // The component's own type: the list may already show another one
    retrieveComponent(client, chosen.type || type, chosen.fullName)
      .then((f) => {
        setFiles(f);
        setStatus('');
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
    // `type` is read from the component
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, chosen]);

  const typeList = useMemo(() => {
    const names = types.map((t) => t.xmlName);
    return [...COMMON.filter((c) => names.includes(c)), ...names.filter((n) => !COMMON.includes(n)).sort()];
  }, [types]);
  const needle = filter.trim().toLowerCase();
  const shown = (members ?? []).filter((m) => !needle || m.fullName.toLowerCase().includes(needle));
  const changed = Object.entries(drafts).filter(([path, text]) => files?.find((f) => f.path === path)?.text !== text);
  const current = files?.[fileIndex];

  const name = chosen?.fullName ?? '';
  const chosenType = chosen?.type || type;

  // The project's version, read when a view or the panel needs it
  useEffect(() => {
    if (!chosen || inProject || (view !== 'project' && view !== 'compare' && release !== 'project')) return;
    let canceled = false;
    void (async () => {
      try {
        const found = await projectVersion(project, chosenType, name, await client.version());
        if (!canceled) setInProject(found);
      } catch (e) {
        if (!canceled) setInProject({ files: [], problem: (e as Error).message });
      }
    })();
    return () => {
      canceled = true;
    };
  }, [chosen, chosenType, name, view, release, inProject, project, client]);

  /** The package for the panel: the org's files with your edits, or the project's version. */
  const build = async () => {
    const version = await client.version();
    if (release === 'project') {
      if (!project.source || !project.info) throw new Error('Open a project first (Release › Project).');
      const { fs, handle } = project.source;
      return projectMetadataZip({
        fs,
        info: project.info,
        deploy: [{ type: chosenType, name }],
        apiVersion: version,
        readBytes: handle ? (path) => folderBytes(handle, path) : undefined,
      });
    }
    if (!files) throw new Error('The files are not retrieved yet.');
    if (files.some((f) => f.text === null))
      throw new Error('This component has binary files: deploy it from the project.');
    return {
      zip: makeZip([
        { path: 'package.xml', content: packageXml([{ type: chosenType, fullName: name }], version) },
        ...files.map((f) => ({ path: f.path, content: drafts[f.path] ?? f.text ?? '' })),
      ]),
    };
  };

  const findTests = async () =>
    release === 'project' && project.source && project.info
      ? projectTests(project.source.fs, project.info, [{ type: chosenType, name }])
      : testsForPackage(await apexSourcesFromOrg(client), [{ type: chosenType, name }]);

  // Compare: every path in either version
  const paths = [...new Set([...(files ?? []), ...(inProject?.files ?? [])].map((f) => f.path))].sort();
  const pairPath = paths.includes(comparePath) ? comparePath : paths[0] ?? '';
  const orgText = (path: string): string | null | undefined => {
    const f = files?.find((x) => x.path === path);
    return f ? drafts[path] ?? f.text : undefined;
  };
  const projectText = (path: string): string | null | undefined => inProject?.files.find((x) => x.path === path)?.text;
  const differs = (path: string): boolean => orgText(path) !== projectText(path);

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
              setType(e.target.value);
            }}
            style={{ minWidth: 220 }}
          >
            {typeList.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <Status text={status} />
      </div>
      {type === 'Profile' && (
        <p className="muted">
          A profile file holds only the settings that go with the other components in the same retrieve: to change a
          profile, use Access › Permissions.
        </p>
      )}
      <div className="code-layout">
        <div className="card code-list">
          <input
            placeholder={`Filter ${members?.length ?? ''}`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {members === null && <p className="muted">Loading…</p>}
          <ul>
            {shown.map((m) => (
              <li key={m.fullName}>
                <button
                  className={chosen?.fullName === m.fullName ? 'active' : ''}
                  onClick={() => setChosen(m)}
                  title={`${m.fullName}\n${m.fileName}`}
                >
                  {m.fullName}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div>
          {chosen && (
            <>
              <div className="form">
                <b>{chosen.fullName}</b>
                <span className="muted">
                  {chosen.lastModifiedByName ? `${chosen.lastModifiedByName} · ` : ''}
                  {chosen.lastModifiedDate?.slice(0, 10) ?? ''}
                  {chosen.manageableState && chosen.manageableState !== 'unmanaged'
                    ? ` · ${chosen.manageableState}`
                    : ''}
                </span>
                <span className="grow" />
                <div className="tabs">
                  <button className={`tab ${view === 'source' ? 'active' : ''}`} onClick={() => setView('source')}>
                    Source
                  </button>
                  <button
                    className={`tab ${view === 'project' ? 'active' : ''}`}
                    disabled={!project.source}
                    title={project.source ? 'Its files in the project' : 'Open a project first (Release › Project)'}
                    onClick={() => setView('project')}
                  >
                    Project
                  </button>
                  <button
                    className={`tab ${view === 'compare' ? 'active' : ''}`}
                    disabled={!project.source}
                    title={project.source ? 'The org and the project side by side' : 'Open a project first'}
                    onClick={() => setView('compare')}
                  >
                    Compare
                  </button>
                  <button
                    className={`tab ${view === 'deps' ? 'active' : ''}`}
                    disabled={!chosen.id}
                    title={chosen.id ? 'What it uses and what uses it' : 'Salesforce gives no Id for this type'}
                    onClick={() => setView('deps')}
                  >
                    Dependencies
                  </button>
                </div>
                {view === 'source' && files && (
                  <button disabled={!changed.length} onClick={() => setDrafts({})}>
                    Undo
                  </button>
                )}
                {files && (
                  <button
                    className={release === 'edits' ? 'primary active' : 'primary'}
                    onClick={() => setRelease(release === 'edits' ? null : 'edits')}
                    title="Validate, deploy or quick deploy the org's files with your edits, with the tests you choose"
                  >
                    Validate / deploy {changed.length ? `${changed.length} edited file(s)` : ''}…
                  </button>
                )}
                {project.source && (
                  <button
                    className={release === 'project' ? 'active' : ''}
                    onClick={() => setRelease(release === 'project' ? null : 'project')}
                    title="Validate, deploy or quick deploy the project's version"
                  >
                    Deploy from project…
                  </button>
                )}
              </div>
              {release && (
                <ReleasePanel
                  key={`${release}:${chosenType}:${name}`}
                  deployCount={1}
                  removeCount={0}
                  from={release === 'project' ? `the project (${chosenType} ${name})` : `your edits of ${name}`}
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
              {view === 'project' || view === 'compare' ? (
                !inProject ? (
                  <p className="muted">Reading the project…</p>
                ) : inProject.problem ? (
                  <p className="muted">{inProject.problem}</p>
                ) : (
                  <>
                    <div className="tabs">
                      {(view === 'project' ? inProject.files.map((f) => f.path) : paths).map((path) => (
                        <button
                          key={path}
                          className={`tab ${path === pairPath ? 'active' : ''}`}
                          onClick={() => setComparePath(path)}
                        >
                          {path.split('/').pop()}
                          {view === 'compare' && differs(path) ? ' •' : ''}
                        </button>
                      ))}
                    </div>
                    {view === 'project' ? (
                      <div className="editor-box">
                        <CodeEditor
                          language={languageOf(pairPath)}
                          value={projectText(pairPath) ?? '(binary file)'}
                          onChange={() => undefined}
                          readOnly
                        />
                      </div>
                    ) : orgText(pairPath) === null || projectText(pairPath) === null ? (
                      <p className="muted">{pairPath}: a binary file, not compared.</p>
                    ) : (
                      <>
                        <p className="muted" style={{ margin: 0 }}>
                          {paths.filter(differs).length
                            ? `${paths.filter(differs).length} of ${paths.length} file(s) differ (•).`
                            : 'The org and the project are the same.'}
                          {orgText(pairPath) === undefined ? ' This file is only in the project.' : ''}
                          {projectText(pairPath) === undefined ? ' This file is only in the org.' : ''}
                        </p>
                        <div className="compare-diff-editor">
                          <CodeDiff
                            original={orgText(pairPath) ?? ''}
                            modified={projectText(pairPath) ?? ''}
                            language={languageOf(pairPath)}
                            labels={[`${chosen.fullName} in the org`, 'the project']}
                          />
                        </div>
                      </>
                    )}
                  </>
                )
              ) : view === 'source' ? (
                !files ? null : (
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
                    {current && current.text === null ? (
                      <p className="muted">
                        {current.path}: a binary file ({current.size.toLocaleString()} bytes), not shown.
                      </p>
                    ) : (
                      current && (
                        <div className="editor-box">
                          <CodeEditor
                            language={languageOf(current.path)}
                            value={drafts[current.path] ?? current.text ?? ''}
                            onChange={(v) => setDrafts({ ...drafts, [current.path]: v })}
                            readOnly={chosen.manageableState === 'installed' && chosen.type !== 'Layout'}
                          />
                        </div>
                      )
                    )}
                  </>
                )
              ) : (
                <Dependencies id={chosen.id!} name={chosen.fullName} />
              )}
            </>
          )}
          {!chosen && members && <p className="muted">Choose a {type} on the left.</p>}
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
