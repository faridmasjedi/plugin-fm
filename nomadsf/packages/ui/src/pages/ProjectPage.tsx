import { useEffect, useState } from 'react';
import {
  checkComponentsWithOrg,
  componentFilePaths,
  folderBytes,
  parsePackageXml,
  projectLabels,
  projectMetadataZip,
  projectTests,
  type ProjectTypeSummary,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { ProjectCompare } from '../components/ProjectCompare';
import { PackageContents } from '../components/PackageContents';
import { ReleasePanel } from '../components/ReleasePanel';
import { RowActionBar, RowActionSelect, withAction, type RowAction } from '../components/RowActions';
import { useProject } from '../project';
import { storage, type Studio } from '../context';
import { Status } from '../statusLog';

/** The Salesforce project (repository): package directories, types, manifests, compare with the org. */
export function ProjectPage({
  studio,
  onOpenMetadata,
  onOpenSettings,
  onOpenCode,
}: {
  studio: Studio | null;
  onOpenMetadata: () => void;
  onOpenSettings: () => void;
  onOpenCode?: () => void;
}) {
  const project = useProject();
  const [type, setType] = useState<ProjectTypeSummary | null>(null);
  const [status, setStatus] = useState('');
  const [tab, setTab] = useState<'overview' | 'compare'>(() => storage.get('project.tab', 'overview'));
  // Overview: components put into a package or made destructive changes (type:name → action), and the ticked ones
  const [actions, setActions] = useState<Map<string, RowAction>>(new Map());
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const { source, info } = project;
  // The labels file is its labels: opening CustomLabels lists each one (type CustomLabel)
  const [labels, setLabels] = useState<string[]>();
  useEffect(() => {
    setLabels(undefined);
    if (type?.type !== 'CustomLabels' || !source || !info) return;
    let canceled = false;
    projectLabels(source.fs, info)
      .then((names) => !canceled && setLabels(names))
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [type, source, info]);
  const shown: ProjectTypeSummary | null =
    type?.type === 'CustomLabels' && labels
      ? { ...type, type: 'CustomLabel', names: labels, count: labels.length }
      : type;
  const keyOf = (t: string, name: string): string => `${t}:${name}`;
  const listed = (kind: RowAction): Array<{ type: string; name: string }> =>
    [...actions]
      .filter(([, a]) => a === kind)
      .map(([key]) => ({ type: key.slice(0, key.indexOf(':')), name: key.slice(key.indexOf(':') + 1) }));
  const toDeploy = listed('deploy');
  /** A whole type's action: the same for every component of it, else none (some chosen one by one). */
  const typeAction = (t: ProjectTypeSummary): RowAction | undefined => {
    const first = actions.get(keyOf(t.type, t.names[0] ?? ''));
    return first && t.names.every((n) => actions.get(keyOf(t.type, n)) === first) ? first : undefined;
  };
  const toDelete = listed('delete');

  const openManifest = async (path: string) => {
    const text = source ? await source.fs.readText(path) : undefined;
    if (!text) return setStatus(`❌ Could not read ${path}.`);
    project.openPackage({ label: path, types: parsePackageXml(text) });
    onOpenMetadata();
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Project</h2>
        {!source && <span className="muted">Your Salesforce project, next to the org</span>}
        {source && (
          <span className="muted">
            <b>{source.name}</b> · {{ local: 'NomadSF app', folder: 'Folder', github: 'GitHub' }[source.kind]}
            {source.path ? <span className="mono"> · {source.path}</span> : null}
          </span>
        )}
        {source && (
          <button className="link" onClick={onOpenSettings}>
            Change
          </button>
        )}
        <span className="grow" />
        {source && (
          <button onClick={() => void project.refresh()} disabled={project.loading}>
            Refresh
          </button>
        )}
      </div>

      {!source && !project.loading && (
        <div className="card section empty-project">
          <h3>No project selected</h3>
          <p className="muted" style={{ margin: 0 }}>
            Choose your Salesforce project (a folder on this computer or a GitHub repository) in Settings. Every page
            then uses it.
          </p>
          <div className="form">
            <button className="primary" onClick={onOpenSettings}>
              Choose a project in Settings
            </button>
          </div>
        </div>
      )}

      {project.loading && <p className="muted">Reading the project…</p>}
      {project.error && <div className="error">{project.error}</div>}
      {status && <Status text={status} block />}

      {info && (
        <>
          <div className="metrics">
            <div className="metric">
              <b>{info.packageDirectories.reduce((n, d) => n + d.total, 0)}</b>components
            </div>
            <div className="metric">
              <b>{info.packageDirectories.length}</b>package directories
            </div>
            <div className="metric">
              <b>{info.manifests.length}</b>manifests
            </div>
            <div className="metric">
              <b style={{ fontSize: 14 }}>{info.sourceApiVersion ?? '—'}</b>API version
            </div>
            {info.branch && (
              <div className="metric">
                <b style={{ fontSize: 14 }}>{info.branch}</b>branch
              </div>
            )}
            {info.namespace && (
              <div className="metric">
                <b style={{ fontSize: 14 }}>{info.namespace}</b>namespace
              </div>
            )}
          </div>

          <div className="tabs">
            {(
              [
                ['overview', 'Overview'],
                ['compare', `Compare with ${studio?.org.label ?? 'the org'}`],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                className={`tab ${tab === id ? 'active' : ''}`}
                onClick={() => {
                  setTab(id);
                  storage.set('project.tab', id);
                }}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'compare' &&
            (studio ? (
              <ProjectCompare studio={studio} info={info} onOpenCode={onOpenCode} />
            ) : (
              <p className="muted">Connect an org to compare the project with it.</p>
            ))}

          {tab === 'overview' && (
            <div className="split">
              <div className="card section">
                {info.packageDirectories.map((dir) => (
                  <div key={dir.path} className="section">
                    <h3>
                      {dir.path} {dir.default && <span className="pill">default</span>}{' '}
                      {dir.package && (
                        <span className="pill good">
                          {dir.package} {dir.versionNumber}
                        </span>
                      )}
                    </h3>
                    <DataTable
                      columns={['type', 'count', 'action']}
                      rows={dir.types.map((t) => ({ ...t, key: `${dir.path}:${t.type}`, action: typeAction(t) ?? '' }))}
                      rowKey="key"
                      name={`${dir.path}-types`}
                      renderCell={(column, row) => {
                        if (column !== 'action') return undefined;
                        const t = dir.types.find((x) => x.type === row.type);
                        if (!t) return undefined;
                        if (t.type === 'CustomLabels')
                          return <span className="muted small">open it: label by label</span>;
                        const chosen = t.names.filter((n) => actions.has(keyOf(t.type, n))).length;
                        return (
                          <span className="type-action">
                            <RowActionSelect
                              value={typeAction(t)}
                              onChange={(a) => setActions(withAction(actions, t.names, a, (n) => keyOf(t.type, n)))}
                            />
                            {chosen > 0 && !typeAction(t) && (
                              <span className="muted small">
                                {chosen}/{t.names.length}
                              </span>
                            )}
                          </span>
                        );
                      }}
                      onRowClick={(row) => {
                        setType(dir.types.find((t) => t.type === row.type) ?? null);
                        setTicked(new Set());
                      }}
                      note={<span>· click a type</span>}
                    />
                  </div>
                ))}
                {info.manifests.length > 0 && (
                  <div className="section">
                    <h3>Manifests</h3>
                    <DataTable
                      columns={['path', 'types', 'members']}
                      rows={info.manifests.map((m) => ({ ...m }))}
                      rowKey="path"
                      name="manifests"
                      onRowClick={(row) => void openManifest(String(row.path))}
                      note={<span>· click to load into Metadata</span>}
                    />
                  </div>
                )}
              </div>

              <div className="card section">
                {!shown ? (
                  <p className="muted">
                    Click a type to see its components or put them in a package. To compare with the org, open the
                    Compare tab.
                  </p>
                ) : (
                  <>
                    <h3>
                      {shown.type} <span className="muted">({shown.count} in the project)</span>
                    </h3>
                    <div className="form">
                      <button
                        onClick={() =>
                          setActions(withAction(actions, shown.names, 'deploy', (n) => keyOf(shown.type, n)))
                        }
                      >
                        Add all to package
                      </button>
                      <button
                        className="danger"
                        onClick={() =>
                          setActions(withAction(actions, shown.names, 'delete', (n) => keyOf(shown.type, n)))
                        }
                      >
                        All as destructive changes
                      </button>
                      <span className="grow" />
                      <button
                        title="Retrieve these from the org in Release › Metadata"
                        onClick={() => {
                          project.openPackage({
                            label: `${shown.type} from ${info.name}`,
                            types: [{ type: shown.type, members: shown.names }],
                          });
                          onOpenMetadata();
                        }}
                      >
                        Open in Metadata ›
                      </button>
                    </div>
                    {ticked.size > 0 && (
                      <div className="form">
                        <span className="muted">{ticked.size} ticked</span>
                        <RowActionBar
                          deployable={ticked.size}
                          deletable={ticked.size}
                          ticked={ticked.size}
                          onSet={(a) => setActions(withAction(actions, [...ticked], a, (n) => keyOf(shown.type, n)))}
                        />
                      </div>
                    )}
                    <DataTable
                      columns={['name', 'action']}
                      rows={shown.names.map((name) => ({ name, action: actions.get(keyOf(shown.type, name)) ?? '' }))}
                      rowKey="name"
                      name={`${shown.type}-components`}
                      selected={ticked}
                      onSelectedChange={setTicked}
                      renderCell={(column, row) =>
                        column === 'action' ? (
                          <RowActionSelect
                            value={actions.get(keyOf(shown.type, String(row.name)))}
                            onChange={(a) =>
                              setActions(withAction(actions, [String(row.name)], a, (n) => keyOf(shown.type, n)))
                            }
                          />
                        ) : undefined
                      }
                    />
                  </>
                )}
              </div>
            </div>
          )}

          {tab === 'overview' && studio && source && (toDeploy.length > 0 || toDelete.length > 0) && (
            <>
              <div className="form">
                <span className="muted">{`Package: ${toDeploy.length} to deploy · ${toDelete.length} to delete (from every type)`}</span>
                <button onClick={() => setActions(new Map())}>Clear all actions</button>
              </div>
              <PackageContents
                deploy={toDeploy}
                remove={toDelete}
                listFiles={(list) => componentFilePaths(source.fs, info, list)}
                loadCode={async (c) => {
                  const side = {
                    fs: source.fs,
                    info,
                    readBytes: source.handle ? (path: string) => folderBytes(source.handle!, path) : undefined,
                  };
                  const found = (await checkComponentsWithOrg(studio.client, side, [c])).get(`${c.type}:${c.name}`);
                  return {
                    before: found?.org.length ? found.org : undefined,
                    after: found?.repo.length ? found.repo : undefined,
                    labels: [studio.org.label, `the project ${info.name}`],
                  };
                }}
              />
              <ReleasePanel
                studio={studio}
                key={[...actions]
                  .map(([k, a]) => `${a}:${k}`)
                  .sort()
                  .join(',')}
                deployCount={toDeploy.length}
                removeCount={toDelete.length}
                from={`the project ${info.name}`}
                build={async (removeWhen) =>
                  projectMetadataZip({
                    fs: source.fs,
                    info,
                    deploy: toDeploy,
                    remove: toDelete,
                    removeWhen,
                    apiVersion: await studio.client.version(),
                    readBytes: source.handle ? (path) => folderBytes(source.handle!, path) : undefined,
                  })
                }
                findTests={toDeploy.length ? () => projectTests(source.fs, info, toDeploy) : undefined}
                zipName={`${info.name}-package.zip`}
              />
            </>
          )}
        </>
      )}
    </div>
  );
}
