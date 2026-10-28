import { useEffect, useState } from 'react';
import { searchUsers, setActive, setFrozen, userLogin, type UserMatch } from '@nomadsf/core';
import { useStudio } from '../context';
import { RecordPage } from '../pages/RecordPage';
import { DataTable } from './DataTable';
import { UserAccessPanel } from './UserAccessPanel';
import { UserSnapshot } from './UserSnapshot';

/** Find a user by name, username, email or Id, then edit any field (the Record editor) or freeze / deactivate. */
export function UserEditor() {
  const studio = useStudio();
  const { client, org, confirmChange, logActivity } = studio;
  const [text, setText] = useState('');
  const [matches, setMatches] = useState<UserMatch[] | null>(null);
  const [chosen, setChosen] = useState<UserMatch | null>(null);
  const [login, setLogin] = useState<{ id: string; frozen: boolean } | undefined>();
  const [status, setStatus] = useState('');
  const [reload, setReload] = useState(0);

  const search = async () => {
    setStatus('Searching…');
    setChosen(null);
    try {
      const found = await searchUsers(client, text);
      setMatches(found);
      setStatus(found.length ? '' : 'No user matches.');
      if (found.length === 1) setChosen(found[0]);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  useEffect(() => {
    setLogin(undefined);
    if (!chosen) return;
    userLogin(client, chosen.Id)
      .then(setLogin)
      .catch(() => undefined);
  }, [client, chosen, reload]);

  const act = async (what: string, change: () => Promise<void>, details: Record<string, unknown>) => {
    if (!chosen || !(await confirmChange(`${what} ${chosen.Name} (${chosen.Username}) in ${org.label}`))) return;
    setStatus(`${what}…`);
    try {
      await change();
      logActivity('user change', { user: chosen.Username, ...details });
      setStatus(`✓ ${what} done.`);
      const fresh = (await searchUsers(client, chosen.Id))[0];
      if (fresh) setChosen(fresh);
      setReload((n) => n + 1);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div className="card section">
      <h3>Find and update a user</h3>
      <div className="form">
        <input
          style={{ minWidth: 380 }}
          placeholder="Name, username, email or user Id"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && text.trim() && void search()}
        />
        <button className="primary" disabled={!text.trim()} onClick={() => void search()}>
          Find
        </button>
        <span className="muted">{status}</span>
      </div>
      {!chosen && <UserSnapshot />}
      {matches && matches.length > 1 && (
        <DataTable
          columns={['Name', 'Username', 'Email', 'Profile', 'IsActive', 'LastLoginDate']}
          rows={matches.map((m) => ({ ...m }))}
          rowKey="Id"
          name="users"
          selectedKey={chosen?.Id}
          onRowClick={(row) => setChosen(matches.find((m) => m.Id === row.Id) ?? null)}
          note={<span>· click a user</span>}
        />
      )}
      {chosen && (
        <>
          <div className="form user-actions">
            <b>{chosen.Name}</b>
            <span className="muted">
              {chosen.Username} · {chosen.Profile}
            </span>
            <span className={`pill ${chosen.IsActive ? 'good' : 'bad'}`}>
              {chosen.IsActive ? 'Active' : 'Inactive'}
            </span>
            {login?.frozen && <span className="pill bad">Frozen</span>}
            <span className="grow" />
            {login && (
              <button
                onClick={() =>
                  void act(login.frozen ? 'Unfreeze' : 'Freeze', () => setFrozen(client, login.id, !login.frozen), {
                    frozen: !login.frozen,
                  })
                }
              >
                {login.frozen ? 'Unfreeze' : 'Freeze'}
              </button>
            )}
            <button
              className={chosen.IsActive ? 'danger' : ''}
              onClick={() =>
                void act(
                  chosen.IsActive ? 'Deactivate' : 'Activate',
                  () => setActive(client, chosen.Id, !chosen.IsActive),
                  {
                    active: !chosen.IsActive,
                  }
                )
              }
            >
              {chosen.IsActive ? 'Deactivate' : 'Activate'}
            </button>
          </div>
          <UserSnapshot key={chosen.Id} userId={chosen.Id} username={chosen.Username} />
          <UserAccessPanel
            userId={chosen.Id}
            label={chosen.Username}
            details={
              /* Every field of the user, with Edit / Save and Log in as */
              <RecordPage key={`${chosen.Id}-${reload}`} initialId={chosen.Id} embedded />
            }
          />
        </>
      )}
    </div>
  );
}
