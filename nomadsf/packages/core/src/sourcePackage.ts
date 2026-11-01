/**
 * Salesforce source format without the CLI: which component a file of a repository belongs to, and the package of a
 * change between two commits — package.xml, destructiveChanges.xml, the components and every changed file with what
 * happens to it. The rules follow Salesforce's own resolver (source-deploy-retrieve): destructiveChanges.xml only knows
 * whole components, so a file deleted from a folder component that still has its -meta.xml deploys its whole new
 * version; labels are compared one by one; object fields and the like are their own types. Moved from NomadSF Release Hub.
 */

/** Source folder → metadata type (the folder right under a package directory, e.g. force-app/main/default/classes). */
export const SOURCE_TYPES: Record<string, string> = {
  applications: 'CustomApplication',
  approvalProcesses: 'ApprovalProcess',
  assignmentRules: 'AssignmentRules',
  aura: 'AuraDefinitionBundle',
  autoResponseRules: 'AutoResponseRules',
  brandingSets: 'BrandingSet',
  cachePartitions: 'PlatformCachePartition',
  classes: 'ApexClass',
  communities: 'Community',
  components: 'ApexComponent',
  connectedApps: 'ConnectedApp',
  contentassets: 'ContentAsset',
  corsWhitelistOrigins: 'CorsWhitelistOrigin',
  cspTrustedSites: 'CspTrustedSite',
  customMetadata: 'CustomMetadata',
  customPermissions: 'CustomPermission',
  dashboards: 'Dashboard',
  dataStreamDefinitions: 'DataStreamDefinition',
  digitalExperienceConfigs: 'DigitalExperienceConfig',
  digitalExperiences: 'DigitalExperienceBundle',
  documents: 'Document',
  duplicateRules: 'DuplicateRule',
  email: 'EmailTemplate',
  escalationRules: 'EscalationRules',
  experiences: 'ExperienceBundle',
  externalClientApps: 'ExternalClientApplication',
  externalCredentials: 'ExternalCredential',
  flexipages: 'FlexiPage',
  flowDefinitions: 'FlowDefinition',
  flows: 'Flow',
  genAiFunctions: 'GenAiFunction',
  genAiPlannerBundles: 'GenAiPlannerBundle',
  genAiPlugins: 'GenAiPlugin',
  genAiPromptTemplates: 'GenAiPromptTemplate',
  globalValueSets: 'GlobalValueSet',
  groups: 'Group',
  labels: 'CustomLabels',
  layouts: 'Layout',
  letterhead: 'Letterhead',
  lightningTypes: 'LightningTypeBundle',
  lwc: 'LightningComponentBundle',
  matchingRules: 'MatchingRules',
  messageChannels: 'LightningMessageChannel',
  namedCredentials: 'NamedCredential',
  networks: 'Network',
  notificationtypes: 'CustomNotificationType',
  objects: 'CustomObject',
  objectTranslations: 'CustomObjectTranslation',
  omniDataTransforms: 'OmniDataTransform',
  omniIntegrationProcedures: 'OmniIntegrationProcedure',
  omniScripts: 'OmniScript',
  omniUiCard: 'OmniUiCard',
  pages: 'ApexPage',
  pathAssistants: 'PathAssistant',
  permissionsetgroups: 'PermissionSetGroup',
  permissionsets: 'PermissionSet',
  platformEventChannelMembers: 'PlatformEventChannelMember',
  platformEventChannels: 'PlatformEventChannel',
  profiles: 'Profile',
  queues: 'Queue',
  quickActions: 'QuickAction',
  remoteSiteSettings: 'RemoteSiteSetting',
  reports: 'Report',
  reportTypes: 'ReportType',
  roles: 'Role',
  settings: 'Settings',
  sharingRules: 'SharingRules',
  sites: 'CustomSite',
  standardValueSets: 'StandardValueSet',
  staticresources: 'StaticResource',
  tabs: 'CustomTab',
  territory2Models: 'Territory2Model',
  territory2Types: 'Territory2Type',
  translations: 'Translations',
  triggers: 'ApexTrigger',
  waveTemplates: 'WaveTemplateBundle',
  workflows: 'Workflow',
};

/** Folders of an object (objects/Account/fields/…) → the child type deployed on its own. */
export const OBJECT_CHILDREN: Record<string, string> = {
  businessProcesses: 'BusinessProcess',
  compactLayouts: 'CompactLayout',
  fieldSets: 'FieldSet',
  fields: 'CustomField',
  indexes: 'Index',
  listViews: 'ListView',
  recordTypes: 'RecordType',
  sharingReasons: 'SharingReason',
  validationRules: 'ValidationRule',
  webLinks: 'WebLink',
};

/** Components that are a folder with their -meta.xml inside it. */
const META_INSIDE = new Set(['lwc', 'aura', 'digitalExperiences']);
/** Components that are a folder with their -meta.xml next to it (experiences/Site1 + experiences/Site1.site-meta.xml). */
const META_BESIDE = new Set(['experiences', 'staticresources']);
/** Folder components with no -meta.xml: the folder itself is the component. */
const NO_META = new Set(['waveTemplates', 'lightningTypes']);
/** Types whose components sit in a folder of their own (reports/MyFolder/Report.report-meta.xml). */
const FOLDERED = new Set(['reports', 'dashboards', 'documents', 'email']);

const metaName = (file: string): string => file.replace(/\.[^.]+-meta\.xml$/, '');

export type SourceComponent = {
  type: string;
  name: string;
  /** The main file: the -meta.xml (or, for a folder without one, the folder). Undefined for Aura until the tree says. */
  xml?: string;
  /** Set for components made of a folder. */
  folder?: string;
  metaInside?: boolean;
  /** A single-file static resource's files start with this. */
  siblings?: string;
  labels?: boolean;
  object?: string;
  /** The source folder of the type (classes, objects…) and its path, e.g. force-app/main/default/classes. */
  typeFolder?: string;
  base?: string;
};

/**
 * The component a file belongs to, or undefined when it is not metadata (README, jest config, a folder Salesforce does
 * not know).
 */
function resolveInner(path: string, packageDirs: string[]): SourceComponent | undefined {
  const dir = packageDirs.find((d) => path.startsWith(`${d}/`));
  if (!dir) return undefined;
  const parts = path.slice(dir.length + 1).split('/');
  const at = parts.findIndex((p) => SOURCE_TYPES[p]);
  if (at < 0 || at === parts.length - 1) return undefined;
  const typeFolder = parts[at];
  const type = SOURCE_TYPES[typeFolder];
  const base = `${dir}/${parts.slice(0, at + 1).join('/')}`;
  const rest = parts.slice(at + 1);
  const file = rest[rest.length - 1];

  if (typeFolder === 'labels') return { type: 'CustomLabels', name: 'CustomLabels', xml: path, labels: true };

  if (typeFolder === 'objects' || typeFolder === 'objectTranslations') {
    const object = rest[0];
    if (rest.length === 2) return file.endsWith('-meta.xml') ? { type, name: object, xml: path } : undefined;
    const child = typeFolder === 'objects' ? OBJECT_CHILDREN[rest[1]] : undefined;
    if (child && rest.length === 3 && file.endsWith('-meta.xml'))
      return { type: child, name: `${object}.${metaName(file)}`, xml: path, object };
    // A translation's parts (fieldTranslations) deploy with the translation
    if (typeFolder === 'objectTranslations')
      return { type, name: object, xml: `${base}/${object}/${object}.objectTranslation-meta.xml` };
    return undefined;
  }

  if (META_INSIDE.has(typeFolder)) {
    // digitalExperiences/site/<name>/… is DigitalExperienceBundle site/<name>
    const depth = typeFolder === 'digitalExperiences' ? 2 : 1;
    if (rest.length <= depth) return undefined;
    const name = rest.slice(0, depth).join('/');
    const folder = `${base}/${name}`;
    const own = rest[depth - 1];
    const xml =
      typeFolder === 'lwc'
        ? `${folder}/${own}.js-meta.xml`
        : typeFolder === 'digitalExperiences'
        ? `${folder}/${own}.digitalExperience-meta.xml`
        : undefined; // aura: .cmp, .app, .evt… — found from the tree
    return { type, name, xml, folder, metaInside: true };
  }

  if (META_BESIDE.has(typeFolder)) {
    const name = rest.length > 1 ? rest[0] : file.replace(/\.[^.]+-meta\.xml$/, '').replace(/\.[^.]+$/, '');
    const suffix = typeFolder === 'experiences' ? 'site' : 'resource';
    return {
      type,
      name,
      xml: `${base}/${name}.${suffix}-meta.xml`,
      folder: `${base}/${name}`,
      // a single-file static resource: staticresources/logo.png next to logo.resource-meta.xml
      siblings: `${base}/${name}.`,
    };
  }

  if (NO_META.has(typeFolder)) {
    if (rest.length < 2) return undefined;
    return { type, name: rest[0], xml: `${base}/${rest[0]}`, folder: `${base}/${rest[0]}` };
  }

  if (FOLDERED.has(typeFolder)) {
    // The folder itself (reports/Sales.reportFolder-meta.xml) or a component in it (reports/Sales/Pipeline.report-meta.xml)
    const name = rest.length === 1 ? metaName(file) : `${rest[0]}/${metaName(file).replace(/\.[^.]+$/, '')}`;
    return { type, name, xml: file.endsWith('-meta.xml') ? path : `${path}-meta.xml` };
  }

  // One component per file (and its -meta.xml): classes/Hello.cls + Hello.cls-meta.xml, permissionsets/X.permissionset-meta.xml
  if (rest.length !== 1) return undefined;
  if (file.endsWith('-meta.xml'))
    return { type, name: metaName(file).replace(/\.(cls|trigger|page|component)$/, ''), xml: path };
  return { type, name: file.replace(/\.[^.]+$/, ''), xml: `${path}-meta.xml` };
}

/**
 * The component a file belongs to, or undefined when it is not metadata (README, jest config, a folder Salesforce does
 * not know). It also says the type's folder, for building the Metadata API zip.
 */
export function resolveComponent(path: string, packageDirs: string[]): SourceComponent | undefined {
  const found = resolveInner(path, packageDirs);
  if (!found) return undefined;
  const dir = packageDirs.find((d) => path.startsWith(`${d}/`)) ?? '';
  const parts = path.slice(dir.length + 1).split('/');
  const at = parts.findIndex((p) => SOURCE_TYPES[p]);
  return { ...found, typeFolder: parts[at], base: `${dir}/${parts.slice(0, at + 1).join('/')}` };
}

/** The labels of a CustomLabels file: name → its <labels> block, to compare them one by one. */
export function labelBlocks(xml: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of String(xml ?? '').matchAll(/<labels>([\s\S]*?)<\/labels>/g)) {
    const name = /<fullName>([^<]+)<\/fullName>/.exec(m[1])?.[1]?.trim();
    if (name) out.set(name, m[1].replace(/\s+/g, ' ').trim());
  }
  return out;
}

const escapeXml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** package.xml (or destructiveChanges.xml) for components, types and members sorted. */
export function manifestXml(components: Array<{ type: string; name: string }>, version: string): string {
  const byType = new Map<string, string[]>();
  for (const c of components) byType.set(c.type, [...(byType.get(c.type) ?? []), c.name]);
  const types = [...byType]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([type, names]) =>
        `    <types>\n${[...new Set(names)]
          .sort()
          .map((n) => `        <members>${escapeXml(n)}</members>\n`)
          .join('')}        <name>${type}</name>\n    </types>\n`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n${types}    <version>${version}</version>\n</Package>\n`;
}

/** How much two texts share, 0–1: common lines over the longer one (enough to pair a renamed file). */
export function similarity(a: string, b: string): number {
  const x = a.split('\n');
  const y = b.split('\n');
  const counts = new Map<string, number>();
  for (const line of x) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of y) {
    const n = counts.get(line) ?? 0;
    if (n > 0) {
      common++;
      counts.set(line, n - 1);
    }
  }
  return common / Math.max(x.length, y.length, 1);
}

/**
 * What brings a component into the package: added, changed or deleted between the two sides — or, offered for you to
 * choose (custom labels: every label is listed), unchanged on the source side, or only in the target.
 */
export type PackageChange = 'added' | 'changed' | 'deleted' | 'unchanged' | 'only in target';

/** A change that goes into destructiveChanges.xml (the others into package.xml). */
export const isRemoval = (change: PackageChange): boolean => change === 'deleted' || change === 'only in target';

export type PackageComponent = {
  type: string;
  name: string;
  change: PackageChange;
  /** The changed files that make it part of the package. */
  files: string[];
  /** What is deployed of it (the whole component on the source side); empty when deleted. */
  deploy: string[];
  note?: string;
};

export type PackageRename = {
  from: { type: string; name: string; files: string[] };
  to: { type: string; name: string };
};

export type PackageFileGroup = 'deploy' | 'destructive' | 'ignoredDeploy' | 'ignoredDestructive' | 'notMetadata';

export type PackageFile = {
  path: string;
  status: 'A' | 'M' | 'D';
  group: PackageFileGroup;
  /** Type:Name of the components it is part of. */
  components: string[];
  note?: string;
  /** A labels file: the labels it sends or removes, by name. */
  labels?: { added?: string[]; changed?: string[]; removed?: string[] };
};

export type SourcePackage = {
  components: PackageComponent[];
  renames: PackageRename[];
  files: PackageFile[];
};

type Side = 'before' | 'after';

/**
 * The package of a change, as Source would bring it into Target.
 *
 * - `before` / `after`: every file of the target-side and source-side commits (path → git object id)
 * - `read(side, path)`: a file's text on one side
 * - `packageDirs`: from sfdx-project.json; `ignored(path)`: the .forceignore
 */
export async function buildPackage(options: {
  before: Map<string, string>;
  after: Map<string, string>;
  read: (side: Side, path: string) => Promise<string>;
  packageDirs: string[];
  ignored?: (path: string) => boolean;
}): Promise<SourcePackage> {
  const { before, after, read, packageDirs, ignored = () => false } = options;
  const changed: string[] = [];
  for (const [path, oid] of after) if (before.get(path) !== oid) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  const status = (path: string): 'A' | 'M' | 'D' => (!before.has(path) ? 'A' : !after.has(path) ? 'D' : 'M');

  const components = new Map<string, PackageComponent>();
  // What happened to each changed file, for the lists
  const rows: PackageFile[] = [];
  const row = (path: string, group: PackageFileGroup, keys: string[] = [], note?: string): void => {
    rows.push({ path, status: status(path), group, components: keys, ...(note ? { note } : {}) });
  };
  const add = (key: string, value: PackageComponent): void => {
    const found = components.get(key);
    if (found) found.files.push(...value.files.filter((f) => !found.files.includes(f)));
    else components.set(key, value);
  };
  // Aura bundles: the main file is whichever -meta.xml the folder has
  const auraXml = (folder: string, files: Map<string, string>): string | undefined =>
    [...files.keys()].find((p) => p.startsWith(`${folder}/`) && p.endsWith('-meta.xml'));
  const filesIn = (folder: string, files: Map<string, string>): string[] =>
    [...files.keys()].filter((p) => p.startsWith(`${folder}/`));
  const folderWithoutMeta = (c: SourceComponent, files: Map<string, string>): boolean =>
    c.xml === c.folder && filesIn(c.folder ?? '', files).length > 0;

  for (const path of changed) {
    if (ignored(path)) {
      row(path, status(path) === 'D' ? 'ignoredDestructive' : 'ignoredDeploy');
      continue;
    }
    const c = resolveComponent(path, packageDirs);
    if (!c) {
      row(path, 'notMetadata');
      continue;
    }

    if (c.labels) {
      // eslint-disable-next-line no-await-in-loop
      const old = labelBlocks(before.has(path) ? await read('before', path) : '');
      // eslint-disable-next-line no-await-in-loop
      const now = labelBlocks(after.has(path) ? await read('after', path) : '');
      const added = [...now.keys()].filter((name) => !old.has(name));
      const changedLabels = [...now]
        .filter(([name, block]) => old.has(name) && old.get(name) !== block)
        .map(([n]) => n);
      const removed = [...old.keys()].filter((name) => !now.has(name));
      const keys = (names: string[]): string[] => names.map((name) => `CustomLabel:${name}`);
      // The labels file is listed with the labels it sends and the ones it removes, by name
      if (added.length || changedLabels.length)
        rows.push({
          path,
          status: status(path),
          group: 'deploy',
          components: keys([...added, ...changedLabels]),
          labels: { added, changed: changedLabels },
        });
      if (removed.length)
        rows.push({ path, status: status(path), group: 'destructive', components: keys(removed), labels: { removed } });
      for (const name of [...added, ...changedLabels])
        add(`CustomLabel:${name}`, {
          type: 'CustomLabel',
          name,
          change: old.has(name) ? 'changed' : 'added',
          files: [path],
          deploy: [path],
        });
      for (const name of removed)
        add(`CustomLabel:${name}`, { type: 'CustomLabel', name, change: 'deleted', files: [path], deploy: [] });
      continue;
    }

    const xmlBefore = c.type === 'AuraDefinitionBundle' ? auraXml(c.folder ?? '', before) : c.xml;
    const xmlAfter = c.type === 'AuraDefinitionBundle' ? auraXml(c.folder ?? '', after) : c.xml;
    const inBefore =
      c.folder && !xmlBefore ? false : (xmlBefore ? before.has(xmlBefore) : false) || folderWithoutMeta(c, before);
    const inAfter =
      c.folder && !xmlAfter ? false : (xmlAfter ? after.has(xmlAfter) : false) || folderWithoutMeta(c, after);
    const key = `${c.type}:${c.name}`;
    if (inAfter) {
      // Deployed whole: a folder component with every file it has now, a file with its -meta.xml
      const stem = (c.xml ?? '').replace(/-meta\.xml$/, '');
      const candidates = c.folder
        ? [
            ...filesIn(c.folder, after),
            ...(c.metaInside || !xmlAfter ? [] : [xmlAfter]),
            ...(c.siblings ? [...after.keys()].filter((p) => p.startsWith(c.siblings ?? '')) : []),
          ]
        : // the file and its -meta.xml: classes/Hello.cls + Hello.cls-meta.xml, whichever of them changed
          [stem, c.xml ?? '', path];
      const deploy = [...new Set(candidates)].filter((p) => after.has(p));
      add(key, { type: c.type, name: c.name, change: inBefore ? 'changed' : 'added', files: [path], deploy });
      row(path, 'deploy', [key], status(path) === 'D' ? 'deleted file: the component is deployed whole' : undefined);
    } else if (inBefore) {
      row(path, 'destructive', [key]);
      const left = c.folder ? filesIn(c.folder, after) : [];
      add(key, {
        type: c.type,
        name: c.name,
        change: 'deleted',
        files: [path],
        deploy: [],
        ...(left.length
          ? {
              note: `Its -meta.xml was deleted, so it is deleted from the org; still in the source: ${left.join(', ')}`,
            }
          : {}),
      });
    } else {
      row(path, 'notMetadata', [], `${key} has no -meta.xml on either side`);
    }
  }

  // An object deleted takes its fields and the rest with it: only the object goes into destructiveChanges.xml
  const deletedObjects = new Set(
    [...components.values()].filter((c) => c.type === 'CustomObject' && c.change === 'deleted').map((c) => c.name)
  );
  for (const [key, c] of components) {
    const object = c.name.split('.')[0];
    if (c.change !== 'deleted' || c.type === 'CustomObject' || !deletedObjects.has(object)) continue;
    components.delete(key);
    for (const r of rows)
      if (r.components.includes(key)) {
        r.components = [`CustomObject:${object}`];
        r.note = `deleted with its object ${object}`;
      }
  }

  const list = [...components.values()].sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  for (const c of list) c.files.sort();
  rows.sort((a, b) => a.path.localeCompare(b.path));
  return { components: list, renames: await findRenames(list, read), files: rows };
}

/** Deleted and added components of one type whose main text matches (exactly or mostly): renamed or moved. */
async function findRenames(
  components: PackageComponent[],
  read: (side: Side, path: string) => Promise<string>
): Promise<PackageRename[]> {
  const renames: PackageRename[] = [];
  const added = components.filter((c) => c.change === 'added' && c.type !== 'CustomLabel');
  const used = new Set<PackageComponent>();
  const mainOf = (files: string[]): string => files.find((f) => !f.endsWith('-meta.xml')) ?? files[0];
  // Lines naming the component differ by definition (class Old / class Newer): compare the rest
  const body = (text: string, name: string): string => {
    const own = name.split(/[./]/).pop() ?? name;
    return text
      .split('\n')
      .filter((line) => !line.includes(own))
      .join('\n');
  };
  for (const gone of components.filter((c) => c.change === 'deleted' && c.type !== 'CustomLabel')) {
    const candidates = added.filter((c) => c.type === gone.type && !used.has(c));
    if (!candidates.length || candidates.length > 50) continue;
    // eslint-disable-next-line no-await-in-loop
    const old = body(await read('before', mainOf(gone.files)), gone.name);
    // Too little text to tell a rename from two look-alike files (two small fields)
    if (old.trim().split('\n').length < 5) continue;
    let best: { c: PackageComponent; score: number } | undefined;
    for (const c of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const now = body(await read('after', mainOf(c.deploy.length ? c.deploy : c.files)), c.name);
      const score = similarity(old, now);
      if (score >= 0.75 && (!best || score > best.score)) best = { c, score };
    }
    if (!best) continue;
    used.add(best.c);
    renames.push({
      from: { type: gone.type, name: gone.name, files: gone.files },
      to: { type: best.c.type, name: best.c.name },
    });
  }
  return renames;
}
