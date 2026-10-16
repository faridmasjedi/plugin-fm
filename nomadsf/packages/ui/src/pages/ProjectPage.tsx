import { useState } from 'react';
import { listMetadata, parsePackageXml, type ProjectTypeSummary } from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { GitHubCard } from '../components/GitHubCard';
import { useProject } from '../project';
import type { Studio } from '../context';

type Comparison = {
  type: string;
  rows: Array<{ name: string; where: string }>;
  onlyOrg: number;
  onlyProject: number;
  both: number;
};

const FOLDER_BASED = new Set(['Report', 'Dashboard', 'Document', 'EmailTemplate']);

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
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [status, setStatus] = useState('');
  const [switchPath, setSwitchPath] = useState('');
  const { source, info } = project;

  const openManifest = async (path: string) => {
    const text = source ? await source.fs.readText(path) : undefined;
    if (!text) return setStatus(`❌ Could not read ${path}.`);
    project.openPackage({ label: path, types: parsePackageXml(text) });
    onOpenMetadata();
  };

  const compare = async (t: ProjectTypeSummary) => {
    if (!studio) return setStatus('Connect an org to compare.');
    setStatus(`Listing ${t.type} in ${studio.org.label}…`);
    try {
      const inOrg = new Set(
        (await listMetadata(studio.client, t.type, FOLDER_BASED.has(t.type)))
          .filter((c) => c.type === t.type)
          .map((c) => c.fullName)
      );
      const inProject = new Set(t.names);
      const names = [...new Set([...inOrg, ...inProject])].sort();
      const rows = names.map((name) => ({
        name,
        where: inOrg.has(name) && inProject.has(name) ? 'both' : inOrg.has(name) ? 'only in org' : 'only in project',
      }));
      setComparison({
        type: t.type,
        rows,
        onlyOrg: rows.filter((r) => r.where === 'only in org').length,
        onlyProject: rows.filter((r) => r.where === 'only in project').length,
        both: rows.filter((r) => r.where === 'both').length,
      });
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

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
        <div className="card section">
          <h3>From the local NomadSF app</h3>
          {project.localAvailable ? (
            <>
              <p className="muted" style={{ margin: 0 }}>
                The project of <code>sf fm dashboard</code>. Runs, runbooks and retrieve follow the project you choose
                here.
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
              Not running. Start <code>sf fm dashboard</code> in a Salesforce project to use it here (runs, runbooks,
              retrieve into the project).
            </p>
          )}
        </div>
        <div className="card section">
          <h3>From a folder on this computer</h3>
          {project.canPickFolder ? (
            <>
              <p className="muted" style={{ margin: 0 }}>
                Read-only access to a repository folder you choose; nothing is uploaded. Works without the CLI.
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
                      setComparison(null);
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
                  Click a type to see its components, compare them with the org, or put them in a package.
                </p>
              ) : (
                <>
                  <h3>
                    {type.type} <span className="muted">({type.count} in the project)</span>
                  </h3>
                  <div className="form">
                    <button className="primary" disabled={!studio} onClick={() => void compare(type)}>
                      Compare with {studio?.org.label ?? 'the org'}
                    </button>
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
                  {comparison && comparison.type === type.type ? (
                    <>
                      <div className="metrics">
                        <div className="metric">
                          <b>{comparison.both}</b>in both
                        </div>
                        <div className={`metric ${comparison.onlyOrg ? 'bad' : ''}`}>
                          <b>{comparison.onlyOrg}</b>only in org
                        </div>
                        <div className={`metric ${comparison.onlyProject ? 'bad' : ''}`}>
                          <b>{comparison.onlyProject}</b>only in project
                        </div>
                      </div>
                      <DataTable
                        columns={['name', 'where']}
                        rows={comparison.rows}
                        rowKey="name"
                        name={`${type.type}-compare`}
                      />
                    </>
                  ) : (
                    <DataTable
                      columns={['name']}
                      rows={type.names.map((name) => ({ name }))}
                      rowKey="name"
                      name={`${type.type}-components`}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
