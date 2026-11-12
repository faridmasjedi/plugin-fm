import { useEffect, useMemo, useRef, useState } from 'react';
import { Select } from './Select';
import {
  fieldAccessOf,
  objectAccessOf,
  permissionHolders,
  permissionSetInfo,
  setupEntities,
  systemPermissionsOf,
  type FieldAccessRow,
  type ObjectAccessRow,
  type PermissionHolder,
  type PermissionSetInfo,
  type SetupEntity,
  type SystemPermission,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { DataTable, EmptyHint } from './DataTable';
import { AccessEditor, GroupEditor } from './AccessEditor';
import {
  CloneHolder,
  LayoutsPanel,
  ProfileLoginPanel,
  RecordTypesPanel,
  SetupAccessPanel,
  TabSettingsPanel,
  CustomPermissionPanel,
} from '../pages/AccessManagePages';
import { cannotChangePermissions, useAccessOf } from '../access';
import { WhoHasIt } from './WhoHasIt';
import { AssignToUsers } from './AssignToUsers';
import { Status } from '../statusLog';

type Tab =
  | 'all'
  | 'objects'
  | 'fields'
  | 'system'
  | 'setup'
  | 'rtypes'
  | 'layouts'
  | 'tabs'
  | 'login'
  | 'assigned'
  | 'assign';
const yes = (v: boolean): string => (v ? '✓' : '');
/** What the kind switch shows: everything, one kind of holder, or custom permissions. */
type Shown = 'all' | PermissionHolder['kind'] | 'custom';

/** The chosen one as Assigned users knows it: a profile by its Profile Id, a group by its PermissionSetGroup Id. */
function holderOf(
  holder: PermissionHolder,
  info: PermissionSetInfo | null
): { kind: 'profile' | 'permset' | 'group'; id: string } | undefined {
  if (holder.kind === 'Permission set') return { kind: 'permset', id: holder.id };
  if (holder.kind === 'Profile') return info?.profileId ? { kind: 'profile', id: info.profileId } : undefined;
  return info?.groupId ? { kind: 'group', id: info.groupId } : undefined;
}

/**
 * What a profile, permission set or group allows: objects, fields and user / system permissions. Custom permission
 * sets and profiles can be edited; a group's permission sets can be added and removed.
 */
export function PermissionsExplorer({ reloadKey = 0 }: { reloadKey?: number } = {}) {
  const { client, org } = useStudio();
  // Changing permissions needs Manage Profiles and Permission Sets (checked once per org)
  const blocked = cannotChangePermissions(useAccessOf(client), org.label);
  const [holders, setHolders] = useState<PermissionHolder[]>([]);
  const [kindShown, setKindShown] = useState<Shown>(() => storage.get('perms.kind', 'all'));
  const [holderId, setHolderId] = useState('');
  // Custom permissions: read when that kind is shown
  const [customs, setCustoms] = useState<SetupEntity[] | null>(null);
  const [customId, setCustomId] = useState('');
  const custom = customs?.find((c) => c.id === customId);
  useEffect(() => {
    if (kindShown !== 'custom') return;
    setCustoms(null);
    setupEntities(client, 'CustomPermission')
      .then(setCustoms)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, kindShown, reloadKey]);
  // One table per tab (the old "All" tab stacked them; a saved "all" opens Object access)
  const chosenByKind = useRef<Partial<Record<Shown, string>>>({});
  const [tab, setTab] = useState<Tab>(() => {
    const saved = storage.get<Tab>('perms.tab', 'objects');
    return saved === 'all' ? 'objects' : saved;
  });
  const [objects, setObjects] = useState<ObjectAccessRow[] | null>(null);
  const [fields, setFields] = useState<FieldAccessRow[] | null>(null);
  const [fieldObject, setFieldObject] = useState('');
  const [typedObject, setTypedObject] = useState('');
  const [system, setSystem] = useState<SystemPermission[] | null>(null);
  const [grantedOnly, setGrantedOnly] = useState(true);
  const [status, setStatus] = useState('');
  const [info, setInfo] = useState<PermissionSetInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [cloning, setCloning] = useState(false);
  // Bumped after saving: reads the permissions again
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    permissionHolders(client)
      .then(setHolders)
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  }, [client, reloadKey]);

  const holder = holders.find((h) => h.id === holderId);
  const shownHolders = useMemo(
    () => holders.filter((h) => kindShown === 'all' || h.kind === kindShown),
    [holders, kindShown]
  );

  // Load what the current tab needs for the chosen holder
  useEffect(() => {
    setObjects(null);
    setFields(null);
    setSystem(null);
    setEditing(false);
    setCloning(false);
    setInfo(null);
    setStatus('');
    if (!holderId) return;
    let canceled = false;
    permissionSetInfo(client, holderId)
      .then((i) => !canceled && setInfo(i))
      .catch(() => undefined);
    return () => {
      canceled = true;
    };
  }, [client, holderId]);
  // What has been asked for this choice (a list is read once per holder, field filter and save)
  const asked = useRef({ key: '', lists: new Set<string>() });
  useEffect(() => {
    if (!holderId) return;
    const key = `${holderId}|${reloads}`;
    if (asked.current.key !== key) asked.current = { key, lists: new Set() };
    const mine = asked.current;
    // Results of an earlier choice are dropped
    const current = () => asked.current === mine;
    const fail = (e: Error) => current() && setStatus(`❌ ${e.message}`);
    // Editing needs all three lists
    const show = (t: Tab) => editing || tab === t || tab === 'all';
    const need = (list: string): boolean => {
      if (mine.lists.has(list)) return false;
      mine.lists.add(list);
      return true;
    };
    if (show('objects') && need('objects'))
      objectAccessOf(client, holderId)
        .then((r) => current() && setObjects(r))
        .catch(fail);
    if (show('system') && need('system'))
      systemPermissionsOf(client, holderId)
        .then((r) => current() && setSystem(r))
        .catch(fail);
    if (show('fields') && need(`fields:${fieldObject}`))
      fieldAccessOf(client, holderId, fieldObject || undefined)
        .then((r) => current() && setFields(r))
        .catch(fail);
  }, [client, holderId, tab, fieldObject, editing, reloads]);

  const kinds = ['Profile', 'Permission set', 'Permission set group'] as const;

  return (
    <div className="card section">
      <h3>Choose a profile, permission set, group or custom permission</h3>
      <div className="form">
        <div className="segmented wraps" role="group" aria-label="Show">
          {(['all', ...kinds, 'custom'] as Shown[]).map((k) => (
            <button
              key={k}
              className={kindShown === k ? 'active' : ''}
              onClick={() => {
                // Each kind keeps the one chosen there: another kind starts empty, coming back shows it again
                chosenByKind.current[kindShown] = holderId;
                setKindShown(k);
                setHolderId(chosenByKind.current[k] ?? '');
                setEditing(false);
                setCloning(false);
                storage.set('perms.kind', k);
              }}
            >
              {k === 'all' ? 'All' : k === 'custom' ? 'Custom permissions' : `${k}s`}
              {k === 'custom' ? '' : ` (${k === 'all' ? holders.length : holders.filter((h) => h.kind === k).length})`}
            </button>
          ))}
        </div>
        {kindShown === 'custom' && (
          <Select value={customId} onChange={(e) => setCustomId(e.target.value)} className="holder-select">
            <option value="">{customs ? `Choose (${customs.length})` : 'Reading…'}</option>
            {(customs ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} ({c.namespace ? `${c.namespace}__` : ''}
                {c.name})
              </option>
            ))}
          </Select>
        )}
        {kindShown !== 'custom' && (
          <Select value={holderId} onChange={(e) => setHolderId(e.target.value)} className="holder-select">
            <option value="">Choose ({shownHolders.length})</option>
            {kinds
              .filter((k) => kindShown === 'all' || k === kindShown)
              .map((k) => (
                <optgroup key={k} label={`${k}s`}>
                  {shownHolders
                    .filter((h) => h.kind === k)
                    .map((h) => (
                      <option key={h.id} value={h.id}>
                        {h.name}
                      </option>
                    ))}
                </optgroup>
              ))}
          </Select>
        )}
        <Status text={status} />
      </div>
      {kindShown === 'custom' && customs?.length === 0 && <EmptyHint what="custom permissions" />}
      {kindShown === 'custom' && custom && <CustomPermissionPanel key={custom.id} chosen={custom} />}
      {holder && kindShown !== 'custom' && (
        // The one chosen: its name and kind, then what can be done with it
        <div className="holder-bar">
          <b>{holder.name}</b>
          <span className="pill">{holder.kind}</span>
          {holder && info?.editable && blocked && <span className="muted">{blocked}</span>}
          <span className="grow" />
          {holder && info?.editable && !editing && (
            <button
              onClick={() => setEditing(true)}
              disabled={Boolean(blocked)}
              title={blocked ?? 'Change object, field and user / system permissions'}
            >
              Edit…
            </button>
          )}
          {holder && info && !editing && (
            <button
              onClick={() => setCloning(true)}
              disabled={Boolean(blocked)}
              title={blocked ?? `A copy of this ${holder.kind.toLowerCase()} under a new name`}
            >
              Clone…
            </button>
          )}
        </div>
      )}
      {holder && info && !info.editable && info.kind !== 'Permission set group' && (
        <p className="note">{info.reason}</p>
      )}
      {holder && info && cloning && (
        <CloneHolder
          kind={holder.kind}
          name={holder.name}
          permissionSetId={holder.id}
          profileId={info.profileId}
          groupId={info.groupId}
          onDone={(created) => {
            setCloning(false);
            if (created) {
              setStatus('✓ Cloned. Find the copy in the list.');
              permissionHolders(client)
                .then(setHolders)
                .catch(() => undefined);
            }
          }}
        />
      )}
      {holder && info?.groupId && <GroupEditor groupId={info.groupId} holders={holders} blocked={blocked} />}
      {holder &&
        editing &&
        (objects && fields && system ? (
          <AccessEditor
            holder={holder}
            objects={objects}
            fields={fields}
            system={system}
            onDone={(saved) => {
              setEditing(false);
              if (saved) {
                setStatus('✓ Saved.');
                setObjects(null);
                setFields(null);
                setSystem(null);
                setReloads((n) => n + 1);
              }
            }}
          />
        ) : (
          <p className="muted">Reading the current permissions…</p>
        ))}
      {holder && !editing && (
        <>
          <div className="tabs">
            {(
              [
                ['objects', 'Object access'],
                ['fields', 'Field access'],
                ['system', 'User & system permissions'],
                ['setup', 'Apps, classes & more'],
                ...(holder.kind !== 'Permission set group' ? [['rtypes', 'Record types']] : []),
                ...(holder.kind === 'Profile' ? [['layouts', 'Page layouts']] : []),
                ...(holder.kind === 'Permission set' ? [['tabs', 'Tabs']] : []),
                ...(holder.kind === 'Profile' ? [['login', 'Login IP ranges']] : []),
                // Who has it, and giving it (a profile is given by changing a user's profile: Users)
                ['assigned', 'Assigned users'],
                ...(holder.kind !== 'Profile' ? [['assign', 'Assign to users']] : []),
              ] as Array<[Tab, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                className={`tab ${tab === id ? 'active' : ''} ${id === 'assigned' ? 'tab-break' : ''}`}
                onClick={() => {
                  setTab(id);
                  storage.set('perms.tab', id);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === 'assigned' &&
            (holderOf(holder, info) ? (
              <WhoHasIt key={holder.id} fixed={holderOf(holder, info)} />
            ) : (
              <p className="muted">Reading…</p>
            ))}
          {tab === 'assign' &&
            (holder.kind === 'Profile' ? (
              <p className="muted">A profile is given by changing a user&apos;s profile: Access › Users.</p>
            ) : holderOf(holder, info) ? (
              <AssignToUsers
                key={holder.id}
                target={{
                  kind: holder.kind === 'Permission set group' ? 'group' : 'permset',
                  id: holderOf(holder, info)!.id,
                  label: holder.name,
                  name: holder.api ?? holder.name,
                }}
              />
            ) : (
              <p className="muted">Reading…</p>
            ))}
          {tab === 'setup' && (
            <SetupAccessPanel
              permissionSetId={holder.id}
              editable={Boolean(info?.editable && !blocked)}
              reason={blocked ?? info?.reason}
            />
          )}
          {tab === 'rtypes' && holder.kind !== 'Permission set group' && info && (
            <RecordTypesPanel
              holder={{
                kind: holder.kind === 'Profile' ? 'Profile' : 'Permission set',
                permissionSetId: holder.id,
                profileId: info.profileId,
              }}
              editable={Boolean(info.editable && !blocked)}
            />
          )}
          {tab === 'layouts' && holder.kind === 'Profile' && info?.profileId && (
            <LayoutsPanel profileId={info.profileId} editable={Boolean(info.editable && !blocked)} />
          )}
          {tab === 'tabs' && holder.kind === 'Permission set' && (
            <TabSettingsPanel permissionSetId={holder.id} editable={Boolean(info?.editable && !blocked)} />
          )}
          {tab === 'login' &&
            holder.kind === 'Profile' &&
            (info?.profileId ? (
              <ProfileLoginPanel profileId={info.profileId} editable={!blocked} />
            ) : (
              <p className="muted">Reading the profile…</p>
            ))}
          {tab === 'all' && <h4>Object access</h4>}
          {(tab === 'objects' || tab === 'all') &&
            (objects === null ? (
              <p className="muted">Reading object access…</p>
            ) : objects.length === 0 ? (
              <EmptyHint what="object access found" />
            ) : (
              <DataTable
                columns={['object', 'read', 'create', 'edit', 'delete', 'viewAll', 'modifyAll']}
                rows={objects.map((o) => ({
                  ...o,
                  read: yes(o.read),
                  create: yes(o.create),
                  edit: yes(o.edit),
                  delete: yes(o.delete),
                  viewAll: yes(o.viewAll),
                  modifyAll: yes(o.modifyAll),
                }))}
                rowKey="object"
                name={`${holder.name}-object-access`}
                note={<span>· objects with any access</span>}
              />
            ))}
          {tab === 'all' && <h4>Field access</h4>}
          {(tab === 'fields' || tab === 'all') && (
            <>
              <div className="form">
                <label>
                  Object
                  <input
                    placeholder="All objects (or e.g. Account), Enter"
                    value={typedObject}
                    onChange={(e) => setTypedObject(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    onBlur={() => {
                      const v = typedObject.trim();
                      if (v !== fieldObject && (v === '' || /^\w+$/.test(v))) {
                        setFieldObject(v);
                        setFields(null);
                      }
                    }}
                  />
                </label>
              </div>
              {fields === null ? (
                <p className="muted">Reading field access…</p>
              ) : fields.length === 0 ? (
                <EmptyHint what="field access found" />
              ) : (
                <DataTable
                  columns={['object', 'field', 'read', 'edit']}
                  groupBy="object"
                  rows={fields.map((f, i) => ({ ...f, read: yes(f.read), edit: yes(f.edit), key: i }))}
                  rowKey="key"
                  name={`${holder.name}-field-access`}
                  note={<span>· fields with field-level security that this one can read</span>}
                />
              )}
            </>
          )}
          {tab === 'all' && <h4>User &amp; system permissions</h4>}
          {(tab === 'system' || tab === 'all') &&
            (system === null ? (
              <p className="muted">Reading permissions…</p>
            ) : (
              <>
                <label className="check">
                  <input type="checkbox" checked={grantedOnly} onChange={(e) => setGrantedOnly(e.target.checked)} />{' '}
                  Granted only ({system.filter((p) => p.enabled).length} of {system.length})
                </label>
                <DataTable
                  columns={['enabled', 'label', 'api']}
                  rows={system.filter((p) => !grantedOnly || p.enabled).map((p) => ({ ...p, enabled: yes(p.enabled) }))}
                  rowKey="api"
                  name={`${holder.name}-system-permissions`}
                />
              </>
            ))}
        </>
      )}
    </div>
  );
}
