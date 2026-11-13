import { useEffect, useMemo, useState } from 'react';
import {
  CONFIG_TYPES,
  compareItems,
  configFiles,
  configItems,
  deployConfigs,
  diffItems,
  forAnotherOrg,
  type ConfigKind,
  type ItemComparison,
} from '@nomadsf/core';
import { DataTable } from './DataTable';
import { OrgPairBar, usePairClients } from '../pair';
import { useStudio } from '../context';
import { askTyped } from './Dialogs';
import { Status } from '../statusLog';

type Show = 'all' | ItemComparison['status'];
const PARTS = ['OAuth settings', 'Global OAuth settings', 'OAuth policies', 'App policies'];

/**
 * The connected apps, external client apps, named and external credentials of A and B: where each is, every setting
 * side by side (or only the differences), and A's version deployed to B (secrets and consumer keys never travel).
 */
export function ConfigCompare({
  kinds,
  embedded = false,
}: {
  /** Only these kinds (apps, or credentials). */
  kinds?: ConfigKind[];
  /** Inside another page: no title or org bar of its own. */
  embedded?: boolean;
}) {
  const { logActivity } = useStudio();
  const { a, b, clientA, clientB, error } = usePairClients();
  const [rows, setRows] = useState<ItemComparison[] | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [chosen, setChosen] = useState('');
  const [onlyDiff, setOnlyDiff] = useState(true);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async (quiet = false) => {
    if (!clientA || !clientB) return;
    setRows(null);
    setChosen('');
    if (!quiet) setStatus('Reading the apps and credentials of both orgs…');
    try {
      const [fa, fb] = await Promise.all([configFiles(clientA, CONFIG_TYPES), configFiles(clientB, CONFIG_TYPES)]);
      const keep = (i: { kind: ConfigKind }) => !kinds || kinds.includes(i.kind);
      setRows(compareItems(configItems(fa).filter(keep), configItems(fb).filter(keep)));
      if (!quiet) setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientA, clientB]);

  const count = (s: Show) => (rows ?? []).filter((r) => s === 'all' || r.status === s).length;
  const item = rows?.find((r) => `${r.kind}:${r.name}` === chosen);
  const diff = useMemo(() => (item ? diffItems(item.a, item.b) : []), [item]);
  // "Only the differences" makes sense when the item is in both; otherwise every setting is shown
  const both = Boolean(item?.a && item?.b);
  const shownDiff = onlyDiff && both ? diff.filter((d) => !d.same) : diff;
  // An app with parts: one folding group per part, the app's own settings first
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const groups = useMemo(() => {
    const out = new Map<string, Array<(typeof diff)[number] & { setting: string }>>();
    for (const d of shownDiff) {
      const [head, ...rest] = d.path.split(' › ');
      const isPart = PARTS.includes(head) && rest.length > 0;
      const part = isPart ? head : 'The app';
      out.set(part, [...(out.get(part) ?? []), { ...d, setting: isPart ? rest.join(' › ') : d.path }]);
    }
    return [...out.entries()].sort((x, y) => (x[0] === 'The app' ? -1 : y[0] === 'The app' ? 1 : 0));
  }, [shownDiff]);

  const deployToB = async () => {
    if (!item?.a || !clientB || !b) return;
    if (
      !(await askTyped(
        `Deploy ${item.kind} ${item.label} as it is in ${a?.label ?? 'A'} to ${b.label} (${
          item.a.files.length
        } file(s); secrets, the consumer key and org-specific links are not copied).`,
        b.label,
        { ok: 'Deploy' }
      ))
    )
      return;
    setBusy(true);
    setStatus(`Deploying ${item.label} to ${b.label}…`);
    try {
      await deployConfigs(
        clientB,
        item.a.files.map((f) => ({ ...f, xml: forAnotherOrg(f.xml) }))
      );
      logActivity('config-deploy-to-b', { item: item.name, kind: item.kind, to: b.label });
      setStatus(`✓ ${item.label} deployed to ${b.label}.`);
      const keep = chosen;
      await load(true);
      setChosen(keep);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={embedded ? 'config-compare' : 'page'}>
      {embedded ? (
        <h3>Settings of the apps defined in A or B</h3>
      ) : (
        <div className="toolbar">
          <h2>{kinds?.includes('Named credential') ? 'Credentials' : 'Settings of apps & credentials'}</h2>
          <span className="muted">
            connected apps, external client apps, named and external credentials in two orgs
          </span>
          <span className="grow" />
          <button disabled={!clientB} onClick={() => void load()}>
            Refresh
          </button>
        </div>
      )}
      {!embedded && <OrgPairBar />}
      {error && <p className="bad-text">{error}</p>}
      {!b && !embedded && <p className="muted">Choose the other org (B) above.</p>}
      {status && <Status text={status} block />}
      {rows && (
        <div className="card section">
          <div className="segmented" role="group" aria-label="Show">
            {(['all', 'only in A', 'only in B', 'different', 'same'] as Show[]).map((s) => (
              <button key={s} className={show === s ? 'active' : ''} onClick={() => setShow(s)}>
                {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)} ({count(s)})
              </button>
            ))}
          </div>
          {rows.length ? (
            <DataTable
              name="apps-credentials-compare"
              columns={['kind', 'label', 'name', 'status', 'differences']}
              rows={rows
                .filter((r) => show === 'all' || r.status === show)
                .map((r) => ({ ...r, Id: `${r.kind}:${r.name}`, differences: r.differences || '' }))}
              onRowClick={(r) => setChosen(String(r.Id))}
              selectedKey={chosen}
            />
          ) : (
            <p className="muted">Neither org defines a connected app, external client app or credential.</p>
          )}
        </div>
      )}
      {item && (
        <div className="card section">
          <div className="form item-head">
            <span className="pill">{item.kind}</span>
            <b>{item.label}</b>
            <span className="muted small">{item.status}</span>
            <span className="grow" />
            {both && (
              <label className="check">
                <input type="checkbox" checked={onlyDiff} onChange={(e) => setOnlyDiff(e.target.checked)} /> Only the
                differences
              </label>
            )}
            {item.a && item.status !== 'same' && (
              <button className="primary" disabled={busy} onClick={() => void deployToB()}>
                Deploy A’s version to {b?.label ?? 'B'}…
              </button>
            )}
          </div>
          {!shownDiff.length && <p className="muted">The same in both.</p>}
          <div className="config-groups">
            {groups.map(([part, list]) => (
              <div key={part} className="config-group">
                {groups.length > 1 && (
                  <button
                    className="config-group-head"
                    aria-expanded={!closed.has(part)}
                    onClick={() => {
                      const next = new Set(closed);
                      if (next.has(part)) next.delete(part);
                      else next.add(part);
                      setClosed(next);
                    }}
                  >
                    <span className="tree-toggle">{closed.has(part) ? '▸' : '▾'}</span> {part}{' '}
                    <span className="muted small">
                      ({list.length}
                      {both ? `, ${list.filter((d) => !d.same).length} different` : ''})
                    </span>
                  </button>
                )}
                {!closed.has(part) && (
                  <table className="config-table config-diff">
                    <thead>
                      <tr>
                        <th>Setting</th>
                        <th>A · {a?.label ?? 'org A'}</th>
                        <th>B · {b?.label ?? 'org B'}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((d) => (
                        <tr key={d.path} className={both && !d.same ? 'changed' : ''}>
                          <td className="mono small">{d.setting}</td>
                          <td>{d.a || <span className="muted">—</span>}</td>
                          <td>{d.b || <span className="muted">—</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
          <p className="muted small">
            The consumer key differs in every org and is not a difference. Secrets (client secrets, passwords, private
            keys) are not in these files and are never copied: set them in Setup in {b?.label ?? 'B'}.
          </p>
        </div>
      )}
    </div>
  );
}
