import { useEffect, useState } from 'react';
import type { SalesforceClient } from '@nomadsf/core';
import { storage, useStudio } from '../context';
import type { OrgChoice } from '../host';

export type OtherOrg = {
  /** The other org, when one is chosen (never the current org). */
  other?: OrgChoice;
  /** Its connection once ready. */
  client: SalesforceClient | null;
  error: string;
  choose: (id: string) => void;
};

/** Another org to compare with, remembered per view (storageKey), and its connection. */
export function useOtherOrg(storageKey: string): OtherOrg {
  const { org, orgs, clientFor } = useStudio();
  const [id, setId] = useState<string>(() => storage.get(storageKey, ''));
  const [client, setClient] = useState<SalesforceClient | null>(null);
  const [error, setError] = useState('');
  const other = id && id !== org.id ? orgs.find((o) => o.id === id) : undefined;

  useEffect(() => {
    setClient(null);
    setError('');
    if (!other) return;
    let canceled = false;
    clientFor(other.id)
      .then((c) => !canceled && setClient(c))
      .catch((e: Error) => !canceled && setError(`❌ ${other.label}: ${e.message}`));
    return () => {
      canceled = true;
    };
  }, [other, clientFor]);

  return {
    other,
    client,
    error,
    choose: (next) => {
      setId(next);
      storage.set(storageKey, next);
    },
  };
}

/** "Compare with: [this org only | another org]" */
export function OtherOrgSelect({ state, label = 'Compare with' }: { state: OtherOrg; label?: string }) {
  const { org, orgs } = useStudio();
  const others = orgs.filter((o) => o.id !== org.id);
  if (others.length === 0)
    return <span className="muted">Log in to a second org (Settings → Org) to compare with another org.</span>;
  return (
    <label>
      {label}
      <select value={state.other?.id ?? ''} onChange={(e) => state.choose(e.target.value)}>
        <option value="">{org.label} (this org)</option>
        {others.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {state.other && !state.client && !state.error && <span className="muted">connecting…</span>}
      {state.error && <span className="bad-text">{state.error}</span>}
    </label>
  );
}
