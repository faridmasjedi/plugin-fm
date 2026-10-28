import type { SalesforceClient } from './client.js';
import { query, type Row } from './query.js';

/**
 * What an org is (company information), how full it is (storage by object), and the details of
 * a connected app; OAuth tokens can be revoked.
 */

const ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

export type InfoField = { group: string; label: string; name: string; value: string };

const GROUPS: Array<[RegExp, string]> = [
  [
    /^(Name|Division|Street|City|State|PostalCode|Country|Address|Phone|Fax|PrimaryContact|Latitude|Longitude|GeocodeAccuracy)$/,
    'Company',
  ],
  [
    /^(Id|OrganizationType|InstanceName|IsSandbox|TrialExpirationDate|NamespacePrefix|CreatedDate|CreatedById|LastModifiedDate|LastModifiedById|SystemModstamp|IsReadOnly)$/,
    'Org',
  ],
  [
    /(Locale|Language|TimeZone|Currency|Fiscal|UsesStartDate|NumKnowledgeService|MonthlyPageViews)/,
    'Locale and fiscal year',
  ],
  [/^(Default|Preferences|Receives|Complianc)/, 'Defaults and preferences'],
];

/** Group order: the known ones first, "Other" last. */
const rank = (group: string): number => {
  const i = GROUPS.findIndex((g) => g[1] === group);
  return i < 0 ? GROUPS.length : i;
};

/** Every field of the Organization record, grouped, with labels. */
export async function companyInformation(client: SalesforceClient): Promise<InfoField[]> {
  const describe = await client.rest<{ fields: Array<{ name: string; label: string; type: string }> }>(
    'GET',
    '/sobjects/Organization/describe'
  );
  const fields = describe.fields.filter((f) => !['address', 'location', 'base64'].includes(f.type));
  const row: Row =
    (await query(client, `SELECT ${fields.map((f) => f.name).join(', ')} FROM Organization LIMIT 1`)).rows[0] ?? {};
  return fields
    .map((f) => ({
      group: GROUPS.find(([pattern]) => pattern.test(f.name))?.[1] ?? 'Other',
      label: f.label,
      name: f.name,
      value: row[f.name] === null || row[f.name] === undefined ? '' : String(row[f.name]),
    }))
    .sort((a, b) => rank(a.group) - rank(b.group));
}

export type StorageRow = { object: string; records: number; estimatedMB: number };
export type StorageReport = {
  dataMB: { used: number; max: number };
  fileMB: { used: number; max: number };
  objects: StorageRow[];
};

/**
 * How full the org is: data and file storage (limits), and records per object. Salesforce counts
 * most records as 2 KB, so the MB per object is an estimate (Setup › Storage Usage has the exact one).
 */
export async function storageReport(client: SalesforceClient): Promise<StorageReport> {
  const [limits, counts, global] = await Promise.all([
    client.rest<Record<string, { Max: number; Remaining: number }>>('GET', '/limits'),
    client.rest<{ sObjects: Array<{ name: string; count: number }> }>('GET', '/limits/recordCount'),
    client.rest<{ sobjects: Array<{ name: string; layoutable: boolean; customSetting: boolean }> }>('GET', '/sobjects'),
  ]);
  // Records people work with (objects with page layouts); setup rows such as FieldPermissions use no data storage
  const records = new Set(global.sobjects.filter((o) => o.layoutable && !o.customSetting).map((o) => o.name));
  const usage = (key: string): { used: number; max: number } => {
    const l = limits[key];
    return l ? { used: l.Max - l.Remaining, max: l.Max } : { used: 0, max: 0 };
  };
  return {
    dataMB: usage('DataStorageMB'),
    fileMB: usage('FileStorageMB'),
    objects: counts.sObjects
      .filter((o) => o.count > 0 && records.has(o.name))
      .map((o) => ({ object: o.name, records: o.count, estimatedMB: Math.round(((o.count * 2) / 1024) * 10) / 10 }))
      .sort((a, b) => b.records - a.records),
  };
}

/** A SOQL filter for records created in a period: from (inclusive) and to (exclusive), YYYY-MM-DD. */
export function createdBetween(from?: string, to?: string): string {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const parts: string[] = [];
  if (from) {
    if (!day.test(from)) throw new Error('From: use YYYY-MM-DD.');
    parts.push(`CreatedDate >= ${from}T00:00:00Z`);
  }
  if (to) {
    if (!day.test(to)) throw new Error('To: use YYYY-MM-DD.');
    parts.push(`CreatedDate < ${to}T00:00:00Z`);
  }
  return parts.join(' AND ');
}

/** How many records of an object were created in a period (no dates: all of them). */
export async function countCreated(
  client: SalesforceClient,
  sobject: string,
  from?: string,
  to?: string
): Promise<number> {
  if (!/^\w+$/.test(sobject)) throw new Error('Invalid object.');
  const where = createdBetween(from, to);
  return (await query(client, `SELECT COUNT() FROM ${sobject}${where ? ` WHERE ${where}` : ''}`)).totalSize;
}

// ---------- connected apps ----------

/** A connected app's settings that matter for access (the fields this org lets us read). */
export async function connectedAppDetails(client: SalesforceClient, appId: string): Promise<Row> {
  if (!ID.test(appId)) throw new Error('Invalid app Id.');
  const describe = await client.rest<{ fields: Array<{ name: string; type: string }> }>(
    'GET',
    '/sobjects/ConnectedApplication/describe'
  );
  const names = describe.fields.filter((f) => !['base64', 'address'].includes(f.type)).map((f) => f.name);
  const row = (await query(client, `SELECT ${names.join(', ')} FROM ConnectedApplication WHERE Id = '${appId}'`))
    .rows[0];
  return row ?? {};
}

/** Revokes OAuth tokens (the user has to connect the app again). */
export async function revokeTokens(client: SalesforceClient, tokenIds: string[]): Promise<void> {
  for (const id of tokenIds) {
    if (!ID.test(id)) throw new Error('Invalid token Id.');
    // eslint-disable-next-line no-await-in-loop
    await client.rest('DELETE', `/sobjects/OauthToken/${id}`);
  }
}
