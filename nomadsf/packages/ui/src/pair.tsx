import { createContext, useContext, useEffect, useState } from 'react';
import type { SalesforceClient } from '@nomadsf/core';
import { useStudio } from './context';
import type { OrgChoice } from './host';

/**
 * Org to org: the two orgs every tool of the hub works on (A → B: compare from A, copy and deploy into B).
 * One pair for the whole hub, remembered; A starts as the org chosen at the top.
 */
export type OrgPair = { a: string; b: string };

export const PairContext = createContext<[OrgPair, (next: OrgPair) => void] | null>(null);

export function usePair(): [OrgPair, (next: OrgPair) => void] {
  const pair = useContext(PairContext);
  if (!pair) throw new Error('No org pair.');
  return pair;
}

/** Both orgs of the pair and their connections (null until connected). */
export function usePairClients(): {
  a?: OrgChoice;
  b?: OrgChoice;
  clientA: SalesforceClient | null;
  clientB: SalesforceClient | null;
  error: string;
} {
  const { orgs, clientFor } = useStudio();
  const [pair] = usePair();
  const a = orgs.find((o) => o.id === pair.a);
  const b = pair.b !== pair.a ? orgs.find((o) => o.id === pair.b) : undefined;
  const [clients, setClients] = useState<{ a: SalesforceClient | null; b: SalesforceClient | null }>({
    a: null,
    b: null,
  });
  const [error, setError] = useState('');
  useEffect(() => {
    setClients({ a: null, b: null });
    setError('');
    let canceled = false;
    void (async () => {
      try {
        const ca = a ? await clientFor(a.id) : null;
        const cb = b ? await clientFor(b.id) : null;
        if (!canceled) setClients({ a: ca, b: cb });
      } catch (e) {
        if (!canceled) setError(`❌ ${(e as Error).message}`);
      }
    })();
    return () => {
      canceled = true;
    };
  }, [a, b, clientFor]);
  return { a, b, clientA: clients.a, clientB: clients.b, error };
}

/** "A [org] ⇄ B [org]" at the top of every tool of the hub. */
export function OrgPairBar({ labelA = 'A', labelB = 'B' }: { labelA?: string; labelB?: string }) {
  const { orgs } = useStudio();
  const [pair, setPair] = usePair();
  const b = pair.b !== pair.a ? orgs.find((o) => o.id === pair.b) : undefined;
  const option = (o: OrgChoice) => (
    <option key={o.id} value={o.id}>
      {o.label}
      {o.type ? ` — ${o.type}` : ''}
    </option>
  );
  return (
    <div className="card section org-pair">
      <div className="form">
        <label>
          {labelA}
          <select
            value={pair.a}
            onChange={(e) => setPair({ a: e.target.value, b: pair.b === e.target.value ? '' : pair.b })}
          >
            {orgs.map(option)}
          </select>
        </label>
        <button className="swap" title="Swap A and B" disabled={!b} onClick={() => setPair({ a: pair.b, b: pair.a })}>
          ⇄
        </button>
        <label>
          {labelB}
          <select value={b?.id ?? ''} onChange={(e) => setPair({ ...pair, b: e.target.value })}>
            <option value="">Choose the other org…</option>
            {orgs.filter((o) => o.id !== pair.a).map(option)}
          </select>
        </label>
      </div>
      {orgs.length < 2 && (
        <p className="muted" style={{ margin: 0 }}>
          Log in to a second org (Settings → Org) to work between two orgs.
        </p>
      )}
    </div>
  );
}
