import { useEffect, useState, type ReactNode } from 'react';
import {
  effectivePermissions,
  userAccess,
  userLogins,
  type EffectivePermission,
  type Row,
  type UserAccess,
} from '@nomadsf/core';
import { storage, useStudio } from '../context';
import { DataTable, EmptyHint } from './DataTable';

type Tab = 'perms' | 'system' | 'groups' | 'licenses' | 'oauth' | 'logins';
const TABS: Array<[Tab, string]> = [
  ['perms', 'Permission sets & groups'],
  ['system', 'System permissions'],
  ['groups', 'Groups & queues'],
  ['licenses', 'Licenses'],
  ['oauth', 'OAuth apps'],
  ['logins', 'Login history'],
];

/** What a user has: permission sets and groups, combined system permissions, groups, licenses, OAuth apps, logins. */
export function UserAccessPanel({ userId, label, details }: { userId: string; label: string; details: ReactNode }) {
  const { client, org } = useStudio();
  const [tab, setTab] = useState<Tab | 'details'>(() => storage.get('user.tab', 'details'));
  const [access, setAccess] = useState<UserAccess | null>(null);
  const [system, setSystem] = useState<EffectivePermission[] | null>(null);
  const [logins, setLogins] = useState<Row[] | null>(null);
  const [status, setStatus] = useState('');

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
    if (tab === 'logins' && !logins)
      userLogins(client, userId)
        .then((l) => !canceled && setLogins(l))
        .catch(fail);
    return () => {
      canceled = true;
    };
    // results are not triggers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, userId, tab]);

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
            {access.permissionSetGroups.length ? (
              <DataTable
                columns={['Label', 'Name', 'ExpirationDate']}
                rows={access.permissionSetGroups}
                name={name('permission-set-groups')}
                rowKey="Id"
              />
            ) : (
              <EmptyHint what="permission set groups" />
            )}
            <h4>Permission sets ({access.permissionSets.length})</h4>
            {access.permissionSets.length ? (
              <DataTable
                columns={['Label', 'Name', 'ExpirationDate']}
                rows={access.permissionSets}
                name={name('permission-sets')}
                rowKey="Id"
              />
            ) : (
              <EmptyHint what="permission sets (besides the profile)" />
            )}
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
        ) : access.groups.length === 0 ? (
          <EmptyHint what="groups or queues" />
        ) : (
          <DataTable
            columns={['Kind', 'Name', 'DeveloperName', 'Member', 'Owner']}
            rows={access.groups}
            rowKey="Id"
            name={name('groups')}
            note={
              <span>· direct memberships (not through roles or other groups), and personal groups the user owns</span>
            }
          />
        )
      ) : tab === 'licenses' ? (
        !access ? (
          loading
        ) : access.licenses.length === 0 ? (
          <EmptyHint what="permission set licenses" />
        ) : (
          <DataTable
            columns={['Label', 'Name', 'Status', 'ExpirationDate']}
            rows={access.licenses}
            rowKey="Name"
            name={name('licenses')}
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
          columns={[
            'LoginTime',
            'Status',
            'LoginType',
            'Application',
            'SourceIp',
            'CountryIso',
            'Browser',
            'Platform',
            'LoginUrl',
          ]}
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
