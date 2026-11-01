import { useEffect, useState } from 'react';
import { deployDetails, deployHistory, quickDeploy, type DeployOutcome, type Row } from '@nomadsf/core';
import { DataTable, EmptyHint } from '../components/DataTable';
import { useStudio } from '../context';
import { Status } from '../statusLog';

/** Recent deployments and validations, their failures, and quick deploy of a recent validation. */
export function DeploymentsPage() {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [chosen, setChosen] = useState<Row | null>(null);
  const [details, setDetails] = useState<DeployOutcome | null>(null);
  const [status, setStatus] = useState('');

  const load = async () => {
    setStatus('Reading deployments…');
    try {
      setRows(await deployHistory(client));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    setRows(null);
    setChosen(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);
  useEffect(() => {
    setDetails(null);
    if (!chosen) return;
    deployDetails(client, String(chosen.Id))
      .then(setDetails)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, chosen]);

  const quick = async () => {
    if (!chosen) return;
    if (!(await confirmChange(`Quick deploy validation ${chosen.Id} to ${org.label}`))) return;
    setStatus('Quick deploy…');
    try {
      const outcome = await quickDeploy(client, String(chosen.Id), {
        onProgress: (s) => setStatus(`Quick deploy: ${s}…`),
      });
      logActivity('quick deploy', { validation: chosen.Id, deploy: outcome.id, success: outcome.success });
      setStatus(outcome.success ? `✓ Deployed (${outcome.id}).` : `❌ ${outcome.errorMessage ?? outcome.status}`);
      await load();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Deployments</h2>
        <span className="muted">Deployments and validations on {org.label}</span>
        <span className="grow" />
        <button onClick={() => void load()}>Refresh</button>
      </div>
      {status && <Status text={status} block />}
      {rows &&
        (rows.length === 0 ? (
          <EmptyHint what="deployments" />
        ) : (
          <DataTable
            columns={['Id', 'Kind', 'Status', 'Started', 'Finished', 'Components', 'Tests', 'By', 'QuickDeploy']}
            rows={rows}
            rowKey="Id"
            name={`${org.label}-deployments`}
            selectedKey={chosen ? String(chosen.Id) : undefined}
            onRowClick={(row) => setChosen(row)}
            note={
              <span>· click one for its failures · QuickDeploy: a recent validation you can deploy without tests</span>
            }
          />
        ))}
      {chosen && (
        <div className="card section">
          <div className="toolbar">
            <h3 style={{ margin: 0 }}>
              {String(chosen.Kind)} {String(chosen.Status).toLowerCase()}{' '}
              <span className="muted mono">{String(chosen.Id)}</span>
            </h3>
            <span className="grow" />
            {chosen.QuickDeploy === 'yes' && (
              <button className="primary" onClick={() => void quick()}>
                Quick deploy…
              </button>
            )}
          </div>
          {!details ? (
            <p className="muted">Reading details…</p>
          ) : (
            <>
              <p className="muted" style={{ margin: 0 }}>
                {details.componentsDeployed}/{details.componentsTotal} components · {details.testsRun} tests run
                {details.errorMessage ? ` · ${details.errorMessage}` : ''}
              </p>
              {details.componentFailures.length > 0 && (
                <>
                  <h4>Component failures ({details.componentFailures.length})</h4>
                  <DataTable
                    columns={['type', 'name', 'line', 'problem']}
                    groupBy="type"
                    rows={details.componentFailures.map((f, i) => ({ ...f, key: i }))}
                    rowKey="key"
                    name={`${String(chosen.Id)}-components`}
                  />
                </>
              )}
              {details.testFailures.length > 0 && (
                <>
                  <h4>Test failures ({details.testFailures.length})</h4>
                  <DataTable
                    columns={['name', 'method', 'message']}
                    rows={details.testFailures.map((f, i) => ({ ...f, key: i }))}
                    rowKey="key"
                    name={`${String(chosen.Id)}-tests`}
                  />
                </>
              )}
              {details.componentFailures.length === 0 && details.testFailures.length === 0 && (
                <p className="good">✓ No failures.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
