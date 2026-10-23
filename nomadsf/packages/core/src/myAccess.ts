import type { SalesforceClient } from './client.js';
import { query } from './query.js';

/** What the logged-in user may do in an org (their effective permissions), to say up front why something is missing. */

export type MyAccess = {
  /** False when the user's permissions could not be read at all (then nothing is assumed). */
  known: boolean;
  /** Effective permissions, by API name without "Permissions" (ApiEnabled, ViewSetup…). */
  permissions: Set<string>;
  /** Labels of every user permission the org has (API name → label), granted or not. */
  labels: Map<string, string>;
  can: {
    readSetup: boolean;
    changePermissions: boolean;
    assignPermissionSets: boolean;
    manageUsers: boolean;
    authorApex: boolean;
    modifyMetadata: boolean;
    viewAllData: boolean;
  };
  /** full · read only · limited · unknown */
  level: 'full' | 'read only' | 'limited' | 'unknown';
  /** One line for people: what is missing and which permission gives it. */
  summary: string;
};

const WANTED = [
  'ApiEnabled',
  'ViewSetup',
  'ManageProfilesPermissionsets',
  'AssignPermissionSets',
  'ManageUsers',
  'AuthorApex',
  'ModifyMetadata',
  'ViewAllData',
  'ModifyAllData',
  'ViewAllUsers',
  'CustomizeApplication',
];

const UNKNOWN: MyAccess = {
  known: false,
  permissions: new Set(),
  labels: new Map(),
  can: {
    readSetup: true,
    changePermissions: true,
    assignPermissionSets: true,
    manageUsers: true,
    authorApex: true,
    modifyMetadata: true,
    viewAllData: true,
  },
  level: 'unknown',
  summary: 'your permissions could not be read',
};

/** The user's effective permissions (UserPermissionAccess: from the profile, permission sets and groups). */
export async function myAccess(client: SalesforceClient): Promise<MyAccess> {
  try {
    const describe = await client.rest<{ fields: Array<{ name: string; label?: string }> }>(
      'GET',
      '/sobjects/UserPermissionAccess/describe'
    );
    // Every user permission of the org (the ones the checks need first), read in chunks
    const all = describe.fields.filter((f) => f.name.startsWith('Permissions'));
    const wanted = new Set(WANTED.map((w) => `Permissions${w}`));
    const fields = [...all.filter((f) => wanted.has(f.name)), ...all.filter((f) => !wanted.has(f.name))].map(
      (f) => f.name
    );
    if (!fields.some((f) => wanted.has(f))) return UNKNOWN;
    const row: Record<string, unknown> = {};
    for (let i = 0; i < fields.length; i += 150) {
      const chunk = fields.slice(i, i + 150);
      try {
        // eslint-disable-next-line no-await-in-loop
        Object.assign(row, (await query(client, `SELECT ${chunk.join(', ')} FROM UserPermissionAccess`)).rows[0] ?? {});
      } catch (e) {
        // The first chunk holds what the checks need: without it nothing is known
        if (i === 0) throw e;
      }
    }
    const permissions = new Set(fields.filter((f) => row[f] === true).map((f) => f.replace(/^Permissions/, '')));
    const labels = new Map(all.map((f) => [f.name.replace(/^Permissions/, ''), f.label ?? f.name]));
    const has = (p: string): boolean => permissions.has(p) || permissions.has('ModifyAllData');
    const can = {
      readSetup: has('ViewSetup'),
      changePermissions: has('ManageProfilesPermissionsets'),
      assignPermissionSets: has('AssignPermissionSets') || has('ManageUsers'),
      manageUsers: has('ManageUsers'),
      authorApex: has('AuthorApex'),
      modifyMetadata: has('ModifyMetadata') || has('CustomizeApplication'),
      viewAllData: has('ViewAllData'),
    };
    const level: MyAccess['level'] = !can.readSetup ? 'limited' : !can.changePermissions ? 'read only' : 'full';
    const summary =
      level === 'limited'
        ? "can't read setup — profiles, permissions, code (needs View Setup and Configuration)"
        : level === 'read only'
        ? "can read setup, can't change permissions (needs Manage Profiles and Permission Sets)"
        : 'can read and change setup and permissions';
    return { known: true, permissions, labels, can, level, summary };
  } catch {
    return UNKNOWN;
  }
}
