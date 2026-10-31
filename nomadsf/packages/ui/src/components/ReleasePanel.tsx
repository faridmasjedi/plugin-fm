import { useContext, useEffect, useState } from 'react';
import {
  deployZip,
  quickDeploy,
  toBase64,
  type DeployOutcome,
  type SalesforceClient,
  type TestLevel,
} from '@nomadsf/core';
import { StudioContext, type Studio } from '../context';
import { detectHost, orgFacts } from '../host';
import { Status } from '../statusLog';
import { askTyped } from './Dialogs';
import { DataTable, download } from './DataTable';

/**
 * Validate, deploy and quick deploy a package — the same everywhere a package is built (Compare & package, Project,
 * Org compare, Metadata, Code). The page builds the Metadata API zip; this panel picks the org it goes to, the tests
 * (none — sandboxes only —, the ones named, with "Find dependent tests", all local, all in the org), when deletions run,
 * then validates or deploys after the org's name is typed, and offers a quick deploy after a successful validation.
 * Taken from Org compare's deploy, which it replaces there.
 */

export type BuiltPackage = {
  zip: Uint8Array;
  /** Components the page could not put in the zip, and why (shown, not hidden). */
  notConverted?: Array<{ type: string; name: string; reason: string }>;
};

export type ReleasePanelProps = {
  /** What goes, for the header and the confirmation: "12 component(s) to deploy, 2 to delete". */
  deployCount: number;
  removeCount: number;
  /** Where it comes from, for the confirmation ("farid-test", "Org A"). */
  from: string;
  /** Builds the zip: package.xml (+ destructiveChanges, before or after) and the files. */
  build: (removeWhen: 'pre' | 'post') => Promise<BuiltPackage>;
  /** The test classes for the package (from its source), when the page can tell. */
  findTests?: () => Promise<{ tests: string[]; uncovered: string[] }>;
  /** The org to deploy to: chosen here (default: the Studio's org), or fixed by the page (Org compare's B). */
  targetId?: string;
  /** A file name for "Download the deployable zip". */
  zipName?: string;
  /** The Studio, for a page drawn outside its context (Release › Project). */
  studio?: Studio;
  /** After each validation, deploy or quick deploy (the page can refresh what it shows). */
  onDone?: (outcome: DeployOutcome) => void;
};

const LEVELS: Array<{ id: TestLevel; label: string }> = [
  { id: 'NoTestRun', label: 'No tests (not in production)' },
  { id: 'RunSpecifiedTests', label: 'These test classes' },
  { id: 'RunLocalTests', label: 'All local tests' },
  { id: 'RunAllTestsInOrg', label: 'All tests in the org' },
];

export function ReleasePanel(props: ReleasePanelProps) {
  const { deployCount, removeCount, from, build, findTests, zipName, onDone } = props;
  const fromContext = useContext(StudioContext);
  const studio = props.studio ?? fromContext;
  if (!studio) throw new Error('No org selected.');
  const [chosen, setChosen] = useState(props.targetId ?? studio.org.id);
  const targetId = props.targetId ?? chosen;
  const target = studio.orgs.find((o) => o.id === targetId);
  const [client, setClient] = useState<SalesforceClient>();
  // What the target is: sandboxes and Developer Edition / trial orgs may deploy with no tests; production may not
  const [orgKind, setOrgKind] = useState<'Sandbox' | 'Developer' | 'Production'>();
  const production = orgKind === 'Production';
  const [level, setLevel] = useState<TestLevel>('RunLocalTests');
  const [tests, setTests] = useState('');
  const [removeWhen, setRemoveWhen] = useState<'pre' | 'post'>('post');
  const [outcome, setOutcome] = useState<DeployOutcome | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [notConverted, setNotConverted] = useState<BuiltPackage['notConverted']>([]);

  // The target's client and whether it is production (no "no tests" there, red, its name to type)
  useEffect(() => {
    setClient(undefined);
    setOutcome(null);
    setOrgKind(undefined);
    if (!target) return undefined;
    let canceled = false;
    void (async () => {
      try {
        const c = await detectHost().client(target);
        if (canceled) return;
        setClient(c);
        const facts = await orgFacts(c);
        if (!canceled)
          setOrgKind(
            facts.isSandbox ? 'Sandbox' : /developer|trial/i.test(facts.organizationType) ? 'Developer' : 'Production'
          );
      } catch (e) {
        if (!canceled) setStatus(`❌ ${(e as Error).message}`);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [target]);

  useEffect(() => {
    if (production && level === 'NoTestRun') setLevel('RunLocalTests');
  }, [production, level]);

  const run = async (label: string, action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setStatus(label);
    try {
      await action();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const confirm = (what: string): Promise<boolean> =>
    askTyped(`${what}${production ? `\n\n⚠ ${target?.label} is a PRODUCTION org.` : ''}`, target?.label ?? '', {
      ok: 'Confirm',
      danger: production,
    });

  const testList = (): string[] => tests.split(/[\s,]+/).filter(Boolean);

  const send = async (checkOnly: boolean): Promise<void> => {
    if (!client || !target) return;
    if (level === 'RunSpecifiedTests' && !testList().length) {
      setStatus('⚠ Name the test classes to run (or Find dependent tests).');
      return;
    }
    const what = `${checkOnly ? 'Validate' : 'Deploy'} ${deployCount} component(s)${
      removeCount ? ` and delete ${removeCount}` : ''
    } from ${from} ${checkOnly ? 'against' : 'to'} ${target.label}`;
    if (!(await confirm(what))) return;
    await run('Building the package…', async () => {
      const built = await build(removeWhen);
      setNotConverted(built.notConverted ?? []);
      setStatus(checkOnly ? 'Validating…' : 'Deploying…');
      const result = await deployZip(client, toBase64(built.zip), {
        checkOnly,
        testLevel: level,
        runTests: level === 'RunSpecifiedTests' ? testList() : [],
        onProgress: (s, done, total) => setStatus(`${checkOnly ? 'Validation' : 'Deploy'} · ${s} · ${done}/${total}`),
      });
      studio.logActivity(checkOnly ? 'validate package' : 'deploy package', {
        from,
        target: target.label,
        id: result.id,
        success: result.success,
        tests: level,
      });
      setOutcome(result);
      setStatus('');
      onDone?.(result);
    });
  };

  const quick = async (): Promise<void> => {
    if (!outcome || !client || !target) return;
    if (!(await confirm(`Quick deploy validation ${outcome.id} to ${target.label}`))) return;
    await run('Quick deploy…', async () => {
      const result = await quickDeploy(client, outcome.id, { onProgress: (s) => setStatus(`Quick deploy · ${s}`) });
      studio.logActivity('quick deploy package', {
        from,
        target: target.label,
        id: result.id,
        success: result.success,
      });
      setOutcome(result);
      setStatus('');
      onDone?.(result);
    });
  };

  const suggest = async (): Promise<void> => {
    if (!findTests) return;
    await run('Finding the tests that reach these classes and triggers…', async () => {
      const found = await findTests();
      const merged = [...new Set([...testList(), ...found.tests])].sort();
      setTests(merged.join(', '));
      setLevel('RunSpecifiedTests');
      setStatus(
        found.tests.length
          ? `✓ ${found.tests.length} test class(es) found${
              found.uncovered.length ? `; no test reaches ${found.uncovered.join(', ')}` : ''
            }. Add or remove any before validating.`
          : `⚠ No test class reaches ${found.uncovered.join(', ') || 'these components'}: name tests yourself.`
      );
    });
  };

  const saveZip = async (): Promise<void> => {
    await run('Building the package…', async () => {
      const built = await build(removeWhen);
      setNotConverted(built.notConverted ?? []);
      download(zipName ?? 'package.zip', built.zip, 'application/zip');
      setStatus('✓ Downloaded: package.xml at its root, ready for the Metadata API.');
    });
  };

  const disabled = busy || !client || (!deployCount && !removeCount);
  return (
    <div className="card section release-panel">
      <div className="release-head">
        <h3>Validate and deploy</h3>
        <span className="release-counts">
          <b>{deployCount}</b> to deploy
          {removeCount > 0 && (
            <>
              {' · '}
              <b className="bad-text">{removeCount}</b> to delete
            </>
          )}
          <span className="muted"> · from {from}</span>
        </span>
      </div>
      <div className="release-grid">
        <span className="release-label">Into</span>
        <div className="release-row">
          {props.targetId ? (
            <b className={production ? 'bad-text' : ''}>{target?.label ?? targetId}</b>
          ) : (
            <select value={chosen} onChange={(e) => setChosen(e.target.value)}>
              {studio.orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
          {orgKind && <span className={`pill ${production ? 'bad' : 'good'}`}>{orgKind}</span>}
        </div>
        <span className="release-label">Tests</span>
        <div className="release-row">
          <select value={level} onChange={(e) => setLevel(e.target.value as TestLevel)}>
            {LEVELS.map((l) => (
              <option key={l.id} value={l.id} disabled={l.id === 'NoTestRun' && production}>
                {l.label}
              </option>
            ))}
          </select>
          {findTests && (
            <button
              disabled={busy}
              onClick={() => void suggest()}
              title="The test classes that reach these classes and triggers"
            >
              Find dependent tests
            </button>
          )}
          {production && <span className="muted">tests must run in production</span>}
        </div>
        {level === 'RunSpecifiedTests' && (
          <>
            <span />
            <textarea
              className="release-tests"
              rows={2}
              placeholder="Test classes, separated by commas or spaces"
              value={tests}
              onChange={(e) => setTests(e.target.value)}
            />
          </>
        )}
        {removeCount > 0 && (
          <>
            <span className="release-label">Deletions</span>
            <div className="release-row">
              <select value={removeWhen} onChange={(e) => setRemoveWhen(e.target.value as 'pre' | 'post')}>
                <option value="post">after the deploy</option>
                <option value="pre">before the deploy</option>
              </select>
            </div>
          </>
        )}
      </div>
      <div className="release-actions">
        <button className="primary" disabled={disabled} onClick={() => void send(true)}>
          Validate on {target?.label ?? '…'}
        </button>
        <button className="danger" disabled={disabled} onClick={() => void send(false)}>
          Deploy to {target?.label ?? '…'}
        </button>
        <span className="grow" />
        <button disabled={busy || (!deployCount && !removeCount)} onClick={() => void saveZip()}>
          ⤓ Deployable zip
        </button>
      </div>
      {status && <Status text={status} block />}
      {notConverted && notConverted.length > 0 && (
        <p className="warn-text">
          ⚠ Not in the package (not converted yet):{' '}
          {notConverted.map((c) => `${c.type} ${c.name} (${c.reason})`).join('; ')}
        </p>
      )}
      {outcome && (
        <div className="release-outcome">
          <h4>
            {outcome.success ? '✓' : '❌'} {outcome.checkOnly ? 'Validation' : 'Deploy'} {outcome.status}{' '}
            <span className="muted mono">{outcome.id}</span>
          </h4>
          <p className="muted" style={{ margin: 0 }}>
            {outcome.componentsDeployed}/{outcome.componentsTotal} components · {outcome.testsRun} tests run
            {outcome.errorMessage ? ` · ${outcome.errorMessage}` : ''}
          </p>
          {outcome.success && outcome.checkOnly && (
            <div className="form">
              <button className="primary" disabled={busy} onClick={() => void quick()}>
                Quick deploy (no second test run)
              </button>
            </div>
          )}
          {outcome.componentFailures.length > 0 && (
            <DataTable
              columns={['type', 'name', 'line', 'problem']}
              rows={outcome.componentFailures.map((f, i) => ({ ...f, key: i }))}
              rowKey="key"
              name="component-failures"
            />
          )}
          {outcome.testFailures.length > 0 && (
            <DataTable
              columns={['name', 'method', 'message']}
              rows={outcome.testFailures.map((f, i) => ({ ...f, key: i }))}
              rowKey="key"
              name="test-failures"
            />
          )}
        </div>
      )}
    </div>
  );
}
