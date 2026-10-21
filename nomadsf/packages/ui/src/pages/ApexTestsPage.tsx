import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import {
  codeCoverage,
  listTestClasses,
  openCode,
  runTests,
  waitForTests,
  type ClassCoverage,
  type TestClass,
  type TestJob,
  type TestResult,
} from '@nomadsf/core';
import { AiExplain } from '../components/AiHelp';
import { CodeEditor } from '../components/CodeEditor';
import { DataTable } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { monaco } from '../monaco';

type Tab = 'run' | 'coverage';

/** Source of a class or trigger with covered (green) and uncovered (red) lines. */
function CoverageSource({ coverage }: { coverage: ClassCoverage }) {
  const { client } = useStudio();
  const [source, setSource] = useState('');
  const editor = useRef<Parameters<OnMount>[0] | null>(null);
  const decorations = useRef<string[]>([]);

  useEffect(() => {
    const kind = coverage.id.startsWith('01q') ? 'ApexTrigger' : 'ApexClass';
    openCode(client, { id: coverage.id, kind, name: coverage.name })
      .then((files) => setSource(files[0]?.source ?? ''))
      .catch((e: Error) => setSource(`// ${e.message}`));
  }, [client, coverage]);

  const paint = useCallback(() => {
    const target = editor.current;
    if (!target) return;
    const line = (n: number, className: string) => ({
      range: new monaco.Range(n, 1, n, 1),
      options: { isWholeLine: true, className, linesDecorationsClassName: `${className}-gutter` },
    });
    decorations.current = target.deltaDecorations(decorations.current, [
      ...coverage.coveredLines.map((n) => line(n, 'cov-hit')),
      ...coverage.uncoveredLines.map((n) => line(n, 'cov-miss')),
    ]);
  }, [coverage]);

  useEffect(paint, [paint, source]);

  return (
    <div className="editor-box">
      <CodeEditor
        language="apex"
        value={source}
        readOnly
        onMount={(e) => {
          editor.current = e;
          paint();
        }}
      />
    </div>
  );
}

/** Developer Console's Tests: run Apex tests, see failures, and code coverage line by line. */
export function ApexTestsPage() {
  const studio = useStudio();
  const { client } = studio;
  const [tab, setTab] = useState<Tab>('run');
  const [classes, setClasses] = useState<TestClass[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [job, setJob] = useState<TestJob & { id: string }>();
  const [results, setResults] = useState<TestResult[] | null>(null);
  const [coverage, setCoverage] = useState<{ orgWide?: number; classes: ClassCoverage[] } | null>(null);
  const [open, setOpen] = useState<ClassCoverage | null>(null);
  const [status, setStatus] = useState('');
  const abort = useRef<AbortController>(undefined);

  useEffect(() => {
    listTestClasses(client)
      .then(setClasses)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
    return () => abort.current?.abort();
  }, [client]);

  const loadCoverage = useCallback(async () => {
    try {
      setCoverage(await codeCoverage(client));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  }, [client]);

  useEffect(() => {
    if (tab === 'coverage' && !coverage) void loadCoverage();
  }, [tab, coverage, loadCoverage]);

  const start = async (all: boolean) => {
    const what = all ? 'all local tests' : `${selected.size} test class(es)`;
    if (!(await studio.confirmRisky(`Run ${what}`))) return;
    abort.current?.abort();
    abort.current = new AbortController();
    setResults(null);
    setStatus(`Starting ${what}…`);
    try {
      const id = await runTests(
        client,
        all ? { kind: 'level', testLevel: 'RunLocalTests' } : { kind: 'classes', classIds: [...selected] }
      );
      storage.set('apexTests.lastJob', id);
      studio.logActivity('apex tests', { job: id, classes: all ? 'RunLocalTests' : selected.size });
      const found = await waitForTests(client, id, (j) => setJob({ ...j, id }), abort.current.signal);
      setResults(found);
      setStatus('');
      setCoverage(null); // coverage changed
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const failed = (results ?? []).filter((r) => r.outcome !== 'Pass');
  const shownClasses = classes ?? [];

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Apex tests</h2>
        <div className="tabs">
          {(['run', 'coverage'] as const).map((t) => (
            <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === 'run' ? 'Run' : 'Code coverage'}
            </button>
          ))}
        </div>
        <span className="grow" />
        {tab === 'run' && (
          <>
            <button disabled={!selected.size} className="primary" onClick={() => void start(false)}>
              Run selected ({selected.size})
            </button>
            <button onClick={() => void start(true)}>Run all local tests</button>
          </>
        )}
        {tab === 'coverage' && <button onClick={() => void loadCoverage()}>Refresh</button>}
      </div>
      {status && <p className="muted">{status}</p>}

      {tab === 'run' && (
        <div className="split">
          <div className="card">
            {classes === null ? (
              <p className="muted">Finding test classes…</p>
            ) : (
              <DataTable
                columns={['name', 'methods']}
                rows={shownClasses.map((c) => ({ ...c }))}
                rowKey="id"
                name="test-classes"
                selected={selected}
                onSelectedChange={setSelected}
                note={<span>· test classes</span>}
              />
            )}
          </div>
          <div className="card section">
            {job && (
              <div className="metrics">
                <div className="metric">
                  <b style={{ fontSize: 14 }}>{job.status}</b>job {job.id}
                </div>
                <div className="metric">
                  <b>
                    {job.processed}/{job.total}
                  </b>
                  classes
                </div>
                {results && (
                  <>
                    <div className="metric">
                      <b>{results.length - failed.length}</b>passed
                    </div>
                    <div className={`metric ${failed.length ? 'bad' : ''}`}>
                      <b>{failed.length}</b>failed
                    </div>
                  </>
                )}
              </div>
            )}
            {failed.length > 0 && (
              <div className="chips">
                <AiExplain
                  task="explain-test"
                  label="Explain failures with AI"
                  what="the failed tests' messages and stack traces"
                  getText={() =>
                    failed
                      .map((f) => `${f.className}.${f.method}: ${f.outcome}\n${f.message ?? ''}\n${f.stackTrace ?? ''}`)
                      .join('\n\n')
                  }
                />
              </div>
            )}
            {results ? (
              <DataTable
                columns={['outcome', 'className', 'method', 'runTimeMs', 'message', 'stackTrace']}
                rows={results.map((r) => ({ ...r }))}
                rowKey="__none"
                name="apex-test-results"
              />
            ) : (
              !job && <p className="muted">Select test classes on the left, or run all local tests.</p>
            )}
          </div>
        </div>
      )}

      {tab === 'coverage' && (
        <>
          {coverage === null ? (
            <p className="muted">Reading coverage…</p>
          ) : (
            <>
              <div className="metrics">
                <div className={`metric ${coverage.orgWide !== undefined && coverage.orgWide < 75 ? 'bad' : ''}`}>
                  <b>{coverage.orgWide ?? '—'}%</b>org-wide (75 % needed to deploy to production)
                </div>
                <div className="metric">
                  <b>{coverage.classes.filter((c) => c.percent < 75).length}</b>classes under 75 %
                </div>
              </div>
              <div className="split">
                <div className="card">
                  <DataTable
                    columns={['name', 'percent', 'covered', 'uncovered']}
                    rows={coverage.classes.map((c) => ({ ...c }))}
                    rowKey="id"
                    name="code-coverage"
                    onRowClick={(row) => setOpen(coverage.classes.find((c) => c.id === row.id) ?? null)}
                    selectedKey={open?.id}
                    note={<span>· click to see lines</span>}
                  />
                </div>
                <div className="card section">
                  {open ? (
                    <>
                      <h3>
                        {open.name}{' '}
                        <span className="muted">
                          {open.percent}% · {open.uncovered} uncovered lines
                        </span>
                      </h3>
                      {open.coveredLines.length + open.uncoveredLines.length === 0 && (
                        <p className="muted">
                          No line details: Salesforce lists lines only after a test has run code in this class.
                        </p>
                      )}
                      <CoverageSource coverage={open} />
                    </>
                  ) : (
                    <p className="muted">Click a class to see covered (green) and uncovered (red) lines.</p>
                  )}
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
