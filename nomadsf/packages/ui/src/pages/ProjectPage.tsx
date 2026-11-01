import { useEffect, useState } from 'react';
import {
  checkComponentsWithOrg,
  componentFilePaths,
  folderBytes,
  parsePackageXml,
  projectLabels,
  projectMetadataZip,
  projectTests,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { ProjectCompare } from '../components/ProjectCompare';
import { PackageContents } from '../components/PackageContents';
import { ReleasePanel } from '../components/ReleasePanel';
import { GroupedActions } from '../components/GroupedActions';
import { type RowAction } from '../components/RowActions';
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
  const [status, setStatus] = useState('');
  const [tab, setTab] = useState<'overview' | 'compare'>(() => storage.get('project.tab', 'overview'));
  // Overview: components put into a package or made destructive changes (type:name → action)
  const [actions, setActions] = useState<Map<string, RowAction>>(new Map());
  const { source, info } = project;
  // The labels file is its labels: listed one by one (type CustomLabel)
  const [labels, setLabels] = useState<string[]>([]);
  useEffect(() => {
    setLabels([]);
    if (!source || !info) return undefined;
    let canceled = false;
    projectLabels(source.fs, info)
      .then((names) => !canceled && setLabels(names))
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [source, info]);
  // Every component of the project, its package directory beside it
  const overviewRows = (info?.packageDirectories ?? []).flatMap((dir) =>
    dir.types.flatMap((t) =>
      (t.type === 'CustomLabels' ? labels : t.names).map((name) => {
        const type = t.type === 'CustomLabels' ? 'CustomLabel' : t.type;
        // The package directory only says something when there are several
        const several = (info?.packageDirectories.length ?? 0) > 1;
        return { key: `${type}:${name}`, type, name, status: several ? dir.path : '' };
      })
    )
  );
  const listed = (kind: RowAction): Array<{ type: string; name: string }> =>
    [...actions]
      .filter(([, a]) => a === kind)
      .map(([key]) => ({ type: key.slice(0, key.indexOf(':')), name: key.slice(key.indexOf(':') + 1) }));
  const toDeploy = listed('deploy');
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
            <>
              {/* Every component by type, as Release's lists: a box per type, its components to put in a package */}
              <div className="card section">
                <div className="form">
                  {info.packageDirectories.map((dir) => (
                    <span key={dir.path}>
                      <b>{dir.path}</b> {dir.default && <span className="pill">default</span>}{' '}
                      {dir.package && (
                        <span className="pill good">
                          {dir.package} {dir.versionNumber}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
                <GroupedActions
                  rows={overviewRows}
                  actions={actions}
                  onActions={setActions}
                  allowed={() => true}
                  tone={() => ''}
                  groupExtra={(t, list) =>
                    t === 'CustomLabel' ? null : (
                      <button
                        title="Retrieve these from the org in Release › Metadata"
                        onClick={() => {
                          project.openPackage({
                            label: `${t} from ${info.name}`,
                            types: [{ type: t, members: list.map((r) => r.name) }],
                          });
                          onOpenMetadata();
                        }}
                      >
                        Open in Metadata ›
                      </button>
                    )
                  }
                />
              </div>
              {info.manifests.length > 0 && (
                <div className="card section">
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
            </>
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
