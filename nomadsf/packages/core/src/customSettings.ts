import type { SalesforceClient } from './client.js';
import { deployFiles } from './accessMeta.js';
import { query, type Row } from './query.js';
import { escapeXml } from './soap.js';

/**
 * Data › Custom settings: every custom setting of the org with its values — a hierarchy setting by level (the org
 * default, a profile, a user), a list setting by name — to edit, add and delete; and a new custom setting with its
 * fields, deployed.
 */

export type SettingKind = 'Hierarchy' | 'List';
export type CustomSettingInfo = { name: string; label: string; kind: SettingKind };
export type SettingField = { name: string; label: string; type: string; updateable: boolean };
export type SettingValues = {
  kind: SettingKind;
  fields: SettingField[];
  /** Each row with `Level` ("Organization", "Profile: Sales", "User: Ann Lee") for a hierarchy setting. */
  rows: Row[];
};

type Describe = {
  label: string;
  fields: Array<{ name: string; label: string; type: string; custom: boolean; updateable: boolean }>;
};
const API = /^\w+__c$/;

/** The org's custom settings (managed ones too), with their kind. */
export async function customSettings(client: SalesforceClient): Promise<CustomSettingInfo[]> {
  const list = (
    await query(
      client,
      'SELECT QualifiedApiName, Label FROM EntityDefinition WHERE IsCustomSetting = true ORDER BY QualifiedApiName',
      { maxRows: 2000 }
    )
  ).rows;
  // A hierarchy setting has SetupOwnerId; a list one has not (one describe each, at most 25 at a time)
  const out: CustomSettingInfo[] = [];
  for (let i = 0; i < list.length; i += 25)
    // eslint-disable-next-line no-await-in-loop
    out.push(
      ...(await Promise.all(
        list.slice(i, i + 25).map(async (r) => {
          const name = String(r.QualifiedApiName);
          const d = await client.rest<Describe>('GET', `/sobjects/${name}/describe`).catch(() => undefined);
          return {
            name,
            label: String(r.Label ?? name),
            kind: d?.fields.some((f) => f.name === 'SetupOwnerId') ? ('Hierarchy' as const) : ('List' as const),
          };
        })
      ))
    );
  return out;
}

/** The values of one custom setting. */
export async function settingValues(client: SalesforceClient, name: string): Promise<SettingValues> {
  if (!API.test(name)) throw new Error('Choose a custom setting.');
  const d = await client.rest<Describe>('GET', `/sobjects/${name}/describe`);
  const kind: SettingKind = d.fields.some((f) => f.name === 'SetupOwnerId') ? 'Hierarchy' : 'List';
  const fields = d.fields
    .filter((f) => f.custom)
    .map((f) => ({ name: f.name, label: f.label, type: f.type, updateable: f.updateable }));
  const cols = ['Id', 'Name', ...(kind === 'Hierarchy' ? ['SetupOwnerId'] : []), ...fields.map((f) => f.name)];
  const rows = (await query(client, `SELECT ${cols.join(', ')} FROM ${name} ORDER BY Name`, { maxRows: 5000 })).rows;
  if (kind === 'Hierarchy') {
    const owners = rows.map((r) => String(r.SetupOwnerId ?? ''));
    const ids = (prefix: string) => [...new Set(owners.filter((o) => o.startsWith(prefix)))];
    const names = new Map<string, string>();
    const read = async (object: string, prefix: string) => {
      const list = ids(prefix);
      if (!list.length) return;
      for (const r of (
        await query(client, `SELECT Id, Name FROM ${object} WHERE Id IN (${list.map((x) => `'${x}'`).join(',')})`)
      ).rows)
        names.set(String(r.Id).slice(0, 15), String(r.Name));
    };
    await Promise.all([read('Profile', '00e'), read('User', '005')]);
    for (const r of rows) {
      const o = String(r.SetupOwnerId ?? '');
      r.Level = o.startsWith('00D')
        ? 'Organization'
        : o.startsWith('00e')
        ? `Profile: ${names.get(o.slice(0, 15)) ?? o}`
        : `User: ${names.get(o.slice(0, 15)) ?? o}`;
    }
    rows.sort((a, b) => String(a.Level).localeCompare(String(b.Level)));
  }
  return { kind, fields, rows };
}

/** Text from the screen as the field's type wants it. */
export function settingValue(type: string, text: string): unknown {
  const t = text.trim();
  if (type === 'boolean') return /^(true|yes|1|✓)$/i.test(t);
  if (['double', 'currency', 'percent', 'int'].includes(type)) return t === '' ? null : Number(t);
  return t === '' ? null : t;
}

/** Saves the values of one row (an existing Id), or adds a row (a hierarchy level by SetupOwnerId, a list one by Name). */
export async function saveSettingRow(
  client: SalesforceClient,
  name: string,
  values: Record<string, unknown>,
  id?: string
): Promise<string> {
  if (!API.test(name)) throw new Error('Choose a custom setting.');
  if (id) {
    await client.rest('PATCH', `/sobjects/${name}/${id}`, values);
    return id;
  }
  const r = await client.rest<{ id: string }>('POST', `/sobjects/${name}`, values);
  return r.id;
}

export async function deleteSettingRow(client: SalesforceClient, name: string, id: string): Promise<void> {
  if (!API.test(name)) throw new Error('Choose a custom setting.');
  await client.rest('DELETE', `/sobjects/${name}/${id}`);
}

/** The org's Id (the organization level of a hierarchy setting). */
export async function orgLevelId(client: SalesforceClient): Promise<string> {
  return String((await query(client, 'SELECT Id FROM Organization')).rows[0]?.Id ?? '');
}

export type NewSettingField = { name: string; label: string; type: 'Text' | 'Number' | 'Checkbox' | 'Url' | 'Email' };
export type NewSetting = {
  name: string;
  label: string;
  kind: SettingKind;
  visibility: 'Public' | 'Protected';
  description?: string;
  fields: NewSettingField[];
};

/** The object file of a new custom setting, with its fields (Metadata API format). */
export function customSettingXml(s: NewSetting): string {
  const field = (f: NewSettingField): string =>
    `  <fields>\n    <fullName>${escapeXml(f.name)}</fullName>\n    <label>${escapeXml(f.label)}</label>\n` +
    (f.type === 'Text'
      ? '    <type>Text</type>\n    <length>255</length>\n'
      : f.type === 'Number'
      ? '    <type>Number</type>\n    <precision>18</precision>\n    <scale>2</scale>\n'
      : f.type === 'Checkbox'
      ? '    <type>Checkbox</type>\n    <defaultValue>false</defaultValue>\n'
      : `    <type>${f.type}</type>\n`) +
    '  </fields>\n';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
    `  <customSettingsType>${s.kind}</customSettingsType>\n` +
    (s.description ? `  <description>${escapeXml(s.description)}</description>\n` : '') +
    s.fields.map(field).join('') +
    `  <label>${escapeXml(s.label)}</label>\n` +
    `  <visibility>${s.visibility}</visibility>\n` +
    '</CustomObject>\n'
  );
}

/** Deploys a new custom setting with its fields. */
export async function createCustomSetting(client: SalesforceClient, s: NewSetting): Promise<void> {
  if (!API.test(s.name))
    throw new Error('The API name ends with __c, letters, digits and _ only (e.g. Billing_Settings__c).');
  if (!s.label.trim()) throw new Error('Give it a label.');
  for (const f of s.fields)
    if (!API.test(f.name)) throw new Error(`Field ${f.name || '(no name)'}: the API name ends with __c.`);
  const r = await deployFiles(client, 'CustomObject', [{ fullName: s.name, xml: customSettingXml(s) }]);
  if (!r.success) throw new Error(r.problems.join('; ') || 'The deploy failed.');
}
