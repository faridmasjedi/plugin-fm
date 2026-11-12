import type { SalesforceClient } from './client.js';
import { deployFiles } from './accessMeta.js';
import { findSameUser } from './accessCompare.js';
import { copySheets, usersBundle } from './recordCopy.js';
import { query, soqlText, type Row } from './query.js';
import { executeAnonymous, getUserInfo } from './soap.js';
import type { FileTable, Sheet } from './workbook.js';

/**
 * Sandbox refresh, before and after (the refresh itself is started in Setup, never here).
 *
 * Before: one workbook of what a refresh replaces with production's — the users you choose (with their access and
 * the files of their permission sets), remote sites, named and external credentials, certificates, custom setting
 * values and scheduled Apex. After: the same workbook next to the refreshed sandbox, item by item (same, different,
 * missing); what the API can put back is restored after asking, the rest is a checklist for Setup.
 */

export type SandboxSection =
  | 'remoteSites'
  | 'namedCredentials'
  | 'externalCredentials'
  | 'certificates'
  | 'customSettings'
  | 'scheduledJobs';

export const SANDBOX_SHEETS: Record<SandboxSection, string> = {
  remoteSites: 'Sandbox · Remote sites',
  namedCredentials: 'Sandbox · Named credentials',
  externalCredentials: 'Sandbox · External credentials',
  certificates: 'Sandbox · Certificates',
  customSettings: 'Sandbox · Custom settings',
  scheduledJobs: 'Sandbox · Scheduled Apex',
};
const ABOUT_SHEET = 'Sandbox · About';

export const SANDBOX_LABELS: Record<SandboxSection, string> = {
  remoteSites: 'Remote sites',
  namedCredentials: 'Named credentials',
  externalCredentials: 'External credentials',
  certificates: 'Certificates',
  customSettings: 'Custom settings',
  scheduledJobs: 'Scheduled Apex',
};

/** Done by hand in Setup after every refresh: the API cannot read or set them. */
export const SANDBOX_CHECKLIST: Array<{ what: string; where: string }> = [
  { what: 'Email deliverability: a refreshed sandbox sends system e-mail only', where: 'Setup › Deliverability' },
  {
    what: 'Secrets of named and external credentials (passwords, tokens, client secrets)',
    where: 'Setup › Named Credentials',
  },
  {
    what: 'Certificates with private keys: import the keystore again',
    where: 'Setup › Certificate and Key Management',
  },
  { what: 'Connected apps: consumer secrets and OAuth logins of integration users', where: 'Setup › App Manager' },
  { what: 'Outbound message and callout endpoints that point to production', where: 'Setup › Outbound Messages' },
  { what: 'Users who should not log in to this sandbox: freeze them', where: 'Access › Users' },
];

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const optional = (p: Promise<{ rows: Row[] }>): Promise<Row[]> => p.then((r) => r.rows).catch(() => []);

// ---------- before ----------

/** Custom setting values as lines: Setting, Key (a list entry's Name, or Organization / Profile: x / User: y), Field, Type, Value. */
async function customSettingLines(client: SalesforceClient): Promise<Row[]> {
  const global = await client.rest<{ sobjects: Array<{ name: string; customSetting: boolean }> }>('GET', '/sobjects');
  const settings = global.sobjects.filter((o) => o.customSetting).map((o) => o.name);
  const lines: Row[] = [];
  const owners = new Map<string, string>();
  for (const setting of settings.slice(0, 200)) {
    // eslint-disable-next-line no-await-in-loop
    const d = await client.rest<{
      fields: Array<{ name: string; type: string; custom: boolean; createable: boolean }>;
    }>('GET', `/sobjects/${setting}/describe`);
    const fields = d.fields.filter((f) => f.custom && f.createable);
    const hierarchy = d.fields.some((f) => f.name === 'SetupOwnerId');
    if (!fields.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const rows = await optional(
      query(
        client,
        `SELECT Id, Name${hierarchy ? ', SetupOwnerId' : ''}, ${fields.map((f) => f.name).join(', ')} FROM ${setting}`,
        {
          maxRows: 10_000,
        }
      )
    );
    for (const r of rows) {
      const key = hierarchy ? text(r.SetupOwnerId) : text(r.Name);
      if (hierarchy) owners.set(key, '');
      for (const f of fields)
        lines.push({ Setting: setting, Key: key, Field: f.name, Type: f.type, Value: text(r[f.name]) });
    }
  }
  // Hierarchy owners by name, so they are found in another org
  const ids = [...owners.keys()];
  const names = new Map<string, string>();
  const profiles = ids.filter((i) => i.startsWith('00e'));
  const users = ids.filter((i) => i.startsWith('005'));
  const quoted = (list: string[]) => list.map((i) => `'${soqlText(i)}'`).join(', ');
  if (profiles.length)
    for (const r of await optional(query(client, `SELECT Id, Name FROM Profile WHERE Id IN (${quoted(profiles)})`)))
      names.set(text(r.Id), `Profile: ${text(r.Name)}`);
  if (users.length)
    for (const r of await optional(query(client, `SELECT Id, Username FROM User WHERE Id IN (${quoted(users)})`)))
      names.set(text(r.Id), `User: ${text(r.Username)}`);
  for (const l of lines) {
    const k = text(l.Key);
    if (k.startsWith('00D')) l.Key = 'Organization';
    else if (names.has(k)) l.Key = names.get(k);
  }
  return lines;
}

async function scheduledApex(client: SalesforceClient): Promise<Row[]> {
  const [triggers, jobs] = await Promise.all([
    optional(
      query(
        client,
        "SELECT Id, CronJobDetail.Name, CronJobDetail.JobType, CronExpression, State, NextFireTime FROM CronTrigger WHERE CronJobDetail.JobType = '7'",
        { maxRows: 5000 }
      )
    ),
    optional(
      query(
        client,
        "SELECT CronTriggerId, ApexClass.Name FROM AsyncApexJob WHERE JobType = 'ScheduledApex' AND Status IN ('Queued', 'Holding', 'Preparing', 'Processing')",
        { maxRows: 5000 }
      )
    ),
  ]);
  const classOf = new Map(jobs.map((j) => [text(j.CronTriggerId), text(j['ApexClass.Name'])]));
  return triggers.map((t) => ({
    Name: text(t['CronJobDetail.Name']),
    ApexClass: classOf.get(text(t.Id)) ?? '',
    CronExpression: text(t.CronExpression),
    State: text(t.State),
    NextFireTime: text(t.NextFireTime),
  }));
}

/** Everything a refresh replaces, as workbook sheets (the users' sheets read back by Data › Record › Open a saved copy too). */
export async function sandboxBefore(
  client: SalesforceClient,
  options: { userIds: string[]; orgLabel: string }
): Promise<Sheet[]> {
  const tooling = (soql: string) => optional(query(client, soql, { tooling: true, maxRows: 10_000 }));
  const [users, remoteSites, named, external, certificates, settings, jobs] = await Promise.all([
    options.userIds.length ? usersBundle(client, options.userIds, options.orgLabel) : { users: [], metadata: [] },
    tooling('SELECT SiteName, EndpointUrl, IsActive, Description FROM RemoteProxy'),
    optional(query(client, 'SELECT DeveloperName, MasterLabel, Endpoint, PrincipalType FROM NamedCredential')),
    tooling('SELECT DeveloperName, MasterLabel, AuthenticationProtocol FROM ExternalCredential'),
    tooling('SELECT DeveloperName, MasterLabel, ExpirationDate, KeySize FROM Certificate'),
    customSettingLines(client).catch(() => [] as Row[]),
    scheduledApex(client),
  ]);
  const sheet = (section: SandboxSection, columns: string[], rows: Row[]): Sheet => ({
    name: SANDBOX_SHEETS[section],
    columns,
    rows: rows.map((r) => Object.fromEntries(columns.map((c) => [c, text(r[c])]))),
  });
  return [
    {
      name: ABOUT_SHEET,
      columns: ['What', 'Value'],
      rows: [
        { What: 'Org', Value: options.orgLabel },
        { What: 'Saved', Value: new Date().toISOString() },
        { What: 'Users', Value: String(users.users.length) },
      ],
    },
    sheet('remoteSites', ['SiteName', 'EndpointUrl', 'IsActive', 'Description'], remoteSites),
    sheet('namedCredentials', ['DeveloperName', 'MasterLabel', 'Endpoint', 'PrincipalType'], named),
    sheet('externalCredentials', ['DeveloperName', 'MasterLabel', 'AuthenticationProtocol'], external),
    sheet('certificates', ['DeveloperName', 'MasterLabel', 'ExpirationDate', 'KeySize'], certificates),
    sheet('customSettings', ['Setting', 'Key', 'Field', 'Type', 'Value'], settings),
    sheet('scheduledJobs', ['Name', 'ApexClass', 'CronExpression', 'State', 'NextFireTime'], jobs),
    ...copySheets({ records: {}, ...users }),
  ];
}

/** Whether a workbook is a sandbox refresh workbook. */
export const isSandboxWorkbook = (tables: FileTable[]): boolean => tables.some((t) => t.name === ABOUT_SHEET);

/** The org the workbook was saved in, and when. */
export function sandboxAbout(tables: FileTable[]): { org: string; saved: string } {
  const rows = tables.find((t) => t.name === ABOUT_SHEET)?.rows ?? [];
  const of = (what: string) => rows.find((r) => r.What === what)?.Value ?? '';
  return { org: of('Org'), saved: of('Saved') };
}

// ---------- after ----------

export type SandboxItem = {
  section: SandboxSection;
  key: string;
  /** What it is, as people read it. */
  label: string;
  before: string;
  now: string;
  state: 'same' | 'different' | 'missing';
  /** Whether NomadSF can put it back (otherwise: by hand, `how`). */
  restorable: boolean;
  how?: string;
  /** What restoring needs. */
  row: Row;
};

/** The saved workbook next to this org: every item, the same, different or missing. */
export async function sandboxAfter(client: SalesforceClient, tables: FileTable[]): Promise<SandboxItem[]> {
  const sheet = (s: SandboxSection) => tables.find((t) => t.name === SANDBOX_SHEETS[s])?.rows ?? [];
  const nowSheets = await sandboxBefore(client, { userIds: [], orgLabel: '' });
  const now = (s: SandboxSection) => (nowSheets.find((t) => t.name === SANDBOX_SHEETS[s])?.rows ?? []) as Row[];
  const items: SandboxItem[] = [];
  const compare = (
    section: SandboxSection,
    keyOf: (r: Row) => string,
    show: (r: Row) => string,
    restorable: boolean,
    how?: string
  ) => {
    const current = new Map(now(section).map((r) => [keyOf(r), r]));
    for (const r of sheet(section)) {
      const key = keyOf(r);
      const there = current.get(key);
      const before = show(r);
      const nowText = there ? show(there) : '';
      items.push({
        section,
        key,
        label: key,
        before,
        now: nowText,
        state: !there ? 'missing' : nowText === before ? 'same' : 'different',
        restorable,
        how,
        row: r,
      });
    }
  };
  compare(
    'remoteSites',
    (r) => text(r.SiteName),
    (r) => `${text(r.EndpointUrl)}${r.IsActive === 'false' ? ' (off)' : ''}`,
    true
  );
  compare(
    'namedCredentials',
    (r) => text(r.DeveloperName),
    (r) => text(r.Endpoint),
    false,
    'Setup › Named Credentials (secrets are never readable)'
  );
  compare(
    'externalCredentials',
    (r) => text(r.DeveloperName),
    (r) => text(r.AuthenticationProtocol),
    false,
    'Setup › Named Credentials'
  );
  compare(
    'certificates',
    (r) => text(r.DeveloperName),
    (r) => text(r.ExpirationDate),
    false,
    'Setup › Certificate and Key Management'
  );
  compare(
    'customSettings',
    (r) => `${text(r.Setting)} · ${text(r.Key)} · ${text(r.Field)}`,
    (r) => text(r.Value),
    true
  );
  compare(
    'scheduledJobs',
    (r) => text(r.Name),
    (r) => `${text(r.ApexClass)} ${text(r.CronExpression)}`.trim(),
    true
  );
  // A scheduled job without its class cannot be scheduled again here
  for (const i of items)
    if (i.section === 'scheduledJobs' && !text(i.row.ApexClass)) {
      i.restorable = false;
      i.how = 'Setup › Scheduled Jobs (its class is not known)';
    }
  return items;
}

// ---------- restore ----------

const remoteSiteXml = (r: Row): string =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<RemoteSiteSetting xmlns="http://soap.sforce.com/2006/04/metadata">\n${
    text(r.Description) ? `    <description>${xmlEscape(text(r.Description))}</description>\n` : ''
  }    <disableProtocolSecurity>${
    text(r.DisableProtocolSecurity) === 'true'
  }</disableProtocolSecurity>\n    <isActive>${text(r.IsActive) !== 'false'}</isActive>\n    <url>${xmlEscape(
    text(r.EndpointUrl)
  )}</url>\n</RemoteSiteSetting>\n`;
const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A custom setting value as the REST API takes it. */
function typed(type: string, value: string): unknown {
  if (value === '') return null;
  if (type === 'boolean') return value === 'true';
  if (['double', 'currency', 'percent', 'int'].includes(type)) return Number(value);
  return value;
}

/** Puts back the items picked (remote sites, custom setting values, scheduled Apex); what fails is listed. */
export async function sandboxRestore(
  client: SalesforceClient,
  items: SandboxItem[]
): Promise<{ done: string[]; failed: Array<{ item: string; error: string }> }> {
  const out = { done: [] as string[], failed: [] as Array<{ item: string; error: string }> };
  const picked = items.filter((i) => i.restorable && i.state !== 'same');

  // Remote sites: one deploy
  const sites = picked.filter((i) => i.section === 'remoteSites');
  if (sites.length) {
    const r = await deployFiles(
      client,
      'RemoteSiteSetting',
      sites.map((i) => ({ fullName: text(i.row.SiteName), xml: remoteSiteXml(i.row) }))
    );
    if (r.success) out.done.push(...sites.map((i) => `remote site ${i.key}`));
    else out.failed.push(...sites.map((i) => ({ item: `remote site ${i.key}`, error: r.problems.join('; ') })));
  }

  // Custom settings: a record per setting and key, its fields set together
  const settings = picked.filter((i) => i.section === 'customSettings');
  const groups = new Map<string, SandboxItem[]>();
  for (const i of settings) {
    const k = `${text(i.row.Setting)}|${text(i.row.Key)}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const orgId = groups.size ? (await getUserInfo(client)).organizationId : '';
  for (const [k, list] of groups) {
    const [setting, key] = k.split('|');
    try {
      if (!/^\w+$/.test(setting)) throw new Error('Invalid setting.');
      const values = Object.fromEntries(
        list.map((i) => [text(i.row.Field), typed(text(i.row.Type), text(i.row.Value))])
      );
      // The record: a list entry by Name; a hierarchy value by its owner (the org, a profile, a user)
      let owner = '';
      let where = '';
      if (key === 'Organization') owner = orgId;
      else if (key.startsWith('Profile: ')) {
        // eslint-disable-next-line no-await-in-loop
        const p = await query(client, `SELECT Id FROM Profile WHERE Name = '${soqlText(key.slice(9))}' LIMIT 1`);
        owner = text(p.rows[0]?.Id);
        if (!owner) throw new Error(`no profile ${key.slice(9)} here`);
      } else if (key.startsWith('User: ')) {
        // eslint-disable-next-line no-await-in-loop
        const u = await findSameUser(client, key.slice(6));
        owner = u?.Id ?? '';
        if (!owner) throw new Error(`no user like ${key.slice(6)} here`);
      }
      where = owner ? `SetupOwnerId = '${owner}'` : `Name = '${soqlText(key)}'`;
      // eslint-disable-next-line no-await-in-loop
      const found = await query(client, `SELECT Id FROM ${setting} WHERE ${where} LIMIT 1`);
      const id = text(found.rows[0]?.Id);
      if (id)
        // eslint-disable-next-line no-await-in-loop
        await client.rest('PATCH', `/sobjects/${setting}/${id}`, values);
      // eslint-disable-next-line no-await-in-loop
      else
        await client.rest(
          'POST',
          `/sobjects/${setting}`,
          owner ? { SetupOwnerId: owner, ...values } : { Name: key, ...values }
        );
      out.done.push(`${setting} · ${key} (${list.length} value(s))`);
    } catch (e) {
      out.failed.push({ item: `${setting} · ${key}`, error: (e as Error).message });
    }
  }

  // Scheduled Apex: scheduled again under its name, with its class
  for (const i of picked.filter((x) => x.section === 'scheduledJobs')) {
    const cls = text(i.row.ApexClass);
    const cron = text(i.row.CronExpression);
    if (!/^[\w.]+$/.test(cls) || !/^[\w\s*?,/#LW-]+$/.test(cron)) {
      out.failed.push({ item: `job ${i.key}`, error: 'unexpected class or schedule' });
      continue;
    }
    const name = text(i.row.Name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await executeAnonymous(client, `System.schedule('${name}', '${cron}', new ${cls}());`);
      if (!r.compiled || !r.success) throw new Error(r.compileProblem || r.exceptionMessage || 'failed');
      out.done.push(`job ${i.key}`);
    } catch (e) {
      out.failed.push({ item: `job ${i.key}`, error: (e as Error).message });
    }
  }
  return out;
}
