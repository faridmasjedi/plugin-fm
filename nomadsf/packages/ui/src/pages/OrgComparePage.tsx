import { useEffect, useMemo, useState } from 'react';
import {
  apexSourcesFromOrg,
  buildDiffPackage,
  compareContent,
  compareOrgs,
  describeMetadata,
  fromBase64,
  testsForPackage,
  type DiffPackage,
  type MetadataType,
  type OrgDiffRow,
  type OrgDiffStatus,
  type SalesforceClient,
} from '@nomadsf/core';
import { DataTable, download } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { detectHost, orgFacts, type OrgChoice, type OrgFacts } from '../host';
import { OrgPairBar, usePair } from '../pair';
import { ReleasePanel } from '../components/ReleasePanel';
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [withDeletions, setWithDeletions] = useState(false);
  const [pkg, setPkg] = useState<DiffPackage | null>(null);
  const [status, setStatus] = useState('');
  // Where the message belongs: at the top (connect, compare), or by Build package
  const [statusAt, setStatusAt] = useState<'top' | 'package'>('top');
  const [busy, setBusy] = useState(false);

  const source = orgs.find((o) => o.id === sourceId);
  const target = orgs.find((o) => o.id === targetId);
  const production = targetFacts ? !targetFacts.isSandbox : false;

  // Connect to both orgs (browser logins in the extension, CLI orgs in the app)
  useEffect(() => {
    setRows(null);
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
  const picked = (rows ?? []).filter((r) => selected.has(r.key));
  const toDeploy = picked.filter(
    (r) => r.status === 'only in source' || r.status === 'different' || r.status === 'in both'
  );
  const toDelete = withDeletions ? picked.filter((r) => r.status === 'only in target') : [];

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

  const pickDifference = () =>
    setSelected(
      new Set((rows ?? []).filter((r) => r.status === 'only in source' || r.status === 'different').map((r) => r.key))
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
            <button onClick={pickDifference} title="Tick every row only in A, or different">
              Add all differences
            </button>
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
                {status && statusAt === 'package' && <Status text={status} />}
              </div>
              <p className="muted" style={{ margin: 0 }}>
                Build package retrieves the ticked components from A into a zip with <code>package.xml</code> (and{' '}
                <code>destructiveChangesPost.xml</code> for those you also delete) to download. Validate and deploy,
                below, send the ticked components into B with the tests you choose.
              </p>
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
            </div>
          )}
          {picked.length > 0 && clients.target && (toDeploy.length > 0 || toDelete.length > 0) && (
            <ReleasePanel
              key={[...selected].sort().join(',') + String(withDeletions)}
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
