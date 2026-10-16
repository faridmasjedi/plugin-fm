import { useState } from 'react';
import { DataTable } from '../components/DataTable';
import { activityLog } from '../context';

/** Changes made from this browser with the Studio (imports, deletes, permission changes, exports). */
export function ActivityPage() {
  const [entries, setEntries] = useState(activityLog.list());
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Activity</h2>
        <span className="muted">Changes made with NomadSF Studio in this browser</span>
        <span className="grow" />
        <button
          className="danger"
          disabled={entries.length === 0}
          onClick={() => {
            if (!confirm('Clear the activity log of this browser?')) return;
            activityLog.clear();
            setEntries([]);
          }}
        >
          Clear
        </button>
      </div>
      <div className="card">
        {entries.length === 0 ? (
          <p className="muted">No changes yet.</p>
        ) : (
          <DataTable
            columns={['at', 'org', 'user', 'action', 'details']}
            rows={entries.map((e) => ({
              ...e,
              at: new Date(e.at).toLocaleString(),
              details: JSON.stringify(e.details),
            }))}
            name="nomadsf-activity"
            rowKey="__none"
          />
        )}
      </div>
    </div>
  );
}
