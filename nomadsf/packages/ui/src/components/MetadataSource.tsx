import { useEffect, useMemo, useState } from 'react';
import {
  dependenciesOf,
  deployComponent,
  describeMetadata,
  listMetadata,
  retrieveComponent,
  type ComponentFile,
  type Dependency,
  type MetadataComponent,
  type MetadataType,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { CodeEditor } from './CodeEditor';
import { DataTable } from './DataTable';

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

/**
 * Any metadata component (FlexiPage, Flow, permission set, layout…): its files from the org, edited
 * in place and validated or deployed; and what it uses and what uses it.
 */
export function MetadataSource({ initial }: { initial?: { type: string; fullName: string } }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [types, setTypes] = useState<MetadataType[]>([]);
  const [type, setType] = useState(() => initial?.type ?? storage.get('code.metaType', 'FlexiPage'));
  const [members, setMembers] = useState<MetadataComponent[] | null>(null);
  const [filter, setFilter] = useState('');
  const [chosen, setChosen] = useState<MetadataComponent | null>(null);
  const [files, setFiles] = useState<ComponentFile[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [fileIndex, setFileIndex] = useState(0);
  const [view, setView] = useState<'source' | 'deps'>('source');
  const [deps, setDeps] = useState<{ uses: Dependency[]; usedBy: Dependency[] } | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

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
    setDeps(null);
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

  useEffect(() => {
    if (view !== 'deps' || !chosen?.id || deps) return;
    dependenciesOf(client, chosen.id)
      .then(setDeps)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, view, chosen, deps]);

  const typeList = useMemo(() => {
    const names = types.map((t) => t.xmlName);
    return [...COMMON.filter((c) => names.includes(c)), ...names.filter((n) => !COMMON.includes(n)).sort()];
  }, [types]);
  const needle = filter.trim().toLowerCase();
  const shown = (members ?? []).filter((m) => !needle || m.fullName.toLowerCase().includes(needle));
  const changed = Object.entries(drafts).filter(([path, text]) => files?.find((f) => f.path === path)?.text !== text);
  const current = files?.[fileIndex];

  const send = async (checkOnly: boolean) => {
    if (!chosen || !files) return;
    const what = `${checkOnly ? 'Validate' : 'Deploy'} ${type} ${chosen.fullName} (${changed.length} changed file(s))`;
    if (!(await confirmChange(`${what} in ${org.label}`))) return;
    setBusy(true);
    setStatus(`${checkOnly ? 'Validating' : 'Deploying'}…`);
    try {
      const outcome = await deployComponent(
        client,
        chosen.type || type,
        chosen.fullName,
        files.map((f) => ({ ...f, text: drafts[f.path] ?? f.text })),
        { checkOnly, onProgress: (s) => setStatus(`${checkOnly ? 'Validating' : 'Deploying'}: ${s}…`) }
      );
      logActivity(checkOnly ? 'validate metadata' : 'deploy metadata', {
        type,
        name: chosen.fullName,
        success: outcome.success,
        id: outcome.id,
      });
      if (outcome.success) {
        setStatus(`✓ ${checkOnly ? 'Valid' : 'Deployed'} (${outcome.id}).`);
        if (!checkOnly) {
          setFiles(files.map((f) => ({ ...f, text: drafts[f.path] ?? f.text })));
          setDrafts({});
        }
      } else
        setStatus(
          `❌ ${[
            ...outcome.componentFailures.map((f) => `${f.name}${f.line ? `:${f.line}` : ''} ${f.problem}`),
            outcome.errorMessage,
          ]
            .filter(Boolean)
            .join('; ')}`
        );
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

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
        <span className="muted">{status}</span>
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
                    className={`tab ${view === 'deps' ? 'active' : ''}`}
                    disabled={!chosen.id}
                    title={chosen.id ? 'What it uses and what uses it' : 'Salesforce gives no Id for this type'}
                    onClick={() => setView('deps')}
                  >
                    Dependencies
                  </button>
                </div>
                {view === 'source' && files && (
                  <>
                    <button disabled={busy || !changed.length} onClick={() => setDrafts({})}>
                      Undo
                    </button>
                    <button disabled={busy} onClick={() => void send(true)} title="Checks the deploy without saving">
                      Validate…
                    </button>
                    <button className="primary" disabled={busy || !changed.length} onClick={() => void send(false)}>
                      Deploy {changed.length ? `${changed.length} file(s)` : ''}…
                    </button>
                  </>
                )}
              </div>
              {view === 'source' ? (
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
              ) : !deps ? (
                <p className="muted">Reading dependencies…</p>
              ) : (
                <>
                  <h4>Uses ({deps.uses.length})</h4>
                  <DataTable
                    columns={['type', 'name', 'namespace']}
                    rows={deps.uses}
                    rowKey="id"
                    name={`${chosen.fullName}-uses`}
                  />
                  <h4>Used by ({deps.usedBy.length})</h4>
                  <DataTable
                    columns={['type', 'name', 'namespace']}
                    rows={deps.usedBy}
                    rowKey="id"
                    name={`${chosen.fullName}-used-by`}
                    note={<span>· tracked by Salesforce for code, flows, pages, objects and fields</span>}
                  />
                </>
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
