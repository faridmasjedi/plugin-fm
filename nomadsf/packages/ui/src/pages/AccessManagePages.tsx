import { useEffect, useMemo, useState } from 'react';
import {
  SETUP_KINDS,
  addGroupMembers,
  apiNameFrom,
  cloneProfile,
  clonePermissionSet,
  clonePermissionSetGroup,
  createCustomPermission,
  createPermissionSet,
  customPermissionHolders,
  grantSetupAccess,
  listGroupMembers,
  layoutAssignments,
  listGroups,
  listMetadata,
  permissionHolders,
  profileLoginSettings,
  query,
  recordTypeAccess,
  removeGroupMembers,
  revokeSetupAccess,
  roleGroups,
  saveLayoutAssignments,
  saveProfileLoginSettings,
  saveRecordTypeAccess,
  setTabSetting,
  setupAccessOf,
  setupEntities,
  tabSettingsOf,
  type GroupInfo,
  type GroupMemberRow,
  type LayoutAssignment,
  type PermissionHolder,
  type ProfileLoginSettings,
  type RecordTypeAccess,
  type Row,
  type SetupAccessRow,
  type SetupEntity,
  type SetupKind,
  type TabSetting,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { DataTable, EmptyHint } from '../components/DataTable';
import { ManagedList, type Choice } from '../components/ManagedList';
import { Status } from '../statusLog';

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
        ...users.rows.map((u) => ({
          id: String(u.Id),
          label: String(u.Name),
          detail: String(u.Username),
          kind: 'User',
        })),
        ...(groups ?? [])
          .filter((g) => g.Kind === 'Public group')
          .map((g) => ({ id: g.Id, label: g.Name, detail: g.DeveloperName, kind: 'Public group' })),
        ...roles.flatMap((r) => [
          ...(r.roleGroupId ? [{ id: r.roleGroupId, label: r.role, kind: 'Role' }] : []),
          ...(r.withSubordinatesGroupId
            ? [{ id: r.withSubordinatesGroupId, label: r.role, kind: 'Role and subordinates' }]
            : []),
        ]),
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
      {status && <Status text={status} block />}
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
                (c) => c.id !== chosen.Id && !members.some((m) => m.UserOrGroupId.slice(0, 15) === c.id.slice(0, 15))
              )}
              kinds={['User', 'Public group', 'Role', 'Role and subordinates']}
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

  const loadList = () =>
    setupEntities(client, 'CustomPermission')
      .then(setList)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  useEffect(() => {
    setList(null);
    setChosen(null);
    void loadList();
    permissionHolders(client)
      .then(setAll)
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      <NewCustomPermission holders={all ?? []} onCreated={() => void loadList()} />
      {status && <Status text={status} block />}
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
          note={<span>· click one for who has it</span>}
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

/** A new custom permission (deployed with the Metadata API), granted at once to the sets and profiles ticked. */
function NewCustomPermission({ holders, onCreated }: { holders: PermissionHolder[]; onCreated: () => void }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [grantTo, setGrantTo] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const apiName = nameTouched ? name : apiNameFrom(label);
  const offered = holders.filter((h) => h.kind !== 'Permission set group');
  const needle = filter.trim().toLowerCase();
  const shown = offered.filter((h) => !needle || `${h.kind} ${h.name}`.toLowerCase().includes(needle));

  const create = async () => {
    const names = offered.filter((h) => grantTo.has(h.id)).map((h) => h.name);
    if (
      !(await confirmChange(
        `Create custom permission ${label} (${apiName}) in ${org.label}${
          names.length ? ` and grant it to: ${names.join(', ')}` : ''
        }`
      ))
    )
      return;
    setStatus('Deploying the custom permission…');
    try {
      const id = await createCustomPermission(client, { label, name: apiName, description });
      const errors: string[] = [];
      for (const holder of grantTo) {
        // eslint-disable-next-line no-await-in-loop
        errors.push(...(await grantSetupAccess(client, holder, [id])).errors);
      }
      logActivity('create custom permission', { label, name: apiName, grantedTo: names });
      setStatus(errors.length ? `✓ Created. ❌ Some grants failed: ${errors.join('; ')}` : `✓ Created ${label}.`);
      setLabel('');
      setName('');
      setNameTouched(false);
      setDescription('');
      setGrantTo(new Set());
      onCreated();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  if (!open)
    return (
      // Like every box that creates something: closed, apart from the list, until opened
      <div className="card section create-box">
        <button className="create-open" onClick={() => setOpen(true)}>
          <b>+ New custom permission</b> <span className="muted">and the permission sets or profiles it goes to</span>
        </button>
        {status && <Status text={status} />}
      </div>
    );
  return (
    <div className="card section">
      <h3>New custom permission</h3>
      <div className="form">
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
          style={{ minWidth: 280 }}
        />
      </div>
      <div className="form">
        <b>Grant it to</b>
        <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="muted">{grantTo.size} ticked (optional; you can grant it later too)</span>
      </div>
      <div className="field-checks two-lines">
        {shown.map((h) => (
          <label key={h.id} className="check">
            <input
              type="checkbox"
              checked={grantTo.has(h.id)}
              onChange={(e) => {
                const next = new Set(grantTo);
                if (e.target.checked) next.add(h.id);
                else next.delete(h.id);
                setGrantTo(next);
              }}
            />{' '}
            <span className="field-check-text">
              <span>{h.name}</span>
              <span className="muted">{h.kind}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="form">
        <button onClick={() => setOpen(false)}>Close</button>
        <button className="primary" disabled={!label.trim() || !apiName} onClick={() => void create()}>
          Create…
        </button>
        {status && <Status text={status} />}
      </div>
    </div>
  );
}

// ---------- Permissions › Apps, classes & more ----------

/** What each kind of access means, in a sentence. */
const SETUP_HELP: Record<SetupKind, string> = {
  ApexClass:
    'Apex classes users may run from outside the class: Visualforce controllers, LWC and Aura @AuraEnabled methods, REST and SOAP web services.',
  ApexPage: 'Visualforce pages users may open.',
  CustomPermission:
    'Custom permissions this grants. Apex ($Permission, FeatureManagement.checkPermission), flows, validation rules and formulas check them.',
  ConnectedApplication:
    'Connected apps set to "Admin approved users are pre-authorized": users with this may log in to the app (OAuth).',
  TabSet: 'Lightning and Classic apps (App Launcher) users may open; the tabs inside still need their own access.',
};

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
      <p className="muted">{SETUP_HELP[kind]}</p>
      {status && <Status text={status} block />}
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

// ---------- Permissions › Login IP ranges (every profile, standard ones too) ----------

export function ProfileLoginPanel({ profileId, editable }: { profileId: string; editable: boolean }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [settings, setSettings] = useState<ProfileLoginSettings | null>(null);
  const [draft, setDraft] = useState<ProfileLoginSettings | null>(null);
  const [status, setStatus] = useState('Reading the profile…');
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
    setDraft(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, profileId]);

  const changed = useMemo(() => JSON.stringify(settings) !== JSON.stringify(draft), [settings, draft]);
  const save = async () => {
    if (!draft) return;
    const ranges = draft.ipRanges.map((r) => `${r.start} – ${r.end}`).join(', ') || 'none (log in from anywhere)';
    if (!(await confirmChange(`Deploy the login IP ranges of profile ${draft.fullName} to ${org.label}: ${ranges}`)))
      return;
    setStatus('Deploying…');
    try {
      const r = await saveProfileLoginSettings(client, draft);
      logActivity('profile login IP ranges', { profile: draft.fullName, success: r.success });
      if (!r.success) setStatus(`❌ ${r.problems.join('; ') || 'The deploy failed.'}`);
      else {
        setStatus('✓ Deployed.');
        await load();
      }
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  if (!draft) return <Status text={status} block />;
  const setRange = (i: number, patch: Partial<ProfileLoginSettings['ipRanges'][number]>) =>
    setDraft({ ...draft, ipRanges: draft.ipRanges.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
  return (
    <div className="section">
      <p className="muted">
        Users of this profile can only log in from these addresses (none: from anywhere). Standard profiles can have
        them too.
      </p>
      <table className="edit-table">
        <tbody>
          {draft.ipRanges.map((r, i) => (
            <tr key={i}>
              <td>
                <input
                  className="mono"
                  placeholder="From"
                  value={r.start}
                  disabled={!editable}
                  onChange={(e) => setRange(i, { start: e.target.value.trim() })}
                />
              </td>
              <td>–</td>
              <td>
                <input
                  className="mono"
                  placeholder="To"
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
          <button disabled={!changed} onClick={() => setDraft(settings)}>
            Undo
          </button>
          <button className="primary" disabled={!changed} onClick={() => void save()}>
            Deploy…
          </button>
          <span className="muted">
            {status || 'Only the IP ranges are deployed; the rest of the profile stays as it is.'}
          </span>
        </div>
      )}
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
      {status && <Status text={status} />}
    </div>
  );
}

// ---------- Permissions › Record types (profiles and permission sets) ----------

type Holder = { kind: 'Profile' | 'Permission set'; permissionSetId: string; profileId?: string };

/** Which record types a profile or permission set may use (and, for a profile, each object's default). */
export function RecordTypesPanel({ holder, editable }: { holder: Holder; editable: boolean }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [rows, setRows] = useState<RecordTypeAccess[] | null>(null);
  const [draft, setDraft] = useState<Map<string, RecordTypeAccess>>(new Map());
  const [filter, setFilter] = useState('');
  const [onlyVisible, setOnlyVisible] = useState(false);
  const [status, setStatus] = useState('');
  const profile = holder.kind === 'Profile';
  const load = () => {
    setRows(null);
    setDraft(new Map());
    recordTypeAccess(client, holder)
      .then((r) => {
        setRows(r);
        setStatus('');
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  };
  useEffect(load, [client, holder.permissionSetId]); // eslint-disable-line react-hooks/exhaustive-deps

  const now = (r: RecordTypeAccess): RecordTypeAccess => draft.get(r.recordType) ?? r;
  const set = (r: RecordTypeAccess, patch: Partial<RecordTypeAccess>) => {
    const next = new Map(draft);
    next.set(r.recordType, { ...now(r), ...patch });
    // One default per object: the others of the object lose it
    if (patch.isDefault)
      for (const other of rows ?? [])
        if (other.object === r.object && other.recordType !== r.recordType && now(other).isDefault)
          next.set(other.recordType, { ...now(other), isDefault: false });
    setDraft(next);
  };
  const changed = [...draft.values()].filter((d) => {
    const r = rows?.find((x) => x.recordType === d.recordType);
    return r && (r.visible !== d.visible || r.isDefault !== d.isDefault);
  });
  const save = async () => {
    if (
      !(await confirmChange(
        `Change ${changed.length} record type setting(s) of ${holder.kind.toLowerCase()} in ${org.label}:\n${changed
          .map((c) => `• ${c.recordType}: ${c.visible ? 'visible' : 'hidden'}${c.isDefault ? ', default' : ''}`)
          .join('\n')}`
      ))
    )
      return;
    setStatus('Deploying…');
    try {
      await saveRecordTypeAccess(client, holder, changed);
      logActivity('record type access', { holder: holder.permissionSetId, changes: changed.length });
      setStatus('✓ Saved.');
      load();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const needle = filter.trim().toLowerCase();
  const shown = (rows ?? []).filter(
    (r) =>
      (!onlyVisible || now(r).visible) &&
      (!needle || `${r.object} ${r.label} ${r.recordType}`.toLowerCase().includes(needle))
  );
  return (
    <div className="section">
      <div className="form">
        <input
          placeholder="Filter objects or record types"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={onlyVisible} onChange={(e) => setOnlyVisible(e.target.checked)} /> Only the
          ones it can use
        </label>
        <span className="grow" />
        {editable && (
          <>
            <button disabled={!changed.length} onClick={() => setDraft(new Map())}>
              Undo
            </button>
            <button className="primary" disabled={!changed.length} onClick={() => void save()}>
              Save {changed.length || ''} change(s)…
            </button>
          </>
        )}
      </div>
      <p className="muted">
        {status ||
          (profile
            ? 'A profile also sets each object’s default record type. Saving deploys only these settings of the profile.'
            : 'Saving deploys the permission set again with these record types (everything else stays as it is).')}
      </p>
      {!rows ? (
        <p className="muted">Reading…</p>
      ) : shown.length === 0 ? (
        <EmptyHint what="record types" />
      ) : (
        <table className="edit-table">
          <thead>
            <tr>
              <th>object</th>
              <th>record type</th>
              <th>Visible</th>
              {profile && <th>Default</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const v = now(r);
              const isChanged = v.visible !== r.visible || v.isDefault !== r.isDefault;
              return (
                <tr key={r.recordType}>
                  <td>{r.object}</td>
                  <td>
                    {r.label} <span className="muted mono">{r.recordType.split('.')[1]}</span>
                    {!r.active && <span className="muted"> · inactive</span>}
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      className={isChanged ? 'changed' : ''}
                      disabled={!editable}
                      checked={v.visible}
                      onChange={(e) =>
                        set(r, { visible: e.target.checked, ...(e.target.checked ? {} : { isDefault: false }) })
                      }
                    />
                  </td>
                  {profile && (
                    <td>
                      <input
                        type="radio"
                        name={`default-${r.object}`}
                        disabled={!editable || !v.visible}
                        checked={v.isDefault}
                        onChange={() => set(r, { isDefault: true })}
                      />
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- Permissions › Page layouts (profiles) ----------

export function LayoutsPanel({ profileId, editable }: { profileId: string; editable: boolean }) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [rows, setRows] = useState<LayoutAssignment[] | null>(null);
  const [layouts, setLayouts] = useState<Map<string, string[]>>(new Map());
  const [draft, setDraft] = useState<Map<string, string>>(new Map());
  const [filter, setFilter] = useState('');
  const [status, setStatus] = useState('');
  const key = (a: LayoutAssignment): string => `${a.object}|${a.recordType}`;
  const load = () => {
    setRows(null);
    setDraft(new Map());
    layoutAssignments(client, profileId)
      .then(setRows)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  };
  useEffect(load, [client, profileId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!editable) return;
    listMetadata(client, 'Layout')
      .then((list) => {
        const byObject = new Map<string, string[]>();
        for (const l of list) {
          const object = l.fullName.slice(0, l.fullName.indexOf('-'));
          byObject.set(object, [...(byObject.get(object) ?? []), l.fullName]);
        }
        setLayouts(byObject);
      })
      .catch(() => undefined);
  }, [client, editable]);

  const changed = (rows ?? []).filter((r) => draft.has(key(r)) && draft.get(key(r)) !== r.layout);
  const save = async () => {
    const list = changed.map((r) => ({ ...r, layout: draft.get(key(r))! }));
    if (
      !(await confirmChange(
        `Assign ${list.length} page layout(s) in ${org.label}:\n${list
          .map((l) => `• ${l.recordType || l.object}: ${l.layout}`)
          .join('\n')}`
      ))
    )
      return;
    setStatus('Deploying…');
    try {
      await saveLayoutAssignments(client, profileId, list);
      logActivity('layout assignments', { profile: profileId, changes: list.length });
      setStatus('✓ Saved.');
      load();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  const needle = filter.trim().toLowerCase();
  const shown = (rows ?? []).filter(
    (r) => !needle || `${r.object} ${r.recordType} ${r.layout}`.toLowerCase().includes(needle)
  );
  return (
    <div className="section">
      <div className="form">
        <input placeholder="Filter objects or layouts" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <span className="grow" />
        {editable && (
          <>
            <button disabled={!changed.length} onClick={() => setDraft(new Map())}>
              Undo
            </button>
            <button className="primary" disabled={!changed.length} onClick={() => void save()}>
              Save {changed.length || ''} change(s)…
            </button>
          </>
        )}
      </div>
      <p className="muted">
        {status ||
          'The page layout this profile sees for each object (and record type). Permission sets have no layouts.'}
      </p>
      {!rows ? (
        <p className="muted">Reading…</p>
      ) : (
        <table className="edit-table">
          <thead>
            <tr>
              <th>object</th>
              <th>record type</th>
              <th>layout</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const value = draft.get(key(r)) ?? r.layout;
              const options = layouts.get(r.object) ?? [];
              return (
                <tr key={key(r)}>
                  <td>{r.object}</td>
                  <td className="muted">{r.recordType ? r.recordType.split('.')[1] : '(master)'}</td>
                  <td>
                    {editable && options.length ? (
                      <select
                        className={value !== r.layout ? 'changed' : ''}
                        value={value}
                        onChange={(e) => setDraft(new Map(draft).set(key(r), e.target.value))}
                      >
                        {[...new Set([r.layout, ...options])].filter(Boolean).map((l) => (
                          <option key={l} value={l}>
                            {l.slice(l.indexOf('-') + 1)}
                          </option>
                        ))}
                      </select>
                    ) : (
                      r.layout.slice(r.layout.indexOf('-') + 1)
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- Permissions › Clone ----------

/** A copy of a profile, permission set or permission set group under a new name. */
export function CloneHolder({
  kind,
  name,
  permissionSetId,
  profileId,
  groupId,
  onDone,
}: {
  kind: 'Profile' | 'Permission set' | 'Permission set group';
  name: string;
  permissionSetId: string;
  profileId?: string;
  groupId?: string;
  onDone: (created: boolean) => void;
}) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [label, setLabel] = useState(`Copy of ${name}`);
  const [apiName, setApiName] = useState('');
  const [touched, setTouched] = useState(false);
  const [description, setDescription] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const api = touched ? apiName : apiNameFrom(label);
  const clone = async () => {
    if (
      !(await confirmChange(
        `Clone ${kind.toLowerCase()} ${name} as ${label}${kind === 'Profile' ? '' : ` (${api})`} in ${org.label}`
      ))
    )
      return;
    setBusy(true);
    setStatus(kind === 'Permission set group' ? 'Creating…' : 'Reading and deploying (Metadata API)…');
    try {
      if (kind === 'Profile') await cloneProfile(client, profileId ?? '', label, description);
      else if (kind === 'Permission set')
        await clonePermissionSet(client, permissionSetId, { label, name: api, description });
      else {
        const r = await clonePermissionSetGroup(client, groupId ?? '', { label, name: api, description });
        if (r.errors.length) setStatus(`✓ Created with ${r.added} permission set(s). ❌ ${r.errors.join('; ')}`);
      }
      logActivity(`clone ${kind.toLowerCase()}`, { from: name, to: label });
      onDone(true);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card section">
      <h4>Clone {name}</h4>
      <div className="form">
        <input
          placeholder={kind === 'Profile' ? 'Profile name' : 'Label'}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        {kind !== 'Profile' && (
          <input
            className="mono"
            placeholder="API name"
            value={api}
            onChange={(e) => {
              setApiName(e.target.value);
              setTouched(true);
            }}
          />
        )}
        <input
          placeholder="Description (optional)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <button onClick={() => onDone(false)} disabled={busy}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !label.trim() || (kind !== 'Profile' && !api)}
          onClick={() => void clone()}
        >
          Clone…
        </button>
      </div>
      <p className="muted">
        {status ||
          (kind === 'Profile'
            ? 'Everything the profile has (permissions, access, record types, layouts, login settings) goes to a new custom profile with the same license.'
            : kind === 'Permission set'
            ? 'Everything the permission set grants goes to the new one; nobody is assigned.'
            : 'The new group holds the same permission sets (muting permission sets are not copied); nobody is assigned.')}
      </p>
    </div>
  );
}
