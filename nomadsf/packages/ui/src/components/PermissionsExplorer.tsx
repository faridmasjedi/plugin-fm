import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fieldAccessOf,
  objectAccessOf,
  permissionHolders,
  permissionSetInfo,
  systemPermissionsOf,
  type FieldAccessRow,
  type ObjectAccessRow,
  type PermissionHolder,
  type PermissionSetInfo,
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
} from '../pages/AccessManagePages';
import { cannotChangePermissions, useAccessOf } from '../access';
import { Status } from '../statusLog';

type Tab = 'all' | 'objects' | 'fields' | 'system' | 'setup' | 'rtypes' | 'layouts' | 'tabs' | 'login';
const yes = (v: boolean): string => (v ? '✓' : '');

/**
 * What a profile, permission set or group allows: objects, fields and user / system permissions. Custom permission
 * sets and profiles can be edited; a group's permission sets can be added and removed.
 */
export function PermissionsExplorer() {
  const { client, org } = useStudio();
  // Changing permissions needs Manage Profiles and Permission Sets (checked once per org)
  const blocked = cannotChangePermissions(useAccessOf(client), org.label);
  const [holders, setHolders] = useState<PermissionHolder[]>([]);
  const [filter, setFilter] = useState('');
  const [kindShown, setKindShown] = useState<'all' | PermissionHolder['kind']>(() => storage.get('perms.kind', 'all'));
  const [holderId, setHolderId] = useState('');
  // One table per tab (the old "All" tab stacked them; a saved "all" opens Object access)
  const chosenByKind = useRef<Partial<Record<'all' | PermissionHolder['kind'], string>>>({});
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
  }, [client]);

  const holder = holders.find((h) => h.id === holderId);
  const shownHolders = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return holders.filter(
      (h) =>
        (kindShown === 'all' || h.kind === kindShown) &&
        (!needle || `${h.kind} ${h.name}`.toLowerCase().includes(needle))
    );
  }, [holders, filter, kindShown]);

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
      <h3>Permissions of a profile, permission set or group</h3>
      <div className="form">
        <div className="segmented" role="group" aria-label="Show">
          {(['all', ...kinds] as Array<'all' | PermissionHolder['kind']>).map((k) => (
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
              {k === 'all' ? 'All' : `${k}s`} (
              {k === 'all' ? holders.length : holders.filter((h) => h.kind === k).length})
            </button>
          ))}
        </div>
        <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
        <select value={holderId} onChange={(e) => setHolderId(e.target.value)} style={{ minWidth: 380 }}>
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
        </select>
        <Status text={status} />
      </div>
      {holder && (
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
              ] as Array<[Tab, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                className={`tab ${tab === id ? 'active' : ''}`}
                onClick={() => {
                  setTab(id);
                  storage.set('perms.tab', id);
                }}
              >
                {label}
              </button>
            ))}
          </div>
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
