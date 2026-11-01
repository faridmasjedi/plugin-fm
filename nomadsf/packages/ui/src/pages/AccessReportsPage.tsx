import { useEffect, useMemo, useState } from 'react';
import { POWER_PERMISSIONS, usersAccessMap, whoCanAccess, type Row } from '@nomadsf/core';
import { TableTabs } from '../components/TableTabs';
import { DataTable, EmptyHint } from '../components/DataTable';
import { useAccessOf } from '../access';
import { storage, useStudio } from '../context';
import { NEEDS, permissionLabel, toolAccess } from '../toolAccess';
import { TOOLS, hubOf, type ToolId } from '../workspace';
import { Status } from '../statusLog';

/** Access › Access overview: every user with what they have; filter any column, export it. */
export function AccessOverviewPage() {
  const { client, org } = useStudio();
  const [activeOnly, setActiveOnly] = useState(true);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [status, setStatus] = useState('');
  const load = async () => {
    setRows(null);
    setStatus('Reading every user, their permission sets, groups and licenses…');
    try {
      setRows(await usersAccessMap(client, { activeOnly }));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, activeOnly]);
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Access overview</h2>
        <span className="muted">every user and what they have, on {org.label}</span>
        <span className="grow" />
        <label className="check">
          <input type="checkbox" checked={activeOnly} onChange={(e) => setActiveOnly(e.target.checked)} /> Active users
          only
        </label>
        <button onClick={() => void load()}>Refresh</button>
      </div>
      {status && <Status text={status} block />}
      {rows &&
        (rows.length === 0 ? (
          <EmptyHint what="users" />
        ) : (
          <DataTable
            columns={[
              'Name',
              'Username',
              'Profile',
              'Role',
              'License',
              'PermissionSets',
              'Groups',
              'PermissionSetLicenses',
              ...POWER_PERMISSIONS.map(([, label]) => label),
              'LastLogin',
            ]}
            rows={rows}
            rowKey="Id"
            name={`${org.label}-access-overview`}
            note={
              <span>
                · filter a column with ✓ (e.g. Modify All Data) to see who has it · powerful permissions from the
                profile, permission sets and groups together
              </span>
            }
          />
        ))}
    </div>
  );
}

/** Access › Object access: who can read, create, edit, delete an object (and read / edit a field), and through what. */
export function ObjectAccessPage() {
  const { client, org } = useStudio();
  const [objects, setObjects] = useState<Array<{ name: string; label: string }>>([]);
  const [object, setObject] = useState<string>(() => storage.get('objectaccess.object', 'Account'));
  const [field, setField] = useState('');
  const [fields, setFields] = useState<Array<{ name: string; label: string }>>([]);
  const [result, setResult] = useState<{ rows: Row[]; notes: string[] } | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    client
      .rest<{ sobjects: Array<{ name: string; label: string; queryable: boolean }> }>('GET', '/sobjects')
      .then((r) => setObjects(r.sobjects.filter((o) => o.queryable).sort((a, b) => a.label.localeCompare(b.label))))
      .catch(() => setObjects([]));
  }, [client]);
  useEffect(() => {
    setFields([]);
    setField('');
    if (!/^\w+$/.test(object)) return;
    client
      .rest<{ fields: Array<{ name: string; label: string }> }>('GET', `/sobjects/${object}/describe`)
      .then((d) => setFields(d.fields.sort((a, b) => a.label.localeCompare(b.label))))
      .catch(() => setFields([]));
  }, [client, object]);

  const check = async () => {
    setResult(null);
    setStatus('Reading who can use it…');
    storage.set('objectaccess.object', object);
    try {
      setResult(await whoCanAccess(client, object, field || undefined));
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Object access</h2>
        <span className="muted">who can use an object or a field, on {org.label}</span>
      </div>
      <div className="card form">
        <label>
          Object
          <select value={object} onChange={(e) => setObject(e.target.value)} style={{ width: 320 }}>
            {!objects.some((o) => o.name === object) && <option value={object}>{object}</option>}
            {objects.map((o) => (
              <option key={o.name} value={o.name}>
                {o.label} ({o.name})
              </option>
            ))}
          </select>
        </label>
        <label>
          Field (optional)
          <select value={field} onChange={(e) => setField(e.target.value)} style={{ width: 320 }}>
            <option value="">—</option>
            {fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label} ({f.name})
              </option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={() => void check()}>
          Show who
        </button>
        <Status text={status} />
      </div>
      {result &&
        (result.rows.length === 0 ? (
          <EmptyHint what="users with access" />
        ) : (
          <DataTable
            columns={[
              'Name',
              'Username',
              'Profile',
              'Read',
              'Create',
              'Edit',
              'Delete',
              'ViewAll',
              'ModifyAll',
              ...(field ? ['FieldRead', 'FieldEdit'] : []),
              'Through',
            ]}
            rows={result.rows}
            rowKey="Id"
            name={`${org.label}-${object}${field ? `-${field}` : ''}-access`}
            note={<span>· active users · {result.notes.join(' ')}</span>}
          />
        ))}
    </div>
  );
}

/** Access › Your access: what your own user may do here, tool by tool, and every permission you have. */
export function MyAccessPage() {
  const { client, org } = useStudio();
  const access = useAccessOf(client);
  const [filter, setFilter] = useState('');
  const tools = useMemo(
    () =>
      access?.known
        ? TOOLS.filter((t) => NEEDS[t.id]).map((t) => {
            const a = toolAccess(access, t.id as ToolId);
            const need = NEEDS[t.id]!;
            return {
              tool: `${hubOf(t.id).label} › ${t.label}`,
              read: a.canRead ? '✓' : `✗ needs ${a.missingRead.map((p) => permissionLabel(access, p)).join(', ')}`,
              change: !need.change
                ? ''
                : a.canChange
                ? `✓ ${need.changeWhat ?? ''}`
                : `✗ ${need.changeWhat ?? 'change'}: needs ${a.missingChange
                    .map((p) => permissionLabel(access, p))
                    .join(' or ')}`,
            };
          })
        : [],
    [access]
  );
  const granted = useMemo(
    () =>
      access?.known
        ? [...access.permissions]
            .map((p) => ({ permission: permissionLabel(access, p), api: p }))
            .filter((p) => !filter || `${p.permission} ${p.api}`.toLowerCase().includes(filter.toLowerCase()))
            .sort((a, b) => a.permission.localeCompare(b.permission))
        : [],
    [access, filter]
  );
  return (
    <div className="page">
      <div className="toolbar">
        <h2>Your access</h2>
        <span className="muted">what your user may do on {org.label}</span>
      </div>
      {!access ? (
        <p className="muted">Reading your permissions…</p>
      ) : !access.known ? (
        <p className="muted">
          Your permissions could not be read here. The tools still work as far as Salesforce allows, and say why when
          something is refused.
        </p>
      ) : (
        <>
          <p>
            <span className={`pill ${access.level === 'full' ? 'good' : access.level === 'limited' ? 'bad' : ''}`}>
              {access.level} access
            </span>{' '}
            {access.summary}
          </p>
          <TableTabs
            tabs={[
              {
                id: 'tools',
                label: 'Tools',
                count: tools.length,
                content: (
                  <DataTable
                    columns={['tool', 'read', 'change']}
                    rows={tools}
                    rowKey="tool"
                    name={`${org.label}-your-access`}
                    note={<span>· the permissions each tool usually needs (Salesforce still decides)</span>}
                  />
                ),
              },
              {
                id: 'permissions',
                label: 'Your permissions',
                count: access.permissions.size,
                content: (
                  <>
                    <div className="form">
                      <input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
                    </div>
                    <DataTable
                      columns={['permission', 'api']}
                      rows={granted}
                      rowKey="api"
                      name={`${org.label}-your-permissions`}
                    />
                  </>
                ),
              },
            ]}
          />
        </>
      )}
    </div>
  );
}
