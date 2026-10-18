import { useState } from 'react';
import { parsePackageXml, type ProjectTypeSummary } from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { GitHubCard } from '../components/GitHubCard';
import { ProjectCompare } from '../components/ProjectCompare';
import { useProject } from '../project';
import type { Studio } from '../context';

/** The Salesforce project (repository): package directories, types, manifests, compare with the org. */
export function ProjectPage({
  studio,
  hostKind,
  onOpenMetadata,
}: {
  studio: Studio | null;
  hostKind: 'app' | 'extension';
  onOpenMetadata: () => void;
}) {
  const project = useProject();
  const [type, setType] = useState<ProjectTypeSummary | null>(null);
  const [status, setStatus] = useState('');
  const [switchPath, setSwitchPath] = useState('');
  const { source, info } = project;

  const openManifest = async (path: string) => {
    const text = source ? await source.fs.readText(path) : undefined;
    if (!text) return setStatus(`❌ Could not read ${path}.`);
    project.openPackage({ label: path, types: parsePackageXml(text) });
    onOpenMetadata();
  };

  // Only the app (sf fm dashboard) has a project of its own; the extension uses a folder or GitHub
  const localCard = (
    <div className="card section">
      <h3>Projects of this app</h3>
      {project.localAvailable ? (
        <>
          <p className="muted" style={{ margin: 0 }}>
            Your Salesforce project as opened by <code>sf fm dashboard</code> on this computer. Runs, runbooks, AI help
            and retrieve into the project follow the project you choose here.
          </p>
          <div className="form">
            <button className={source?.kind === 'local' ? '' : 'primary'} onClick={() => void project.useLocal()}>
              Use the local app project
            </button>
            {project.recent.length > 0 && (
              <select value="" onChange={(e) => e.target.value && void project.switchLocal(e.target.value)}>
                <option value="">Switch to a recent project…</option>
                {project.recent.map((r) => (
                  <option key={r.path} value={r.path}>
                    {r.name} — {r.path}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="form">
            <input
              placeholder="/path/to/salesforce-project"
              value={switchPath}
              onChange={(e) => setSwitchPath(e.target.value)}
              style={{ minWidth: 300 }}
            />
            <button disabled={!switchPath.trim()} onClick={() => void project.switchLocal(switchPath.trim())}>
              Open project
            </button>
          </div>
        </>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          Could not reach the app. Is <code>sf fm dashboard</code> still running?
        </p>
      )}
    </div>
  );

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Project</h2>
        {source && (
          <span className="muted">
            {{ local: 'Local app', folder: 'Browser folder', github: 'GitHub' }[source.kind]} · <b>{source.name}</b>
            {source.path ? <span className="mono"> · {source.path}</span> : null}
          </span>
        )}
        <span className="grow" />
        {source && (
          <button onClick={() => void project.refresh()} disabled={project.loading}>
            Refresh
          </button>
        )}
      </div>

      <div className="grid3">
        {hostKind === 'app' && localCard}
        <div className="card section">
          <h3>From a folder on this computer</h3>
          {project.canPickFolder ? (
            <>
              <p className="muted" style={{ margin: 0 }}>
                Read-only access to a project folder you choose; nothing is uploaded.
              </p>
              <div className="form">
                <button
                  className={source?.kind === 'folder' ? '' : 'primary'}
                  onClick={() => void project.pickFolder().catch(() => undefined)}
                >
                  Choose project folder…
                </button>
                {project.needsPermission && (
                  <button onClick={() => void project.reconnectFolder()}>Reconnect the last folder</button>
                )}
              </div>
            </>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              This browser cannot open folders (use Chrome or Edge).
            </p>
          )}
        </div>
        <GitHubCard hostKind={hostKind} />
      </div>

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

          {studio ? (
            <ProjectCompare studio={studio} info={info} />
          ) : (
            <p className="muted">Connect an org to compare the project with it.</p>
          )}

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
                  Click a type to see its components or put them in a package. To compare with the org, use Compare
                  above.
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
        </>
      )}
    </div>
  );
}
