import { useEffect, useMemo, useState } from 'react';
import { userFullAccess, type Row, type SalesforceClient, type UserAccessSection } from '@nomadsf/core';
import { DataTable } from './DataTable';
import { Status } from '../statusLog';

/** The columns that name a row of each section (the others are its value; Via is left out of the comparison). */
const KEYS: Record<string, string[]> = {
  fields: ['Object', 'Field'],
  recordTypes: ['Object', 'Record type'],
  layouts: ['Object', 'Record type'],
};

type Merged = { id: string; title: string; rows: Row[]; differs: number; note?: string };

/** Two sections side by side: each row's value in A and in B (its access, its layout…). */
export function mergeSections(a: UserAccessSection[], b: UserAccessSection[]): Merged[] {
  const ids = [...new Set([...a.map((s) => s.id), ...b.map((s) => s.id)])];
  return ids.map((id) => {
    const x = a.find((s) => s.id === id);
    const y = b.find((s) => s.id === id);
    const columns = x?.columns ?? y?.columns ?? [];
    const keys = KEYS[id] ?? [columns[0]];
    const values = columns.filter((c) => !keys.includes(c) && c !== 'Via');
    const keyOf = (r: Row) => keys.map((k) => String(r[k] ?? '')).join('.');
    // A row with no value column (a class, a page): ✓ when the user has it
    const valueOf = (r: Row) =>
      values.length
        ? values
            .map((c) => (r[c] ? (r[c] === '✓' ? c : `${c}: ${String(r[c])}`) : ''))
            .filter(Boolean)
            .join(', ')
        : '✓';
    const by = new Map<string, Row>();
    for (const r of x?.rows ?? []) by.set(keyOf(r), { item: keyOf(r), a: valueOf(r), b: '' });
    for (const r of y?.rows ?? []) {
      const k = keyOf(r);
      by.set(k, { ...(by.get(k) ?? { item: k, a: '' }), b: valueOf(r) });
    }
    const unread = Boolean(x?.note || y?.note);
    const rows = [...by.values()]
      .map((r): Row => ({ ...r, differs: !unread && r.a !== r.b ? '≠' : '' }))
      .sort((p, q) => String(p.item).localeCompare(String(q.item)));
    return {
      id,
      title: x?.title ?? y?.title ?? id,
      rows,
      differs: rows.filter((r) => r.differs).length,
      note: [x?.note && `A: ${x.note}`, y?.note && `B: ${y.note}`].filter(Boolean).join(' · ') || undefined,
    };
  });
}

/** Compare two users › Access (combined): what each can do from all their access, section by section. */
export function CombinedAccessCompare({
  client,
  clientB,
  userA,
  userB,
  note,
}: {
  client: SalesforceClient;
  clientB: SalesforceClient;
  userA: string;
  userB: string;
  note: string;
}) {
  const [merged, setMerged] = useState<Merged[] | null>(null);
  const [status, setStatus] = useState('Reading everything each user can do…');
  const [shown, setShown] = useState('objects');
  const [differencesOnly, setDifferencesOnly] = useState(true);
  useEffect(() => {
    let canceled = false;
    setMerged(null);
    setStatus('Reading everything each user can do…');
    Promise.all([userFullAccess(client, userA), userFullAccess(clientB, userB)])
      .then(([a, b]) => {
        if (canceled) return;
        setMerged(mergeSections(a.sections, b.sections));
        setStatus('');
      })
      .catch((e: Error) => !canceled && setStatus(`❌ ${e.message}`));
    return () => {
      canceled = true;
    };
  }, [client, clientB, userA, userB]);
  const section = merged?.find((s) => s.id === shown) ?? merged?.[0];
  const rows = useMemo(
    () =>
      (section?.rows ?? [])
        .filter((r) => !differencesOnly || r.differs)
        .map((r) => ({ ...r, object: String(r.item).split('.')[0] })),
    [section, differencesOnly]
  );
  if (!merged || !section) return <Status text={status} block />;
  return (
    <div className="access-compare section">
      <p className="muted">
        Everything each user can do, combined from their profile, permission sets and groups. The Profile and Permission
        sets tabs show where it comes from.
      </p>
      <div className="tabs" role="tablist" aria-label="Section">
        {merged.map((s) => (
          <button
            key={s.id}
            role="tab"
            className={`tab ${section.id === s.id ? 'active' : ''}`}
            onClick={() => setShown(s.id)}
          >
            {s.title}
            <span className="tab-count">{s.note ? '?' : `${s.differs} ≠`}</span>
          </button>
        ))}
      </div>
      <label className="check">
        <input type="checkbox" checked={differencesOnly} onChange={(e) => setDifferencesOnly(e.target.checked)} />{' '}
        Differences only
      </label>
      {section.note && <p className="bad-text">Not read — {section.note}</p>}
      {rows.length === 0 ? (
        <p className="good">✓ No differences in {section.title.toLowerCase()}.</p>
      ) : (
        <DataTable
          columns={['item', 'a', 'b', 'differs']}
          rows={rows}
          rowKey="item"
          groupBy={KEYS[section.id] ? 'object' : undefined}
          name={`users-access-${section.id}`}
          note={<span>{note}</span>}
        />
      )}
    </div>
  );
}
