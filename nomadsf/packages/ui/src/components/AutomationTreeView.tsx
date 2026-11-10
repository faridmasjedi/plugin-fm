import { useEffect, useRef, useState } from 'react';
import type { AutoNode, AutomationTree } from '@nomadsf/core';

const ICON: Record<AutoNode['kind'], string> = {
  trigger: 'Trigger',
  method: 'Method',
  class: 'Class',
  flow: 'Flow',
  writes: 'Writes',
  action: 'Action',
  missing: '',
};

/**
 * What a trigger or flow runs, as a tree that opens one level per click (read only then). Something already open
 * higher up on the same branch is marked ↺ (it calls back into itself) and not opened again.
 */
export function AutomationTreeView({ tree, root }: { tree: AutomationTree; root: AutoNode }) {
  return (
    <div className="auto-tree">
      <TreeNode tree={tree} node={root} path={[]} startOpen />
      <p className="muted small">
        Read from the Apex code and the flow definitions: calls through interfaces, dynamic Apex or managed packages
        cannot be followed. ↺ = already open above on this branch.
      </p>
    </div>
  );
}

function TreeNode({
  tree,
  node,
  path,
  startOpen,
}: {
  tree: AutomationTree;
  node: AutoNode;
  path: string[];
  startOpen?: boolean;
}) {
  const loop = path.includes(node.id);
  // The step clicked opens at once
  const [open, setOpen] = useState(Boolean(startOpen));
  const [children, setChildren] = useState<AutoNode[] | null>(null);
  const [error, setError] = useState('');
  const asked = useRef(false);

  // Read what is under it the first time it opens
  useEffect(() => {
    if (!open || asked.current || !node.opens || loop) return;
    asked.current = true;
    tree
      .children(node)
      .then(setChildren)
      .catch((e: Error) => setError(e.message));
  }, [open, node, loop, tree]);
  const busy = open && !children && !error && node.opens && !loop;
  const toggle = () => {
    if (node.opens && !loop) setOpen(!open);
  };

  const canOpen = node.opens && !loop;
  return (
    <div className={`auto-node ${node.off ? 'off' : ''} ${node.kind}`}>
      <div className="auto-node-row">
        <button className="auto-node-toggle" disabled={!canOpen} onClick={toggle} aria-label={open ? 'Close' : 'Open'}>
          {loop ? '↺' : !node.opens ? '·' : open ? '▾' : '▸'}
        </button>
        {ICON[node.kind] && <span className="pill">{ICON[node.kind]}</span>}
        <b className="auto-node-label" onClick={toggle}>
          {node.label}
        </b>
        {node.detail && <span className="muted small">{node.detail}</span>}
        {node.off && <span className="muted small">inactive</span>}
        {loop && <span className="muted small">calls back into itself</span>}
      </div>
      {open && (
        <div className="auto-node-children">
          {busy && <span className="muted small">Reading…</span>}
          {error && <span className="bad-text small">❌ {error}</span>}
          {children?.length === 0 && <span className="muted small">Runs nothing we can follow.</span>}
          {children?.map((c) => (
            <TreeNode key={c.id} tree={tree} node={c} path={[...path, node.id]} />
          ))}
        </div>
      )}
    </div>
  );
}
