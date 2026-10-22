import { useEffect, useMemo, useState } from 'react';
import {
  buildDiffPackage,
  compareContent,
  compareOrgs,
  deployZip,
  describeMetadata,
  fromBase64,
  quickDeploy,
  type DeployOutcome,
  type DiffPackage,
  type MetadataType,
  type OrgDiffRow,
  type OrgDiffStatus,
  type SalesforceClient,
  type TestLevel,
} from '@nomadsf/core';
import { DataTable, download } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { detectHost, orgFacts, type OrgChoice, type OrgFacts } from '../host';

const LEVELS: Array<{ id: TestLevel; label: string }> = [
  { id: 'NoTestRun', label: 'No tests (sandboxes only)' },
  { id: 'RunSpecifiedTests', label: 'Specific test classes' },
  { id: 'RunLocalTests', label: 'All local tests' },
  { id: 'RunAllTestsInOrg', label: 'All tests in the org' },
];
const COMMON = [
  'ApexClass',
  'ApexTrigger',
  'LightningComponentBundle',
  'CustomObject',
  'Flow',
  'Layout',
  'FlexiPage',
  'PermissionSet',
  'CustomLabels',
];
type Show = 'all' | OrgDiffStatus;
const SHOW: Array<[Show, string]> = [
  ['all', 'All'],
  ['only in source', 'Only in source'],
  ['only in target', 'Only in target'],
  ['different', 'Different'],
  ['same', 'Same'],
  ['in both', 'In both (not checked)'],
];

const stamp = (): string => new Date().toISOString().replace(/[-:]/g, '').slice(0, 13);
const zipBytes = (b64: string): Blob => new Blob([fromBase64(b64)], { type: 'application/zip' });

/**
 * Org compare: what differs between two orgs (sandbox ↔ sandbox or ↔ production), then a manifest
 * and a deployable package of the difference, to download for later or deploy to the target.
 */
export function OrgComparePage({ orgs }: { orgs: OrgChoice[] }) {
  const studio = useStudio();
  const [sourceId, setSourceId] = useState<string>(() => storage.get('orgdiff.source', studio.org.id));
  const [targetId, setTargetId] = useState<string>(() => storage.get('orgdiff.target', ''));
  const [clients, setClients] = useState<{ source?: SalesforceClient; target?: SalesforceClient }>({});
  const [targetFacts, setTargetFacts] = useState<OrgFacts>();
  const [types, setTypes] = useState<MetadataType[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(storage.get<string[]>('orgdiff.types', COMMON)));
  const [rows, setRows] = useState<OrgDiffRow[] | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [withDeletions, setWithDeletions] = useState(false);
  const [pkg, setPkg] = useState<DiffPackage | null>(null);
  const [level, setLevel] = useState<TestLevel>('RunLocalTests');
  const [tests, setTests] = useState('');
  const [checkOnly, setCheckOnly] = useState(true);
  const [outcome, setOutcome] = useState<DeployOutcome | null>(null);
  const [status, setStatus] = useState('');
  // Where the message belongs: at the top (connect, compare), by Build package, or by Validate / Deploy
  const [statusAt, setStatusAt] = useState<'top' | 'package' | 'deploy'>('top');
  const [busy, setBusy] = useState(false);

  const source = orgs.find((o) => o.id === sourceId);
  const target = orgs.find((o) => o.id === targetId);
  const production = targetFacts ? !targetFacts.isSandbox : false;

  // Connect to both orgs (browser logins in the extension, CLI orgs in the app)
  useEffect(() => {
    setRows(null);
    setPkg(null);
    setOutcome(null);
    setClients({});
    setTargetFacts(undefined);
    storage.set('orgdiff.source', sourceId);
    storage.set('orgdiff.target', targetId);
    const host = detectHost();
    let canceled = false;
    void (async () => {
      try {
        const s = source ? await host.client(source) : undefined;
        const t = target && target.id !== source?.id ? await host.client(target) : undefined;
        if (canceled) return;
        setClients({ source: s, target: t });
        if (s) setTypes(await describeMetadata(s));
        if (t) setTargetFacts(await orgFacts(t));
      } catch (e) {
        if (!canceled) setStatus(`❌ ${(e as Error).message}`);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [sourceId, targetId, source, target]);

  const count = (s: Show): number => (rows ?? []).filter((r) => s === 'all' || r.status === s).length;
  const shown = useMemo(() => (rows ?? []).filter((r) => show === 'all' || r.status === show), [rows, show]);
  const picked = (rows ?? []).filter((r) => selected.has(r.key));
  const toDeploy = picked.filter(
    (r) => r.status === 'only in source' || r.status === 'different' || r.status === 'in both'
  );
  const toDelete = withDeletions ? picked.filter((r) => r.status === 'only in target') : [];

  const run = async (label: string, action: () => Promise<void>, at: 'top' | 'package' | 'deploy' = 'top') => {
    setBusy(true);
    setStatusAt(at);
    setStatus(label);
    try {
      await action();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const compare = () =>
    run('Listing components…', async () => {
      if (!clients.source || !clients.target) throw new Error('Choose two different orgs.');
      storage.set('orgdiff.types', [...chosen]);
      setPkg(null);
      setOutcome(null);
      const result = await compareOrgs(clients.source, clients.target, [...chosen].sort(), (done, total, type) =>
        setStatus(`Listing ${type} (${done + 1} of ${total})…`)
      );
      setRows(result.rows);
      setSelected(new Set());
      setShow('all');
      setStatus(
        result.skipped ? `${result.skipped} component(s) of installed packages or other namespaces left out.` : ''
      );
    });

  const checkContent = () =>
    run('Comparing content…', async () => {
      if (!rows || !clients.source || !clients.target) return;
      const content = await compareContent(clients.source, clients.target, rows, (done, total) =>
        setStatus(`Retrieving and comparing (${done.toLocaleString()} of ${total.toLocaleString()})…`)
      );
      setRows(rows.map((r) => (content.has(r.key) ? { ...r, status: content.get(r.key)! } : r)));
      setStatus(`Content compared: ${[...content.values()].filter((v) => v === 'different').length} different.`);
    });

  const makePackage = () =>
    run(
      'Building the package…',
      async () => {
        if (!clients.source) return;
        const built = await buildDiffPackage(
          clients.source,
          toDeploy.map((r) => ({ type: r.type, name: r.name })),
          toDelete.map((r) => ({ type: r.type, name: r.name })),
          (s) => setStatus(s)
        );
        setPkg(built);
        setOutcome(null);
        studio.logActivity('org diff package', {
          source: source?.label,
          target: target?.label,
          components: built.components,
        });
        setStatus(
          `✓ Package ready: ${toDeploy.length} to deploy${toDelete.length ? `, ${toDelete.length} to delete` : ''}.`
        );
      },
      'package'
    );

  const deploy = async () => {
    if (!pkg || !clients.target || !target) return;
    if (
      !checkOnly &&
      !(await studio.confirmChange(`Deploy ${pkg.components} component(s) from ${source?.label} to ${target.label}`))
    )
      return;
    if (checkOnly && production && !(await studio.confirmRisky(`Validate a package against ${target.label}`))) return;
    void run(
      checkOnly ? 'Validating…' : 'Deploying…',
      async () => {
        const result = await deployZip(clients.target!, pkg.zipBase64, {
          checkOnly,
          testLevel: level,
          runTests: tests.split(/[\s,]+/).filter(Boolean),
          onProgress: (s, done, total) => setStatus(`${checkOnly ? 'Validation' : 'Deploy'} · ${s} · ${done}/${total}`),
        });
        studio.logActivity(checkOnly ? 'org diff validate' : 'org diff deploy', {
          target: target.label,
          id: result.id,
          success: result.success,
        });
        setOutcome(result);
        setStatus('');
      },
      'deploy'
    );
  };

  const quick = async () => {
    if (!outcome || !clients.target || !target) return;
    if (!(await studio.confirmChange(`Quick deploy validation ${outcome.id} to ${target.label}`))) return;
    void run(
      'Quick deploy…',
      async () => {
        const result = await quickDeploy(clients.target!, outcome.id, {
          onProgress: (s) => setStatus(`Quick deploy · ${s}`),
        });
        studio.logActivity('org diff quick deploy', { target: target.label, id: result.id, success: result.success });
        setOutcome(result);
        setStatus('');
      },
      'deploy'
    );
  };

  const pickDifference = () =>
    setSelected(
      new Set((rows ?? []).filter((r) => r.status === 'only in source' || r.status === 'different').map((r) => r.key))
    );

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Org compare</h2>
        <span className="muted">differences between two orgs → package.xml and a deployable package</span>
      </div>
      <div className="card section">
        <div className="form">
          <label>
            Source (copy from)
            <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
              {orgs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                  {o.type ? ` — ${o.type}` : ''}
                </option>
              ))}
            </select>
          </label>
          <span className="arrow">→</span>
          <label>
            Target (compare with)
            <select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">Choose…</option>
              {orgs
                .filter((o) => o.id !== sourceId)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                    {o.type ? ` — ${o.type}` : ''}
                  </option>
                ))}
            </select>
          </label>
          {targetFacts && (
            <span className={`pill ${production ? 'bad' : 'good'}`}>{production ? 'Production' : 'Sandbox'}</span>
          )}
        </div>
        {orgs.length < 2 && (
          <p className="muted" style={{ margin: 0 }}>
            Log in to a second org (Settings → Org) to compare two orgs.
          </p>
        )}
        <div className="form">
          <b>Metadata types</b>
          <button onClick={() => setChosen(new Set(types.map((t) => t.xmlName)))}>All</button>
          <button onClick={() => setChosen(new Set(COMMON))}>Common</button>
          <button onClick={() => setChosen(new Set())}>None</button>
          <button
            className="primary"
            disabled={busy || !chosen.size || !clients.source || !clients.target}
            onClick={() => void compare()}
          >
            Compare {chosen.size} type(s)
          </button>
        </div>
        {types.length > 0 && (
          <div className="field-checks">
            {types.map((t) => (
              <label key={t.xmlName} className="check">
                <input
                  type="checkbox"
                  checked={chosen.has(t.xmlName)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(t.xmlName);
                    else next.delete(t.xmlName);
                    setChosen(next);
                  }}
                />{' '}
                {t.xmlName}
              </label>
            ))}
          </div>
        )}
      </div>

      {status && statusAt === 'top' && <p className="muted">{status}</p>}

      {rows && (
        <div className="card section">
          <div className="metrics">
            {SHOW.filter(([id]) => id === 'all' || count(id) > 0).map(([id, label]) => (
              <button
                key={id}
                className={`metric filter ${show === id ? 'active' : ''} ${
                  id.startsWith('only') || id === 'different' ? 'bad' : ''
                }`}
                onClick={() => {
                  setShow(id);
                  setSelected(new Set());
                }}
              >
                <b>{count(id)}</b>
                {label}
              </button>
            ))}
          </div>
          <div className="form">
            {count('in both') > 0 && (
              <button
                disabled={busy}
                onClick={() => void checkContent()}
                title="Retrieves the components in both orgs and compares their files"
              >
                Compare content of {count('in both')} in both
              </button>
            )}
            <button onClick={pickDifference}>Select the difference (only in source + different)</button>
          </div>
          <DataTable
            columns={['type', 'name', 'status']}
            rows={shown.map((r) => ({ ...r }))}
            rowKey="key"
            name={`org-diff-${source?.label}-${target?.label}`}
            selected={selected}
            onSelectedChange={setSelected}
            note={<span>· tick rows for the package</span>}
          />
          {picked.length > 0 && (
            <div className="compare-actions">
              <span className="muted">
                {picked.length} selected · {toDeploy.length} to deploy from {source?.label}
                {picked.some((r) => r.status === 'only in target') && (
                  <label className="check" style={{ marginLeft: 12 }}>
                    <input
                      type="checkbox"
                      checked={withDeletions}
                      onChange={(e) => setWithDeletions(e.target.checked)}
                    />{' '}
                    also delete {picked.filter((r) => r.status === 'only in target').length} that exist only in{' '}
                    {target?.label}
                  </label>
                )}
              </span>
              <div className="form">
                <button
                  className="primary"
                  disabled={busy || (!toDeploy.length && !toDelete.length)}
                  onClick={() => void makePackage()}
                >
                  Build package
                </button>
                {status && statusAt === 'package' && <span className="muted">{status}</span>}
              </div>
            </div>
          )}
          {pkg && (
            <div className="card section deploy-panel">
              <h3>
                Package of the difference{' '}
                <span className="muted">
                  {pkg.components} component(s){pkg.destructiveXml ? ' · with deletions' : ''}
                </span>
              </h3>
              <div className="form">
                <button
                  onClick={() => download(`package-${source?.label}-${stamp()}.xml`, pkg.packageXml, 'application/xml')}
                >
                  Download package.xml
                </button>
                {pkg.destructiveXml && (
                  <button
                    onClick={() =>
                      download(`destructiveChangesPost-${stamp()}.xml`, pkg.destructiveXml!, 'application/xml')
                    }
                  >
                    Download destructiveChangesPost.xml
                  </button>
                )}
                <button
                  className="primary"
                  onClick={() => {
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(zipBytes(pkg.zipBase64));
                    a.download = `diff-${source?.label}-to-${target?.label}-${stamp()}.zip`;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
                  }}
                >
                  Download package (zip)
                </button>
              </div>
              <p className="muted" style={{ margin: 0 }}>
                Deploy it later from here, Workbench, or{' '}
                <code>sf project deploy start --metadata-dir &lt;unzipped folder&gt;</code>.
              </p>
              <div className="form">
                <label>
                  Tests
                  <select value={level} onChange={(e) => setLevel(e.target.value as TestLevel)}>
                    {LEVELS.map((l) => (
                      <option key={l.id} value={l.id} disabled={l.id === 'NoTestRun' && production}>
                        {l.label}
                      </option>
                    ))}
                  </select>
                </label>
                {level === 'RunSpecifiedTests' && (
                  <input
                    placeholder="Test classes, comma separated"
                    value={tests}
                    onChange={(e) => setTests(e.target.value)}
                  />
                )}
                <label className="check">
                  <input type="checkbox" checked={checkOnly} onChange={(e) => setCheckOnly(e.target.checked)} />{' '}
                  Validate only (changes nothing)
                </label>
                <button className={checkOnly ? '' : 'danger'} disabled={busy} onClick={deploy}>
                  {checkOnly ? 'Validate' : 'Deploy'} on {target?.label}
                </button>
                {status && statusAt === 'deploy' && <span className="muted">{status}</span>}
              </div>
            </div>
          )}
          {outcome && (
            <div className="card section">
              <h3>
                {outcome.success ? '✓' : '❌'} {outcome.checkOnly ? 'Validation' : 'Deploy'} {outcome.status}{' '}
                <span className="muted mono">{outcome.id}</span>
              </h3>
              <p className="muted" style={{ margin: 0 }}>
                {outcome.componentsDeployed}/{outcome.componentsTotal} components · {outcome.testsRun} tests run
                {outcome.errorMessage ? ` · ${outcome.errorMessage}` : ''}
              </p>
              {outcome.success && outcome.checkOnly && (
                <div className="form">
                  <button className="primary" onClick={quick}>
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
      )}
    </div>
  );
}
