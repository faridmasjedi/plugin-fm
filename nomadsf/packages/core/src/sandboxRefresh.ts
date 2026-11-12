import type { SalesforceClient } from './client.js';
import { deployFiles } from './accessMeta.js';
import { findSameUser } from './accessCompare.js';
import { copySheets, usersBundle } from './recordCopy.js';
import { query, soqlText, type Row } from './query.js';
import { executeAnonymous, getUserInfo } from './soap.js';
import { retrieveZip } from './metadata.js';
import { fromBase64, readZip } from './zip.js';
import { updateRecord } from './inspector.js';
import type { UserCopy } from './recordCopy.js';
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
  | 'scheduledJobs'
  | 'sharingDefaults'
  | 'sharingRules';

export const SANDBOX_SHEETS: Record<SandboxSection, string> = {
  remoteSites: 'Sandbox · Remote sites',
  namedCredentials: 'Sandbox · Named credentials',
  externalCredentials: 'Sandbox · External credentials',
  certificates: 'Sandbox · Certificates',
  customSettings: 'Sandbox · Custom settings',
  scheduledJobs: 'Sandbox · Scheduled Apex',
  sharingDefaults: 'Sandbox · Sharing defaults',
  sharingRules: 'Sandbox · Sharing rules',
};
const ABOUT_SHEET = 'Sandbox · About';

export const SANDBOX_LABELS: Record<SandboxSection, string> = {
  remoteSites: 'Remote sites',
  namedCredentials: 'Named credentials',
  externalCredentials: 'External credentials',
  certificates: 'Certificates',
  customSettings: 'Custom settings',
  scheduledJobs: 'Scheduled Apex',
  sharingDefaults: 'Sharing defaults',
  sharingRules: 'Sharing rules',
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

/** Excel holds at most 32,767 characters in a cell: a long file goes over several. */
const CELL = 32_000;

/** Every object's sharing rules (one Metadata API retrieve), as Object, Rules, Xml1…Xmln. */
async function sharingRules(client: SalesforceClient): Promise<Row[]> {
  const retrieved = await retrieveZip(client, [{ type: 'SharingRules', fullName: '*' }]);
  if (!retrieved.zipFile) return [];
  const files = await readZip(fromBase64(retrieved.zipFile));
  const rows: Row[] = [];
  for (const [path, bytes] of files) {
    if (!path.endsWith('.sharingRules')) continue;
    const xml = new TextDecoder().decode(bytes);
    const rules = (xml.match(/<sharing(Criteria|Owner|Guest|Territory)Rules>/g) ?? []).length;
    if (!rules) continue;
    const row: Row = { Object: (path.split('/').pop() ?? '').replace(/\.sharingRules$/, ''), Rules: String(rules) };
    for (let i = 0; i * CELL < xml.length; i += 1) row[`Xml${i + 1}`] = xml.slice(i * CELL, (i + 1) * CELL);
    rows.push(row);
  }
  return rows.sort((a, b) => text(a.Object).localeCompare(text(b.Object)));
}

/** A sharing rules file back from its cells. */
const xmlOf = (r: Row): string =>
  Object.keys(r)
    .filter((k) => /^Xml\d+$/.test(k))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
    .map((k) => text(r[k]))
    .join('');
const sameXml = (a: string, b: string): boolean => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');

/** Everything a refresh replaces, as workbook sheets (the users' sheets read back by Data › Record › Open a saved copy too). */
export async function sandboxBefore(
  client: SalesforceClient,
  options: { userIds: string[]; orgLabel: string; skip?: SandboxSection[] }
): Promise<Sheet[]> {
  const tooling = (soql: string) => optional(query(client, soql, { tooling: true, maxRows: 10_000 }));
  // A kind left out is not read at all (sharing rules and custom settings take the longest)
  const want = (s: SandboxSection, read: () => Promise<Row[]>): Promise<Row[]> =>
    options.skip?.includes(s) ? Promise.resolve([]) : read();
  const [users, remoteSites, named, external, certificates, settings, jobs, defaults, rules] = await Promise.all([
    options.userIds.length ? usersBundle(client, options.userIds, options.orgLabel) : { users: [], metadata: [] },
    want('remoteSites', () => tooling('SELECT SiteName, EndpointUrl, IsActive, Description FROM RemoteProxy')),
    want('namedCredentials', () =>
      optional(query(client, 'SELECT DeveloperName, MasterLabel, Endpoint, PrincipalType FROM NamedCredential'))
    ),
    want('externalCredentials', () =>
      tooling('SELECT DeveloperName, MasterLabel, AuthenticationProtocol FROM ExternalCredential')
    ),
    want('certificates', () => tooling('SELECT DeveloperName, MasterLabel, ExpirationDate, KeySize FROM Certificate')),
    want('customSettings', () => customSettingLines(client).catch(() => [] as Row[])),
    want('scheduledJobs', () => scheduledApex(client)),
    want('sharingDefaults', () =>
      optional(
        query(
          client,
          'SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE IsCustomizable = true AND InternalSharingModel != null',
          { maxRows: 5000 }
        )
      )
    ),
    want('sharingRules', () => sharingRules(client).catch(() => [] as Row[])),
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
    sheet(
      'sharingDefaults',
      ['Object', 'Internal', 'External'],
      defaults.map((d) => ({
        Object: d.QualifiedApiName,
        Internal: d.InternalSharingModel,
        External: d.ExternalSharingModel,
      }))
    ),
    {
      name: SANDBOX_SHEETS.sharingRules,
      columns: [
        'Object',
        'Rules',
        ...Array.from({ length: Math.max(1, ...rules.map((r) => Object.keys(r).length - 2)) }, (_, i) => `Xml${i + 1}`),
      ],
      rows: rules,
    },
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
  /** What restoring needs (the editable value already in it: Value, EndpointUrl or CronExpression). */
  row: Row;
  /** The value that can be changed before it is put back. */
  edit?: { field: string; label: string };
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
  compare(
    'sharingDefaults',
    (r) => text(r.Object),
    (r) => `${text(r.Internal)} / external ${text(r.External)}`,
    true
  );
  {
    const current = new Map(now('sharingRules').map((r) => [text(r.Object), r]));
    for (const r of sheet('sharingRules')) {
      const there = current.get(text(r.Object));
      items.push({
        section: 'sharingRules',
        key: text(r.Object),
        label: text(r.Object),
        before: `${text(r.Rules)} rule(s)`,
        now: there ? `${text(there.Rules)} rule(s)` : 'none',
        state: !there ? 'missing' : sameXml(xmlOf(r), xmlOf(there)) ? 'same' : 'different',
        restorable: true,
        row: r,
      });
    }
  }
  // A standard object the org lacks (a feature or license it does not have): nothing to put back
  for (const i of items)
    if (
      (i.section === 'sharingDefaults' || i.section === 'sharingRules') &&
      i.state === 'missing' &&
      !isCustomObject(i.key)
    ) {
      i.restorable = false;
      i.how = 'not in this org: it needs a feature or license this org lacks';
    }
  // What can be changed before it is put back
  for (const i of items) {
    if (i.section === 'customSettings') i.edit = { field: 'Value', label: 'value' };
    if (i.section === 'remoteSites') i.edit = { field: 'EndpointUrl', label: 'URL' };
    if (i.section === 'scheduledJobs') i.edit = { field: 'CronExpression', label: 'schedule' };
    if (i.section === 'sharingDefaults') i.edit = { field: 'Internal', label: 'internal default' };
  }
  // A scheduled job without its class cannot be scheduled again here
  for (const i of items)
    if (i.section === 'scheduledJobs' && !text(i.row.ApexClass)) {
      i.restorable = false;
      i.how = 'Setup › Scheduled Jobs (its class is not known)';
    }
  return items;
}

// ---------- restore ----------

/** What could not be put back, and why; `keys` are the items it was about (section|key). */
export type SandboxFailure = { item: string; error: string; keys: string[] };

/** Standard objects (Account, WebCart…) cannot be deployed: one an org lacks needs a feature or license there. */
export const isCustomObject = (name: string): boolean => /__(c|mdt|e|b|x)$/.test(name);

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
): Promise<{ done: string[]; failed: SandboxFailure[] }> {
  const out = { done: [] as string[], failed: [] as SandboxFailure[] };
  const keyOf = (i: SandboxItem) => `${i.section}|${i.key}`;
  /** A deploy's problems, each item with the ones that name it (all of them when none does). */
  const deployFailed = (list: SandboxItem[], what: (i: SandboxItem) => string, problems: string[]) => {
    for (const i of list) {
      const own = problems.filter((p) => p.includes(i.key));
      out.failed.push({ item: what(i), error: (own.length ? own : problems).join('; '), keys: [keyOf(i)] });
    }
  };
  // Exactly the items chosen (a same one too: its value may have been changed)
  const picked = items.filter((i) => i.restorable);

  // Remote sites: one deploy
  const sites = picked.filter((i) => i.section === 'remoteSites');
  if (sites.length) {
    const r = await deployFiles(
      client,
      'RemoteSiteSetting',
      sites.map((i) => ({ fullName: text(i.row.SiteName), xml: remoteSiteXml(i.row) }))
    );
    if (r.success) out.done.push(...sites.map((i) => `remote site ${i.key}`));
    else deployFailed(sites, (i) => `remote site ${i.key}`, r.problems);
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
      out.failed.push({ item: `${setting} · ${key}`, error: (e as Error).message, keys: list.map(keyOf) });
    }
  }

  // Sharing defaults: each object as it is in this org, with only its sharing model changed, deployed back
  const defaults = picked.filter((i) => i.section === 'sharingDefaults');
  if (defaults.length) {
    try {
      const retrieved = await retrieveZip(
        client,
        defaults.map((i) => ({ type: 'CustomObject', fullName: i.key }))
      );
      const files = retrieved.zipFile ? await readZip(fromBase64(retrieved.zipFile)) : new Map<string, Uint8Array>();
      const patched: Array<{ fullName: string; xml: string }> = [];
      for (const i of defaults) {
        const file = files.get(`objects/${i.key}.object`);
        if (!file) {
          out.failed.push({
            item: `sharing default of ${i.key}`,
            error: 'the object could not be read in this org',
            keys: [keyOf(i)],
          });
          continue;
        }
        const set = (xml: string, tag: string, value: string) =>
          !value
            ? xml
            : xml.includes(`<${tag}>`)
            ? xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), `<${tag}>${value}</${tag}>`)
            : xml.replace('</CustomObject>', `    <${tag}>${value}</${tag}>\n</CustomObject>`);
        let xml = new TextDecoder().decode(file);
        xml = set(xml, 'sharingModel', text(i.row.Internal));
        xml = set(xml, 'externalSharingModel', text(i.row.External));
        patched.push({ fullName: i.key, xml });
      }
      if (patched.length) {
        const r = await deployFiles(client, 'CustomObject', patched);
        if (r.success) out.done.push(...patched.map((p) => `sharing default of ${p.fullName}`));
        else
          deployFailed(
            defaults.filter((i) => patched.some((p) => p.fullName === i.key)),
            (i) => `sharing default of ${i.key}`,
            r.problems
          );
      }
    } catch (e) {
      out.failed.push({ item: 'sharing defaults', error: (e as Error).message, keys: defaults.map(keyOf) });
    }
  }

  // Sharing rules: one deploy, an object's whole file each
  const shared = picked.filter((i) => i.section === 'sharingRules');
  if (shared.length) {
    const r = await deployFiles(
      client,
      'SharingRules',
      shared.map((i) => ({ fullName: i.key, xml: xmlOf(i.row) }))
    );
    if (r.success) out.done.push(...shared.map((i) => `sharing rules of ${i.key}`));
    else deployFailed(shared, (i) => `sharing rules of ${i.key}`, r.problems);
  }

  // Scheduled Apex: scheduled again under its name, with its class
  for (const i of picked.filter((x) => x.section === 'scheduledJobs')) {
    const cls = text(i.row.ApexClass);
    const cron = text(i.row.CronExpression);
    if (!/^[\w.]+$/.test(cls) || !/^[\w\s*?,/#LW-]+$/.test(cron)) {
      out.failed.push({ item: `job ${i.key}`, error: 'unexpected class or schedule', keys: [keyOf(i)] });
      continue;
    }
    const name = text(i.row.Name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await executeAnonymous(client, `System.schedule('${name}', '${cron}', new ${cls}());`);
      if (!r.compiled || !r.success) throw new Error(r.compileProblem || r.exceptionMessage || 'failed');
      out.done.push(`job ${i.key}`);
    } catch (e) {
      out.failed.push({ item: `job ${i.key}`, error: (e as Error).message, keys: [keyOf(i)] });
    }
  }
  return out;
}

// ---------- e-mail addresses after a refresh ----------

/**
 * A refresh adds ".invalid" to every user's e-mail (so a sandbox never mails real people). The users kept in the
 * workbook (integration users, testers) are found here with such an address, to set it back.
 */
export async function invalidEmails(client: SalesforceClient, users: UserCopy[]): Promise<Row[]> {
  const out: Row[] = [];
  for (const u of users) {
    // eslint-disable-next-line no-await-in-loop
    const found = await findSameUser(client, u.username);
    if (!found) continue;
    // eslint-disable-next-line no-await-in-loop
    const row = (await query(client, `SELECT Id, Name, Username, Email FROM User WHERE Id = '${found.Id}'`)).rows[0];
    const email = text(row?.Email);
    if (/\.invalid$/i.test(email))
      out.push({
        Id: row.Id,
        Name: row.Name,
        Username: row.Username,
        Email: email,
        Fixed: email.replace(/\.invalid$/i, ''),
      });
  }
  return out;
}

/** Sets the e-mails back (without ".invalid"). Salesforce may ask the user to confirm a changed address. */
export async function fixEmails(client: SalesforceClient, rows: Row[]): Promise<{ done: number; errors: string[] }> {
  const out = { done: 0, errors: [] as string[] };
  for (const r of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await updateRecord(client, 'User', text(r.Id), { Email: text(r.Fixed) });
      out.done += 1;
    } catch (e) {
      out.errors.push(`${text(r.Username)}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** The public groups, queues and roles a sharing rules row of the workbook names (they must exist to deploy it). */
export function sharingRuleTargets(row: Row): { groups: string[]; roles: string[] } {
  const xml = Object.keys(row)
    .filter((k) => /^Xml\d+$/.test(k))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
    .map((k) => text(row[k]))
    .join('');
  const all = (tags: string[]) => [
    ...new Set(tags.flatMap((t) => [...xml.matchAll(new RegExp(`<${t}>([^<]+)</${t}>`, 'g'))].map((m) => m[1]))),
  ];
  return {
    groups: all(['group', 'queue']),
    roles: all(['role', 'roleAndSubordinates', 'roleAndSubordinatesInternal']),
  };
}
