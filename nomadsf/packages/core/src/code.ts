import type { SalesforceClient } from './client.js';
import { query } from './query.js';

/**
 * Developer Console-style source editing through the Tooling API: Apex classes and triggers
 * are compiled and saved in a MetadataContainer; LWC files are saved as resources.
 */

export type CodeKind = 'ApexClass' | 'ApexTrigger' | 'LWC';
export type CodeItem = { id: string; name: string; kind: CodeKind; lastModified?: string; apiVersion?: string };
export type CodeFile = {
  id: string;
  path: string;
  language: 'apex' | 'javascript' | 'html' | 'css' | 'xml' | 'json';
  source: string;
};

const SAFE_ID = /^\w{15,18}$/;

export async function listCode(client: SalesforceClient, kind: CodeKind): Promise<CodeItem[]> {
  const soql = {
    ApexClass:
      'SELECT Id, Name, ApiVersion, LastModifiedDate FROM ApexClass WHERE NamespacePrefix = null ORDER BY Name',
    ApexTrigger:
      'SELECT Id, Name, ApiVersion, LastModifiedDate FROM ApexTrigger WHERE NamespacePrefix = null ORDER BY Name',
    LWC: 'SELECT Id, DeveloperName, ApiVersion, LastModifiedDate FROM LightningComponentBundle WHERE NamespacePrefix = null ORDER BY DeveloperName',
  }[kind];
  const result = await query(client, soql, { tooling: true, maxRows: 5000 });
  return result.rows.map((r) => ({
    id: String(r.Id),
    name: String(r.Name ?? r.DeveloperName),
    kind,
    apiVersion: r.ApiVersion === undefined ? undefined : String(r.ApiVersion),
    lastModified: r.LastModifiedDate ? String(r.LastModifiedDate) : undefined,
  }));
}

const LANGUAGE: Record<string, CodeFile['language']> = {
  js: 'javascript',
  html: 'html',
  css: 'css',
  xml: 'xml',
  json: 'json',
};

/** Source files of an item: one Apex body, or every file of an LWC bundle. */
export async function openCode(
  client: SalesforceClient,
  item: Pick<CodeItem, 'id' | 'kind' | 'name'>
): Promise<CodeFile[]> {
  if (!SAFE_ID.test(item.id)) throw new Error('Invalid Id.');
  if (item.kind === 'LWC') {
    const result = await query(
      client,
      `SELECT Id, FilePath, Format, Source FROM LightningComponentResource WHERE LightningComponentBundleId = '${item.id}' ORDER BY FilePath`,
      { tooling: true }
    );
    return result.rows.map((r) => {
      const path = String(r.FilePath);
      return {
        id: String(r.Id),
        path,
        language: LANGUAGE[path.split('.').pop() ?? ''] ?? 'javascript',
        source: String(r.Source ?? ''),
      };
    });
  }
  const body = (await client.tooling<{ Body: string }>('GET', `/sobjects/${item.kind}/${item.id}`)).Body;
  return [
    {
      id: item.id,
      path: `${item.name}.${item.kind === 'ApexClass' ? 'cls' : 'trigger'}`,
      language: 'apex',
      source: body,
    },
  ];
}

export type CompileProblem = { line?: number; column?: number; problem: string; name?: string };
export type SaveResult = { ok: boolean; state: string; problems: CompileProblem[] };

type ContainerRequest = {
  State: string;
  ErrorMsg?: string | null;
  DeployDetails?: {
    componentFailures?: Array<{ lineNumber?: number; columnNumber?: number; problem: string; fullName?: string }>;
  } | null;
};

/**
 * Compiles (and with `checkOnly: false` saves) an Apex class or trigger, like the Developer
 * Console: MetadataContainer + member + ContainerAsyncRequest, polled until done.
 */
export async function saveApex(
  client: SalesforceClient,
  item: Pick<CodeItem, 'id' | 'kind'>,
  body: string,
  options: { checkOnly?: boolean; intervalMs?: number; timeoutMs?: number } = {}
): Promise<SaveResult> {
  if (item.kind === 'LWC') throw new Error('Use saveLwcFile for LWC.');
  if (!SAFE_ID.test(item.id)) throw new Error('Invalid Id.');
  const container = await client.tooling<{ id: string }>('POST', '/sobjects/MetadataContainer', {
    Name: `NomadSF${Date.now()}`.slice(0, 32),
  });
  try {
    await client.tooling('POST', `/sobjects/${item.kind}Member`, {
      MetadataContainerId: container.id,
      ContentEntityId: item.id,
      Body: body,
    });
    const request = await client.tooling<{ id: string }>('POST', '/sobjects/ContainerAsyncRequest', {
      MetadataContainerId: container.id,
      IsCheckOnly: options.checkOnly ?? false,
    });
    const until = Date.now() + (options.timeoutMs ?? 120_000);
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const state = await client.tooling<ContainerRequest>('GET', `/sobjects/ContainerAsyncRequest/${request.id}`);
      if (state.State !== 'Queued' && state.State !== 'Invalidated') {
        const problems = (state.DeployDetails?.componentFailures ?? []).map((f) => ({
          line: f.lineNumber,
          column: f.columnNumber,
          problem: f.problem,
          name: f.fullName,
        }));
        if (state.ErrorMsg && problems.length === 0)
          problems.push({ problem: state.ErrorMsg, line: undefined, column: undefined, name: undefined });
        return { ok: state.State === 'Completed', state: state.State, problems };
      }
      if (Date.now() > until)
        return { ok: false, state: 'Timeout', problems: [{ problem: 'Still compiling; check again later.' }] };
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
    }
  } finally {
    await client.tooling('DELETE', `/sobjects/MetadataContainer/${container.id}`).catch(() => undefined);
  }
}

/** Saves one file of an LWC bundle. */
export async function saveLwcFile(client: SalesforceClient, fileId: string, source: string): Promise<void> {
  if (!SAFE_ID.test(fileId)) throw new Error('Invalid Id.');
  await client.tooling('PATCH', `/sobjects/LightningComponentResource/${fileId}`, { Source: source });
}

/** Creates an Apex class from its body (the class name comes from the body). */
export async function createApexClass(client: SalesforceClient, body: string): Promise<string> {
  if (!/\bclass\s+\w+/i.test(body)) throw new Error('The body must declare a class.');
  return (await client.tooling<{ id: string }>('POST', '/sobjects/ApexClass', { Body: body })).id;
}

export const newClassTemplate = (name: string): string =>
  `public with sharing class ${name} {\n    public ${name}() {\n\n    }\n}\n`;
