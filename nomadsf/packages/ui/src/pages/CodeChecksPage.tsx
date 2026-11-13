import { useMemo, useState } from 'react';
import {
  checkCode,
  checkKindOf,
  orgCodeFiles,
  projectFiles,
  type CheckFile,
  type CheckKind,
  type CodeFinding,
  type Severity,
} from '@nomadsf/core';
import { DataTable } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { useProject } from '../project';
import { Status } from '../statusLog';

type From = 'org' | 'project';
const KINDS: CheckKind[] = ['Apex class', 'Apex trigger', 'Visualforce', 'LWC', 'Aura'];
const SEVERITIES: Severity[] = ['High', 'Medium', 'Low'];

/**
 * Develop › Code checks: Apex, triggers, Visualforce, LWC and Aura — of the org or the project — checked for well-known
 * mistakes (injection, XSS, secrets in code, sharing, access checks, queries in loops…), each with why and how to fix.
 * Read only.
 */
export function CodeChecksPage() {
  const { client, org } = useStudio();
  const project = useProject();
  const [from, setFrom] = useState<From>(() => storage.get<From>('checks.from', 'org'));
  const [kinds, setKinds] = useState<Set<CheckKind>>(new Set(KINDS));
  const [found, setFound] = useState<CodeFinding[] | null>(null);
  const [checked, setChecked] = useState(0);
  const [show, setShow] = useState<Set<Severity>>(new Set(SEVERITIES));
  const [open, setOpen] = useState<CodeFinding | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setFound(null);
    setOpen(null);
    try {
      let files: CheckFile[] = [];
      if (from === 'org') {
        setStatus(`Reading the code of ${org.label}…`);
        files = await orgCodeFiles(client, [...kinds]);
      } else {
        if (!project.source || !project.info) throw new Error('Open a project first (Settings › Project).');
        setStatus(`Reading ${project.source.name}…`);
        const paths = (await projectFiles(project.source.fs, project.info)).filter((p) => {
          const k = checkKindOf(p);
          return k && kinds.has(k);
        });
        const texts = await Promise.all(paths.map((p) => project.source!.fs.readText(p)));
        files = paths.map((p, i) => ({
          kind: checkKindOf(p)!,
          name: p.split('/').slice(-2).join('/'),
          path: p,
          text: texts[i] ?? '',
        }));
      }
      setChecked(files.length);
      const out = checkCode(files);
      setFound(out);
      setStatus(`✓ ${files.length} file(s) checked: ${out.length} finding(s).`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  const count = (s: Severity) => found?.filter((f) => f.severity === s).length ?? 0;
  const rows = useMemo(
    () =>
      (found ?? [])
        .filter((f) => show.has(f.severity))
        .map((f, i) => ({
          Id: String(i),
          severity: f.severity,
          rule: f.rule,
          kind: f.kind,
          name: f.name,
          line: f.line,
          code: f.code,
        })),
    [found, show]
  );

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Code checks</h2>
        <span className="muted">Well-known mistakes in Apex, Visualforce, LWC and Aura — read only</span>
      </div>
      <div className="form">
        <div className="segmented" role="group" aria-label="Whose code">
          {(
            [
              ['org', `The org (${org.label})`],
              ['project', project.source ? `The project (${project.source.name})` : 'The project'],
            ] as Array<[From, string]>
          ).map(([id, label]) => (
            <button
              key={id}
              className={from === id ? 'active' : ''}
              disabled={id === 'project' && !project.source}
              title={id === 'project' && !project.source ? 'Open a project first (Settings › Project)' : undefined}
              onClick={() => {
                setFrom(id);
                storage.set('checks.from', id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="form">
        {KINDS.map((k) => (
          <label key={k} className="check">
            <input
              type="checkbox"
              checked={kinds.has(k)}
              onChange={() => {
                const next = new Set(kinds);
                if (next.has(k)) next.delete(k);
                else next.add(k);
                setKinds(next);
              }}
            />{' '}
            {k}
          </label>
        ))}
        <button className="primary" disabled={busy || !kinds.size} onClick={() => void run()}>
          Check
        </button>
      </div>
      {status && <Status text={status} block />}
      {found && (
        <div className="card section">
          <div className="form">
            {SEVERITIES.map((s) => (
              <button
                key={s}
                className={`chip severity-${s.toLowerCase()} ${show.has(s) ? 'on' : ''}`}
                onClick={() => {
                  const next = new Set(show);
                  if (next.has(s)) next.delete(s);
                  else next.add(s);
                  setShow(next);
                }}
              >
                {s} ({count(s)})
              </button>
            ))}
            <span className="muted small">{checked} file(s) checked · click a finding for why and how to fix it</span>
          </div>
          {found.length === 0 ? (
            <p className="muted">
              Nothing found. These are pattern rules: a clean result is not a full security review.
            </p>
          ) : (
            <DataTable
              name="code-checks"
              columns={['severity', 'rule', 'kind', 'name', 'line', 'code']}
              rows={rows}
              onRowClick={(r) => setOpen(found.filter((f) => show.has(f.severity))[Number(r.Id)] ?? null)}
            />
          )}
          {open && (
            <div className={`check-detail severity-${open.severity.toLowerCase()}`}>
              <div className="form">
                <span className="pill">{open.severity}</span>
                <b>{open.rule}</b>
                <span className="muted">
                  {open.kind} {open.name}, line {open.line}
                </span>
                <span className="grow" />
                <button onClick={() => setOpen(null)}>Close</button>
              </div>
              <pre className="mono">{open.code}</pre>
              <p>
                <b>Why:</b> {open.why}
              </p>
              <p>
                <b>Fix:</b> {open.fix}
              </p>
            </div>
          )}
          <p className="muted small">
            Pattern rules, line by line: a place to look, not a verdict — and not a full scan like Salesforce Code
            Analyzer or Checkmarx.
          </p>
        </div>
      )}
    </div>
  );
}
