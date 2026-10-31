import { useEffect, useMemo, useState } from 'react';
import {
  apexSourcesFromOrg,
  buildDiffPackage,
  compareContent,
  compareOrgs,
  describeMetadata,
  fromBase64,
  orgComponentFiles,
  testsForPackage,
  type DiffPackage,
  type MetadataType,
  type OrgDiffRow,
  type OrgDiffStatus,
  type SalesforceClient,
} from '@nomadsf/core';
import { download } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { detectHost, orgFacts, type OrgChoice, type OrgFacts } from '../host';
import { OrgPairBar, usePair } from '../pair';
import { PackageContents } from '../components/PackageContents';
import { ReleasePanel } from '../components/ReleasePanel';
import { GroupedActions } from '../components/GroupedActions';
import { withAction, type RowAction } from '../components/RowActions';
import { Status } from '../statusLog';

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
export function OrgComparePage({ orgs, embedded }: { orgs: OrgChoice[]; embedded?: boolean }) {
  const studio = useStudio();
  // A → B of the Org to org hub: copy from A, compare with and deploy into B
  const [pair] = usePair();
  const sourceId = pair.a;
  const targetId = pair.b;
  const [clients, setClients] = useState<{ source?: SalesforceClient; target?: SalesforceClient }>({});
  const [targetFacts, setTargetFacts] = useState<OrgFacts>();
  const [types, setTypes] = useState<MetadataType[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(storage.get<string[]>('orgdiff.types', COMMON)));
  const [rows, setRows] = useState<OrgDiffRow[] | null>(null);
  const [show, setShow] = useState<Show>('all');
  // Each row: deployed from A (package.xml) or deleted from B (destructiveChanges.xml)
  const [actions, setActions] = useState<Map<string, RowAction>>(new Map());
  const [pkg, setPkg] = useState<DiffPackage | null>(null);
  const [status, setStatus] = useState('');
  // Where the message belongs: at the top (connect, compare), or by Build package
  const [statusAt, setStatusAt] = useState<'top' | 'package'>('top');
  const [busy, setBusy] = useState(false);

  const source = orgs.find((o) => o.id === sourceId);
  const target = orgs.find((o) => o.id === targetId);
  // Developer Edition and trial orgs are not production (they may deploy with no tests)
  const production = targetFacts
    ? !targetFacts.isSandbox && !/developer|trial/i.test(targetFacts.organizationType)
    : false;

  // Connect to both orgs (browser logins in the extension, CLI orgs in the app)
  useEffect(() => {
    setRows(null);
    setActions(new Map());
    setPkg(null);
    setClients({});
    setTargetFacts(undefined);
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
  // Deploying needs the component in A; deleting needs it in B
  const allowed = (r: OrgDiffRow, a: RowAction): boolean =>
    a === 'deploy' ? r.status !== 'only in target' : r.status !== 'only in source';
  const toDeploy = (rows ?? []).filter((r) => actions.get(r.key) === 'deploy');
  const toDelete = (rows ?? []).filter((r) => actions.get(r.key) === 'delete');
  const setAction = (list: OrgDiffRow[], a: RowAction | undefined): void =>
    setActions(withAction(actions, list, a, (r) => r.key, allowed));

  // A built package is of the actions chosen then: another choice needs another build
  useEffect(() => setPkg(null), [actions]);

  const run = async (label: string, action: () => Promise<void>, at: 'top' | 'package' = 'top') => {
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
      const result = await compareOrgs(clients.source, clients.target, [...chosen].sort(), (done, total, type) =>
        setStatus(`Listing ${type} (${done + 1} of ${total})…`)
      );
      setRows(result.rows);
      setActions(new Map());
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

  /** The package for the panel: retrieved from A, with deletions before or after. */
  const buildForPanel = async (removeWhen: 'pre' | 'post') => {
    if (!clients.source) throw new Error('Connect to A first');
    const built = await buildDiffPackage(
      clients.source,
      toDeploy.map((r) => ({ type: r.type, name: r.name })),
      toDelete.map((r) => ({ type: r.type, name: r.name })),
      undefined,
      removeWhen
    );
    return { zip: fromBase64(built.zipBase64) };
  };

  /** The tests that reach the package's Apex, from A's Apex (where the package comes from). */
  const findTests = async () =>
    testsForPackage(
      await apexSourcesFromOrg(clients.source!),
      toDeploy.map((r) => ({ type: r.type, name: r.name }))
    );

  /** Every row A changes (only in A, or different) goes into the package; only-in-B rows stay for you. */
  const pickDifference = () =>
    setAction(
      (rows ?? []).filter((r) => r.status === 'only in source' || r.status === 'different'),
      'deploy'
    );

  return (
    <div className={embedded ? '' : 'page'}>
      {!embedded && (
        <div className="toolbar">
          <h2>Org compare</h2>
          <span className="muted">differences between two orgs → package.xml and a deployable package</span>
        </div>
      )}
      <OrgPairBar labelA="A — source (copy from)" labelB="B — target (compare with, deploy to)" />
      {production && (
        <p className="bad-text">⚠ B ({target?.label}) is a PRODUCTION org: deploys there ask for its name.</p>
      )}
      <div className="card section">
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

      {status && statusAt === 'top' && <Status text={status} block />}

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
            <button
              onClick={pickDifference}
              title="Deploy every row only in A or different (choose Destructive change for what is only in B)"
            >
              Add all differences
            </button>
          </div>
          <GroupedActions
            rows={shown}
            actions={actions}
            onActions={setActions}
            allowed={allowed}
            tone={(st) => (st === 'same' ? 'good' : st === 'in both' ? '' : st === 'different' ? 'warn' : 'bad')}
          />
          {(toDeploy.length > 0 || toDelete.length > 0) && (
            <div className="compare-actions">
              <span className="muted">
                {`Package: ${toDeploy.length} to deploy from ${source?.label ?? 'A'} · ${
                  toDelete.length
                } to delete from ${target?.label ?? 'B'}`}
              </span>
              <div className="form">
                <button className="primary" disabled={busy} onClick={() => void makePackage()}>
                  {pkg ? 'Build the package again' : 'Build package'}
                </button>
                <button onClick={() => setActions(new Map())}>Clear all actions</button>
                {status && statusAt === 'package' && <Status text={status} />}
              </div>
              {pkg ? (
                <div className="form">
                  <span className="muted">
                    {`Built: ${pkg.components} component(s)${pkg.destructiveXml ? ' with deletions' : ''} ·`}
                  </span>
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
                    ⤓ Package (zip)
                  </button>
                  <button
                    onClick={() =>
                      download(`package-${source?.label}-${stamp()}.xml`, pkg.packageXml, 'application/xml')
                    }
                  >
                    ⤓ package.xml
                  </button>
                  {pkg.destructiveXml && (
                    <button
                      onClick={() =>
                        download(`destructiveChangesPost-${stamp()}.xml`, pkg.destructiveXml!, 'application/xml')
                      }
                    >
                      ⤓ destructiveChangesPost.xml
                    </button>
                  )}
                  <span className="muted">
                    {'deploy it later from here, Workbench, or sf project deploy start --metadata-dir'}
                  </span>
                </div>
              ) : (
                <p className="muted" style={{ margin: 0 }}>
                  Build package retrieves the components to deploy from A into a zip with <code>package.xml</code> (and{' '}
                  <code>destructiveChangesPost.xml</code> for the destructive changes) to download. Validate and deploy,
                  below, send them into B with the tests you choose.
                </p>
              )}
            </div>
          )}
          <PackageContents
            deploy={toDeploy}
            remove={toDelete}
            loadCode={async (c) => {
              const key = `${c.type}:${c.name}`;
              const [a, b] = await Promise.all([
                clients.source && allowed(c as OrgDiffRow, 'deploy')
                  ? orgComponentFiles(clients.source, [c]).then((m) => m.get(key))
                  : undefined,
                clients.target ? orgComponentFiles(clients.target, [c]).then((m) => m.get(key)) : undefined,
              ]);
              return {
                before: b?.length ? b : undefined,
                after: a?.length ? a : undefined,
                labels: [`${target?.label ?? 'B'} (B)`, `${source?.label ?? 'A'} (A)`],
              };
            }}
          />
          {clients.target && (toDeploy.length > 0 || toDelete.length > 0) && (
            <ReleasePanel
              key={[...actions]
                .map(([k, a]) => `${a}:${k}`)
                .sort()
                .join(',')}
              deployCount={toDeploy.length}
              removeCount={toDelete.length}
              from={source?.label ?? 'A'}
              build={buildForPanel}
              findTests={clients.source && toDeploy.length ? findTests : undefined}
              targetId={targetId}
              zipName={`diff-${source?.label}-to-${target?.label}-${stamp()}.zip`}
            />
          )}
        </div>
      )}
    </div>
  );
}
