import { useCallback, useEffect, useState } from 'react';
import { DataTable } from '../components/DataTable';
import { localAppBase } from '../project';

type RunStage = {
  id: string;
  uses: string;
  startedAt?: string;
  targetOrg?: string;
  status: string;
  result?: { tests?: Array<Record<string, unknown>>; stats?: Record<string, number> };
};
type Run = { id: string; stages: RunStage[] };

/** Playwright scenarios of the project, run by the local NomadSF app (`sf fm e2e run`). */
export function TestsPage({ hostKind, defaultOrg }: { hostKind: 'app' | 'extension'; defaultOrg?: string }) {
  const base = localAppBase(hostKind);
  const [specs, setSpecs] = useState<string[] | null>(null);
  const [hasConfig, setHasConfig] = useState(false);
  const [orgs, setOrgs] = useState<string[]>([]);
  const [org, setOrg] = useState(defaultOrg ?? '');
  const [grep, setGrep] = useState('');
  const [last, setLast] = useState<{ run: Run; stage: RunStage } | null>(null);
  const [status, setStatus] = useState('');

  const load = useCallback(async () => {
    try {
      const [specRes, orgRes, runRes] = await Promise.all([
        fetch(`${base}/api/e2e/specs`),
        fetch(`${base}/api/orgs`),
        fetch(`${base}/api/runs`),
      ]);
      const info = (await specRes.json()) as { specs: string[]; hasConfig: boolean };
      setSpecs(info.specs);
      setHasConfig(info.hasConfig);
      const cliOrgs = ((await orgRes.json()) as Array<{ alias?: string; username: string }>).map(
        (o) => o.alias ?? o.username
      );
      setOrgs(cliOrgs);
      setOrg((current) => current || cliOrgs[0] || '');
      const runs = (await runRes.json()) as Run[];
      const found = runs.flatMap((run) =>
        run.stages.filter((s) => s.uses === 'e2e' && s.result).map((stage) => ({ run, stage }))
      )[0];
      setLast(found ?? null);
      setStatus('');
    } catch {
      setSpecs(null);
      setStatus(
        hostKind === 'app'
          ? 'Could not reach the app.'
          : `Start the local app (sf fm dashboard) to run Playwright scenarios.`
      );
    }
  }, [base, hostKind]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async () => {
    setStatus('Starting…');
    const res = await fetch(`${base}/api/e2e/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fm-dashboard': '1' },
      body: JSON.stringify({ org, grep: grep.trim() }),
    });
    const body = (await res.json()) as { error?: string };
    setStatus(
      res.ok && !body.error
        ? 'Running — see Runs for the live log. Refresh here for the results.'
        : `❌ ${body.error ?? res.statusText}`
    );
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>E2E tests</h2>
        <span className="muted">Playwright scenarios of the project, logged in through the frontdoor URL</span>
        <span className="grow" />
        <button onClick={() => void load()}>Refresh</button>
      </div>
      {status && <p className="muted">{status}</p>}
      {specs !== null && !hasConfig && (
        <div className="card section">
          <h3>No Playwright setup in this project yet</h3>
          <pre className="chip" style={{ padding: 10 }}>
            {'sf fm e2e init\nnpm install --save-dev @playwright/test\nnpx playwright install chromium'}
          </pre>
        </div>
      )}
      {specs !== null && hasConfig && (
        <div className="card section">
          <div className="form">
            <label>
              Org (CLI)
              <select value={org} onChange={(e) => setOrg(e.target.value)}>
                {orgs.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </select>
            </label>
            <label>
              Only tests matching
              <input value={grep} onChange={(e) => setGrep(e.target.value)} placeholder="optional" />
            </label>
            <button className="primary" disabled={!org} onClick={() => void run()}>
              Run on {org}
            </button>
            <a href={`${base}/api/e2e/report/`} target="_blank" rel="noreferrer">
              Last HTML report ↗
            </a>
          </div>
          <div className="chips">
            {specs.map((s) => (
              <span key={s} className="chip">
                {s}
              </span>
            ))}
          </div>
        </div>
      )}
      {last && (
        <div className="card section">
          <h3>
            Last results{' '}
            <span className="muted">
              · {last.stage.targetOrg} · {last.stage.startedAt ? new Date(last.stage.startedAt).toLocaleString() : ''}
            </span>
          </h3>
          <DataTable
            columns={['status', 'title', 'file', 'durationMs', 'retries', 'error']}
            rows={last.stage.result?.tests ?? []}
            rowKey="__none"
            name="e2e-results"
          />
        </div>
      )}
    </div>
  );
}
