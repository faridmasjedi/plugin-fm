import { useState } from 'react';
import { GitHubCard } from '../components/GitHubCard';
import { OrgSettings } from '../components/OrgSettings';
import type { OrgChoice } from '../host';
import { storage } from '../context';
import { localAppEnabled, useProject } from '../project';

const SOURCE_LABEL = { local: 'NomadSF app', folder: 'Folder on this computer', github: 'GitHub' } as const;

/** Settings: the org and the Salesforce project every page uses, and (extension) where the NomadSF CLI app runs. */
export function SettingsPage({
  hostKind,
  onOpenProject,
  orgs,
  orgId,
  onSwitchOrg,
  onRefreshOrgs,
}: {
  hostKind: 'app' | 'extension';
  onOpenProject: () => void;
  orgs: OrgChoice[];
  orgId: string;
  onSwitchOrg: (id: string) => void;
  onRefreshOrgs: () => void;
}) {
  const project = useProject();
  const { source, info } = project;
  const [switchPath, setSwitchPath] = useState('');
  const [port, setPort] = useState<number>(() => storage.get('local.port', 7007));
  const [useLocalApp, setUseLocalApp] = useState(localAppEnabled);

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Settings</h2>
      </div>

      <OrgSettings
        hostKind={hostKind}
        orgs={orgs}
        orgId={orgId}
        onSwitchOrg={onSwitchOrg}
        onRefreshOrgs={onRefreshOrgs}
      />

      <div className="card section">
        <h3>Project</h3>
        {source ? (
          <div className="form">
            <span>
              <b>{source.name}</b> <span className="muted">· {SOURCE_LABEL[source.kind]}</span>
              {source.path ? <span className="muted mono"> · {source.path}</span> : null}
              {info && (
                <span className="muted">
                  {' '}
                  · {info.packageDirectories.reduce((n, d) => n + d.total, 0).toLocaleString()} components
                </span>
              )}
            </span>
            <span className="grow" />
            <button onClick={() => void project.refresh()} disabled={project.loading}>
              Reload
            </button>
            <button className="primary" disabled={!info} onClick={onOpenProject}>
              Open Project
            </button>
          </div>
        ) : (
          <p className="muted" style={{ margin: 0 }}>
            No project yet. Choose one below; Project, compare, manifests and saved queries all use it.
          </p>
        )}
        {project.loading && <p className="muted">Reading the project…</p>}
        {project.error && <div className="error">{project.error}</div>}
      </div>

      <div className="grid3">
        {hostKind === 'app' && (
          <div className="card section">
            <h3>Projects of this app</h3>
            {project.localAvailable ? (
              <>
                <p className="muted" style={{ margin: 0 }}>
                  Your Salesforce project as opened by <code>sf fm dashboard</code> on this computer. Retrieve, deploy
                  and AI help follow the project you choose here.
                </p>
                <div className="form">
                  <button className={source?.kind === 'local' ? '' : 'primary'} onClick={() => void project.useLocal()}>
                    Use the app's project
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
                  />
                  <button disabled={!switchPath.trim()} onClick={() => void project.switchLocal(switchPath.trim())}>
                    Open
                  </button>
                </div>
              </>
            ) : (
              <p className="muted" style={{ margin: 0 }}>
                Could not reach the app. Is <code>sf fm dashboard</code> still running?
              </p>
            )}
          </div>
        )}
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

      {hostKind === 'extension' && (
        <div className="card section">
          <h3>NomadSF CLI app (optional)</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={useLocalApp}
              onChange={(e) => {
                setUseLocalApp(e.target.checked);
                storage.set('local.enabled', e.target.checked);
                // Look for it (or stop looking) right away
                location.reload();
              }}
            />{' '}
            Use the NomadSF CLI app on this computer
          </label>
          <p className="muted" style={{ margin: 0 }}>
            {!useLocalApp
              ? 'Off: the extension works on its own and never contacts the app. Switch it on if you run sf fm dashboard, for CLI orgs, AI help, E2E tests, restore and deploy.'
              : project.localAvailable
              ? `Found on this computer (port ${port}): CLI orgs, AI settings, E2E tests, restore and deploy are available.`
              : `Not running on port ${port}. Start it with the command below; the Studio finds it when you come back to this tab.`}
          </p>
          {useLocalApp && (
            <div className="form">
              <label>
                Port
                <input
                  type="number"
                  min={1024}
                  max={65535}
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  style={{ width: 110 }}
                />
              </label>
              <button
                disabled={port === storage.get('local.port', 7007)}
                onClick={() => {
                  storage.set('local.port', port);
                  // The Studio looks for the app on start
                  location.reload();
                }}
              >
                Save and reconnect
              </button>
              <code className="muted">sf fm dashboard --port {port}</code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
