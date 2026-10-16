import { useCallback, useEffect, useState } from 'react';
import { storage } from '../context';

/** Dashboard pages that need the local NomadSF app (CLI, git, pipelines). */
export const LOCAL_PAGES = [
  { id: 'local-runs', page: 'runs', label: 'Runs & approvals', icon: '⛭' },
  { id: 'local-runbooks', page: 'runbooks', label: 'Runbooks (AI)', icon: '✦' },
  { id: 'local-repo', page: 'repo', label: 'Repository', icon: '⑂' },
  { id: 'local-orgs', page: 'orgs', label: 'CLI orgs', icon: '☁' },
  { id: 'local-ai', page: 'ai', label: 'AI settings', icon: '⚙' },
] as const;

type Status = 'checking' | 'up' | 'down';

/**
 * Shows a page of the local NomadSF app (`sf fm dashboard`) inside the extension.
 * The app only listens on 127.0.0.1 and allows being framed by extensions only.
 */
export function LocalAppPage({ page }: { page: string }) {
  const [port, setPort] = useState<number>(() => storage.get('local.port', 7007));
  const [status, setStatus] = useState<Status>('checking');
  const base = `http://127.0.0.1:${port}`;

  const check = useCallback(async () => {
    setStatus('checking');
    try {
      const res = await fetch(`${base}/api/info`, { cache: 'no-store' });
      setStatus(res.ok ? 'up' : 'down');
    } catch {
      setStatus('down');
    }
  }, [base]);

  useEffect(() => {
    void check();
  }, [check]);

  if (status !== 'up') {
    return (
      <div className="page">
        <div className="card section">
          <h3>Local NomadSF app</h3>
          {status === 'checking' ? (
            <p className="muted">Looking for the local app on {base}…</p>
          ) : (
            <>
              <p style={{ margin: 0 }}>
                Pipelines, runbooks and the repository run on your machine. Start the local app in your Salesforce
                project, then retry:
              </p>
              <pre className="chip" style={{ padding: 10 }}>
                sf fm dashboard --port {port}
              </pre>
              <div className="form">
                <label>
                  Port
                  <input
                    type="number"
                    value={port}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setPort(value);
                      storage.set('local.port', value);
                    }}
                    style={{ width: 110 }}
                  />
                </label>
                <button className="primary" onClick={() => void check()}>
                  Retry
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="local-frame">
      <div className="local-bar muted">
        Local app · {base}
        <span className="grow" />
        <a href={`${base}/#page=${page}`} target="_blank" rel="noreferrer">
          Open in a tab ↗
        </a>
      </div>
      <iframe title="NomadSF local app" src={`${base}/?embedded=1#page=${page}`} />
    </div>
  );
}
