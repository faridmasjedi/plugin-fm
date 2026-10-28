import { useEffect, useMemo, useState } from 'react';
import {
  NO_ACCESS,
  addToGroup,
  applyAccessChanges,
  describeChange,
  describeGlobal,
  fieldAccessOf,
  groupPermissionSets,
  normalizeObjectAccess,
  removeFromGroup,
  type AccessChange,
  type FieldAccessRow,
  type GroupMember,
  type ObjectAccess,
  type ObjectAccessRow,
  type PermissionHolder,
  type SystemPermission,
} from '@nomadsf/core';
import { useStudio } from '../context';
import { ObjectOptions } from './ObjectOptions';

type EditableField = { name: string; label: string; type: string; editable: boolean };

const FLAGS: Array<[keyof ObjectAccess, string]> = [
  ['read', 'Read'],
  ['create', 'Create'],
  ['edit', 'Edit'],
  ['delete', 'Delete'],
  ['viewAll', 'View all'],
  ['modifyAll', 'Modify all'],
];

const keyOf = (c: AccessChange): string =>
  c.kind === 'system' ? `system:${c.api}` : c.kind === 'object' ? `object:${c.object}` : `field:${c.field}`;

/**
 * Edit mode of the permissions explorer: tick and untick object access, field access and user / system
 * permissions of a custom permission set or profile; nothing is sent until Save (after the org name).
 */
export function AccessEditor({
  holder,
  objects,
  fields,
  system,
  onDone,
}: {
  holder: PermissionHolder;
  objects: ObjectAccessRow[];
  fields: FieldAccessRow[];
  system: SystemPermission[];
  onDone: (saved: boolean) => void;
}) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [changes, setChanges] = useState<Map<string, AccessChange>>(new Map());
  const [addedObjects, setAddedObjects] = useState<string[]>([]);
  const [newObject, setNewObject] = useState('');
  // Field access: one object at a time, every field that can have field permissions
  const [allObjects, setAllObjects] = useState<Array<{ name: string; label: string }>>([]);
  const [fieldObject, setFieldObject] = useState('');
  const [typedFieldObject, setTypedFieldObject] = useState('');
  const [objectFields, setObjectFields] = useState<EditableField[] | null>(null);
  const [loadedAccess, setLoadedAccess] = useState<FieldAccessRow[]>([]);
  const [fieldFilter, setFieldFilter] = useState('');
  const [systemFilter, setSystemFilter] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const put = (c: AccessChange) => setChanges((m) => new Map(m).set(keyOf(c), c));
  const objectNow = (object: string): ObjectAccess => {
    const c = changes.get(`object:${object}`);
    if (c?.kind === 'object') return c.access;
    const o = objects.find((x) => x.object === object);
    return o
      ? { read: o.read, create: o.create, edit: o.edit, delete: o.delete, viewAll: o.viewAll, modifyAll: o.modifyAll }
      : NO_ACCESS;
  };
  const fieldNow = (field: string): { read: boolean; edit: boolean } => {
    const c = changes.get(`field:${field}`);
    if (c?.kind === 'field') return { read: c.read, edit: c.edit };
    const f = [...loadedAccess, ...fields].find((x) => `${x.object}.${x.field}` === field);
    return { read: Boolean(f?.read), edit: Boolean(f?.edit) };
  };

  useEffect(() => {
    describeGlobal(client)
      .then((list) => setAllObjects(list.map((o) => ({ name: o.name, label: o.label }))))
      .catch(() => undefined);
  }, [client]);
  useEffect(() => {
    setObjectFields(null);
    setLoadedAccess([]);
    if (!fieldObject) return;
    let canceled = false;
    void Promise.all([
      client.rest<{
        fields: Array<{
          name: string;
          label: string;
          type: string;
          permissionable: boolean;
          updateable: boolean;
          calculated: boolean;
        }>;
      }>('GET', `/sobjects/${fieldObject}/describe`),
      fieldAccessOf(client, holder.id, fieldObject).catch(() => [] as FieldAccessRow[]),
    ])
      .then(([describe, access]) => {
        if (canceled) return;
        setObjectFields(
          describe.fields
            .filter((f) => f.permissionable)
            .map((f) => ({ name: f.name, label: f.label, type: f.type, editable: f.updateable && !f.calculated }))
            .sort((a, b) => a.label.localeCompare(b.label))
        );
        setLoadedAccess(access);
      })
      .catch((e: Error) => !canceled && setStatus(`❌ ${fieldObject}: ${e.message}`));
    return () => {
      canceled = true;
    };
  }, [client, holder.id, fieldObject]);
  const systemNow = (p: SystemPermission): boolean => {
    const c = changes.get(`system:${p.api}`);
    return c?.kind === 'system' ? c.enabled : p.enabled;
  };

  const setObject = (object: string, flag: keyof ObjectAccess, on: boolean) => {
    let next = { ...objectNow(object), [flag]: on };
    // Unticking Read takes everything away; unticking the others keeps what they need
    if (flag === 'read' && !on) next = NO_ACCESS;
    else if (!on && flag !== 'modifyAll')
      next = { ...next, modifyAll: false, ...(flag === 'edit' ? { delete: false } : {}) };
    put({ kind: 'object', object, access: normalizeObjectAccess(next) });
  };
  const objectRows = useMemo(
    () => [...new Set([...objects.map((o) => o.object), ...addedObjects])],
    [objects, addedObjects]
  );
  const fieldNeedle = fieldFilter.trim().toLowerCase();
  const shownFields = (objectFields ?? []).filter(
    (f) => !fieldNeedle || `${f.label} ${f.name}`.toLowerCase().includes(fieldNeedle)
  );
  const changedElsewhere = [...changes.values()].filter(
    (c) => c.kind === 'field' && !c.field.startsWith(`${fieldObject}.`)
  ).length;
  const setAllFields = (what: 'read' | 'edit', on: boolean) => {
    for (const f of shownFields) {
      const field = `${fieldObject}.${f.name}`;
      const now = fieldNow(field);
      if (what === 'read') put({ kind: 'field', field, read: on, edit: on && now.edit });
      else if (f.editable) put({ kind: 'field', field, read: now.read || on, edit: on });
    }
  };
  const needle = systemFilter.trim().toLowerCase();
  const systemRows = system.filter((p) => !needle || `${p.label} ${p.api}`.toLowerCase().includes(needle));

  const save = async () => {
    const list = [...changes.values()];
    if (!list.length) return;
    const shown = list.slice(0, 12).map((c) => `• ${describeChange(c)}`);
    if (
      !(await confirmChange(
        `Change ${list.length} permission(s) of ${holder.kind.toLowerCase()} ${holder.name} in ${
          org.label
        }:\n${shown.join('\n')}${list.length > shown.length ? `\n… and ${list.length - shown.length} more` : ''}`
      ))
    )
      return;
    setBusy(true);
    setStatus('Saving…');
    try {
      const result = await applyAccessChanges(client, holder.id, list);
      logActivity('change permissions', { of: holder.name, applied: result.applied, failed: result.failures.length });
      if (result.failures.length) {
        setStatus(
          `✓ ${result.applied} saved. ❌ ${result.failures.length} failed: ${result.failures
            .map((f) => `${f.change} (${f.error})`)
            .join('; ')}`
        );
        setChanges(new Map());
      } else onDone(true);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const box = (checked: boolean, onChange: (on: boolean) => void, changed: boolean) => (
    <input
      type="checkbox"
      className={changed ? 'changed' : ''}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  );

  return (
    <div className="access-editor">
      <div className="form editor-bar">
        <b>Editing {holder.name}</b>
        <span className="muted">
          {changes.size} change(s) · nothing is sent until you save · changed boxes are outlined
        </span>
        <span className="grow" />
        <button onClick={() => onDone(false)} disabled={busy}>
          Cancel
        </button>
        <button className="primary" disabled={busy || changes.size === 0} onClick={() => void save()}>
          Save {changes.size || ''} change(s)…
        </button>
      </div>
      {status && <p className="muted">{status}</p>}

      <h4>Object access</h4>
      <table className="edit-table">
        <thead>
          <tr>
            <th>object</th>
            {FLAGS.map(([, label]) => (
              <th key={label}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {objectRows.map((object) => {
            const now = objectNow(object);
            return (
              <tr key={object}>
                <td>{object}</td>
                {FLAGS.map(([flag]) => (
                  <td key={flag}>
                    {box(now[flag], (on) => setObject(object, flag, on), changes.has(`object:${object}`))}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="form">
        <input
          list="editor-objects"
          placeholder="Add an object"
          value={newObject}
          onChange={(e) => setNewObject(e.target.value)}
        />
        <ObjectOptions id="editor-objects" objects={allObjects} typed={newObject} />
        <button
          disabled={!/^\w+$/.test(newObject.trim())}
          onClick={() => {
            setAddedObjects((l) => [...l, newObject.trim()]);
            setNewObject('');
          }}
        >
          Add
        </button>
      </div>

      <h4>Field access</h4>
      <div className="form">
        <input
          list="editor-field-objects"
          placeholder="Choose an object"
          value={typedFieldObject}
          onChange={(e) => {
            setTypedFieldObject(e.target.value);
            const match = allObjects.find((o) => o.name.toLowerCase() === e.target.value.trim().toLowerCase());
            if (match) setFieldObject(match.name);
          }}
        />
        <ObjectOptions id="editor-field-objects" objects={allObjects} typed={typedFieldObject} />
        {objectFields && (
          <>
            <input placeholder="Filter fields" value={fieldFilter} onChange={(e) => setFieldFilter(e.target.value)} />
            <button onClick={() => setAllFields('read', true)}>All Read</button>
            <button onClick={() => setAllFields('edit', true)}>All Edit</button>
            <button onClick={() => setAllFields('read', false)}>None</button>
          </>
        )}
        <span className="muted">
          {fieldObject && !objectFields ? `Reading ${fieldObject} fields…` : ''}
          {changedElsewhere ? ` ${changedElsewhere} field change(s) in other objects are kept.` : ''}
        </span>
      </div>
      {objectFields && (
        <p className="muted">
          Required and system fields (Id, Name of most objects, CreatedDate…) are not listed: everyone with access to
          the object can read and edit them, so they have no field permissions.
        </p>
      )}
      {objectFields && (
        <table className="edit-table">
          <thead>
            <tr>
              <th>field</th>
              <th>API name</th>
              <th>Read</th>
              <th>Edit</th>
            </tr>
          </thead>
          <tbody>
            {shownFields.map((f) => {
              const field = `${fieldObject}.${f.name}`;
              const now = fieldNow(field);
              const changed = changes.has(`field:${field}`);
              return (
                <tr key={field}>
                  <td>{f.label}</td>
                  <td className="muted mono">{f.name}</td>
                  <td>
                    {box(now.read, (on) => put({ kind: 'field', field, read: on, edit: on && now.edit }), changed)}
                  </td>
                  <td>
                    {f.editable ? (
                      box(now.edit, (on) => put({ kind: 'field', field, read: now.read || on, edit: on }), changed)
                    ) : (
                      <span className="muted" title="Formula, auto-number and other read-only fields can only be read">
                        —
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h4>User &amp; system permissions</h4>
      <div className="form">
        <input placeholder="Filter…" value={systemFilter} onChange={(e) => setSystemFilter(e.target.value)} />
        <span className="muted">
          {systemRows.length} of {system.length}
        </span>
      </div>
      <table className="edit-table">
        <tbody>
          {systemRows.map((p) => (
            <tr key={p.api}>
              <td>
                {box(
                  systemNow(p),
                  (on) => put({ kind: 'system', api: p.api, label: p.label, enabled: on }),
                  changes.has(`system:${p.api}`)
                )}
              </td>
              <td>{p.label}</td>
              <td className="muted mono">{p.api}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The permission sets in a permission set group: remove one, or add one (Salesforce then recalculates the group). */
export function GroupEditor({
  groupId,
  holders,
  blocked,
}: {
  groupId: string;
  holders: PermissionHolder[];
  /** Why changes are not possible here (the user's permissions). */
  blocked?: string;
}) {
  const { client, org, confirmChange, logActivity } = useStudio();
  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [groupStatus, setGroupStatus] = useState('');
  const [adding, setAdding] = useState('');
  const [status, setStatus] = useState('');

  const load = () =>
    groupPermissionSets(client, groupId)
      .then((r) => {
        setMembers(r.members);
        setGroupStatus(r.status);
      })
      .catch((e: Error) => setStatus(`❌ ${e.message}`));
  useEffect(() => {
    setMembers(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, groupId]);

  const inGroup = new Set((members ?? []).map((m) => m.permissionSetId));
  const addable = holders.filter((h) => h.kind === 'Permission set' && !inGroup.has(h.id));
  const run = async (what: string, action: () => Promise<void>) => {
    if (!(await confirmChange(`${what} in ${org.label}`))) return;
    setStatus('Saving…');
    try {
      await action();
      logActivity('change permission set group', { what });
      setStatus(`✓ ${what}. Salesforce recalculates the group's permissions in a moment.`);
      await load();
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div className="section">
      <h4>
        Permission sets in this group{' '}
        {groupStatus && <span className={`pill ${groupStatus === 'Updated' ? 'good' : ''}`}>{groupStatus}</span>}
      </h4>
      {members === null ? (
        <p className="muted">Reading…</p>
      ) : (
        <table className="edit-table">
          <tbody>
            {members.map((m) => (
              <tr key={m.componentId}>
                <td>{m.label}</td>
                <td className="muted mono">{m.name}</td>
                <td>
                  <button
                    className="link danger"
                    disabled={Boolean(blocked)}
                    title={blocked}
                    onClick={() =>
                      void run(`Remove ${m.label} from the group`, () => removeFromGroup(client, m.componentId))
                    }
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="form">
        <select value={adding} onChange={(e) => setAdding(e.target.value)} style={{ minWidth: 300 }}>
          <option value="">Add a permission set ({addable.length})…</option>
          {addable.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        <button
          disabled={!adding || Boolean(blocked)}
          title={blocked}
          onClick={() => {
            const name = holders.find((h) => h.id === adding)?.name ?? adding;
            setAdding('');
            void run(`Add ${name} to the group`, () => addToGroup(client, groupId, adding));
          }}
        >
          Add
        </button>
        <span className="muted">{status || blocked}</span>
      </div>
    </div>
  );
}
