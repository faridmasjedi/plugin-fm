import { useEffect, useMemo, useState } from 'react';
import {
  SETUP_KINDS,
  WEEK_DAYS,
  addGroupMembers,
  apiNameFrom,
  createPermissionSet,
  customPermissionHolders,
  grantSetupAccess,
  listGroupMembers,
  listGroups,
  permissionHolders,
  profileLoginSettings,
  query,
  removeGroupMembers,
  revokeSetupAccess,
  roleGroups,
  saveProfileLoginSettings,
  setTabSetting,
  setupAccessOf,
  setupEntities,
  tabSettingsOf,
  type GroupInfo,
  type GroupMemberRow,
  type PermissionHolder,
  type ProfileLoginSettings,
  type Row,
  type SetupAccessRow,
  type SetupEntity,
  type SetupKind,
  type TabSetting,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { DataTable, EmptyHint } from '../components/DataTable';
import { ManagedList, type Choice } from '../components/ManagedList';

const fail = (r: { errors: string[] }): void => {
  if (r.errors.length) throw new Error(r.errors.join('; '));
};

// ---------- Access › Groups & queues ----------

/** Public groups and queues: members (users, roles, groups), add and remove them. */
export function GroupsPage() {
  const { client } = useStudio();
  const [groups, setGroups] = useState<GroupInfo[] | null>(null);
  const [kind, setKind] = useState<'all' | GroupInfo['Kind']>('all');
  const [chosen, setChosen] = useState<GroupInfo | null>(null);
  const [members, setMembers] = useState<GroupMemberRow[] | null>(null);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [status, setStatus] = useState('');

  const loadGroups = () =>
    listGroups(client)
      .then(setGroups)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  useEffect(() => {
    setGroups(null);
    setChosen(null);
    void loadGroups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  useEffect(() => {
    setMembers(null);
    if (!chosen) return;
    listGroupMembers(client, chosen.Id)
      .then(setMembers)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, chosen]);

  // Who can be added: active users, roles (alone or with subordinates), other public groups
  useEffect(() => {
    if (!chosen || choices) return;
    void Promise.all([
      query(client, 'SELECT Id, Name, Username FROM User WHERE IsActive = true ORDER BY Name', { maxRows: 5000 }),
      roleGroups(client).catch(() => []),
    ]).then(([users, roles]) =>
      setChoices([
        ...users.rows.map((u) => ({ id: String(u.Id), label: String(u.Name), detail: `user · ${String(u.Username)}` })),
        ...roles.flatMap((r) => [
          ...(r.roleGroupId ? [{ id: r.roleGroupId, label: r.role, detail: 'role' }] : []),
          ...(r.withSubordinatesGroupId
            ? [{ id: r.withSubordinatesGroupId, label: r.role, detail: 'role and subordinates' }]
            : []),
        ]),
        ...(groups ?? [])
          .filter((g) => g.Kind === 'Public group')
          .map((g) => ({ id: g.Id, label: g.Name, detail: 'public group' })),
      ])
    );
  }, [client, chosen, choices, groups]);

  const shown = (groups ?? []).filter((g) => kind === 'all' || g.Kind === kind);
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Groups &amp; queues</h2>
        <span className="muted">public groups and queues, and who is in them</span>
        <span className="grow" />
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="all">Groups and queues</option>
          <option value="Public group">Public groups</option>
          <option value="Queue">Queues</option>
        </select>
      </div>
      {status && <p className="muted">{status}</p>}
      {!groups ? (
        <p className="muted">Reading…</p>
      ) : (
        <DataTable
          columns={['Name', 'Kind', 'DeveloperName', 'Members', 'Objects', 'Email']}
          rows={shown}
          rowKey="Id"
          name="groups-and-queues"
          selectedKey={chosen?.Id}
          onRowClick={(r) => setChosen(groups.find((g) => g.Id === r.Id) ?? null)}
          note={<span>· click one for its members · Objects: what a queue can own</span>}
        />
      )}
      {chosen && (
        <div className="card section">
          <h3>
            {chosen.Name} <span className="muted">· {chosen.Kind}</span>
          </h3>
          {!members ? (
            <p className="muted">Reading members…</p>
          ) : (
            <ManagedList
              rows={members}
              columns={['Name', 'Kind', 'Detail']}
              what="member"
              removeKey="MemberId"
              onRemove={async (r) => fail(await removeGroupMembers(client, [String(r.MemberId)]))}
              choices={(choices ?? []).filter(
                (c) => !members.some((m) => m.UserOrGroupId.slice(0, 15) === c.id.slice(0, 15))
              )}
              addLabel={choices ? 'Add a user, role or group' : 'Loading users and roles'}
              onAdd={async (c) => fail(await addGroupMembers(client, chosen.Id, [c.id]))}
              onChanged={() => {
                setMembers(null);
                void listGroupMembers(client, chosen.Id).then(setMembers);
                void loadGroups();
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Access › Custom permissions ----------

/** Custom permissions: which permission sets, profiles and groups give each one; grant or remove it. */
export function CustomPermissionsPage() {
  const { client } = useStudio();
  const [list, setList] = useState<SetupEntity[] | null>(null);
  const [chosen, setChosen] = useState<SetupEntity | null>(null);
  const [holders, setHolders] = useState<Row[] | null>(null);
  const [all, setAll] = useState<PermissionHolder[] | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    setList(null);
    setChosen(null);
    setupEntities(client, 'CustomPermission')
      .then(setList)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
    permissionHolders(client)
      .then(setAll)
      .catch(() => undefined);
  }, [client]);
  const load = (id: string) => {
    setHolders(null);
    customPermissionHolders(client, id)
      .then(setHolders)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  };
  useEffect(() => {
    if (chosen) load(chosen.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, chosen]);

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Custom permissions</h2>
        <span className="muted">who gives each one; grant it to a permission set or profile</span>
      </div>
      {status && <p className="muted">{status}</p>}
      {!list ? (
        <p className="muted">Reading…</p>
      ) : list.length === 0 ? (
        <EmptyHint what="custom permissions" />
      ) : (
        <DataTable
          columns={['label', 'name', 'namespace']}
          rows={list}
          rowKey="id"
          name="custom-permissions"
          selectedKey={chosen?.id}
          onRowClick={(r) => setChosen(list.find((c) => c.id === r.id) ?? null)}
          note={<span>· click one for who has it · new ones are made in Setup or deployed as metadata</span>}
        />
      )}
      {chosen && (
        <div className="card section">
          <h3>
            {chosen.label} <span className="muted mono">{chosen.name}</span>
          </h3>
          {!holders ? (
            <p className="muted">Reading…</p>
          ) : (
            <ManagedList
              rows={holders}
              columns={['Name', 'Kind']}
              what="grant"
              removeKey="AccessId"
              onRemove={async (r) => fail(await revokeSetupAccess(client, [String(r.AccessId)]))}
              choices={(all ?? [])
                .filter((h) => h.kind !== 'Permission set group')
                .filter((h) => !holders.some((x) => String(x.PermissionSetId).slice(0, 15) === h.id.slice(0, 15)))
                .map((h) => ({ id: h.id, label: h.name, detail: h.kind }))}
              addLabel="Grant to a permission set or profile"
              onAdd={async (c) => fail(await grantSetupAccess(client, c.id, [chosen.id]))}
              onChanged={() => load(chosen.id)}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Permissions › Apps, classes & more ----------

/**
 * What a permission set or profile gives access to besides objects, fields and system permissions:
 * Apex classes, Visualforce pages, custom permissions, connected apps and apps.
 */
export function SetupAccessPanel({
  permissionSetId,
  editable,
  reason,
}: {
  permissionSetId: string;
  editable: boolean;
  reason?: string;
}) {
  const { client } = useStudio();
  const [rows, setRows] = useState<SetupAccessRow[] | null>(null);
  const [kind, setKind] = useState<SetupKind>('ApexClass');
  const [entities, setEntities] = useState<Partial<Record<SetupKind, SetupEntity[]>>>({});
  const [status, setStatus] = useState('');

  const load = () => {
    setRows(null);
    setupAccessOf(client, permissionSetId)
      .then(setRows)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  };
  useEffect(load, [client, permissionSetId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!editable || entities[kind]) return;
    setupEntities(client, kind)
      .then((list) => setEntities((e) => ({ ...e, [kind]: list })))
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, kind, editable, entities]);

  const mine = (rows ?? []).filter((r) => r.kind === kind);
  const info = SETUP_KINDS.find((k) => k.type === kind);
  return (
    <div className="section">
      <div className="tabs">
        {SETUP_KINDS.map((k) => (
          <button key={k.type} className={`tab ${kind === k.type ? 'active' : ''}`} onClick={() => setKind(k.type)}>
            {k.label} ({(rows ?? []).filter((r) => r.kind === k.type).length})
          </button>
        ))}
      </div>
      {status && <p className="muted">{status}</p>}
      {!rows ? (
        <p className="muted">Reading…</p>
      ) : (
        <ManagedList
          rows={mine.map((r) => ({ ...r, Name: r.name, Label: r.label }))}
          columns={['Name', 'Label']}
          what={info?.one ?? kind}
          whatPlural={info?.label}
          removeKey={editable ? 'accessId' : '__none'}
          onRemove={async (r) => fail(await revokeSetupAccess(client, [String(r.accessId)]))}
          choices={(entities[kind] ?? [])
            .filter((e) => !mine.some((m) => m.entityId.slice(0, 15) === e.id.slice(0, 15)))
            .map((e) => ({
              id: e.id,
              label: `${e.namespace ? `${e.namespace}__` : ''}${e.name}`,
              detail: e.label !== e.name ? e.label : undefined,
            }))}
          onAdd={editable ? async (c) => fail(await grantSetupAccess(client, permissionSetId, [c.id])) : undefined}
          onChanged={load}
        />
      )}
      {!editable && reason && <p className="muted">{reason}</p>}
    </div>
  );
}

// ---------- Permissions › Tabs (permission sets) ----------

export function TabSettingsPanel({ permissionSetId, editable }: { permissionSetId: string; editable: boolean }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [tabs, setTabs] = useState<TabSetting[] | null>(null);
  const [filter, setFilter] = useState('');
  const [onlySet, setOnlySet] = useState(true);
  const [status, setStatus] = useState('');
  const load = () =>
    tabSettingsOf(client, permissionSetId)
      .then(setTabs)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  useEffect(() => {
    setTabs(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, permissionSetId]);

  const change = async (t: TabSetting, visibility: TabSetting['visibility']) => {
    if (!(await confirmChange(`Set the ${t.label} tab to ${visibility} in ${org.label}`))) return;
    setStatus('Saving…');
    try {
      await setTabSetting(client, permissionSetId, t, visibility);
      logActivity('tab setting', { tab: t.tab, visibility });
      setStatus(`✓ ${t.label}: ${visibility}.`);
      await load();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  const needle = filter.trim().toLowerCase();
  const shown = (tabs ?? []).filter(
    (t) => (!onlySet || t.visibility !== 'Hidden') && (!needle || `${t.label} ${t.tab}`.toLowerCase().includes(needle))
  );
  return (
    <div className="section">
      <div className="form">
        <input placeholder="Filter tabs" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={onlySet} onChange={(e) => setOnlySet(e.target.checked)} /> Only tabs it sets
        </label>
        <span className="muted">
          {status || 'Visible: on the app nav · Available: in App Launcher · Hidden: not set'}
        </span>
      </div>
      {!tabs ? (
        <p className="muted">Reading…</p>
      ) : (
        <table className="edit-table">
          <tbody>
            {shown.map((t) => (
              <tr key={t.tab}>
                <td>{t.label}</td>
                <td className="muted mono">{t.tab}</td>
                <td>
                  {editable ? (
                    <select
                      value={t.visibility}
                      onChange={(e) => void change(t, e.target.value as TabSetting['visibility'])}
                    >
                      <option>Visible</option>
                      <option>Available</option>
                      <option>Hidden</option>
                    </select>
                  ) : (
                    t.visibility
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- Permissions › Login IP ranges & hours (custom profiles) ----------

const time = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const minutesOf = (text: string): number => {
  const [h, m] = text.split(':').map(Number);
  return h * 60 + (m || 0);
};

export function ProfileLoginPanel({ profileId, editable }: { profileId: string; editable: boolean }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [settings, setSettings] = useState<ProfileLoginSettings | null>(null);
  const [draft, setDraft] = useState<ProfileLoginSettings | null>(null);
  const [status, setStatus] = useState('Reading the profile (Metadata API)…');
  const load = () =>
    profileLoginSettings(client, profileId)
      .then((s) => {
        setSettings(s);
        setDraft(s);
        setStatus('');
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  useEffect(() => {
    setSettings(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, profileId]);

  const changed = useMemo(() => JSON.stringify(settings) !== JSON.stringify(draft), [settings, draft]);
  const save = async () => {
    if (!draft) return;
    const ranges = draft.ipRanges.map((r) => `${r.start} – ${r.end}`).join(', ') || 'none';
    if (
      !(await confirmChange(
        `Deploy login IP ranges (${ranges}) and login hours of profile ${draft.fullName} to ${org.label}`
      ))
    )
      return;
    setStatus('Deploying…');
    try {
      const r = await saveProfileLoginSettings(client, draft);
      logActivity('profile login settings', { profile: draft.fullName, success: r.success });
      if (!r.success) setStatus(`❌ ${r.problems.join('; ') || 'The deploy failed.'}`);
      else {
        setStatus('✓ Deployed.');
        await load();
      }
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  if (!draft) return <p className="muted">{status}</p>;
  const setRange = (i: number, patch: Partial<ProfileLoginSettings['ipRanges'][number]>) =>
    setDraft({ ...draft, ipRanges: draft.ipRanges.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <div className="section">
      <h4>Login IP ranges</h4>
      <p className="muted">Users of this profile can only log in from these addresses (none: from anywhere).</p>
      <table className="edit-table">
        <tbody>
          {draft.ipRanges.map((r, i) => (
            <tr key={i}>
              <td>
                <input
                  className="mono"
                  value={r.start}
                  disabled={!editable}
                  onChange={(e) => setRange(i, { start: e.target.value.trim() })}
                />
              </td>
              <td>–</td>
              <td>
                <input
                  className="mono"
                  value={r.end}
                  disabled={!editable}
                  onChange={(e) => setRange(i, { end: e.target.value.trim() })}
                />
              </td>
              <td>
                <input
                  placeholder="Description"
                  value={r.description}
                  disabled={!editable}
                  onChange={(e) => setRange(i, { description: e.target.value })}
                />
              </td>
              <td>
                {editable && (
                  <button
                    className="link danger"
                    onClick={() => setDraft({ ...draft, ipRanges: draft.ipRanges.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editable && (
        <div className="form">
          <button
            onClick={() =>
              setDraft({ ...draft, ipRanges: [...draft.ipRanges, { start: '', end: '', description: '' }] })
            }
          >
            + IP range
          </button>
        </div>
      )}
      <h4>Login hours</h4>
      <p className="muted">Days without hours: any time. Times are in the org's default time zone.</p>
      <table className="edit-table">
        <tbody>
          {WEEK_DAYS.map((d) => {
            const h = draft.hours[d];
            return (
              <tr key={d}>
                <td style={{ textTransform: 'capitalize' }}>{d}</td>
                <td>
                  <label className="check">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={Boolean(h)}
                      onChange={(e) => {
                        const hours = { ...draft.hours };
                        if (e.target.checked) hours[d] = { start: 480, end: 1080 };
                        else delete hours[d];
                        setDraft({ ...draft, hours });
                      }}
                    />{' '}
                    {h ? 'from' : 'any time'}
                  </label>
                </td>
                {h && (
                  <>
                    <td>
                      <input
                        type="time"
                        disabled={!editable}
                        value={time(h.start)}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            hours: { ...draft.hours, [d]: { ...h, start: minutesOf(e.target.value) } },
                          })
                        }
                      />
                    </td>
                    <td>to</td>
                    <td>
                      <input
                        type="time"
                        disabled={!editable}
                        value={time(Math.min(h.end, 1439))}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            hours: { ...draft.hours, [d]: { ...h, end: minutesOf(e.target.value) } },
                          })
                        }
                      />
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="form">
        {editable && (
          <>
            <button disabled={!changed} onClick={() => setDraft(settings)}>
              Undo
            </button>
            <button className="primary" disabled={!changed} onClick={() => void save()}>
              Deploy…
            </button>
          </>
        )}
        <span className="muted">{status || (editable ? '' : 'Standard profiles cannot be changed.')}</span>
      </div>
    </div>
  );
}

// ---------- Permission sets & groups › New ----------

export function NewPermissionSet({ onCreated }: { onCreated: () => void }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [group, setGroup] = useState(false);
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('');
  const apiName = nameTouched ? name : apiNameFrom(label);
  const what = group ? 'permission set group' : 'permission set';

  const create = async () => {
    if (!(await confirmChange(`Create ${what} ${label} (${apiName}) in ${org.label}`))) return;
    setStatus('Creating…');
    try {
      const id = await createPermissionSet(client, { label, name: apiName, description, group });
      logActivity(`create ${what}`, { label, name: apiName, id });
      setStatus(
        `✓ Created ${label}. Add permissions in Access › Permissions${group ? ', and its permission sets there' : ''}.`
      );
      setLabel('');
      setName('');
      setNameTouched(false);
      setDescription('');
      onCreated();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  return (
    <div className="form">
      <select value={group ? 'group' : 'set'} onChange={(e) => setGroup(e.target.value === 'group')}>
        <option value="set">New permission set</option>
        <option value="group">New permission set group</option>
      </select>
      <input placeholder="Label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <input
        className="mono"
        placeholder="API name"
        value={apiName}
        onChange={(e) => {
          setName(e.target.value);
          setNameTouched(true);
        }}
      />
      <input
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <button className="primary" disabled={!label.trim() || !apiName} onClick={() => void create()}>
        Create…
      </button>
      {status && <span className="muted">{status}</span>}
    </div>
  );
}
