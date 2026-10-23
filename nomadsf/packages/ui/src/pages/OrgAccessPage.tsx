import { useState } from 'react';
import { findUserInBoth, type Row, type SalesforceClient } from '@nomadsf/core';
import { CompareAccess } from '../components/CompareAccess';
import { DataTable, EmptyHint } from '../components/DataTable';
import { WhoHasIt } from '../components/WhoHasIt';
import { storage } from '../context';
import { OrgPairBar, usePairClients } from '../pair';

type Tab = 'find' | 'compare' | 'who';

/** Org to org › Access: a user in both orgs, users / profiles / permission sets compared, assigned users in both. */
export function OrgAccessPage() {
  const { a, b, clientA, clientB, error } = usePairClients();
  const [tab, setTab] = useState<Tab>(() => storage.get('orgaccess.tab', 'find'));
  const sides = clientA && a && b ? { clientA, labelA: a.label, clientB, labelB: b.label } : undefined;
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Access</h2>
        <span className="muted">users, profiles, permission sets and groups in two orgs</span>
      </div>
      <OrgPairBar />
      {error && <p className="bad-text">{error}</p>}
      <div className="tabs">
        {(
          [
            ['find', 'Find a user'],
            ['compare', 'Compare'],
            ['who', 'Assigned users'],
          ] as Array<[Tab, string]>
        ).map(([id, text]) => (
          <button
            key={id}
            className={`tab ${tab === id ? 'active' : ''}`}
            onClick={() => {
              setTab(id);
              storage.set('orgaccess.tab', id);
            }}
          >
            {text}
          </button>
        ))}
      </div>
      {!sides || !sides.clientB ? (
        <p className="muted">{b ? 'Connecting…' : 'Choose the other org (B) above.'}</p>
      ) : tab === 'find' ? (
        <FindUser
          key={`${a?.id}-${b?.id}`}
          clientA={sides.clientA}
          clientB={sides.clientB}
          labelA={sides.labelA}
          labelB={sides.labelB}
        />
      ) : tab === 'compare' ? (
        <CompareAccess key={`${a?.id}-${b?.id}`} between={sides} />
      ) : (
        <WhoHasIt key={`${a?.id}-${b?.id}`} between={sides} />
      )}
    </div>
  );
}

/** Is this user in both orgs? By name, username, email or Id; paired by username (with or without a sandbox suffix). */
function FindUser({
  clientA,
  clientB,
  labelA,
  labelB,
}: {
  clientA: SalesforceClient;
  clientB: SalesforceClient;
  labelA: string;
  labelB: string;
}) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [status, setStatus] = useState('');
  const find = async () => {
    if (!text.trim()) return;
    setRows(null);
    setStatus('Looking in both orgs…');
    try {
      setRows(await findUserInBoth(clientA, clientB, text));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  return (
    <div className="card section">
      <h3>Find a user</h3>
      <div className="form">
        <input
          placeholder="Name, username, email or Id"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void find()}
          style={{ minWidth: 320 }}
        />
        <button className="primary" disabled={!text.trim()} onClick={() => void find()}>
          Find
        </button>
        <span className="muted">{status}</span>
      </div>
      {rows &&
        (rows.length === 0 ? (
          <EmptyHint what="users" />
        ) : (
          <DataTable
            columns={[
              'Name',
              'in',
              'usernameA',
              'usernameB',
              'activeA',
              'activeB',
              'profileA',
              'profileB',
              'lastLoginA',
              'lastLoginB',
            ]}
            rows={rows}
            rowKey="Id"
            name={`${labelA}-${labelB}-users`}
            note={
              <span>
                · A = {labelA}, B = {labelB} · the same user by username, with or without a sandbox suffix
              </span>
            }
          />
        ))}
    </div>
  );
}
