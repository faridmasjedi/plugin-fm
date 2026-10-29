import { useCallback, useEffect, useState } from 'react';
import {
  countCreated,
  createdBetween,
  deleteByQuery,
  orgLimits,
  storageReport,
  type OrgLimit,
  type StorageReport,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { DataTable } from '../components/DataTable';
import { Status } from '../statusLog';

const Usage = ({ used, max }: { used: number; max: number }) => {
  const percent = max ? Math.round((used / max) * 100) : 0;
  return (
    <div className="usage">
      <span
        className={percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : ''}
        style={{ width: `${Math.min(100, percent)}%` }}
      />
      <em>{percent}%</em>
    </div>
  );
};

/** Data and file storage, records per object; records created in a period, and deleting them. */
function StorageView() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [report, setReport] = useState<StorageReport | null>(null);
  const [object, setObject] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    setReport(null);
    storageReport(client)
      .then(setReport)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client]);
  useEffect(load, [load]);
  useEffect(() => setCount(null), [object, from, to]);

  const doCount = async () => {
    setStatus('Counting…');
    try {
      setCount(await countCreated(client, object, from || undefined, to || undefined));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  const remove = async () => {
    if (!count) return;
    const period = `${from ? `from ${from}` : ''}${to ? ` before ${to}` : ''}` || 'ever';
    if (
      !(await confirmChange(
        `Delete ${count.toLocaleString()} ${object} record(s) created ${period} in ${
          org.label
        } (Bulk API; they go to the Recycle Bin). Back them up first in Data protection › Backup if you may need them.`
      ))
    )
      return;
    setBusy(true);
    setStatus('Deleting…');
    try {
      const where = createdBetween(from || undefined, to || undefined);
      const r = await deleteByQuery(client, `SELECT Id FROM ${object}${where ? ` WHERE ${where}` : ''}`, {
        onProgress: (state) => setStatus(`Bulk delete: ${state}…`),
      });
      logActivity('delete records by date', { object, from, to, processed: r?.processed, failed: r?.failed });
      setStatus(
        r ? `✓ ${r.processed - r.failed} deleted${r.failed ? `, ${r.failed} failed` : ''}.` : 'Nothing to delete.'
      );
      setCount(null);
      load();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!report) return status ? <Status text={status} block /> : <p className="muted">Reading storage…</p>;
  return (
    <>
      <table className="org-limits card">
        <tbody>
          <tr>
            <td>Data storage</td>
            <td>
              {report.dataMB.used.toLocaleString()} of {report.dataMB.max.toLocaleString()} MB
            </td>
            <td style={{ width: '40%' }}>
              <Usage {...report.dataMB} />
            </td>
          </tr>
          <tr>
            <td>File storage</td>
            <td>
              {report.fileMB.used.toLocaleString()} of {report.fileMB.max.toLocaleString()} MB
            </td>
            <td>
              <Usage {...report.fileMB} />
            </td>
          </tr>
        </tbody>
      </table>
      <DataTable
        columns={['object', 'records', 'estimatedMB']}
        rows={report.objects.map((o) => ({ ...o }))}
        rowKey="object"
        name={`${org.label}-storage`}
        selectedKey={object}
        onRowClick={(r) => setObject(String(r.object))}
        note={
          <span>
            · most records first · MB: about 2 KB a record (Setup › Storage Usage has the exact size) · click an object
          </span>
        }
      />
      {object && (
        <div className="card section">
          <h3>{object}: records created in a period</h3>
          <div className="form">
            <label>
              From
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label>
              Before
              <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <button className="primary" disabled={busy} onClick={() => void doCount()}>
              Count
            </button>
            {count !== null && (
              <>
                <b>{count.toLocaleString()} record(s)</b>
                <button className="danger" disabled={busy || count === 0} onClick={() => void remove()}>
                  Delete them…
                </button>
              </>
            )}
          </div>
          {status ? (
            <Status text={status} block />
          ) : (
            <p className="muted">
              Empty dates: no limit on that side. For deletes on a schedule, with a backup and an approval step, use
              Data protection › Lifecycle.
            </p>
          )}
        </div>
      )}
    </>
  );
}

/** Org limits (API calls, storage, async Apex, …), most used first; Storage: what fills the org. */
export function LimitsPage() {
  const { client } = useStudio();
  const [tab, setTab] = useState<'limits' | 'storage'>(() => storage.get('limits.tab', 'limits'));
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
        <div className="tabs">
          {(
            [
              ['limits', 'Limits'],
              ['storage', 'Storage'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              className={`tab ${tab === id ? 'active' : ''}`}
              onClick={() => {
                setTab(id);
                storage.set('limits.tab', id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'limits' && <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />}
        <span className="grow" />
        {tab === 'limits' && <button onClick={() => void load()}>Refresh</button>}
      </div>
      {tab === 'storage' && <StorageView />}
      {tab === 'limits' && <Status text={error} kind="problem" block />}
      {tab === 'limits' && limits === null && !error && <p className="muted">Loading…</p>}
      <div className="card" hidden={tab !== 'limits'}>
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
