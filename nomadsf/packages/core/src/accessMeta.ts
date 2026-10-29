import type { SalesforceClient } from './client.js';
import { deployZip } from './deploy.js';
import { packageXml, retrieveZip } from './metadata.js';
import { query, soqlText } from './query.js';
import { escapeXml, xmlBlocks, xmlValue } from './soap.js';
import { fromBase64, makeZip, readZip, toBase64 } from './zip.js';

/**
 * Access settings that only the Metadata API can change: record type visibility (profiles and
 * permission sets), page layout assignments (profiles), new custom permissions, and clones of a
 * profile or permission set. Profiles are read in one Tooling API call (their Metadata field);
 * a permission set is retrieved as its file, which holds everything it grants.
 */

const ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
const check = (id: string, prefix: string, what: string): string => {
  if (!ID.test(id) || !id.startsWith(prefix)) throw new Error(`Invalid ${what} Id.`);
  return id;
};

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };
export type MetadataJson = { [key: string]: Json };

/** Metadata as the Tooling API returns it (JSON) to the XML the Metadata API deploys; elements in name order. */
export function metadataToXml(type: string, metadata: MetadataJson): string {
  const value = (v: Json): string => (typeof v === 'string' ? escapeXml(v) : String(v));
  const element = (name: string, v: Json, indent: string): string => {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.map((item) => element(name, item, indent)).join('');
    if (typeof v === 'object') {
      const inner = Object.keys(v)
        .sort()
        .map((k) => element(k, v[k], `${indent}    `))
        .join('');
      return inner ? `${indent}<${name}>\n${inner}${indent}</${name}>\n` : '';
    }
    return `${indent}<${name}>${value(v)}</${name}>\n`;
  };
  const body = Object.keys(metadata)
    .filter((k) => k !== 'fullName' && k !== 'urls')
    .sort()
    .map((k) => element(k, metadata[k], '    '))
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<${type} xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}</${type}>\n`;
}

const FOLDERS: Record<string, [string, string]> = {
  Profile: ['profiles', 'profile'],
  PermissionSet: ['permissionsets', 'permissionset'],
  PermissionSetGroup: ['permissionsetgroups', 'permissionsetgroup'],
  CustomPermission: ['customPermissions', 'customPermission'],
};

/** Deploys whole files of one type (test level Default: none without Apex, allowed in production). */
export async function deployFiles(
  client: SalesforceClient,
  type: keyof typeof FOLDERS,
  files: Array<{ fullName: string; xml: string }>
): Promise<{ success: boolean; problems: string[] }> {
  const [folder, suffix] = FOLDERS[type];
  const version = await client.version();
  const zip = makeZip([
    {
      path: 'package.xml',
      content: packageXml(
        files.map((f) => ({ type, fullName: f.fullName })),
        version
      ),
    },
    ...files.map((f) => ({ path: `${folder}/${f.fullName}.${suffix}`, content: f.xml })),
  ]);
  const outcome = await deployZip(client, toBase64(zip), { testLevel: 'Default' });
  return {
    success: outcome.success,
    problems: [
      ...outcome.componentFailures.map((f) => `${f.name}: ${f.problem}`),
      ...(outcome.errorMessage ? [outcome.errorMessage] : []),
    ],
  };
}

const failed = (r: { success: boolean; problems: string[] }): void => {
  if (!r.success) throw new Error(r.problems.join('; ') || 'The deploy failed.');
};

/** A profile's settings in one Tooling call: its Metadata API name and its Metadata. */
export async function profileMetadata(
  client: SalesforceClient,
  profileId: string
): Promise<{ fullName: string; metadata: MetadataJson }> {
  check(profileId, '00e', 'profile');
  const r = await client.tooling<{ records: Array<{ FullName: string; Metadata: MetadataJson }> }>(
    'GET',
    `/query?q=${encodeURIComponent(`SELECT FullName, Metadata FROM Profile WHERE Id = '${profileId}'`)}`
  );
  const row = r.records[0];
  if (!row) throw new Error('Profile not found.');
  return { fullName: row.FullName, metadata: row.Metadata };
}

/** One file of a component, as the Metadata API returns it. */
export async function retrieveFile(client: SalesforceClient, type: string, fullName: string): Promise<string> {
  const result = await retrieveZip(client, [{ type, fullName }], { pollMs: 1000 });
  if (!result.zipFile) throw new Error(result.errorMessage ?? `${fullName} could not be retrieved.`);
  const problem = result.messages[0]?.problem;
  const files = await readZip(fromBase64(result.zipFile));
  const file = [...files.entries()].find(([path]) => !path.endsWith('package.xml'));
  if (!file) throw new Error(problem ?? `${fullName} was not in the retrieve.`);
  return new TextDecoder().decode(file[1]);
}

/** The Metadata API name of a permission set (namespace__Name). */
async function permissionSetName(client: SalesforceClient, permissionSetId: string): Promise<string> {
  check(permissionSetId, '0PS', 'permission set');
  const row = (await query(client, `SELECT Name, NamespacePrefix FROM PermissionSet WHERE Id = '${permissionSetId}'`))
    .rows[0];
  if (!row) throw new Error('Permission set not found.');
  return `${row.NamespacePrefix ? `${String(row.NamespacePrefix)}__` : ''}${String(row.Name)}`;
}

// ---------- record types ----------

export type RecordTypeAccess = {
  /** Object.DeveloperName */
  recordType: string;
  object: string;
  label: string;
  active: boolean;
  visible: boolean;
  /** Profiles only: the default record type of the object. */
  isDefault: boolean;
};

/** Every record type in the org, with whether the profile or permission set can use it. */
export async function recordTypeAccess(
  client: SalesforceClient,
  holder: { kind: 'Profile' | 'Permission set'; permissionSetId: string; profileId?: string }
): Promise<RecordTypeAccess[]> {
  const types = await query(
    client,
    'SELECT SobjectType, DeveloperName, Name, NamespacePrefix, IsActive FROM RecordType ORDER BY SobjectType, Name',
    { maxRows: 50_000 }
  );
  let granted: Array<{ recordType: string; visible: boolean; isDefault: boolean }>;
  if (holder.kind === 'Profile') {
    const { metadata } = await profileMetadata(client, holder.profileId ?? '');
    const list = (metadata.recordTypeVisibilities ?? []) as Array<Record<string, Json>>;
    granted = list.map((v) => ({
      recordType: String(v.recordType),
      visible: v.visible === true,
      isDefault: v.default === true,
    }));
  } else {
    const xml = await retrieveFile(client, 'PermissionSet', await permissionSetName(client, holder.permissionSetId));
    granted = xmlBlocks(xml, 'recordTypeVisibilities').map((b) => ({
      recordType: xmlValue(b, 'recordType') ?? '',
      visible: xmlValue(b, 'visible') === 'true',
      isDefault: false,
    }));
  }
  const byName = new Map(granted.map((g) => [g.recordType, g]));
  return types.rows.map((t) => {
    const recordType = `${String(t.SobjectType)}.${t.NamespacePrefix ? `${String(t.NamespacePrefix)}__` : ''}${String(
      t.DeveloperName
    )}`;
    const g = byName.get(recordType);
    return {
      recordType,
      object: String(t.SobjectType),
      label: String(t.Name ?? t.DeveloperName),
      active: t.IsActive === true,
      visible: Boolean(g?.visible),
      isDefault: Boolean(g?.isDefault),
    };
  });
}

const rtvXml = (r: Pick<RecordTypeAccess, 'recordType' | 'visible' | 'isDefault'>, profile: boolean): string =>
  `    <recordTypeVisibilities>\n${
    profile ? `        <default>${r.isDefault}</default>\n` : ''
  }        <recordType>${escapeXml(r.recordType)}</recordType>\n        <visible>${
    r.visible
  }</visible>\n    </recordTypeVisibilities>\n`;

/**
 * Saves record type access. A profile gets a file with only these settings (the rest of the
 * profile stays); a permission set is retrieved, changed and deployed whole.
 */
export async function saveRecordTypeAccess(
  client: SalesforceClient,
  holder: { kind: 'Profile' | 'Permission set'; permissionSetId: string; profileId?: string },
  changes: Array<Pick<RecordTypeAccess, 'recordType' | 'visible' | 'isDefault'>>
): Promise<void> {
  if (!changes.length) return;
  for (const c of changes)
    if (!/^\w+\.\w+$/.test(c.recordType)) throw new Error(`Invalid record type ${c.recordType}.`);
  if (holder.kind === 'Profile') {
    const { fullName } = await profileMetadata(client, holder.profileId ?? '');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n${changes
      .map((c) => rtvXml(c, true))
      .join('')}</Profile>\n`;
    failed(await deployFiles(client, 'Profile', [{ fullName, xml }]));
    return;
  }
  const fullName = await permissionSetName(client, holder.permissionSetId);
  const file = await retrieveFile(client, 'PermissionSet', fullName);
  failed(await deployFiles(client, 'PermissionSet', [{ fullName, xml: withRecordTypes(file, changes) }]));
}

/** A permission set file with these record types' visibility changed (hidden ones are left out). */
export function withRecordTypes(
  file: string,
  changes: Array<Pick<RecordTypeAccess, 'recordType' | 'visible'>>
): string {
  const changed = new Set(changes.map((c) => c.recordType));
  const kept = file.replace(/[ \t]*<recordTypeVisibilities>[\s\S]*?<\/recordTypeVisibilities>[ \t]*\n?/g, (block) =>
    changed.has(xmlValue(block, 'recordType') ?? '') ? '' : block
  );
  const added = changes
    .filter((c) => c.visible)
    .map((c) => rtvXml({ ...c, isDefault: false }, false))
    .join('');
  return kept.replace('</PermissionSet>', `${added}</PermissionSet>`);
}

// ---------- page layouts (profiles) ----------

export type LayoutAssignment = { object: string; recordType: string; layout: string };

/** Which page layout a profile sees for each object (and record type). */
export async function layoutAssignments(client: SalesforceClient, profileId: string): Promise<LayoutAssignment[]> {
  check(profileId, '00e', 'profile');
  const tooling = <T>(soql: string): Promise<{ records: T[] }> =>
    client.tooling('GET', `/query?q=${encodeURIComponent(soql)}`);
  const [assigned, objects, recordTypes] = await Promise.all([
    tooling<{ TableEnumOrId: string; Layout: { Name: string } | null; RecordTypeId: string | null }>(
      `SELECT TableEnumOrId, Layout.Name, RecordTypeId FROM ProfileLayout WHERE ProfileId = '${profileId}'`
    ),
    tooling<{ Id: string; DeveloperName: string; NamespacePrefix: string | null }>(
      'SELECT Id, DeveloperName, NamespacePrefix FROM CustomObject'
    ).catch(() => ({ records: [] })),
    // The Tooling API's RecordType has no DeveloperName: named from the data API
    query(client, 'SELECT Id, DeveloperName, NamespacePrefix FROM RecordType', { maxRows: 50_000 }),
  ]);
  const recordTypeName = new Map(
    recordTypes.rows.map((r) => [
      String(r.Id).slice(0, 15),
      `${r.NamespacePrefix ? `${String(r.NamespacePrefix)}__` : ''}${String(r.DeveloperName)}`,
    ])
  );
  // Custom objects come as their Id
  const customName = new Map(
    objects.records.map((o) => [
      o.Id.slice(0, 15),
      `${o.NamespacePrefix ? `${o.NamespacePrefix}__` : ''}${o.DeveloperName}__c`,
    ])
  );
  return assigned.records
    .map((a) => {
      const object = customName.get(a.TableEnumOrId.slice(0, 15)) ?? a.TableEnumOrId;
      return {
        object,
        recordType: a.RecordTypeId
          ? `${object}.${recordTypeName.get(a.RecordTypeId.slice(0, 15)) ?? a.RecordTypeId}`
          : '',
        layout: a.Layout ? `${object}-${a.Layout.Name}` : '',
      };
    })
    .sort((a, b) => a.object.localeCompare(b.object) || a.recordType.localeCompare(b.recordType));
}

/** Changes which layout a profile sees (only these assignments are deployed). */
export async function saveLayoutAssignments(
  client: SalesforceClient,
  profileId: string,
  changes: LayoutAssignment[]
): Promise<void> {
  if (!changes.length) return;
  const { fullName } = await profileMetadata(client, profileId);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n${changes
    .map(
      (c) =>
        `    <layoutAssignments>\n        <layout>${escapeXml(c.layout)}</layout>\n${
          c.recordType ? `        <recordType>${escapeXml(c.recordType)}</recordType>\n` : ''
        }    </layoutAssignments>\n`
    )
    .join('')}</Profile>\n`;
  failed(await deployFiles(client, 'Profile', [{ fullName, xml }]));
}

// ---------- new custom permissions, clones ----------

const API_NAME = /^[A-Za-z][A-Za-z0-9_]{0,79}$/;
const checkApiName = (name: string): void => {
  if (!API_NAME.test(name) || /__|_$/.test(name))
    throw new Error('API name: letters, digits and single underscores, starting with a letter.');
};

/** Creates a custom permission (Metadata API) and returns its Id. */
export async function createCustomPermission(
  client: SalesforceClient,
  input: { label: string; name: string; description?: string }
): Promise<string> {
  checkApiName(input.name);
  if (!input.label.trim()) throw new Error('Give it a label.');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<CustomPermission xmlns="http://soap.sforce.com/2006/04/metadata">\n${
    input.description ? `    <description>${escapeXml(input.description)}</description>\n` : ''
  }    <isLicensed>false</isLicensed>\n    <label>${escapeXml(input.label.trim())}</label>\n</CustomPermission>\n`;
  failed(await deployFiles(client, 'CustomPermission', [{ fullName: input.name, xml }]));
  const row = (
    await query(
      client,
      `SELECT Id FROM CustomPermission WHERE DeveloperName = '${input.name}' AND NamespacePrefix = null`
    )
  ).rows[0];
  if (!row) throw new Error('Created, but its Id could not be read.');
  return String(row.Id);
}

/**
 * A new custom profile with everything the source profile has (its settings and layout
 * assignments), deployed under a new name.
 */
export async function cloneProfile(
  client: SalesforceClient,
  sourceProfileId: string,
  name: string,
  description = ''
): Promise<string> {
  if (!/^[\w ()&.-]{1,80}$/.test(name.trim())) throw new Error('Profile name: letters, digits, spaces and ( ) & . - _');
  const exists = await query(client, `SELECT Id FROM Profile WHERE Name = '${soqlText(name.trim())}'`);
  if (exists.rows.length) throw new Error(`A profile named ${name.trim()} already exists.`);
  const { metadata } = await profileMetadata(client, sourceProfileId);
  const layouts = await layoutAssignments(client, sourceProfileId).catch(() => []);
  const copy: MetadataJson = {
    ...metadata,
    custom: true,
    description: description || (metadata.description as string) || undefined,
    layoutAssignments: layouts
      .filter((l) => l.layout)
      .map((l) => ({ layout: l.layout, recordType: l.recordType || undefined })),
  };
  failed(await deployFiles(client, 'Profile', [{ fullName: name.trim(), xml: metadataToXml('Profile', copy) }]));
  const row = (await query(client, `SELECT Id FROM Profile WHERE Name = '${soqlText(name.trim())}'`)).rows[0];
  return String(row?.Id ?? '');
}

/** A new permission set with everything the source one grants (its file, renamed). */
export async function clonePermissionSet(
  client: SalesforceClient,
  sourcePermissionSetId: string,
  input: { label: string; name: string; description?: string }
): Promise<string> {
  checkApiName(input.name);
  const file = await retrieveFile(client, 'PermissionSet', await permissionSetName(client, sourcePermissionSetId));
  let xml = file.replace(/<label>[\s\S]*?<\/label>/, `<label>${escapeXml(input.label.trim())}</label>`);
  if (input.description !== undefined) {
    const description = `<description>${escapeXml(input.description)}</description>`;
    xml = /<description>/.test(xml)
      ? xml.replace(/<description>[\s\S]*?<\/description>/, description)
      : xml.replace('<label>', `${description}\n    <label>`);
  }
  failed(await deployFiles(client, 'PermissionSet', [{ fullName: input.name, xml }]));
  const row = (
    await query(client, `SELECT Id FROM PermissionSet WHERE Name = '${input.name}' AND NamespacePrefix = null`)
  ).rows[0];
  return String(row?.Id ?? '');
}

/** A new permission set group holding the same permission sets (muting permission sets are not copied). */
export async function clonePermissionSetGroup(
  client: SalesforceClient,
  sourceGroupId: string,
  input: { label: string; name: string; description?: string }
): Promise<{ id: string; added: number; errors: string[] }> {
  check(sourceGroupId, '0PG', 'permission set group');
  checkApiName(input.name);
  const components = await query(
    client,
    `SELECT PermissionSetId, PermissionSet.Type FROM PermissionSetGroupComponent WHERE PermissionSetGroupId = '${sourceGroupId}'`,
    { maxRows: 5000 }
  );
  const created = await client.rest<{ id: string }>('POST', '/sobjects/PermissionSetGroup', {
    MasterLabel: input.label.trim(),
    DeveloperName: input.name,
    Description: input.description ?? '',
  });
  const errors: string[] = [];
  let added = 0;
  for (const c of components.rows.filter((r) => r['PermissionSet.Type'] !== 'Muting')) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await client.rest('POST', '/sobjects/PermissionSetGroupComponent', {
        PermissionSetGroupId: created.id,
        PermissionSetId: c.PermissionSetId,
      });
      added++;
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return { id: created.id, added, errors };
}
