import { useEffect, useMemo, useState } from 'react';
import {
  fieldAccessOf,
  objectAccessOf,
  permissionHolders,
  systemPermissionsOf,
  type FieldAccessRow,
  type ObjectAccessRow,
  type PermissionHolder,
  type SystemPermission,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { DataTable, EmptyHint } from './DataTable';

type Tab = 'all' | 'objects' | 'fields' | 'system';
const yes = (v: boolean): string => (v ? '✓' : '');

/** What a profile, permission set or group allows: objects, fields and user / system permissions (read-only). */
export function PermissionsExplorer() {
  const { client } = useStudio();
  const [holders, setHolders] = useState<PermissionHolder[]>([]);
  const [filter, setFilter] = useState('');
  const [kindShown, setKindShown] = useState<'all' | PermissionHolder['kind']>(() => storage.get('perms.kind', 'all'));
  const [holderId, setHolderId] = useState('');
  const [tab, setTab] = useState<Tab>(() => storage.get('perms.tab', 'objects'));
  const [objects, setObjects] = useState<ObjectAccessRow[] | null>(null);
  const [fields, setFields] = useState<FieldAccessRow[] | null>(null);
  const [fieldObject, setFieldObject] = useState('');
  const [typedObject, setTypedObject] = useState('');
  const [system, setSystem] = useState<SystemPermission[] | null>(null);
  const [grantedOnly, setGrantedOnly] = useState(true);
  const [status, setStatus] = useState('');

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
  }, [holderId]);
  useEffect(() => {
    if (!holderId) return;
    let canceled = false;
    const fail = (e: Error) => !canceled && setStatus(`❌ ${e.message}`);
    setStatus('');
    const show = (t: Tab) => tab === t || tab === 'all';
    if (show('objects') && objects === null)
      objectAccessOf(client, holderId)
        .then((r) => !canceled && setObjects(r))
        .catch(fail);
    if (show('system') && system === null)
      systemPermissionsOf(client, holderId)
        .then((r) => !canceled && setSystem(r))
        .catch(fail);
    if (show('fields') && fields === null)
      fieldAccessOf(client, holderId, fieldObject || undefined)
        .then((r) => !canceled && setFields(r))
        .catch(fail);
    return () => {
      canceled = true;
    };
    // results are not triggers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, holderId, tab, fieldObject]);

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
                setKindShown(k);
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
        {holder && <span className="pill">{holder.kind}</span>}
        <span className="muted">{status}</span>
      </div>
      {holder && (
        <>
          <div className="tabs">
            {(
              [
                ['all', 'All'],
                ['objects', 'Object access'],
                ['fields', 'Field access'],
                ['system', 'User & system permissions'],
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
