import type { SalesforceClient } from './client.js';
import { query, type Row } from './query.js';

/** The Security hub: a dashboard of small checks, a timeline of what happened, and why a user can see a record. */

const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;
const count = async (client: SalesforceClient, soql: string, tooling = false): Promise<number> =>
  (await query(client, soql, { tooling, maxRows: 1 })).totalSize;

// ---------- dashboard ----------

export type TileLevel = 'good' | 'warn' | 'bad' | 'info';
export type TileValue = { value: string; detail: string; level: TileLevel };
export type Tile = {
  id: string;
  label: string;
  /** The tool a click opens, and the tab to open it on (the page's remembered choice). */
  tool: string;
  set?: Record<string, string>;
  read: (client: SalesforceClient) => Promise<TileValue>;
};

const level = (n: number, warn: number, bad: number): TileLevel => (n >= bad ? 'bad' : n >= warn ? 'warn' : 'good');

/** Each tile is one small query, read on its own when the dashboard opens: a slow one does not hold the others. */
export const SECURITY_TILES: Tile[] = [
  {
    id: 'health',
    label: 'Health Check',
    tool: 'health',
    set: { 'health.tab': 'security' },
    read: async (client) => {
      const [score, risks] = await Promise.all([
        query(client, 'SELECT Score FROM SecurityHealthCheck', { tooling: true }),
        count(client, "SELECT Id FROM SecurityHealthCheckRisks WHERE RiskType = 'HIGH_RISK'", true),
      ]);
      const s = Number(score.rows[0]?.Score ?? NaN);
      return {
        value: Number.isFinite(s) ? `${Math.round(s)}%` : '—',
        detail: `${risks} high risk${risks === 1 ? '' : 's'}`,
        level: !Number.isFinite(s) ? 'info' : s >= 80 ? 'good' : s >= 60 ? 'warn' : 'bad',
      };
    },
  },
  {
    id: 'failedLogins',
    label: 'Failed logins (24 h)',
    tool: 'audit',
    set: { 'audit.tab': 'login' },
    read: async (client) => {
      // Status cannot be filtered in SOQL: the day's logins, counted here
      const rows = (
        await query(client, 'SELECT Status FROM LoginHistory WHERE LoginTime = LAST_N_DAYS:1', { maxRows: 2000 })
      ).rows;
      const n = rows.filter((r) => r.Status !== 'Success').length;
      return { value: String(n), detail: 'wrong password, locked, blocked…', level: level(n, 5, 20) };
    },
  },
  {
    id: 'api',
    label: 'API calls today',
    tool: 'limits',
    set: { 'limits.tab': 'limits' },
    read: async (client) => {
      const l = await client.rest<Record<string, { Max: number; Remaining: number }>>('GET', '/limits');
      const api = l.DailyApiRequests;
      if (!api?.Max) return { value: '—', detail: 'not reported', level: 'info' };
      const used = Math.round(((api.Max - api.Remaining) / api.Max) * 100);
      return {
        value: `${used}%`,
        detail: `${(api.Max - api.Remaining).toLocaleString()} of ${api.Max.toLocaleString()}`,
        level: level(used, 50, 80),
      };
    },
  },
  {
    id: 'setup',
    label: 'Setup changes (7 days)',
    tool: 'timeline',
    set: { 'timeline.kinds': 'Setup' },
    read: async (client) => {
      const n = await count(client, 'SELECT Id FROM SetupAuditTrail WHERE CreatedDate = LAST_N_DAYS:7');
      return { value: String(n), detail: 'who changed what: the timeline', level: 'info' };
    },
  },
  {
    id: 'admins',
    label: 'Users with Modify All Data',
    tool: 'health',
    set: { 'health.tab': 'security' },
    read: async (client) => {
      const rows = (
        await query(
          client,
          'SELECT COUNT_DISTINCT(AssigneeId) n FROM PermissionSetAssignment WHERE PermissionSet.PermissionsModifyAllData = true AND Assignee.IsActive = true'
        )
      ).rows;
      const n = Number(rows[0]?.n ?? 0);
      return { value: String(n), detail: 'active users who can change any data', level: level(n, 4, 8) };
    },
  },
  {
    id: 'dormant',
    label: 'Inactive users (90 days)',
    tool: 'health',
    set: { 'health.tab': 'security' },
    read: async (client) => {
      const n = await count(
        client,
        "SELECT Id FROM User WHERE IsActive = true AND UserType = 'Standard' AND (LastLoginDate < LAST_N_DAYS:90 OR LastLoginDate = null)"
      );
      return { value: String(n), detail: 'active, no login for 90 days: a license each', level: n ? 'warn' : 'good' };
    },
  },
  {
    id: 'licenses',
    label: 'Free user licenses',
    tool: 'health',
    set: { 'health.tab': 'licenses' },
    read: async (client) => {
      const rows = (
        await query(
          client,
          "SELECT Name, TotalLicenses, UsedLicenses FROM UserLicense WHERE Status = 'Active' AND Name IN ('Salesforce', 'Salesforce Platform')"
        )
      ).rows;
      const free = rows.reduce((n, r) => n + Number(r.TotalLicenses ?? 0) - Number(r.UsedLicenses ?? 0), 0);
      return { value: String(free), detail: 'Salesforce and Salesforce Platform', level: 'info' };
    },
  },
  {
    id: 'failedJobs',
    label: 'Failed Apex jobs (7 days)',
    tool: 'jobs',
    set: { 'jobs.tab2': 'apex' },
    read: async (client) => {
      const n = await count(
        client,
        "SELECT Id FROM AsyncApexJob WHERE Status = 'Failed' AND CreatedDate = LAST_N_DAYS:7 AND JobType != 'TestRequest'"
      );
      return { value: String(n), detail: 'batch, queueable, future, scheduled', level: n ? 'bad' : 'good' };
    },
  },
];

// ---------- timeline ----------

export type TimelineKind = 'Setup' | 'Login' | 'Component' | 'NomadSF';
export type TimelineRow = { when: string; who: string; kind: TimelineKind; what: string; detail: string };
/** What NomadSF itself logged (the Activity page), passed in by the Studio. */
export type ActivityEntry = { at: string; user: string; action: string; details?: Record<string, unknown> };

/** Components whose last change is in the timeline (Tooling, LastModifiedDate). */
const COMPONENTS: Array<[string, string, string]> = [
  ['Apex class', 'ApexClass', 'Name'],
  ['Apex trigger', 'ApexTrigger', 'Name'],
  ['Flow', 'Flow', 'Definition.DeveloperName'],
  ['Validation rule', 'ValidationRule', 'ValidationName'],
  ['Field', 'CustomField', 'DeveloperName'],
  ['LWC', 'LightningComponentBundle', 'DeveloperName'],
  ['Permission set', 'PermissionSet', 'Name'],
  ['Profile', 'Profile', 'Name'],
];

/**
 * What happened in the org, newest first, in one list: setup changes (audit trail), logins, components last changed,
 * and what was done with NomadSF. A part that cannot be read (no permission) becomes a note; the rest still shows.
 */
export async function securityTimeline(
  client: SalesforceClient,
  options: { days: number; kinds?: TimelineKind[]; activity?: ActivityEntry[] }
): Promise<{ rows: TimelineRow[]; notes: string[] }> {
  const days = Math.max(1, Math.min(180, Math.floor(options.days)));
  const kinds = new Set(options.kinds ?? ['Setup', 'Login', 'Component', 'NomadSF']);
  const notes: string[] = [];
  const part = async (what: string, read: () => Promise<TimelineRow[]>): Promise<TimelineRow[]> => {
    try {
      return await read();
    } catch (e) {
      notes.push(`${what}: ${(e as Error).message}`);
      return [];
    }
  };
  const when = (v: unknown): string =>
    String(v ?? '')
      .replace('T', ' ')
      .slice(0, 19);
  const parts = await Promise.all([
    kinds.has('Setup')
      ? part('Setup audit trail', async () =>
          (
            await query(
              client,
              `SELECT CreatedDate, CreatedBy.Name, Section, Display FROM SetupAuditTrail WHERE CreatedDate = LAST_N_DAYS:${days} ORDER BY CreatedDate DESC`,
              { maxRows: 5000 }
            )
          ).rows.map((r) => ({
            when: when(r.CreatedDate),
            who: String(r['CreatedBy.Name'] ?? ''),
            kind: 'Setup' as const,
            what: String(r.Display ?? ''),
            detail: String(r.Section ?? ''),
          }))
        )
      : [],
    kinds.has('Login')
      ? part('Logins', async () => {
          const logins = (
            await query(
              client,
              `SELECT LoginTime, UserId, Status, Application, Browser, SourceIp FROM LoginHistory WHERE LoginTime = LAST_N_DAYS:${days} ORDER BY LoginTime DESC`,
              { maxRows: 5000 }
            )
          ).rows;
          const ids = [...new Set(logins.map((r) => String(r.UserId)))].filter((id) => ID.test(id));
          const names = new Map<string, string>();
          for (let i = 0; i < ids.length; i += 300) {
            // eslint-disable-next-line no-await-in-loop
            const users = await query(
              client,
              `SELECT Id, Name FROM User WHERE Id IN (${ids
                .slice(i, i + 300)
                .map((id) => `'${id}'`)
                .join(',')})`
            );
            for (const u of users.rows) names.set(String(u.Id), String(u.Name));
          }
          return logins.map((r) => ({
            when: when(r.LoginTime),
            who: names.get(String(r.UserId)) ?? String(r.UserId),
            kind: 'Login' as const,
            what: String(r.Status ?? ''),
            detail: [r.Application, r.Browser, r.SourceIp].filter(Boolean).join(' · '),
          }));
        })
      : [],
    ...(kinds.has('Component')
      ? COMPONENTS.map(([label, type, name]) =>
          part(label, async () =>
            (
              await query(
                client,
                `SELECT LastModifiedDate, LastModifiedBy.Name, ${name} FROM ${type} WHERE LastModifiedDate = LAST_N_DAYS:${days} ORDER BY LastModifiedDate DESC`,
                { tooling: true, maxRows: 2000 }
              )
            ).rows.map((r) => ({
              when: when(r.LastModifiedDate),
              who: String(r['LastModifiedBy.Name'] ?? ''),
              kind: 'Component' as const,
              what: `${label} ${String(r[name] ?? '')}`,
              detail: 'last changed',
            }))
          )
        )
      : []),
  ]);
  const since = Date.now() - days * 86_400_000;
  const mine: TimelineRow[] = kinds.has('NomadSF')
    ? (options.activity ?? [])
        .filter((a) => Date.parse(a.at) >= since)
        .map((a) => ({
          when: when(new Date(a.at).toISOString()),
          who: a.user,
          kind: 'NomadSF',
          what: a.action,
          detail: a.details ? JSON.stringify(a.details).slice(0, 200) : '',
        }))
    : [];
  return { rows: [...parts.flat(), ...mine].sort((a, b) => b.when.localeCompare(a.when)), notes };
}

// ---------- who can see a record ----------

export type AccessStep = { area: string; text: string; applies: boolean };
export type RecordAccess = {
  object: string;
  read: boolean;
  edit: boolean;
  delete: boolean;
  transfer: boolean;
  steps: AccessStep[];
  /** What Edit would need, when the user cannot edit. */
  editNeeds?: string;
};

const SHARE_LEVEL: Record<string, string> = { Read: 'Read', Edit: 'Read/Write', All: 'Full access' };

/**
 * Whether a user can read, edit, delete or transfer a record — Salesforce's own answer (UserRecordAccess) — and why,
 * step by step: what their object permission allows, view/modify all, the owner and the role hierarchy, and the
 * sharing rows of the record (rules, teams, manual shares), marked when they reach the user.
 */
export async function whoCanSee(client: SalesforceClient, userId: string, recordId: string): Promise<RecordAccess> {
  if (!ID.test(userId) || !userId.startsWith('005')) throw new Error('Choose a user.');
  if (!ID.test(recordId)) throw new Error('Not a record Id.');
  const prefix = recordId.slice(0, 3);
  const objects = await client.rest<{ sobjects: Array<{ name: string; keyPrefix: string | null; label: string }> }>(
    'GET',
    '/sobjects'
  );
  const object = objects.sobjects.find((o) => o.keyPrefix === prefix)?.name;
  if (!object) throw new Error(`No object has Ids starting ${prefix}.`);

  const [access, user] = await Promise.all([
    query(
      client,
      `SELECT RecordId, HasReadAccess, HasEditAccess, HasDeleteAccess, HasTransferAccess FROM UserRecordAccess WHERE UserId = '${userId}' AND RecordId = '${recordId}'`
    ),
    query(client, `SELECT Id, Name, UserRoleId, UserRole.Name FROM User WHERE Id = '${userId}'`),
  ]);
  const a = access.rows[0] ?? {};
  const u = user.rows[0] ?? {};
  const name = String(u.Name ?? 'The user');
  const steps: AccessStep[] = [];

  // 1. Object permissions from the profile, permission sets and groups
  const perms = (
    await query(
      client,
      `SELECT PermissionsRead, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords, Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name FROM ObjectPermissions WHERE SobjectType = '${object}' AND ParentId IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}')`
    ).catch(() => ({ rows: [] as Row[] }))
  ).rows;
  const from = (r: Row): string =>
    r['Parent.IsOwnedByProfile']
      ? `profile ${String(r['Parent.Profile.Name'] ?? '')}`
      : `permission set ${String(r['Parent.Label'] ?? '')}`;
  const grant = (field: string): string[] => perms.filter((r) => r[field] === true).map(from);
  const readFrom = grant('PermissionsRead');
  const editFrom = grant('PermissionsEdit');
  const viewAll = grant('PermissionsViewAllRecords');
  const modifyAll = grant('PermissionsModifyAllRecords');
  steps.push({
    area: 'Object',
    applies: readFrom.length > 0,
    text: readFrom.length
      ? `${object}: Read via ${readFrom.join(', ')}${
          editFrom.length ? `; Edit via ${editFrom.join(', ')}` : '; no Edit'
        }`
      : `${object}: no Read in the profile or any permission set — no record of it can be seen`,
  });
  if (viewAll.length || modifyAll.length)
    steps.push({
      area: 'View all',
      applies: true,
      text: `${
        modifyAll.length ? `Modify All via ${modifyAll.join(', ')}` : `View All via ${viewAll.join(', ')}`
      } — every ${object} record, whatever its sharing`,
    });

  // 2. The owner and the role hierarchy
  const record = (
    await query(client, `SELECT Id, OwnerId, Owner.Name FROM ${object} WHERE Id = '${recordId}'`).catch(() => ({
      rows: [] as Row[],
    }))
  ).rows[0];
  let ancestorRoles = new Set<string>();
  if (record?.OwnerId) {
    const ownerId = String(record.OwnerId);
    if (ownerId.slice(0, 15) === userId.slice(0, 15))
      steps.push({ area: 'Owner', applies: true, text: `${name} owns the record` });
    else {
      const owner = ownerId.startsWith('005')
        ? (await query(client, `SELECT UserRoleId, UserRole.Name FROM User WHERE Id = '${ownerId}'`)).rows[0]
        : undefined;
      const roles = (await query(client, 'SELECT Id, Name, ParentRoleId FROM UserRole', { maxRows: 50_000 })).rows;
      const parent = new Map(roles.map((r) => [String(r.Id), String(r.ParentRoleId ?? '')]));
      // The roles above the owner's: their users see what the owner owns
      let at = String(owner?.UserRoleId ?? '');
      const above = new Set<string>();
      while (parent.get(at)) {
        at = parent.get(at)!;
        above.add(at);
      }
      ancestorRoles = new Set([...above, String(u.UserRoleId ?? '')]);
      const userRole = String(u.UserRoleId ?? '');
      const reaches = Boolean(userRole) && above.has(userRole);
      steps.push({
        area: 'Owner',
        applies: reaches,
        text: `owned by ${String(record['Owner.Name'] ?? ownerId)}${
          owner?.['UserRole.Name'] ? ` (role ${String(owner['UserRole.Name'])})` : ''
        }; ${name}'s role ${u['UserRole.Name'] ? String(u['UserRole.Name']) : '(none)'} ${
          reaches ? 'is above it: sees it through the role hierarchy' : 'is not above it: no access through roles'
        }`,
      });
    }
  }

  // 3. The record's sharing rows, and whether each reaches the user (directly, a group of theirs, their role)
  const share = object.endsWith('__c') ? object.replace(/__c$/, '__Share') : `${object}Share`;
  const parentField = object.endsWith('__c') ? 'ParentId' : `${object}Id`;
  const accessField = object.endsWith('__c') ? 'AccessLevel' : `${object}AccessLevel`;
  const shares = await query(
    client,
    `SELECT UserOrGroupId, ${accessField}, RowCause FROM ${share} WHERE ${parentField} = '${recordId}'`
  ).catch(() => undefined);
  if (shares) {
    const groups = new Set(
      (await query(client, `SELECT GroupId FROM GroupMember WHERE UserOrGroupId = '${userId}'`)).rows.map((r) =>
        String(r.GroupId).slice(0, 15)
      )
    );
    const roleGroups = ancestorRoles.size
      ? (
          await query(
            client,
            `SELECT Id, Type, RelatedId FROM Group WHERE RelatedId IN (${
              [...ancestorRoles, String(u.UserRoleId ?? '')]
                .filter((id) => ID.test(id))
                .map((id) => `'${id}'`)
                .join(',') || "''"
            })`
          )
        ).rows
      : [];
    for (const g of roleGroups)
      if (
        g.Type === 'Role'
          ? String(g.RelatedId) === String(u.UserRoleId)
          : String(g.Type).startsWith('RoleAndSubordinates')
      )
        groups.add(String(g.Id).slice(0, 15));
    // Who each share is to, by name: a user, a public group or queue, a role (and its subordinates)
    const targets = shares.rows.map((r) => String(r.UserOrGroupId)).filter((id) => ID.test(id));
    const label = new Map<string, string>();
    const usersTo = targets.filter((id) => id.startsWith('005'));
    const groupsTo = targets.filter((id) => id.startsWith('00G'));
    const inList = (ids: string[]) => ids.map((id) => `'${id}'`).join(',');
    if (usersTo.length)
      for (const r of (await query(client, `SELECT Id, Name FROM User WHERE Id IN (${inList(usersTo)})`)).rows)
        label.set(String(r.Id).slice(0, 15), `user ${String(r.Name)}`);
    if (groupsTo.length) {
      const gs = (await query(client, `SELECT Id, Name, Type, RelatedId FROM Group WHERE Id IN (${inList(groupsTo)})`))
        .rows;
      const roleIds = gs.map((g) => String(g.RelatedId ?? '')).filter((id) => id.startsWith('00E'));
      const roleName = new Map(
        roleIds.length
          ? (await query(client, `SELECT Id, Name FROM UserRole WHERE Id IN (${inList(roleIds)})`)).rows.map((r) => [
              String(r.Id),
              String(r.Name),
            ])
          : []
      );
      for (const g of gs) {
        const type = String(g.Type);
        const role = roleName.get(String(g.RelatedId ?? ''));
        label.set(
          String(g.Id).slice(0, 15),
          role
            ? `${type.startsWith('RoleAndSubordinates') ? 'role and subordinates' : 'role'} ${role}`
            : `${type === 'Queue' ? 'queue' : 'group'} ${String(g.Name ?? '')}`
        );
      }
    }
    for (const s of shares.rows) {
      const to = String(s.UserOrGroupId);
      if (s.RowCause === 'Owner') continue;
      const applies = to.slice(0, 15) === userId.slice(0, 15) || groups.has(to.slice(0, 15));
      steps.push({
        area: 'Sharing',
        applies,
        text: `${String(s.RowCause)} share: ${SHARE_LEVEL[String(s[accessField])] ?? String(s[accessField])} to ${
          label.get(to.slice(0, 15)) ?? (to.startsWith('005') ? 'a user' : 'a group or role')
        }${applies ? ` — reaches ${name}` : ''}`,
      });
    }
  } else
    steps.push({
      area: 'Sharing',
      applies: false,
      text: `${object} has no sharing rows to read (public, or controlled by its parent)`,
    });

  const can = (k: string): boolean => a[k] === true;
  return {
    object,
    read: can('HasReadAccess'),
    edit: can('HasEditAccess'),
    delete: can('HasDeleteAccess'),
    transfer: can('HasTransferAccess'),
    steps,
    editNeeds:
      can('HasReadAccess') && !can('HasEditAccess')
        ? `Edit needs Edit on ${object} (a permission set) and Read/Write sharing: owning it, a role above the owner, or a rule, team or manual share`
        : undefined,
  };
}

// ---------- who can see: records by name, and access without a record ----------

const soqlText = (value: string): string => value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export type RecordPick = { Id: string; Name: string };

/**
 * Records of an object to choose from: by their name field (contains the text), the most recently changed first;
 * with no text, the 20 last changed. An Id or a Salesforce link typed in is taken as it is.
 */
export async function findRecords(client: SalesforceClient, object: string, text: string): Promise<RecordPick[]> {
  if (!/^\w+$/.test(object)) throw new Error('Choose an object.');
  const id = text.match(/\b([a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?)\b/g)?.find((t) => /\d/.test(t) && ID.test(t));
  const describe = await client.rest<{ fields: Array<{ name: string; nameField: boolean; filterable: boolean }> }>(
    'GET',
    `/sobjects/${object}/describe`
  );
  const name = describe.fields.find((f) => f.nameField)?.name ?? 'Id';
  const t = text.trim();
  const where = id
    ? `WHERE Id = '${id}'`
    : t && name !== 'Id' && describe.fields.find((f) => f.name === name)?.filterable
    ? `WHERE ${name} LIKE '%${soqlText(t)}%'`
    : '';
  const rows = (
    await query(client, `SELECT Id, ${name} FROM ${object} ${where} ORDER BY LastModifiedDate DESC LIMIT 20`)
  ).rows;
  return rows.map((r) => ({ Id: String(r.Id), Name: String(r[name] ?? r.Id) }));
}

/** What can be checked without a record: an object, one of its fields, or an Apex class, page or custom permission. */
export type UseTarget =
  | { kind: 'object'; object: string }
  | { kind: 'field'; object: string; field: string }
  | { kind: 'ApexClass' | 'ApexPage' | 'CustomPermission'; name: string };

export type TargetAccess = {
  /** What was checked, in words ("Invoice__c", "Account.Customer_Tier__c", "Apex class InvoiceService"). */
  what: string;
  can: Array<[string, boolean]>;
  steps: AccessStep[];
  note?: string;
};

const ENTITY: Record<'ApexClass' | 'ApexPage' | 'CustomPermission', { label: string; field: string }> = {
  ApexClass: { label: 'Apex class', field: 'Name' },
  ApexPage: { label: 'Visualforce page', field: 'Name' },
  CustomPermission: { label: 'Custom permission', field: 'DeveloperName' },
};

/**
 * What a user may do with an object, a field, or an Apex class / Visualforce page / custom permission — from their
 * profile, permission sets and permission set groups — and which of them gives it. Read only.
 */
export async function whoCanUse(client: SalesforceClient, userId: string, target: UseTarget): Promise<TargetAccess> {
  if (!ID.test(userId) || !userId.startsWith('005')) throw new Error('Choose a user.');
  const assigned = `ParentId IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}')`;
  const from = (r: Row): string =>
    r['Parent.IsOwnedByProfile']
      ? `profile ${String(r['Parent.Profile.Name'] ?? '')}`
      : `permission set ${String(r['Parent.Label'] ?? '')}`;
  const parentFields = 'Parent.Label, Parent.IsOwnedByProfile, Parent.Profile.Name';
  // "View All Data" / "Modify All Data" open every object and record
  const powers = (
    await query(
      client,
      `SELECT Label, IsOwnedByProfile, Profile.Name, PermissionsViewAllData, PermissionsModifyAllData FROM PermissionSet WHERE Id IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}') AND (PermissionsViewAllData = true OR PermissionsModifyAllData = true)`
    ).catch(() => ({ rows: [] as Row[] }))
  ).rows.map((r) => ({
    who: r.IsOwnedByProfile ? `profile ${String(r['Profile.Name'] ?? '')}` : `permission set ${String(r.Label ?? '')}`,
    modify: r.PermissionsModifyAllData === true,
  }));
  const powerSteps: AccessStep[] = powers.map((p) => ({
    area: p.modify ? 'Modify all data' : 'View all data',
    applies: true,
    text: `${p.modify ? 'Modify All Data' : 'View All Data'} via ${p.who} — every object and record`,
  }));

  if (target.kind === 'object' || target.kind === 'field') {
    if (!/^\w+$/.test(target.object)) throw new Error('Choose an object.');
    const object = target.object;
    const perms = (
      await query(
        client,
        `SELECT PermissionsRead, PermissionsCreate, PermissionsEdit, PermissionsDelete, PermissionsViewAllRecords, PermissionsModifyAllRecords, ${parentFields} FROM ObjectPermissions WHERE SobjectType = '${object}' AND ${assigned}`
      ).catch(() => ({ rows: [] as Row[] }))
    ).rows;
    const grant = (field: string): string[] => perms.filter((r) => r[field] === true).map(from);
    const objectRead = grant('PermissionsRead');
    if (target.kind === 'object') {
      const rights: Array<[string, string]> = [
        ['Read', 'PermissionsRead'],
        ['Create', 'PermissionsCreate'],
        ['Edit', 'PermissionsEdit'],
        ['Delete', 'PermissionsDelete'],
        ['View all', 'PermissionsViewAllRecords'],
        ['Modify all', 'PermissionsModifyAllRecords'],
      ];
      const sharing = (
        await query(
          client,
          `SELECT InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE QualifiedApiName = '${object}'`
        ).catch(() => ({ rows: [] as Row[] }))
      ).rows[0];
      const steps: AccessStep[] = [
        ...rights.map(([label, field]) => {
          const via = grant(field);
          return {
            area: label,
            applies: via.length > 0,
            text: via.length ? `${label} via ${via.join(', ')}` : `${label}: not in the profile or any permission set`,
          };
        }),
        ...powerSteps,
      ];
      if (sharing?.InternalSharingModel)
        steps.push({
          area: 'Sharing',
          applies: false,
          text: `Org-wide default ${String(sharing.InternalSharingModel)} (external ${String(
            sharing.ExternalSharingModel ?? '—'
          )}): which records they see also depends on ownership, roles and sharing — check one record for that`,
        });
      return {
        what: object,
        // View All Data opens reading; Modify All Data opens everything
        can: rights.map(([label, field]): [string, boolean] => [
          label,
          grant(field).length > 0 || powers.some((p) => p.modify || label === 'Read' || label === 'View all'),
        ]),
        steps,
      };
    }
    // A field: field-level security, and the object's own Read first
    const field = target.field.includes('.') ? target.field.split('.').pop()! : target.field;
    if (!/^\w+$/.test(field)) throw new Error('Choose a field.');
    const fls = (
      await query(
        client,
        `SELECT PermissionsRead, PermissionsEdit, ${parentFields} FROM FieldPermissions WHERE Field = '${object}.${field}' AND SobjectType = '${object}' AND ${assigned}`
      ).catch(() => ({ rows: [] as Row[] }))
    ).rows;
    const flsGrant = (f: string): string[] => fls.filter((r) => r[f] === true).map(from);
    const read = flsGrant('PermissionsRead');
    const edit = flsGrant('PermissionsEdit');
    // Required and system fields have no field-level security: whoever reads the object reads them
    const permissionable = (
      await query(
        client,
        `SELECT IsPermissionable FROM EntityParticle WHERE EntityDefinition.QualifiedApiName = '${object}' AND QualifiedApiName = '${field}'`
      ).catch(() => ({ rows: [] as Row[] }))
    ).rows[0];
    if (!permissionable) throw new Error(`${object} has no field ${field}.`);
    const always = permissionable.IsPermissionable === false;
    const objectOk = objectRead.length > 0 || powers.length > 0;
    const steps: AccessStep[] = [
      {
        area: 'Object',
        applies: objectOk,
        text: objectRead.length
          ? `${object}: Read via ${objectRead.join(', ')}`
          : `${object}: no Read in the profile or any permission set${
              powers.length ? '' : ' — none of its fields can be seen'
            }`,
      },
      ...(always
        ? [
            {
              area: 'Field',
              applies: objectOk,
              text: `${field} has no field-level security (required or system): it follows the object`,
            },
          ]
        : [
            {
              area: 'Read',
              applies: read.length > 0,
              text: read.length ? `Read via ${read.join(', ')}` : 'Read: not in the profile or any permission set',
            },
            {
              area: 'Edit',
              applies: edit.length > 0,
              text: edit.length ? `Edit via ${edit.join(', ')}` : 'Edit: not in the profile or any permission set',
            },
          ]),
      ...powerSteps,
    ];
    return {
      what: `${object}.${field}`,
      can: [
        ['Read', objectOk && (always || read.length > 0)],
        ['Edit', objectOk && (always || edit.length > 0)],
      ],
      steps,
      note:
        powers.length && !always
          ? 'View/Modify All Data does not open fields hidden by field-level security.'
          : undefined,
    };
  }

  const kind = ENTITY[target.kind];
  const entity = (
    await query(
      client,
      `SELECT Id, ${kind.field} FROM ${target.kind} WHERE ${kind.field} = '${soqlText(target.name)}' LIMIT 1`
    )
  ).rows[0];
  if (!entity) throw new Error(`No ${kind.label.toLowerCase()} named ${target.name}.`);
  const holders = (
    await query(
      client,
      `SELECT ${parentFields} FROM SetupEntityAccess WHERE SetupEntityId = '${String(entity.Id)}' AND ${assigned}`
    ).catch(() => ({ rows: [] as Row[] }))
  ).rows.map(from);
  const author =
    target.kind === 'CustomPermission'
      ? []
      : (
          await query(
            client,
            `SELECT Label, IsOwnedByProfile, Profile.Name FROM PermissionSet WHERE Id IN (SELECT PermissionSetId FROM PermissionSetAssignment WHERE AssigneeId = '${userId}') AND PermissionsAuthorApex = true`
          ).catch(() => ({ rows: [] as Row[] }))
        ).rows.map((r) =>
          r.IsOwnedByProfile ? `profile ${String(r['Profile.Name'] ?? '')}` : `permission set ${String(r.Label ?? '')}`
        );
  const steps: AccessStep[] = [
    {
      area: 'Access',
      applies: holders.length > 0,
      text: holders.length
        ? `Given by ${holders.join(', ')}`
        : `Not in the profile or any permission set (or group) of the user`,
    },
  ];
  if (author.length)
    steps.push({
      area: 'Author Apex',
      applies: true,
      text: `Author Apex via ${author.join(', ')} — every class and page`,
    });
  return {
    what: `${kind.label} ${target.name}`,
    can: [[target.kind === 'CustomPermission' ? 'Has it' : 'Can run', holders.length > 0 || author.length > 0]],
    steps,
  };
}
