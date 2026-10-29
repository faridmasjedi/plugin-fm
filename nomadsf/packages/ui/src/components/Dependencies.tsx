import { useEffect, useState } from 'react';
import { dependenciesOf, type Dependency } from '@nomadsf/core';
import { useStudio } from '../context';
import { DataTable } from './DataTable';

/** What a component uses and what uses it (Salesforce's dependency tracking), read when shown. */
export function Dependencies({ id, name }: { id: string; name: string }) {
  const { client } = useStudio();
  const [deps, setDeps] = useState<{ uses: Dependency[]; usedBy: Dependency[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let canceled = false;
    setDeps(null);
    setError('');
    dependenciesOf(client, id)
      .then((d) => !canceled && setDeps(d))
      .catch((e: Error) => !canceled && setError(e.message));
    return () => {
      canceled = true;
    };
  }, [client, id]);
  if (error) return <p className="bad">❌ {error}</p>;
  if (!deps) return <p className="muted">Reading dependencies…</p>;
  return (
    <>
      <h4>Uses ({deps.uses.length})</h4>
      <DataTable columns={['type', 'name', 'namespace']} rows={deps.uses} rowKey="id" name={`${name}-uses`} />
      <h4>Used by ({deps.usedBy.length})</h4>
      <DataTable
        columns={['type', 'name', 'namespace']}
        rows={deps.usedBy}
        rowKey="id"
        name={`${name}-used-by`}
        note={<span>· tracked by Salesforce for code, flows, pages, objects and fields</span>}
      />
    </>
  );
}
