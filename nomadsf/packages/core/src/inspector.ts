import type { HttpRequest, SalesforceClient } from './client.js';
import { describeGlobal } from './query.js';

/**
 * Salesforce Inspector-style tools: every field of a record with inline edit,
 * org limits, a REST explorer and "login as" links.
 */

export type RecordField = {
  name: string;
  label: string;
  type: string;
  value: unknown;
  updateable: boolean;
  nillable: boolean;
  calculated: boolean;
  referenceTo: string[];
  length?: number;
  picklistValues: string[];
};

export type InspectedRecord = {
  id: string;
  sobject: string;
  label: string;
  name?: string;
  fields: RecordField[];
};

const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

/** Finds a record Id in a pasted value: an Id, a Lightning or Classic URL. */
export function extractRecordId(input: string): string | undefined {
  const text = input.trim();
  if (ID.test(text)) return text;
  const fromUrl =
    /\/lightning\/r\/\w+\/([a-zA-Z0-9]{15,18})\b/.exec(text)?.[1] ??
    /[?&](?:id|Id)=([a-zA-Z0-9]{15,18})\b/.exec(text)?.[1] ??
    /\.com\/([a-zA-Z0-9]{15,18})(?:[/?#]|$)/.exec(text)?.[1];
  return fromUrl && ID.test(fromUrl) ? fromUrl : undefined;
}

let prefixCache: { client: SalesforceClient; map: Promise<Map<string, string>> } | undefined;

/** sObject name for an Id, from its 3-character key prefix. */
export async function sobjectForId(client: SalesforceClient, id: string): Promise<string> {
  if (prefixCache?.client !== client) {
    prefixCache = {
      client,
      map: describeGlobal(client).then(
        (list) => new Map(list.filter((s) => s.keyPrefix).map((s) => [s.keyPrefix!, s.name]))
      ),
    };
  }
  const name = (await prefixCache.map).get(id.slice(0, 3));
  if (!name) throw new Error(`No queryable object has the key prefix ${id.slice(0, 3)}.`);
  return name;
}

type RawField = {
  name: string;
  label: string;
  type: string;
  updateable: boolean;
  nillable: boolean;
  calculated: boolean;
  referenceTo?: string[];
  length?: number;
  picklistValues?: Array<{ value: string; active: boolean }>;
  nameField?: boolean;
};

export async function inspectRecord(client: SalesforceClient, input: string): Promise<InspectedRecord> {
  const id = extractRecordId(input);
  if (!id) throw new Error('Paste a record Id or a record URL.');
  const sobject = await sobjectForId(client, id);
  const describe = await client.rest<{ label: string; fields: RawField[] }>('GET', `/sobjects/${sobject}/describe`);
  const record = await client.rest<Record<string, unknown>>('GET', `/sobjects/${sobject}/${id}`);
  const nameField = describe.fields.find((f) => f.nameField)?.name;
  return {
    id: String(record.Id ?? id),
    sobject,
    label: describe.label,
    name: nameField ? String(record[nameField] ?? '') : undefined,
    fields: describe.fields
      .map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        value: record[f.name] ?? null,
        updateable: f.updateable,
        nillable: f.nillable,
        calculated: f.calculated,
        referenceTo: f.referenceTo ?? [],
        length: f.length || undefined,
        picklistValues: (f.picklistValues ?? []).filter((p) => p.active).map((p) => p.value),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

const NUMERIC = new Set(['int', 'double', 'currency', 'percent', 'long']);

/** Converts edited text to the value the REST API expects for the field type. */
export function coerceFieldValue(field: Pick<RecordField, 'type' | 'name'>, text: string): unknown {
  const value = text.trim();
  if (value === '') return null;
  if (field.type === 'boolean') {
    if (!/^(true|false)$/i.test(value)) throw new Error(`${field.name}: use true or false.`);
    return value.toLowerCase() === 'true';
  }
  if (NUMERIC.has(field.type)) {
    const number = Number(value);
    if (Number.isNaN(number)) throw new Error(`${field.name}: not a number.`);
    return number;
  }
  if (field.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field.name}: use YYYY-MM-DD.`);
  return text;
}

/** Saves only the changed fields (PATCH). */
export async function updateRecord(
  client: SalesforceClient,
  sobject: string,
  id: string,
  changes: Record<string, unknown>
): Promise<void> {
  if (!/^\w+$/.test(sobject) || !ID.test(id)) throw new Error('Invalid record.');
  if (Object.keys(changes).length === 0) throw new Error('Nothing changed.');
  await client.rest('PATCH', `/sobjects/${sobject}/${id}`, changes);
}

// ---------- org limits ----------

export type OrgLimit = { name: string; max: number; remaining: number; used: number; percent: number };

export async function orgLimits(client: SalesforceClient): Promise<OrgLimit[]> {
  const raw = await client.rest<Record<string, { Max: number; Remaining: number }>>('GET', '/limits');
  return Object.entries(raw)
    .map(([name, l]) => {
      const used = Math.max(0, l.Max - l.Remaining);
      return {
        name,
        max: l.Max,
        remaining: l.Remaining,
        used,
        percent: l.Max ? Math.round((used / l.Max) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.percent - a.percent || a.name.localeCompare(b.name));
}

// ---------- REST explorer ----------

export type RestCall = { method: HttpRequest['method']; path: string; body?: string };
export type RestAnswer = { status: number; headers: Record<string, string>; body: string; durationMs: number };

/** Any call under /services/ (version placeholder `vXX.X` filled with the org's latest). */
export async function restExplorer(client: SalesforceClient, call: RestCall): Promise<RestAnswer> {
  let path = call.path.trim();
  if (!path.startsWith('/')) path = `/${path}`;
  if (!path.startsWith('/services/')) path = `/services/data/vXX.X${path}`;
  path = path.replace('vXX.X', `v${await client.version()}`);
  const started = Date.now();
  // raw() throws on errors; the explorer shows error answers instead
  try {
    const response = await client.raw({
      method: call.method,
      path,
      headers: call.body ? { 'content-type': 'application/json' } : {},
      body: call.method === 'GET' ? undefined : call.body || undefined,
    });
    return { ...response, durationMs: Date.now() - started };
  } catch (e) {
    const error = e as Error & { status?: number };
    return { status: error.status ?? 0, headers: {}, body: error.message, durationMs: Date.now() - started };
  }
}

// ---------- login as ----------

/** Setup URL that logs an administrator in as another user (needs "Login as any user" or a grant). */
export function loginAsPath(organizationId: string, userId: string, retUrl = '/'): string {
  if (!ID.test(organizationId) || !ID.test(userId)) throw new Error('Invalid org or user Id.');
  const params = new URLSearchParams({
    oid: organizationId,
    suorgadminid: userId,
    retURL: retUrl,
    targetURL: '/home/home.jsp',
  });
  return `/servlet/servlet.su?${params.toString()}`;
}
