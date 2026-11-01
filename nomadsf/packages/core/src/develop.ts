import type { SalesforceClient } from './client.js';
import { deployZip, type DeployOutcome } from './deploy.js';
import { packageXml, retrieveZip } from './metadata.js';
import { fromBase64, makeZip, readZip, toBase64 } from './zip.js';

/**
 * Any metadata component as its files (FlexiPage, Flow, PermissionSet, Layout, a bundle…): read,
 * change and deploy them; what a component uses and what uses it; how Salesforce would run a query.
 */

export type ComponentFile = {
  /** Path inside the retrieve (flexipages/Home.flexipage, lwc/card/card.js…). */
  path: string;
  /** The text, or null for a binary file (static resources, images). */
  text: string | null;
  size: number;
};

const BINARY = /\.(zip|png|jpe?g|gif|ico|pdf|woff2?|ttf|eot|resource)$/i;

/** The files of one component, as the Metadata API returns them. */
export async function retrieveComponent(
  client: SalesforceClient,
  type: string,
  fullName: string
): Promise<ComponentFile[]> {
  if (!/^\w+$/.test(type)) throw new Error('Invalid metadata type.');
  const result = await retrieveZip(client, [{ type, fullName }], { pollMs: 1000 });
  if (!result.zipFile) throw new Error(result.errorMessage ?? `${fullName} could not be retrieved.`);
  const files = await readZip(fromBase64(result.zipFile));
  const out: ComponentFile[] = [];
  for (const [path, bytes] of files) {
    if (path.endsWith('package.xml')) continue;
    const text = BINARY.test(path) ? null : new TextDecoder().decode(bytes);
    out.push({ path, text: text !== null && text.includes('\u0000') ? null : text, size: bytes.length });
  }
  if (!out.length) throw new Error(result.messages[0]?.problem ?? `${type} ${fullName} was not found.`);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Deploys a component's files (changed text; binary files as they were retrieved are not sent,
 * so bundles with binaries are refused). `checkOnly` validates without saving.
 */
export async function deployComponent(
  client: SalesforceClient,
  type: string,
  fullName: string,
  files: ComponentFile[],
  options: { checkOnly?: boolean; onProgress?: (status: string) => void } = {}
): Promise<DeployOutcome> {
  if (!/^\w+$/.test(type)) throw new Error('Invalid metadata type.');
  if (files.some((f) => f.text === null)) throw new Error('This component has binary files: deploy it from a project.');
  if (files.some((f) => /(^|\/)\.\.(\/|$)/.test(f.path))) throw new Error('Invalid file path.');
  const version = await client.version();
  const zip = makeZip([
    { path: 'package.xml', content: packageXml([{ type, fullName }], version) },
    ...files.map((f) => ({ path: f.path, content: f.text ?? '' })),
  ]);
  return deployZip(client, toBase64(zip), {
    checkOnly: options.checkOnly,
    testLevel: 'Default',
    onProgress: options.onProgress ? (status) => options.onProgress?.(status) : undefined,
  });
}

// ---------- dependencies ----------

export type Dependency = { id: string; name: string; type: string; namespace: string };

/**
 * What a component uses and what uses it (Tooling API MetadataComponentDependency; Salesforce
 * tracks most code, flows, pages, fields and objects, not every type).
 */
export async function dependenciesOf(
  client: SalesforceClient,
  componentId: string
): Promise<{ uses: Dependency[]; usedBy: Dependency[] }> {
  if (!/^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/.test(componentId)) throw new Error('Invalid component Id.');
  type Row = Record<string, string | null>;
  const run = async (where: string): Promise<Row[]> => {
    const soql = `SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType, MetadataComponentNamespace, RefMetadataComponentId, RefMetadataComponentName, RefMetadataComponentType, RefMetadataComponentNamespace FROM MetadataComponentDependency WHERE ${where}`;
    const r = await client.tooling<{ records: Row[] }>('GET', `/query?q=${encodeURIComponent(soql)}`);
    return r.records;
  };
  const [uses, usedBy] = await Promise.all([
    run(`MetadataComponentId = '${componentId}'`),
    run(`RefMetadataComponentId = '${componentId}'`),
  ]);
  const pick =
    (prefix: '' | 'Ref') =>
    (r: Row): Dependency => ({
      id: String(r[`${prefix}MetadataComponentId`] ?? ''),
      name: String(r[`${prefix}MetadataComponentName`] ?? ''),
      type: String(r[`${prefix}MetadataComponentType`] ?? ''),
      namespace: String(r[`${prefix}MetadataComponentNamespace`] ?? ''),
    });
  const order = (a: Dependency, b: Dependency): number => a.type.localeCompare(b.type) || a.name.localeCompare(b.name);
  const out = { uses: uses.map(pick('Ref')), usedBy: usedBy.map(pick('')) };
  await nameFieldsWithObjects(client, [...out.uses, ...out.usedBy]);
  return { uses: out.uses.sort(order), usedBy: out.usedBy.sort(order) };
}

/**
 * The dependency API names a custom field without its object (Customer_Tier): this adds it (Account.Customer_Tier__c),
 * from the field's TableEnumOrId (a standard object's name, or a custom object's Id).
 */
async function nameFieldsWithObjects(client: SalesforceClient, list: Dependency[]): Promise<void> {
  const fields = list.filter((d) => d.type === 'CustomField' && /^[a-zA-Z0-9]{15,18}$/.test(d.id));
  if (!fields.length) return;
  const ids = [...new Set(fields.map((d) => d.id))].slice(0, 200);
  type Row = Record<string, string | null>;
  const toolingQuery = async (soql: string): Promise<Row[]> =>
    (await client.tooling<{ records: Row[] }>('GET', `/query?q=${encodeURIComponent(soql)}`)).records;
  try {
    const rows = await toolingQuery(
      `SELECT Id, DeveloperName, NamespacePrefix, TableEnumOrId FROM CustomField WHERE Id IN ('${ids.join("','")}')`
    );
    const objectIds = [...new Set(rows.map((r) => String(r.TableEnumOrId ?? '')).filter((t) => /^01I/.test(t)))];
    const objects = new Map<string, string>();
    if (objectIds.length)
      for (const o of await toolingQuery(
        `SELECT Id, DeveloperName, NamespacePrefix FROM CustomObject WHERE Id IN ('${objectIds.join("','")}')`
      ))
        objects.set(
          String(o.Id).slice(0, 15),
          `${o.NamespacePrefix ? `${o.NamespacePrefix}__` : ''}${o.DeveloperName}__c`
        );
    const byId = new Map(rows.map((r) => [String(r.Id).slice(0, 15), r]));
    for (const d of fields) {
      const r = byId.get(d.id.slice(0, 15));
      if (!r) continue;
      const table = String(r.TableEnumOrId ?? '');
      const object = objects.get(table.slice(0, 15)) ?? (/^01I/.test(table) ? '' : table);
      const field = `${r.NamespacePrefix ? `${r.NamespacePrefix}__` : ''}${r.DeveloperName}__c`;
      if (object) d.name = `${object}.${field}`;
    }
  } catch {
    // Names stay as the dependency API gives them
  }
}

// ---------- query plan ----------

export type QueryPlan = {
  /** How Salesforce would start: Index, TableScan, Sharing, Other. */
  leadingOperationType: string;
  relativeCost: number;
  cardinality: number;
  sobjectCardinality: number;
  sobjectType: string;
  fields: string[];
  notes: Array<{ description: string; fields: string[]; tableEnumOrId: string }>;
};

/** The plans Salesforce considers for a query, cheapest first (REST explain). Relative cost above 1 is slow. */
export async function explainQuery(client: SalesforceClient, soql: string): Promise<QueryPlan[]> {
  if (!soql.trim()) throw new Error('Write a query first.');
  const r = await client.rest<{ plans: QueryPlan[] }>('GET', `/query?explain=${encodeURIComponent(soql.trim())}`);
  return [...r.plans].sort((a, b) => a.relativeCost - b.relativeCost);
}
