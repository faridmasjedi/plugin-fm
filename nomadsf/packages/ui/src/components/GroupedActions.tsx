import { useState, type ReactNode } from 'react';
import { RowActionSelect, withAction, type RowAction } from './RowActions';

/**
 * A compare's rows by metadata type, each type a line you open: how many and where (only on one side, different…),
 * what is chosen so far, and "all to the package" / "all destructive" for the type; opened, each component with its
 * own choice. The same in Org compare and Release › Project (and Branch ↔ Org).
 */

export type GroupRow = { key: string; type: string; name: string; status: string };

export function GroupedActions<R extends GroupRow>({
  rows,
  actions,
  onActions,
  allowed,
  tone,
  renderName,
}: {
  rows: R[];
  actions: Map<string, RowAction>;
  onActions: (next: Map<string, RowAction>) => void;
  /** Whether a row can be deployed / deleted (deploying needs the source side, deleting the org). */
  allowed: (row: R, action: RowAction) => boolean;
  /** The pill colour of a status (good / warn / bad / ''). */
  tone: (status: string) => string;
  /** The name cell, when it does more (opens in Code). */
  renderName?: (row: R) => ReactNode;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const shown = rows.filter((r) => !needle || `${r.type} ${r.name}`.toLowerCase().includes(needle));
  const groups = new Map<string, R[]>();
  for (const r of shown) groups.set(r.type, [...(groups.get(r.type) ?? []), r]);
  const set = (list: R[], action: RowAction | undefined): void =>
    onActions(withAction(actions, list, action, (r) => r.key, allowed));
  const toggle = (type: string): void => {
    const next = new Set(open);
    if (next.has(type)) next.delete(type);
    else next.add(type);
    setOpen(next);
  };

  return (
    <div className="grouped-actions">
      <div className="form">
        <input
          className="grow"
          type="search"
          placeholder={`Filter ${rows.length} component(s) by type or name`}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button onClick={() => setOpen(new Set(groups.keys()))}>Open all</button>
        <button onClick={() => setOpen(new Set())}>Close all</button>
      </div>
      {!groups.size && <p className="muted">Nothing to show.</p>}
      {[...groups].map(([type, list]) => {
        const isOpen = open.has(type) || (needle.length > 0 && groups.size <= 3);
        const byStatus = new Map<string, number>();
        for (const r of list) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
        const deploying = list.filter((r) => actions.get(r.key) === 'deploy').length;
        const deleting = list.filter((r) => actions.get(r.key) === 'delete').length;
        const canDeploy = list.filter((r) => allowed(r, 'deploy'));
        const canDelete = list.filter((r) => allowed(r, 'delete'));
        return (
          <div key={type} className={`group ${isOpen ? 'open' : ''}`}>
            <div className="group-head">
              <button className="group-toggle" aria-expanded={isOpen} onClick={() => toggle(type)}>
                <span className="caret">{isOpen ? '▾' : '▸'}</span>
                <b>{type}</b>
                <span className="muted">{list.length}</span>
              </button>
              <span className="group-status">
                {[...byStatus].map(([status, n]) => (
                  <span key={status} className={`pill ${tone(status)}`}>
                    {n} {status}
                  </span>
                ))}
              </span>
              <span className="grow" />
              {(deploying > 0 || deleting > 0) && (
                <span className="group-chosen">
                  {deploying > 0 && <span className="pill good">{deploying} to package</span>}
                  {deleting > 0 && <span className="pill bad">{deleting} destructive</span>}
                </span>
              )}
              <span className="group-buttons">
                <button
                  disabled={!canDeploy.length}
                  title={`Every ${type} shown that can be deployed goes into package.xml`}
                  onClick={() => set(canDeploy, 'deploy')}
                >
                  + All to package
                </button>
                <button
                  className="danger"
                  disabled={!canDelete.length}
                  title={`Every ${type} shown that is in the org goes into destructiveChanges.xml`}
                  onClick={() => set(canDelete, 'delete')}
                >
                  − All destructive
                </button>
                <button disabled={!deploying && !deleting} onClick={() => set(list, undefined)}>
                  Clear
                </button>
              </span>
            </div>
            {isOpen && (
              <table className="table group-rows">
                <tbody>
                  {list.map((r) => (
                    <tr key={r.key} className={actions.get(r.key) ?? ''}>
                      <td>{renderName ? renderName(r) : r.name}</td>
                      <td>
                        <span className={`pill ${tone(r.status)}`}>{r.status}</span>
                      </td>
                      <td className="group-action">
                        <RowActionSelect
                          value={actions.get(r.key)}
                          canDeploy={allowed(r, 'deploy')}
                          canDelete={allowed(r, 'delete')}
                          onChange={(a) => set([r], a)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}
