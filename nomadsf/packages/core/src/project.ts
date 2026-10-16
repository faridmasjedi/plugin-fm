/**
 * Reads a Salesforce DX project (repository) through a small file-system interface, so the
 * same code works with the local NomadSF app (HTTP) and a folder picked in the browser.
 */

export type ProjectEntry = { name: string; kind: 'file' | 'dir' };

export type ProjectFs = {
  /** Display name of the project (folder name). */
  name: string;
  list(dir: string): Promise<ProjectEntry[]>;
  readText(path: string): Promise<string | undefined>;
};

/** Source-format folder name -> metadata type (the common types; the org's describe can add more). */
export const FOLDER_TYPES: Record<string, string> = {
  applications: 'CustomApplication',
  aura: 'AuraDefinitionBundle',
  cachePartitions: 'PlatformCachePartition',
  classes: 'ApexClass',
  components: 'ApexComponent',
  contentassets: 'ContentAsset',
  customMetadata: 'CustomMetadata',
  customPermissions: 'CustomPermission',
  dashboards: 'Dashboard',
  dataStreamDefinitions: 'DataStreamDefinition',
  documents: 'Document',
  duplicateRules: 'DuplicateRule',
  email: 'EmailTemplate',
  experiences: 'ExperienceBundle',
  externalCredentials: 'ExternalCredential',
  flexipages: 'FlexiPage',
  flows: 'Flow',
  genAiFunctions: 'GenAiFunction',
  genAiPlannerBundles: 'GenAiPlannerBundle',
  genAiPlugins: 'GenAiPlugin',
  genAiPromptTemplates: 'GenAiPromptTemplate',
  globalValueSets: 'GlobalValueSet',
  groups: 'Group',
  labels: 'CustomLabels',
  layouts: 'Layout',
  lwc: 'LightningComponentBundle',
  matchingRules: 'MatchingRule',
  messageChannels: 'LightningMessageChannel',
  namedCredentials: 'NamedCredential',
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
  platformEventChannels: 'PlatformEventChannel',
  profiles: 'Profile',
  queues: 'Queue',
  quickActions: 'QuickAction',
  remoteSiteSettings: 'RemoteSiteSetting',
  reports: 'Report',
  reportTypes: 'ReportType',
  roles: 'Role',
  sharingRules: 'SharingRules',
  sites: 'CustomSite',
  standardValueSets: 'StandardValueSet',
  staticresources: 'StaticResource',
  tabs: 'CustomTab',
  translations: 'Translations',
  triggers: 'ApexTrigger',
  wave: 'WaveTemplateBundle',
  workflows: 'Workflow',
};

/** Types whose components are folders (bundles, objects) rather than single files. */
const FOLDER_COMPONENTS = new Set([
  'aura',
  'lwc',
  'experiences',
  'objects',
  'objectTranslations',
  'wave',
  'genAiPlannerBundles',
]);
/** Types whose components live in sub-folders (reports/MyFolder/Report.report-meta.xml). */
const FOLDERED = new Set(['reports', 'dashboards', 'documents', 'email']);

export type ProjectTypeSummary = { folder: string; type: string; count: number; names: string[]; paths: string[] };

export type PackageDirectory = {
  path: string;
  default: boolean;
  package?: string;
  versionNumber?: string;
  types: ProjectTypeSummary[];
  total: number;
};

export type ManifestSummary = { path: string; types: number; members: number };

export type ProjectInfo = {
  name: string;
  sourceApiVersion?: string;
  namespace?: string;
  packageDirectories: PackageDirectory[];
  packageAliases: Record<string, string>;
  manifests: ManifestSummary[];
  branch?: string;
};

type SfdxProject = {
  packageDirectories?: Array<{ path: string; default?: boolean; package?: string; versionNumber?: string }>;
  packageAliases?: Record<string, string>;
  sourceApiVersion?: string;
  namespace?: string;
};

const join = (...parts: string[]): string => parts.filter(Boolean).join('/').replace(/\/+/g, '/');

/** Component name of a source file: "Account.object-meta.xml" -> "Account", "A.cls-meta.xml" -> "A". */
const componentName = (file: string): string => file.replace(/-meta\.xml$/, '').replace(/\.[^.]+$/, '');

async function summarizeTypeFolder(
  fs: ProjectFs,
  folder: string,
  path: string,
  folderTypes: Record<string, string>
): Promise<ProjectTypeSummary> {
  const entries = await fs.list(path);
  let names: string[];
  if (FOLDER_COMPONENTS.has(folder)) {
    names = entries.filter((e) => e.kind === 'dir').map((e) => e.name);
  } else if (FOLDERED.has(folder)) {
    names = [];
    for (const sub of entries.filter((e) => e.kind === 'dir')) {
      // eslint-disable-next-line no-await-in-loop
      const inner = await fs.list(join(path, sub.name));
      names.push(
        ...inner
          .filter((e) => e.kind === 'file' && e.name.endsWith('-meta.xml'))
          .map((e) => `${sub.name}/${componentName(e.name)}`)
      );
    }
  } else {
    names = entries.filter((e) => e.kind === 'file' && e.name.endsWith('-meta.xml')).map((e) => componentName(e.name));
  }
  names = [...new Set(names)].sort();
  return { folder, type: folderTypes[folder], count: names.length, names: names.slice(0, 5000), paths: [path] };
}

/** Walks a package directory (max depth 5) and summarizes every known type folder in it. */
async function scanPackageDirectory(
  fs: ProjectFs,
  root: string,
  folderTypes: Record<string, string>
): Promise<ProjectTypeSummary[]> {
  const byType = new Map<string, ProjectTypeSummary>();
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    let entries: ProjectEntry[];
    try {
      entries = await fs.list(dir);
    } catch {
      return;
    }
    for (const entry of entries.filter((e) => e.kind === 'dir')) {
      const path = join(dir, entry.name);
      if (folderTypes[entry.name]) {
        // eslint-disable-next-line no-await-in-loop
        const summary = await summarizeTypeFolder(fs, entry.name, path, folderTypes);
        const existing = byType.get(summary.type);
        if (existing) {
          existing.names = [...new Set([...existing.names, ...summary.names])].sort();
          existing.count = existing.names.length;
          existing.paths.push(path);
        } else {
          byType.set(summary.type, summary);
        }
      } else {
        // eslint-disable-next-line no-await-in-loop
        await walk(path, depth + 1);
      }
    }
  };
  await walk(root, 0);
  return [...byType.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/** Parses package.xml into [{ type, members }]. */
export function parsePackageXml(xml: string): Array<{ type: string; members: string[] }> {
  return [...xml.matchAll(/<types>([\s\S]*?)<\/types>/g)]
    .map((block) => ({
      type: /<name>\s*([^<\s]+)\s*<\/name>/.exec(block[1])?.[1] ?? '',
      members: [...block[1].matchAll(/<members>\s*([^<]+?)\s*<\/members>/g)].map((m) => m[1].replace(/&amp;/g, '&')),
    }))
    .filter((t) => t.type);
}

/** Finds package.xml-style manifests outside the package directories (max depth 3). */
async function findManifests(fs: ProjectFs, skip: Set<string>): Promise<ManifestSummary[]> {
  const out: ManifestSummary[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 3 || out.length >= 100) return;
    let entries: ProjectEntry[];
    try {
      entries = await fs.list(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.kind === 'dir') {
        if (!skip.has(path) && !entry.name.startsWith('.')) {
          // eslint-disable-next-line no-await-in-loop
          await walk(path, depth + 1);
        }
      } else if (entry.name.endsWith('.xml')) {
        // eslint-disable-next-line no-await-in-loop
        const text = await fs.readText(path);
        if (text && /<Package[\s>]/.test(text)) {
          const types = parsePackageXml(text);
          out.push({ path, types: types.length, members: types.reduce((n, t) => n + t.members.length, 0) });
        }
      }
    }
  };
  await walk('', 0);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export async function analyzeProject(
  fs: ProjectFs,
  extraFolderTypes: Record<string, string> = {}
): Promise<ProjectInfo> {
  const raw = await fs.readText('sfdx-project.json');
  if (!raw) throw new Error(`${fs.name} has no sfdx-project.json; choose the root of a Salesforce DX project.`);
  const sfdx = JSON.parse(raw) as SfdxProject;
  const folderTypes = { ...extraFolderTypes, ...FOLDER_TYPES };

  const packageDirectories: PackageDirectory[] = [];
  for (const dir of sfdx.packageDirectories ?? []) {
    const path = dir.path.replace(/^\.\//, '').replace(/\/$/, '');
    // eslint-disable-next-line no-await-in-loop
    const types = await scanPackageDirectory(fs, path, folderTypes);
    packageDirectories.push({
      path,
      default: Boolean(dir.default),
      package: dir.package,
      versionNumber: dir.versionNumber,
      types,
      total: types.reduce((n, t) => n + t.count, 0),
    });
  }

  const head = await fs.readText('.git/HEAD').catch(() => undefined);
  return {
    name: fs.name,
    sourceApiVersion: sfdx.sourceApiVersion,
    namespace: sfdx.namespace || undefined,
    packageDirectories,
    packageAliases: sfdx.packageAliases ?? {},
    manifests: await findManifests(fs, new Set(packageDirectories.map((d) => d.path))),
    branch: head ? /ref: refs\/heads\/(.+)/.exec(head)?.[1]?.trim() : undefined,
  };
}

/** Project file system over HTTP: the local NomadSF app's read-only project endpoints. */
export function httpProjectFs(name: string, baseUrl = ''): ProjectFs {
  return {
    name,
    async list(dir) {
      const res = await fetch(`${baseUrl}/api/project/list?dir=${encodeURIComponent(dir)}`);
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? res.statusText);
      return (await res.json()) as ProjectEntry[];
    },
    async readText(path) {
      const res = await fetch(`${baseUrl}/api/project/file?path=${encodeURIComponent(path)}`);
      return res.ok ? res.text() : undefined;
    },
  };
}
