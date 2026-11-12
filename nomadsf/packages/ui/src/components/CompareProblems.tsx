import type { CompareProblem } from '@nomadsf/core';
import { DataTable } from './DataTable';

/**
 * The components that could not be compared, and why (Salesforce's own message when it gave one): a closed box under
 * the status, so a missing verdict is never silent. Often the user's permissions, or a managed package.
 */
export function CompareProblems({ problems }: { problems: CompareProblem[] }) {
  if (!problems.length) return null;
  return (
    <details className="callout section">
      <summary>⚠ {problems.length} component(s) could not be compared — open to see which and why</summary>
      <DataTable
        columns={['type', 'name', 'problem']}
        rows={problems.map((p) => ({ ...p, key: `${p.type}:${p.name}` }))}
        rowKey="key"
        name="could-not-compare"
        note={<span>· often your user's permissions in the org, or a managed package</span>}
      />
    </details>
  );
}
