import { SESSION_PLACEHOLDER, type SalesforceClient } from './client.js';
import { escapeXml, xmlBlocks, xmlValue } from './soap.js';

/** Metadata API (SOAP): describe types, list components, retrieve as a zip. */

const envelope = (body: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">
<soapenv:Header><met:SessionHeader><met:sessionId>${SESSION_PLACEHOLDER}</met:sessionId></met:SessionHeader></soapenv:Header>
<soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;

export type MetadataType = { xmlName: string; directoryName: string; inFolder: boolean; childXmlNames: string[] };

export async function describeMetadata(client: SalesforceClient): Promise<MetadataType[]> {
  const version = await client.version();
  const xml = await client.soap(
    'metadata',
    envelope(`<met:describeMetadata><met:asOfVersion>${version}</met:asOfVersion></met:describeMetadata>`)
  );
  return xmlBlocks(xml, 'metadataObjects')
    .map((block) => ({
      xmlName: xmlValue(block, 'xmlName') ?? '',
      directoryName: xmlValue(block, 'directoryName') ?? '',
      inFolder: xmlValue(block, 'inFolder') === 'true',
      childXmlNames: xmlBlocks(block, 'childXmlNames'),
    }))
    .filter((t) => t.xmlName)
    .sort((a, b) => a.xmlName.localeCompare(b.xmlName));
}

export type MetadataComponent = {
  fullName: string;
  type: string;
  fileName: string;
  lastModifiedDate?: string;
  lastModifiedByName?: string;
  manageableState?: string;
  namespacePrefix?: string;
  id?: string;
};

export function parseFileProperties(xml: string, tag = 'result'): MetadataComponent[] {
  return xmlBlocks(xml, tag).map((block) => ({
    fullName: xmlValue(block, 'fullName') ?? '',
    type: xmlValue(block, 'type') ?? '',
    fileName: xmlValue(block, 'fileName') ?? '',
    lastModifiedDate: xmlValue(block, 'lastModifiedDate'),
    lastModifiedByName: xmlValue(block, 'lastModifiedByName'),
    manageableState: xmlValue(block, 'manageableState'),
    namespacePrefix: xmlValue(block, 'namespacePrefix') || undefined,
    id: xmlValue(block, 'id') || undefined,
  }));
}

/** Folder type that holds the folders of a folder-based type (Report -> ReportFolder, EmailTemplate -> EmailFolder). */
export const folderTypeOf = (type: string): string => (type === 'EmailTemplate' ? 'EmailFolder' : `${type}Folder`);

async function listQueries(
  client: SalesforceClient,
  queries: Array<{ type: string; folder?: string }>
): Promise<MetadataComponent[]> {
  const version = await client.version();
  const out: MetadataComponent[] = [];
  // The Metadata API accepts at most 3 queries per call
  for (let i = 0; i < queries.length; i += 3) {
    const body = queries
      .slice(i, i + 3)
      .map(
        (q) =>
          `<met:queries>${q.folder ? `<met:folder>${escapeXml(q.folder)}</met:folder>` : ''}<met:type>${escapeXml(
            q.type
          )}</met:type></met:queries>`
      )
      .join('');
    // eslint-disable-next-line no-await-in-loop
    const xml = await client.soap(
      'metadata',
      envelope(`<met:listMetadata>${body}<met:asOfVersion>${version}</met:asOfVersion></met:listMetadata>`)
    );
    out.push(...parseFileProperties(xml));
  }
  return out;
}

/** Components of a type; folder-based types (reports, dashboards, documents, email templates) list every folder. */
export async function listMetadata(
  client: SalesforceClient,
  type: string,
  inFolder = false
): Promise<MetadataComponent[]> {
  if (!/^\w+$/.test(type)) throw new Error('Invalid metadata type.');
  let components: MetadataComponent[];
  if (inFolder) {
    const folders = await listQueries(client, [{ type: folderTypeOf(type) }]);
    components = [
      ...folders,
      ...(await listQueries(
        client,
        folders.map((f) => ({ type, folder: f.fullName }))
      )),
    ];
  } else {
    components = await listQueries(client, [{ type }]);
  }
  return components.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/** package.xml for the given components, grouped by type. */
export function packageXml(components: Array<Pick<MetadataComponent, 'type' | 'fullName'>>, version: string): string {
  const byType = new Map<string, Set<string>>();
  for (const c of components) {
    if (!byType.has(c.type)) byType.set(c.type, new Set());
    byType.get(c.type)!.add(c.fullName);
  }
  const types = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([type, members]) =>
        `    <types>\n${[...members]
          .sort()
          .map((m) => `        <members>${escapeXml(m)}</members>`)
          .join('\n')}\n        <name>${type}</name>\n    </types>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types}\n    <version>${version}</version>\n</Package>\n`;
}

export type RetrieveResult = {
  id: string;
  status: string;
  /** Base64 zip with package.xml and the files. */
  zipFile?: string;
  files: MetadataComponent[];
  messages: Array<{ fileName: string; problem: string }>;
  errorMessage?: string;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Retrieves components as a zip (Metadata API retrieve + checkRetrieveStatus). */
export async function retrieveZip(
  client: SalesforceClient,
  components: Array<Pick<MetadataComponent, 'type' | 'fullName'>>,
  options: { pollMs?: number; timeoutMs?: number; onProgress?: (status: string) => void } = {}
): Promise<RetrieveResult> {
  if (components.length === 0) throw new Error('Choose components to retrieve.');
  const version = await client.version();
  const types = [...new Set(components.map((c) => c.type))]
    .map(
      (type) =>
        `<met:types>${components
          .filter((c) => c.type === type)
          .map((c) => `<met:members>${escapeXml(c.fullName)}</met:members>`)
          .join('')}<met:name>${escapeXml(type)}</met:name></met:types>`
    )
    .join('');
  const started = await client.soap(
    'metadata',
    envelope(
      `<met:retrieve><met:retrieveRequest><met:apiVersion>${version}</met:apiVersion><met:singlePackage>true</met:singlePackage><met:unpackaged>${types}<met:version>${version}</met:version></met:unpackaged></met:retrieveRequest></met:retrieve>`
    )
  );
  const id = xmlValue(started, 'id');
  if (!id) throw new Error('The Metadata API did not start the retrieve.');

  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60_000);
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const xml = await client.soap(
      'metadata',
      envelope(
        `<met:checkRetrieveStatus><met:asyncProcessId>${id}</met:asyncProcessId><met:includeZip>true</met:includeZip></met:checkRetrieveStatus>`
      )
    );
    const result = xmlValue(xml, 'result') ?? '';
    const status = xmlValue(result, 'status') ?? 'Pending';
    options.onProgress?.(status);
    if (xmlValue(result, 'done') === 'true') {
      return {
        id,
        status,
        zipFile: xmlValue(result, 'zipFile'),
        files: parseFileProperties(result, 'fileProperties'),
        messages: xmlBlocks(result, 'messages').map((m) => ({
          fileName: xmlValue(m, 'fileName') ?? '',
          problem: xmlValue(m, 'problem') ?? '',
        })),
        errorMessage: xmlValue(result, 'errorMessage') || undefined,
      };
    }
    if (Date.now() > deadline) throw new Error(`Retrieve ${id} is still ${status}.`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(options.pollMs ?? 2000);
  }
}
