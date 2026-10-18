import type { SalesforceClient } from './client.js';
import { query } from './query.js';

/**
 * Developer Console-style source editing through the Tooling API: Apex classes, triggers and
 * Visualforce pages/components are compiled and saved in a MetadataContainer; LWC and Aura
 * bundle files are saved one by one.
 */

export type CodeKind = 'ApexClass' | 'ApexTrigger' | 'ApexPage' | 'ApexComponent' | 'LWC' | 'Aura';
/** Kinds saved through a MetadataContainer (one body each). */
export type ContainerKind = 'ApexClass' | 'ApexTrigger' | 'ApexPage' | 'ApexComponent';
export const isBundle = (kind: CodeKind): kind is 'LWC' | 'Aura' => kind === 'LWC' || kind === 'Aura';
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
    ApexPage: 'SELECT Id, Name, ApiVersion, LastModifiedDate FROM ApexPage WHERE NamespacePrefix = null ORDER BY Name',
    ApexComponent:
      'SELECT Id, Name, ApiVersion, LastModifiedDate FROM ApexComponent WHERE NamespacePrefix = null ORDER BY Name',
    LWC: 'SELECT Id, DeveloperName, ApiVersion, LastModifiedDate FROM LightningComponentBundle WHERE NamespacePrefix = null ORDER BY DeveloperName',
    Aura: 'SELECT Id, DeveloperName, ApiVersion, LastModifiedDate FROM AuraDefinitionBundle WHERE NamespacePrefix = null ORDER BY DeveloperName',
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

/** File name of an Aura definition from its type (COMPONENT -> name.cmp, CONTROLLER -> nameController.js…). */
const AURA_FILES: Record<string, [string, CodeFile['language']]> = {
  APPLICATION: ['.app', 'html'],
  COMPONENT: ['.cmp', 'html'],
  EVENT: ['.evt', 'html'],
  INTERFACE: ['.intf', 'html'],
  CONTROLLER: ['Controller.js', 'javascript'],
  HELPER: ['Helper.js', 'javascript'],
  RENDERER: ['Renderer.js', 'javascript'],
  STYLE: ['.css', 'css'],
  DOCUMENTATION: ['.auradoc', 'html'],
  DESIGN: ['.design', 'xml'],
  SVG: ['.svg', 'xml'],
  TOKENS: ['.tokens', 'xml'],
};

/** Source files of an item: one body (Apex, Visualforce), or every file of an LWC / Aura bundle. */
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
  if (item.kind === 'Aura') {
    const result = await query(
      client,
      `SELECT Id, DefType, Source FROM AuraDefinition WHERE AuraDefinitionBundleId = '${item.id}' ORDER BY DefType`,
      { tooling: true }
    );
    return result.rows.map((r) => {
      const [suffix, language] = AURA_FILES[String(r.DefType)] ?? [`.${String(r.DefType).toLowerCase()}`, 'html'];
      return {
        id: String(r.Id),
        path: `aura/${item.name}/${item.name}${suffix}`,
        language,
        source: String(r.Source ?? ''),
      };
    });
  }
  if (item.kind === 'ApexPage' || item.kind === 'ApexComponent') {
    const markup = (await client.tooling<{ Markup: string }>('GET', `/sobjects/${item.kind}/${item.id}`)).Markup;
    return [
      {
        id: item.id,
        path: `${item.name}.${item.kind === 'ApexPage' ? 'page' : 'component'}`,
        language: 'html',
        source: markup,
      },
    ];
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
/** Was the class / trigger / page saved in the org after `since` (a timestamp)? */
async function savedSince(
  client: SalesforceClient,
  item: Pick<CodeItem, 'id' | 'kind'>,
  since: number
): Promise<boolean> {
  try {
    const row = await client.tooling<{ LastModifiedDate?: string }>(
      'GET',
      `/sobjects/${item.kind}/${item.id}?fields=LastModifiedDate`
    );
    return Boolean(row.LastModifiedDate) && Date.parse(row.LastModifiedDate!) >= since - 5000;
  } catch {
    return false;
  }
}

export async function saveApex(
  client: SalesforceClient,
  item: Pick<CodeItem, 'id' | 'kind'>,
  body: string,
  options: { checkOnly?: boolean; intervalMs?: number; timeoutMs?: number; onWait?: (seconds: number) => void } = {}
): Promise<SaveResult> {
  if (isBundle(item.kind)) throw new Error('Use saveBundleFile for LWC and Aura.');
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
    const started = Date.now();
    const until = started + (options.timeoutMs ?? 120_000);
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const state = await client.tooling<ContainerRequest>(
        'GET',
        `/sobjects/ContainerAsyncRequest/${request.id}?t=${Date.now()}`
      );
      options.onWait?.(Math.round((Date.now() - started) / 1000));
      // Queued is the only state that is still running; Invalidated, Error, Aborted are final
      if (state.State !== 'Queued') {
        const problems = (state.DeployDetails?.componentFailures ?? []).map((f) => ({
          line: f.lineNumber,
          column: f.columnNumber,
          problem: f.problem,
          name: f.fullName,
        }));
        if (state.ErrorMsg && problems.length === 0)
          problems.push({ problem: state.ErrorMsg, line: undefined, column: undefined, name: undefined });
        if (state.State === 'Invalidated' && problems.length === 0)
          problems.push({
            problem: 'Salesforce dropped this save because the class changed meanwhile; save again.',
            line: undefined,
            column: undefined,
            name: undefined,
          });
        return { ok: state.State === 'Completed', state: state.State, problems };
      }
      if (Date.now() > until) {
        // Salesforce may have finished without telling us yet: was the class saved after we started?
        if (!options.checkOnly && (await savedSince(client, item, started)))
          return { ok: true, state: 'Completed', problems: [] };
        return {
          ok: false,
          state: 'Timeout',
          problems: [{ problem: 'Still compiling after 2 minutes; check the class in the org.' }],
        };
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
    }
  } finally {
    await client.tooling('DELETE', `/sobjects/MetadataContainer/${container.id}`).catch(() => undefined);
  }
}

/** Saves one file of an LWC bundle. */
/** Saves one file of an LWC or Aura bundle (Salesforce compiles the bundle on save). */
export async function saveBundleFile(
  client: SalesforceClient,
  kind: 'LWC' | 'Aura',
  fileId: string,
  source: string
): Promise<void> {
  if (!SAFE_ID.test(fileId)) throw new Error('Invalid Id.');
  const sobject = kind === 'LWC' ? 'LightningComponentResource' : 'AuraDefinition';
  await client.tooling('PATCH', `/sobjects/${sobject}/${fileId}`, { Source: source });
}

/** @deprecated use saveBundleFile(client, 'LWC', …) */
export const saveLwcFile = (client: SalesforceClient, fileId: string, source: string): Promise<void> =>
  saveBundleFile(client, 'LWC', fileId, source);

// ---------- creating new code ----------

/** Names Salesforce accepts for Apex, Visualforce and Aura (letters, digits, single underscores). */
const API_NAME = /^[A-Za-z](?:[A-Za-z0-9]|_(?!_))*$/;
/** LWC folder names start lowercase (camelCase). */
const LWC_NAME = /^[a-z](?:[A-Za-z0-9]|_(?!_))*$/;

export function checkCodeName(kind: CodeKind, name: string): string {
  const value = name.trim();
  const ok = (kind === 'LWC' ? LWC_NAME : API_NAME).test(value) && value.length <= 40 && !value.endsWith('_');
  if (!ok) {
    throw new Error(
      kind === 'LWC'
        ? 'LWC names start with a lowercase letter: letters, digits and single underscores (e.g. accountCard).'
        : 'Use letters, digits and single underscores, starting with a letter (max 40).'
    );
  }
  return value;
}

export const newClassTemplate = (name: string): string =>
  `public with sharing class ${name} {\n    public ${name}() {\n\n    }\n}\n`;

/** Creates an Apex class from its body (the class name comes from the body). */
export async function createApexClass(client: SalesforceClient, body: string): Promise<string> {
  if (!/\bclass\s+\w+/i.test(body)) throw new Error('The body must declare a class.');
  return (await client.tooling<{ id: string }>('POST', '/sobjects/ApexClass', { Body: body })).id;
}

export type NewCode = { kind: CodeKind; name: string; /** Trigger: the object it runs on. */ sobject?: string };

/** Starter source for each kind, as created by createCode. */
export function codeTemplate(kind: CodeKind, name: string, sobject = ''): Record<string, string> {
  switch (kind) {
    case 'ApexClass':
      return { body: newClassTemplate(name) };
    case 'ApexTrigger':
      return { body: `trigger ${name} on ${sobject} (before insert) {\n\n}\n` };
    case 'ApexPage':
      return { markup: '<apex:page>\n    <h1>' + name + '</h1>\n</apex:page>\n' };
    case 'ApexComponent':
      return { markup: '<apex:component>\n\n</apex:component>\n' };
    case 'LWC': {
      const className = name.charAt(0).toUpperCase() + name.slice(1);
      return {
        js: `import { LightningElement } from 'lwc';\n\nexport default class ${className} extends LightningElement {}\n`,
        html: '<template>\n    <lightning-card title="' + name + '"></lightning-card>\n</template>\n',
      };
    }
    case 'Aura':
      return {
        cmp: '<aura:component implements="flexipage:availableForAllPageTypes">\n\n</aura:component>\n',
        controller: '({\n    init: function (component, event, helper) {}\n})\n',
      };
  }
}

/**
 * Creates a new class, trigger, Visualforce page or component, LWC or Aura bundle from a
 * starter template. Returns the new item (open it with openCode).
 */
export async function createCode(client: SalesforceClient, request: NewCode): Promise<CodeItem> {
  const name = checkCodeName(request.kind, request.name);
  const sobject = (request.sobject ?? '').trim();
  const t = codeTemplate(request.kind, name, sobject);
  const create = async (sobjectName: string, fields: Record<string, unknown>): Promise<string> =>
    (await client.tooling<{ id: string }>('POST', `/sobjects/${sobjectName}`, fields)).id;
  const version = Number(await client.version());
  let id: string;
  switch (request.kind) {
    case 'ApexClass':
      id = await create('ApexClass', { Body: t.body });
      break;
    case 'ApexTrigger':
      if (!/^\w+$/.test(sobject)) throw new Error('Choose the object the trigger runs on (e.g. Account).');
      id = await create('ApexTrigger', { Name: name, TableEnumOrId: sobject, Body: t.body });
      break;
    case 'ApexPage':
    case 'ApexComponent':
      id = await create(request.kind, { Name: name, MasterLabel: name, Markup: t.markup, ApiVersion: version });
      break;
    case 'LWC':
      id = await create('LightningComponentBundle', {
        FullName: name,
        Metadata: {
          apiVersion: version,
          isExposed: true,
          masterLabel: name,
          targets: { target: ['lightning__RecordPage', 'lightning__AppPage', 'lightning__HomePage'] },
        },
      });
      await create('LightningComponentResource', {
        LightningComponentBundleId: id,
        FilePath: `lwc/${name}/${name}.js`,
        Format: 'js',
        Source: t.js,
      });
      await create('LightningComponentResource', {
        LightningComponentBundleId: id,
        FilePath: `lwc/${name}/${name}.html`,
        Format: 'html',
        Source: t.html,
      });
      break;
    case 'Aura':
      id = await create('AuraDefinitionBundle', {
        DeveloperName: name,
        MasterLabel: name,
        ApiVersion: version,
        Description: name,
      });
      await create('AuraDefinition', {
        AuraDefinitionBundleId: id,
        DefType: 'COMPONENT',
        Format: 'XML',
        Source: t.cmp,
      });
      await create('AuraDefinition', {
        AuraDefinitionBundleId: id,
        DefType: 'CONTROLLER',
        Format: 'JS',
        Source: t.controller,
      });
      break;
  }
  return { id, name, kind: request.kind };
}
