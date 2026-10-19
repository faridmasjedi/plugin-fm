import { useState } from 'react';
import { parsePackageXml, type ProjectTypeSummary } from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { ProjectCompare } from '../components/ProjectCompare';
import { useProject } from '../project';
import { storage, type Studio } from '../context';

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
  const { source, info } = project;

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
      {status && <p className="muted">{status}</p>}

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
                      columns={['type', 'count', 'folder']}
                      rows={dir.types.map((t) => ({ ...t, key: `${dir.path}:${t.type}` }))}
                      rowKey="key"
                      name={`${dir.path}-types`}
                      onRowClick={(row) => {
                        setType(dir.types.find((t) => t.type === row.type) ?? null);
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
                {!type ? (
                  <p className="muted">
                    Click a type to see its components or put them in a package. To compare with the org, open the
                    Compare tab.
                  </p>
                ) : (
                  <>
                    <h3>
                      {type.type} <span className="muted">({type.count} in the project)</span>
                    </h3>
                    <div className="form">
                      <button
                        onClick={() => {
                          project.openPackage({
                            label: `${type.type} from ${info.name}`,
                            types: [{ type: type.type, members: type.names }],
                          });
                          onOpenMetadata();
                        }}
                      >
                        Add all to package
                      </button>
                    </div>
                    <DataTable
                      columns={['name']}
                      rows={type.names.map((name) => ({ name }))}
                      rowKey="name"
                      name={`${type.type}-components`}
                    />
                  </>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
