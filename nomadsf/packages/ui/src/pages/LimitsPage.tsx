import { useCallback, useEffect, useState } from 'react';
import { orgLimits, type OrgLimit } from '@nomadsf/core';
import { useStudio } from '../context';

/** Org limits (API calls, storage, async Apex, …), most used first. */
export function LimitsPage() {
  const { client } = useStudio();
  const [limits, setLimits] = useState<OrgLimit[] | null>(null);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setLimits(await orgLimits(client));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = (limits ?? []).filter((l) => l.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Org limits</h2>
        <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="grow" />
        <button onClick={() => void load()}>Refresh</button>
      </div>
      {error && <div className="error">{error}</div>}
      {limits === null && !error && <p className="muted">Loading…</p>}
      <div className="card">
        <table className="org-limits">
          <thead>
            <tr>
              <th>Limit</th>
              <th>Used</th>
              <th>Max</th>
              <th style={{ width: '40%' }}>Usage</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((l) => (
              <tr key={l.name}>
                <td className="mono">{l.name}</td>
                <td>{l.used.toLocaleString()}</td>
                <td>{l.max.toLocaleString()}</td>
                <td>
                  <div className="usage">
                    <span
                      className={l.percent >= 90 ? 'bad' : l.percent >= 70 ? 'warn' : ''}
                      style={{ width: `${Math.min(100, l.percent)}%` }}
                    />
                    <em>{l.percent}%</em>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
