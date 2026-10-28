import type { MyAccess } from '@nomadsf/core';
import { useAccessOf } from './access';
import { useStudio } from './context';
import type { ToolId } from './workspace';

/**
 * What each tool needs from the logged-in user (the well-known permissions only — Salesforce still has the last
 * word, and its errors are shown as they come). `read`: all needed to see it; `change`: any one of them to change.
 */
export type Need = { read?: string[]; change?: string[]; changeWhat?: string; partialRecords?: boolean };

export const NEEDS: Partial<Record<ToolId, Need>> = {
  apex: { change: ['AuthorApex'], changeWhat: 'run anonymous Apex' },
  code: { read: ['ViewSetup'], change: ['AuthorApex'], changeWhat: 'save code' },
  apextests: { read: ['ViewSetup'] },
  logs: { read: ['ViewSetup'] },
  automation: { read: ['ViewSetup'] },
  jobs: { read: ['ViewSetup'], change: ['AuthorApex'], changeWhat: 'stop jobs' },
  fields: { read: ['ViewSetup'] },
  backup: { partialRecords: true },
  lifecycle: { partialRecords: true },
  project: { read: ['ViewSetup'], change: ['ModifyMetadata'], changeWhat: 'retrieve and deploy' },
  metadata: { read: ['ViewSetup'], change: ['ModifyMetadata'], changeWhat: 'retrieve metadata' },
  deployments: { read: ['ViewSetup'], change: ['ModifyMetadata'], changeWhat: 'quick deploy' },
  access: { change: ['ManageUsers'], changeWhat: 'edit, freeze or deactivate users' },
  permsets: {
    read: ['ViewSetup'],
    change: ['AssignPermissionSets', 'ManageUsers'],
    changeWhat: 'assign or remove permission sets',
  },
  permissions: { read: ['ViewSetup'], change: ['ManageProfilesPermissionsets'], changeWhat: 'change permissions' },
  assigned: { read: ['ViewSetup'] },
  groups: { read: ['ViewSetup'], change: ['ManageUsers'], changeWhat: 'add or remove group and queue members' },
  custperms: {
    read: ['ViewSetup'],
    change: ['ManageProfilesPermissionsets'],
    changeWhat: 'grant or remove custom permissions',
  },
  compare: { read: ['ViewSetup'] },
  accessmap: { read: ['ViewSetup'] },
  objectaccess: { read: ['ViewSetup'] },
  audit: { read: ['ViewSetup'] },
  apps: { read: ['ViewSetup'] },
  health: { read: ['ViewSetup'] },
};

/** Names people know, for the permissions the tools need (the org's own labels win when known). */
const LABELS: Record<string, string> = {
  ViewSetup: 'View Setup and Configuration',
  AuthorApex: 'Author Apex',
  ModifyMetadata: 'Modify Metadata Through Metadata API Functions',
  ManageUsers: 'Manage Users',
  AssignPermissionSets: 'Assign Permission Sets',
  ManageProfilesPermissionsets: 'Manage Profiles and Permission Sets',
  ViewAllData: 'View All Data',
  ModifyAllData: 'Modify All Data',
};
export const permissionLabel = (access: MyAccess | null, p: string): string => LABELS[p] ?? access?.labels.get(p) ?? p;

/** Modify All Data includes the rest. */
export const hasPermission = (access: MyAccess, p: string): boolean =>
  access.permissions.has(p) || access.permissions.has('ModifyAllData');

export type ToolAccess = { canRead: boolean; canChange: boolean; missingRead: string[]; missingChange: string[] };

export function toolAccess(access: MyAccess, tool: ToolId): ToolAccess {
  const need = NEEDS[tool] ?? {};
  const missingRead = (need.read ?? []).filter((p) => !hasPermission(access, p));
  const canChange = !need.change || need.change.some((p) => hasPermission(access, p));
  return {
    canRead: missingRead.length === 0,
    canChange,
    missingRead,
    missingChange: canChange ? [] : need.change ?? [],
  };
}

/** At the top of a tool: what the user cannot do here, and which permission gives it (nothing when all is fine). */
export function AccessNote({ tool }: { tool: ToolId }) {
  const { client, org } = useStudio();
  const access = useAccessOf(client);
  if (!access?.known) return null;
  const need = NEEDS[tool];
  if (!need) return null;
  const t = toolAccess(access, tool);
  const names = (list: string[], joiner: string) => list.map((p) => permissionLabel(access, p)).join(joiner);
  const partial = need.partialRecords && !hasPermission(access, 'ViewAllData');
  if (t.canRead && t.canChange && !partial) return null;
  return (
    <div className="callout access-note">
      {!t.canRead && (
        <div>
          Your user can't read what this tool shows in {org.label} — needs <b>{names(t.missingRead, ', ')}</b>.
        </div>
      )}
      {t.canRead && !t.canChange && (
        <div>
          Your user can read here, but can't {need.changeWhat ?? 'change'} in {org.label} — needs{' '}
          <b>{names(t.missingChange, ' or ')}</b>.
        </div>
      )}
      {partial && (
        <div>
          Without <b>View All Data</b> you see only the records shared with you in {org.label}: a backup or copy may be
          incomplete.
        </div>
      )}
    </div>
  );
}
