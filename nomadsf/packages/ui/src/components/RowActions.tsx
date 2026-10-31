/**
 * What a row does in a package: deploy it (package.xml), delete it from the org (destructiveChanges.xml), or nothing.
 * The same select and the same "ticked rows" buttons wherever a list builds a package (Project, Org compare).
 */

export type RowAction = 'deploy' | 'delete';

export function RowActionSelect({
  value,
  canDeploy = true,
  canDelete = true,
  onChange,
}: {
  value: RowAction | undefined;
  canDeploy?: boolean;
  canDelete?: boolean;
  onChange: (action: RowAction | undefined) => void;
}) {
  return (
    <select
      className={`row-action ${value ?? ''}`}
      value={value ?? ''}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => onChange((e.target.value || undefined) as RowAction | undefined)}
    >
      <option value="">–</option>
      {canDeploy && <option value="deploy">Add to package</option>}
      {canDelete && <option value="delete">Destructive change</option>}
    </select>
  );
}

/** Sets the action of the ticked rows, and says how many go where. */
export function RowActionBar({
  deployable,
  deletable,
  ticked,
  busy,
  onSet,
}: {
  /** How many ticked rows can be deployed / deleted. */
  deployable: number;
  deletable: number;
  ticked: number;
  busy?: boolean;
  onSet: (action: RowAction | undefined) => void;
}) {
  return (
    <>
      <button
        disabled={busy || !deployable}
        title="The ticked rows go into package.xml"
        onClick={() => onSet('deploy')}
      >
        + Add to package ({deployable})
      </button>
      <button
        className="danger"
        disabled={busy || !deletable}
        title="The ticked rows go into destructiveChanges.xml"
        onClick={() => onSet('delete')}
      >
        − Destructive change ({deletable})
      </button>
      <button disabled={busy || !ticked} onClick={() => onSet(undefined)}>
        Clear action
      </button>
    </>
  );
}

/** Sets an action on rows (only where it applies), or clears it. */
export function withAction<R>(
  actions: Map<string, RowAction>,
  rows: R[],
  action: RowAction | undefined,
  keyOf: (r: R) => string,
  allowed: (r: R, action: RowAction) => boolean = () => true
): Map<string, RowAction> {
  const next = new Map(actions);
  for (const r of rows) {
    if (!action) next.delete(keyOf(r));
    else if (allowed(r, action)) next.set(keyOf(r), action);
  }
  return next;
}
