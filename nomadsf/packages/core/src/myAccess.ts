import type { SalesforceClient } from './client.js';
import { query } from './query.js';

/** What the logged-in user may do in an org (their effective permissions), to say up front why something is missing. */

export type MyAccess = {
  /** False when the user's permissions could not be read at all (then nothing is assumed). */
  known: boolean;
  /** Effective permissions, by API name without "Permissions" (ApiEnabled, ViewSetup…). */
  permissions: Set<string>;
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
    const describe = await client.rest<{ fields: Array<{ name: string }> }>(
      'GET',
      '/sobjects/UserPermissionAccess/describe'
    );
    const have = new Set(describe.fields.map((f) => f.name));
    const fields = WANTED.map((w) => `Permissions${w}`).filter((f) => have.has(f));
    if (!fields.length) return UNKNOWN;
    const row = (await query(client, `SELECT ${fields.join(', ')} FROM UserPermissionAccess`)).rows[0] ?? {};
    const permissions = new Set(fields.filter((f) => row[f] === true).map((f) => f.replace(/^Permissions/, '')));
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
    return { known: true, permissions, can, level, summary };
  } catch {
    return UNKNOWN;
  }
}
