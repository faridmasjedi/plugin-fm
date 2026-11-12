import { useEffect, useState } from 'react';
import { dependenciesOf, projectDependencies, type Dependency, type ProjectDependency } from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { useProject } from '../project';
import { DataTable } from './DataTable';
import { TableTabs } from './TableTabs';

type From = 'org' | 'project' | 'both';
type Found = { uses: Array<Record<string, unknown>>; usedBy: Array<Record<string, unknown>> };

/**
 * What a component uses and what uses it, in one box: a tab for each, one table grouped by type. From Salesforce's
 * dependency tracking in the org (when the org has the component) and from the project's files (when it is open and
 * has the component, also before it reaches the org), with a column saying where it was found.
 */
export function Dependencies({
  id,
  type,
  name,
  inProject,
}: {
  /** The component's Id in the org (none: not in the org). */
  id?: string;
  type: string;
  name: string;
  /** Whether the open project has it. */
  inProject?: boolean;
}) {
  const { client, org } = useStudio();
  const project = useProject();
  const [found, setFound] = useState<Found | null>(null);
  const [error, setError] = useState('');
  // Where to look, when both can: the org alone is quick; the project's files take longer in a big project
  const [from, setFrom] = useState<From>(() => storage.get<From>('deps.from', 'org'));
  const both = Boolean(id && inProject && project.source);
  const lookOrg = Boolean(id) && (!both || from !== 'project');
  const lookProject = inProject && (!both || from !== 'org');
  const fs = lookProject ? project.source?.fs : undefined;
  const info = lookProject ? project.info : undefined;
  const pick = (f: From) => {
    setFrom(f);
    storage.set('deps.from', f);
  };

  useEffect(() => {
    let canceled = false;
    setFound(null);
    setError('');
    const fromOrg = (list: Dependency[]) =>
      list.map((d) => ({
        key: `org:${d.id}`,
        // Salesforce's own name for a standard object
        type: d.type === 'StandardEntity' ? 'Standard object' : d.type,
        name: d.name,
        where: org.label,
        namespace: d.namespace,
      }));
    const fromProject = (list: ProjectDependency[]) =>
      list.map((d) => ({
        key: `project:${d.type}:${d.name}`,
        type: d.type,
        name: d.name,
        where: 'project',
        namespace: '',
      }));
    void Promise.all([
      id && lookOrg ? dependenciesOf(client, id) : Promise.resolve({ uses: [], usedBy: [] }),
      fs && info ? projectDependencies(fs, info, { type, name }) : Promise.resolve({ uses: [], usedBy: [] }),
    ])
      .then(([o, p]) => {
        if (canceled) return;
        setFound({
          uses: [...fromOrg(o.uses), ...fromProject(p.uses)],
          usedBy: [...fromOrg(o.usedBy), ...fromProject(p.usedBy)],
        });
      })
      .catch((e: Error) => !canceled && setError(e.message));
    return () => {
      canceled = true;
    };
  }, [client, id, lookOrg, fs, info, type, name, org.label]);

  const choice = both && (
    <div className="form deps-from">
      <span className="muted small">Look in</span>
      <div className="segmented" role="group" aria-label="Look in">
        {(
          [
            ['org', org.label, `Salesforce's dependency tracking in ${org.label}: quick`],
            ['project', 'Project', "The project's files: takes longer in a big project"],
            ['both', 'Both', 'The org and the project together'],
          ] as Array<[From, string, string]>
        ).map(([f, label, hint]) => (
          <button key={f} className={from === f ? 'active' : ''} title={hint} onClick={() => pick(f)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  );
  if (!id && !project.source)
    return <p className="muted">Not in the org, and no open project has it: nothing to look in.</p>;
  if (error)
    return (
      <>
        {choice}
        <p className="bad">❌ {error}</p>
      </>
    );
  if (!found)
    return (
      <>
        {choice}
        <p className="muted">
          {lookProject ? "Reading dependencies (the project's files too)…" : 'Reading dependencies…'}
        </p>
      </>
    );
  const sources = [lookOrg ? `Salesforce's tracking in ${org.label}` : '', fs ? "the project's files" : '']
    .filter(Boolean)
    .join(' and ');
  const table = (rows: Array<Record<string, unknown>>, what: string) => (
    <DataTable
      columns={['type', 'name', 'where', ...(rows.some((r) => r.namespace) ? ['namespace'] : [])]}
      rows={rows}
      rowKey="key"
      name={`${name}-${what}`}
      groupBy="type"
      note={<span>· from {sources}</span>}
    />
  );
  return (
    <>
      {choice}
      <TableTabs
        title="Dependencies"
        tabs={[
          { id: 'uses', label: 'Uses', count: found.uses.length, content: table(found.uses, 'uses') },
          { id: 'usedBy', label: 'Used by', count: found.usedBy.length, content: table(found.usedBy, 'used-by') },
        ]}
      />
    </>
  );
}
