import { useEffect, useState } from 'react';
import { projectDependencies, type ProjectDependency } from '@nomadsf/core';
import { useProject } from '../project';
import { DataTable } from './DataTable';

/**
 * What a component uses and what uses it in the project, read from the project's files — for components the org does
 * not have yet (Salesforce's dependency tracking only knows the org), and next to it for the others.
 */
export function ProjectDependencies({ type, name }: { type: string; name: string }) {
  const project = useProject();
  const [deps, setDeps] = useState<{ uses: ProjectDependency[]; usedBy: ProjectDependency[] } | null>(null);
  const [error, setError] = useState('');
  const fs = project.source?.fs;
  const info = project.info;
  useEffect(() => {
    setDeps(null);
    setError('');
    if (!fs || !info) return undefined;
    let canceled = false;
    projectDependencies(fs, info, { type, name })
      .then((d) => !canceled && setDeps(d))
      .catch((e: Error) => !canceled && setError(e.message));
    return () => {
      canceled = true;
    };
  }, [fs, info, type, name]);
  if (!fs || !info) return <p className="muted">Open a project to see what uses it there.</p>;
  if (error) return <p className="bad">❌ {error}</p>;
  if (!deps) return <p className="muted">Reading the project…</p>;
  const rows = (list: ProjectDependency[]) => list.map((d) => ({ ...d, key: `${d.type}:${d.name}` }));
  return (
    <>
      <h4>Uses in the project ({deps.uses.length})</h4>
      <DataTable columns={['type', 'name']} rows={rows(deps.uses)} rowKey="key" name={`${name}-uses-project`} />
      <h4>Used by in the project ({deps.usedBy.length})</h4>
      <DataTable
        columns={['type', 'name']}
        rows={rows(deps.usedBy)}
        rowKey="key"
        name={`${name}-used-by-project`}
        note={<span>· found by its name, tag or label in the project's files</span>}
      />
    </>
  );
}
