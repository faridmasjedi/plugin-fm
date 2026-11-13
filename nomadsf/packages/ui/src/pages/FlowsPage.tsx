import { useEffect, useState } from 'react';
import {
  deleteFlowVersions,
  deleteInterviews,
  failedRuns,
  flowVersions,
  oldApiFlows,
  oldVersions,
  pausedInterviews,
  type FlowVersion,
  type Row,
} from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { Status } from '../statusLog';

type Tab = 'versions' | 'api' | 'paused' | 'failed';

/**
 * Develop › Flows: tidying flows — old versions that no longer run (delete them), active flows on an old API version,
 * interviews left waiting (delete them), and runs that failed. Deleting asks for the org name first.
 */
export function FlowsPage() {
  const studio = useStudio();
  const { client, org } = studio;
  const [tab, setTab] = useState<Tab>(() => storage.get('flows.tab', 'versions'));
  const [all, setAll] = useState<FlowVersion[] | null>(null);
  const [paused, setPaused] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState<Row[] | null | undefined>(null);
  const [below, setBelow] = useState(55);
  const [days, setDays] = useState(7);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState('');

  const fail = (e: Error) => setStatus(`❌ ${e.message}`);
  const loadVersions = () => {
    setAll(null);
    flowVersions(client).then(setAll).catch(fail);
  };
  const loadPaused = () => {
    setPaused(null);
    pausedInterviews(client).then(setPaused).catch(fail);
  };
  const loadFailed = (d = days) => {
    setFailed(null);
    failedRuns(client, d).then(setFailed).catch(fail);
  };
  useEffect(() => {
    setStatus('');
    setTicked(new Set());
    loadVersions();
    loadPaused();
    loadFailed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const old = all ? oldVersions(all) : null;
  const oldApi = all ? oldApiFlows(all, below) : null;
  const choose = (t: Tab) => {
    setTab(t);
    setTicked(new Set());
    storage.set('flows.tab', t);
  };

  const removeVersions = async () => {
    const list = (old ?? []).filter((v) => ticked.has(v.id));
    if (!list.length || !(await studio.confirmChange(`Delete ${list.length} old flow version(s) in ${org.label}`)))
      return;
    setStatus(`Deleting ${list.length} flow version(s)…`);
    const r = await deleteFlowVersions(client, list);
    studio.logActivity('flows', { deletedVersions: r.done, errors: r.errors.length });
    setStatus(
      r.errors.length ? `Deleted ${r.done}. ❌ ${r.errors.join('; ')}` : `✓ Deleted ${r.done} flow version(s).`
    );
    setTicked(new Set());
    loadVersions();
  };
  const removeInterviews = async () => {
    const ids = [...ticked];
    if (!ids.length || !(await studio.confirmChange(`Delete ${ids.length} waiting flow interview(s) in ${org.label}`)))
      return;
    setStatus(`Deleting ${ids.length} interview(s)…`);
    const r = await deleteInterviews(client, ids);
    studio.logActivity('flows', { deletedInterviews: r.done, errors: r.errors.length });
    setStatus(r.errors.length ? `Deleted ${r.done}. ❌ ${r.errors.join('; ')}` : `✓ Deleted ${r.done} interview(s).`);
    setTicked(new Set());
    loadPaused();
  };

  const tabs: Array<[Tab, string, number | undefined]> = [
    ['versions', 'Old versions', old?.length],
    ['api', 'Old API versions', oldApi?.length],
    ['paused', 'Waiting interviews', paused?.length],
    ['failed', 'Failed runs', failed ? failed.length : undefined],
  ];

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Flows</h2>
        <span className="muted">Old versions, old API versions, waiting and failed interviews on {org.label}</span>
        <span className="grow" />
        <button
          onClick={() => {
            loadVersions();
            loadPaused();
            loadFailed();
          }}
        >
          Refresh
        </button>
      </div>
      <div className="tabs" role="tablist">
        {tabs.map(([id, label, count]) => (
          <button key={id} role="tab" className={`tab ${tab === id ? 'active' : ''}`} onClick={() => choose(id)}>
            {label}
            {count !== undefined && <span className="tab-count">{count}</span>}
          </button>
        ))}
      </div>
      {status && <Status text={status} block />}

      {tab === 'versions' &&
        (!old ? (
          <p className="muted">Reading flow versions…</p>
        ) : old.length === 0 ? (
          <EmptyHint what="old flow versions" />
        ) : (
          <>
            <DataTable
              columns={['flow', 'label', 'version', 'status', 'apiVersion', 'lastModified']}
              rows={old}
              rowKey="id"
              name={`${org.label}-old-flow-versions`}
              groupBy="flow"
              selected={ticked}
              onSelectedChange={setTicked}
              note={<span>· versions that do not run; the active one and the newest of each flow are kept</span>}
            />
            <div className="form">
              <button className="danger" disabled={!ticked.size} onClick={() => void removeVersions()}>
                Delete {ticked.size || ''} ticked…
              </button>
            </div>
          </>
        ))}

      {tab === 'api' && (
        <>
          <div className="form">
            <label>
              Active flows on an API version below
              <input
                type="number"
                min={20}
                max={99}
                value={below}
                onChange={(e) => setBelow(Number(e.target.value))}
                style={{ width: 80 }}
              />
            </label>
          </div>
          {!oldApi ? (
            <p className="muted">Reading flow versions…</p>
          ) : oldApi.length === 0 ? (
            <EmptyHint what={`active flows below API ${below}`} />
          ) : (
            <DataTable
              columns={['flow', 'label', 'version', 'apiVersion', 'processType', 'lastModified']}
              rows={oldApi}
              rowKey="id"
              name={`${org.label}-old-api-flows`}
              note={<span>· save each one again in Flow Builder to move it to the current API version</span>}
            />
          )}
        </>
      )}

      {tab === 'paused' &&
        (!paused ? (
          <p className="muted">Reading interviews…</p>
        ) : paused.length === 0 ? (
          <EmptyHint what="waiting interviews" />
        ) : (
          <>
            <DataTable
              columns={[
                'InterviewLabel',
                'InterviewStatus',
                'CurrentElement',
                'PauseLabel',
                'CreatedDate',
                'CreatedBy.Name',
              ]}
              rows={paused}
              rowKey="Id"
              name={`${org.label}-waiting-interviews`}
              selected={ticked}
              onSelectedChange={setTicked}
              note={<span>· paused, or waiting for a time or an event</span>}
            />
            <div className="form">
              <button className="danger" disabled={!ticked.size} onClick={() => void removeInterviews()}>
                Delete {ticked.size || ''} ticked…
              </button>
            </div>
          </>
        ))}

      {tab === 'failed' && (
        <>
          <div className="form">
            <label>
              Last
              <input
                type="number"
                min={1}
                max={3650}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
                onKeyDown={(e) => e.key === 'Enter' && loadFailed()}
                style={{ width: 80 }}
              />
            </label>
            <span className="muted">days</span>
            <button onClick={() => loadFailed()}>Show</button>
          </div>
          {failed === null ? (
            <p className="muted">Reading…</p>
          ) : failed === undefined ? (
            <p className="note">
              This org keeps no flow interview logs. Turn them on in Setup › Process Automation Settings (“Enable flow
              interview logs”) to see failed runs here; failure e-mails go to the flow’s last editor meanwhile.
            </p>
          ) : failed.length === 0 ? (
            <EmptyHint what="failed runs" />
          ) : (
            <DataTable
              columns={[
                'FlowDeveloperName',
                'FlowLabel',
                'FlowVersionNumber',
                'InterviewStartTimestamp',
                'CreatedBy.Name',
              ]}
              rows={failed}
              rowKey="Id"
              name={`${org.label}-failed-flow-runs`}
              groupBy="FlowDeveloperName"
              note={<span>· runs that ended in an error</span>}
            />
          )}
        </>
      )}
    </div>
  );
}
