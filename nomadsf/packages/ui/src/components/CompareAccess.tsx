import { useEffect, useMemo, useState } from 'react';
import {
  comparePermissionSets,
  compareUsers,
  permissionHolders,
  searchUsers,
  type Difference,
  type PermissionHolder,
  type UserMatch,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { DataTable } from './DataTable';

type Mode = 'users' | 'sets';

/** Two users, or two profiles / permission sets / groups: what one has that the other does not. */
export function CompareAccess() {
  const { client, org } = useStudio();
  const [mode, setMode] = useState<Mode>(() => storage.get('compare.mode', 'users'));
  const [userA, setUserA] = useState<UserMatch | null>(null);
  const [userB, setUserB] = useState<UserMatch | null>(null);
  const [holders, setHolders] = useState<PermissionHolder[]>([]);
  const [setA, setSetA] = useState('');
  const [setB, setSetB] = useState('');
  const [diff, setDiff] = useState<Difference[] | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    if (mode === 'sets' && holders.length === 0)
      permissionHolders(client)
        .then(setHolders)
        .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, mode, holders.length]);
  useEffect(() => setDiff(null), [mode, userA, userB, setA, setB]);

  const a = mode === 'users' ? userA?.Name : holders.find((h) => h.id === setA)?.name;
  const b = mode === 'users' ? userB?.Name : holders.find((h) => h.id === setB)?.name;
  const ready = mode === 'users' ? Boolean(userA && userB) : Boolean(setA && setB);

  const compare = async () => {
    setStatus('Comparing…');
    try {
      setDiff(
        mode === 'users'
          ? await compareUsers(client, userA!.Id, userB!.Id)
          : await comparePermissionSets(client, setA, setB)
      );
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const areas = useMemo(() => [...new Set((diff ?? []).map((d) => d.area))], [diff]);

  return (
    <div className="card section">
      <h3>Compare</h3>
      <div className="form">
        <div className="segmented" role="group" aria-label="Compare">
          {(
            [
              ['users', 'Two users'],
              ['sets', 'Two profiles, permission sets or groups'],
            ] as Array<[Mode, string]>
          ).map(([id, text]) => (
            <button
              key={id}
              className={mode === id ? 'active' : ''}
              onClick={() => {
                setMode(id);
                storage.set('compare.mode', id);
              }}
            >
              {text}
            </button>
          ))}
        </div>
      </div>
      {mode === 'users' ? (
        <div className="form">
          <UserPicker label="A" value={userA} onChange={setUserA} />
          <UserPicker label="B" value={userB} onChange={setUserB} />
        </div>
      ) : (
        <div className="form">
          {(
            [
              ['A', setA, setSetA],
              ['B', setB, setSetB],
            ] as const
          ).map(([label, value, set]) => (
            <label key={label}>
              {label}
              <select value={value} onChange={(e) => set(e.target.value)} style={{ minWidth: 300 }}>
                <option value="">Choose ({holders.length})</option>
                {(['Profile', 'Permission set', 'Permission set group'] as const).map((k) => (
                  <optgroup key={k} label={`${k}s`}>
                    {holders
                      .filter((h) => h.kind === k)
                      .map((h) => (
                        <option key={h.id} value={h.id}>
                          {h.name}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      <div className="form">
        <button className="primary" disabled={!ready} onClick={() => void compare()}>
          Compare
        </button>
        <span className="muted">{status}</span>
      </div>
      {diff &&
        (diff.length === 0 ? (
          <p className="good">
            ✓ {a} and {b} have the same {mode === 'users' ? 'access' : 'system permissions and object access'}.
          </p>
        ) : (
          <DataTable
            columns={['area', 'item', 'a', 'b']}
            rows={diff.map((d, i) => ({ ...d, key: i }))}
            rowKey="key"
            name={`${org.label}-compare`}
            note={
              <span>
                · A = {a}, B = {b} · only the differences ({areas.join(', ')})
              </span>
            }
          />
        ))}
    </div>
  );
}

function UserPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: UserMatch | null;
  onChange: (u: UserMatch | null) => void;
}) {
  const { client } = useStudio();
  const [text, setText] = useState('');
  const [matches, setMatches] = useState<UserMatch[]>([]);
  const find = async () => {
    const found = await searchUsers(client, text).catch(() => []);
    setMatches(found);
    if (found.length === 1) onChange(found[0]);
  };
  return (
    <label>
      {label}
      {value ? (
        <span className="form">
          <b>{value.Name}</b>
          <span className="muted">{value.Username}</span>
          <button onClick={() => onChange(null)}>Change</button>
        </span>
      ) : (
        <span className="form">
          <input
            placeholder="Name, username or email, Enter"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && text.trim() && void find()}
          />
          {matches.length > 1 && (
            <select value="" onChange={(e) => onChange(matches.find((m) => m.Id === e.target.value) ?? null)}>
              <option value="">{matches.length} users…</option>
              {matches.map((m) => (
                <option key={m.Id} value={m.Id}>
                  {m.Name} ({m.Username})
                </option>
              ))}
            </select>
          )}
        </span>
      )}
    </label>
  );
}
