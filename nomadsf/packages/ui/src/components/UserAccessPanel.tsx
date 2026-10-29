import { useEffect, useState, type ReactNode } from 'react';
import {
  addGroupMembers,
  assignAccess,
  assignLicense,
  deleteByIds,
  effectivePermissions,
  inspectRecord,
  listGroups,
  listPermissionSetLicenses,
  listPermissionSets,
  removeAccess,
  removeGroupMembers,
  userAccess,
  userLogins,
  type AccessTarget,
  type SalesforceClient,
  type Sheet,
  type EffectivePermission,
  type GroupInfo,
  type LicenseInfo,
  type Row,
  type UserAccess,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { DataTable, EmptyHint } from './DataTable';
import { ManagedList } from './ManagedList';

const fail = (r: { errors: string[] }): void => {
  if (r.errors.length) throw new Error(r.errors.join('; '));
};

type Tab = 'perms' | 'system' | 'groups' | 'licenses' | 'oauth' | 'logins';
const TABS: Array<[Tab, string]> = [
  ['perms', 'Permission sets & groups'],
  ['system', 'System permissions'],
  ['groups', 'Groups & queues'],
  ['licenses', 'Licenses'],
  ['oauth', 'OAuth apps'],
  ['logins', 'Login history'],
];

const LOGIN_COLUMNS = [
  'LoginTime',
  'Status',
  'LoginType',
  'Application',
  'SourceIp',
  'CountryIso',
  'Browser',
  'Platform',
  'LoginUrl',
];

/** Every tab of a user, a sheet each (Details, permission sets… login history): ⤓ takes only the open one. */
export async function userWorkbook(client: SalesforceClient, userId: string): Promise<Sheet[]> {
  const [record, access, system, logins] = await Promise.all([
    inspectRecord(client, userId),
    userAccess(client, userId),
    effectivePermissions(client, userId),
    userLogins(client, userId),
  ]);
  const value = (v: unknown): string =>
    v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return [
    {
      name: 'Details',
      columns: ['Label', 'API name', 'Value'],
      rows: record.fields.map((f) => ({ Label: f.label, 'API name': f.name, Value: value(f.value) })),
    },
    { name: 'Permission set groups', columns: ['Label', 'Name', 'ExpirationDate'], rows: access.permissionSetGroups },
    { name: 'Permission sets', columns: ['Label', 'Name', 'ExpirationDate'], rows: access.permissionSets },
    {
      name: 'System permissions',
      columns: ['label', 'api', 'grantedBy'],
      rows: system.map((p) => ({ ...p, grantedBy: p.grantedBy.join(' · ') })),
    },
    { name: 'Groups & queues', columns: ['Name', 'Kind', 'DeveloperName', 'Member', 'Owner'], rows: access.groups },
    { name: 'Licenses', columns: ['Label', 'Name', 'Status', 'ExpirationDate'], rows: access.licenses },
    { name: 'OAuth apps', columns: ['App', 'Uses', 'LastUsed', 'Connected'], rows: access.oauthApps },
    { name: 'Login history', columns: LOGIN_COLUMNS, rows: logins },
  ];
}

/** What a user has: permission sets and groups, combined system permissions, groups, licenses, OAuth apps, logins. */
export function UserAccessPanel({ userId, label, details }: { userId: string; label: string; details: ReactNode }) {
  const { client, org } = useStudio();
  const [tab, setTab] = useState<Tab | 'details'>(() => storage.get('user.tab', 'details'));
  const [access, setAccess] = useState<UserAccess | null>(null);
  const [system, setSystem] = useState<EffectivePermission[] | null>(null);
  const [logins, setLogins] = useState<Row[] | null>(null);
  const [status, setStatus] = useState('');
  // What can be added: loaded with the tab that offers it
  const [targets, setTargets] = useState<AccessTarget[] | null>(null);
  const [groupList, setGroupList] = useState<GroupInfo[] | null>(null);
  const [licenseList, setLicenseList] = useState<LicenseInfo[] | null>(null);
  const refresh = () => {
    setAccess(null);
    setSystem(null);
    setGroupList(null);
    setLicenseList(null);
  };

  useEffect(() => {
    setAccess(null);
    setSystem(null);
    setLogins(null);
    setStatus('');
  }, [userId]);

  // Each tab loads what it needs, once per user
  useEffect(() => {
    let canceled = false;
    const fail = (e: Error) => !canceled && setStatus(`❌ ${e.message}`);
    if (['perms', 'groups', 'licenses', 'oauth'].includes(tab) && !access)
      userAccess(client, userId)
        .then((a) => !canceled && setAccess(a))
        .catch(fail);
    if (tab === 'system' && !system)
      effectivePermissions(client, userId)
        .then((s) => !canceled && setSystem(s))
        .catch(fail);
    if (tab === 'perms' && !targets)
      listPermissionSets(client)
        .then((t) => !canceled && setTargets(t))
        .catch(fail);
    if (tab === 'groups' && !groupList)
      listGroups(client)
        .then((g) => !canceled && setGroupList(g))
        .catch(fail);
    if (tab === 'licenses' && !licenseList)
      listPermissionSetLicenses(client)
        .then((l) => !canceled && setLicenseList(l))
        .catch(fail);
    if (tab === 'logins' && !logins)
      userLogins(client, userId)
        .then((l) => !canceled && setLogins(l))
        .catch(fail);
    return () => {
      canceled = true;
    };
    // results are not triggers (cleared to read again after a change)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, userId, tab, access === null]);

  const choose = (next: Tab | 'details') => {
    setTab(next);
    storage.set('user.tab', next);
  };
  const name = (what: string) => `${label}-${what}`;
  const loading = <p className="muted">{status || 'Reading…'}</p>;

  return (
    <>
      <div className="tabs">
        {([['details', 'Details'], ...TABS] as Array<[Tab | 'details', string]>).map(([id, text]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => choose(id)}>
            {text}
          </button>
        ))}
      </div>
      {tab === 'details' ? (
        details
      ) : tab === 'perms' ? (
        !access ? (
          loading
        ) : (
          <>
            <h4>Permission set groups ({access.permissionSetGroups.length})</h4>
            <ManagedList
              rows={access.permissionSetGroups}
              columns={['Label', 'Name', 'ExpirationDate']}
              what="permission set group"
              removeKey="AssignmentId"
              onRemove={async (r) => fail(await removeAccess(client, [String(r.AssignmentId)]))}
              choices={(targets ?? [])
                .filter((t) => t.kind === 'group' && !access.permissionSetGroups.some((g) => g.Id === t.id))
                .map((t) => ({ id: t.id, label: t.label, detail: t.name }))}
              onAdd={async (c) => fail(await assignAccess(client, { kind: 'group', id: c.id }, [userId]))}
              onChanged={refresh}
            />
            <h4>Permission sets ({access.permissionSets.length})</h4>
            <ManagedList
              rows={access.permissionSets}
              columns={['Label', 'Name', 'ExpirationDate']}
              what="permission set"
              removeKey="AssignmentId"
              onRemove={async (r) => fail(await removeAccess(client, [String(r.AssignmentId)]))}
              choices={(targets ?? [])
                .filter((t) => t.kind === 'permset' && !access.permissionSets.some((p) => p.Id === t.id))
                .map((t) => ({ id: t.id, label: t.label, detail: t.name }))}
              onAdd={async (c) => fail(await assignAccess(client, { kind: 'permset', id: c.id }, [userId]))}
              onChanged={refresh}
            />
          </>
        )
      ) : tab === 'system' ? (
        !system ? (
          loading
        ) : system.length === 0 ? (
          <EmptyHint what="permissions" />
        ) : (
          <DataTable
            columns={['label', 'api', 'grantedBy']}
            rows={system.map((p) => ({ ...p, grantedBy: p.grantedBy.join(' · ') }))}
            rowKey="api"
            name={name('system-permissions')}
            note={
              <span>· every permission this user has, and the profile, permission sets or groups that give it</span>
            }
          />
        )
      ) : tab === 'groups' ? (
        !access ? (
          loading
        ) : (
          <>
            <p className="muted">
              Direct memberships (not through roles or other groups), and personal groups the user owns (those cannot be
              removed here).
            </p>
            <ManagedList
              rows={access.groups}
              columns={['Name', 'Kind', 'DeveloperName', 'Member', 'Owner']}
              what="group or queue"
              whatPlural="groups or queues"
              removeKey="MemberId"
              onRemove={async (r) => fail(await removeGroupMembers(client, [String(r.MemberId)]))}
              choices={(groupList ?? [])
                .filter((g) => !access.groups.some((m) => m.Id === g.Id && m.MemberId))
                .map((g) => ({ id: g.Id, label: g.Name, detail: g.Kind }))}
              addLabel="Add to a public group or queue"
              onAdd={async (c) => fail(await addGroupMembers(client, c.id, [userId]))}
              onChanged={refresh}
            />
          </>
        )
      ) : tab === 'licenses' ? (
        !access ? (
          loading
        ) : (
          <ManagedList
            rows={access.licenses}
            columns={['Label', 'Name', 'Status', 'ExpirationDate']}
            what="permission set license"
            removeKey="AssignmentId"
            onRemove={async (r) => fail(await deleteByIds(client, [String(r.AssignmentId)]))}
            choices={(licenseList ?? [])
              .filter((l) => !access.licenses.some((a) => a.Name === l.Name))
              .map((l) => ({ id: l.Id, label: l.Label, detail: `${l.Used} of ${l.Total} used` }))}
            onAdd={(c) => assignLicense(client, userId, c.id)}
            onChanged={refresh}
          />
        )
      ) : tab === 'oauth' ? (
        !access ? (
          loading
        ) : access.oauthApps.length === 0 ? (
          <EmptyHint what="OAuth apps" />
        ) : (
          <DataTable
            columns={['App', 'Uses', 'LastUsed', 'Connected']}
            rows={access.oauthApps}
            rowKey="__none"
            name={name('oauth-apps')}
            note={<span>· apps this user has connected with OAuth (Org › Connected apps for everyone)</span>}
          />
        )
      ) : !logins ? (
        loading
      ) : logins.length === 0 ? (
        <EmptyHint what="logins" />
      ) : (
        <DataTable
          columns={LOGIN_COLUMNS}
          rows={logins}
          rowKey="__none"
          name={name('logins')}
          note={
            <span>
              · the last {logins.length} logins on {org.label}
            </span>
          }
        />
      )}
    </>
  );
}
