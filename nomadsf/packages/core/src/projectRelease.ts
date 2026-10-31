import ignore from 'ignore';
import { checkForceignore } from './compareEngine.js';
import { apexSourcesFromFiles, testsForPackage } from './dependentTests.js';
import type { TestSelection } from './apexGraph.js';
import type { SalesforceClient } from './client.js';
import type { CodeFile } from './code.js';
import type { FolderHandle, FolderRepo } from './gitFolder.js';
import { retrieveZip } from './metadata.js';
import { pairCodeFiles, pairsSame } from './projectCode.js';
import { fromBase64, readZip } from './zip.js';
import { FOLDER_TYPES, type ProjectFs, type ProjectInfo } from './project.js';
import { CHILD_ELEMENTS, toMetadataFormat, type ConvertResult } from './sourceConvert.js';
import { labelBlocks, resolveComponent } from './sourcePackage.js';

/**
 * A package from the project as it is on disk (not a branch): the same converter and dependent tests as Compare &
 * package, for the Project page and Code. Files in the .forceignore stay out, named, like the CLI's deploy.
 */

const SKIPPED = new Set(['node_modules', '.git', '.sfdx', '.sf']);

/** Every file under the package directories. */
export async function projectFiles(fs: ProjectFs, info: ProjectInfo): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.list(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      // eslint-disable-next-line no-await-in-loop
      if (entry.kind === 'dir') await walk(path);
      else out.push(path);
    }
  };
  for (const dir of info.packageDirectories) {
    // eslint-disable-next-line no-await-in-loop
    await walk(dir.path);
  }
  return out;
}

/**
 * A branch, tag or commit of the folder's git history as a read-only project: its files as they are at that ref, so
 * what reads a project (compare with an org, the converter, dependent tests) reads a branch the same way.
 */
export async function refProjectFs(
  repo: FolderRepo,
  ref: string
): Promise<{ fs: ProjectFs; readBytes: (path: string) => Promise<Uint8Array> }> {
  const commit = await repo.commit(ref);
  const files = await repo.files(commit);
  const fs: ProjectFs = {
    name: ref,
    list: async (dir) => {
      const prefix = dir ? `${dir.replace(/\/$/, '')}/` : '';
      const out = new Map<string, 'file' | 'dir'>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const [first, ...rest] = path.slice(prefix.length).split('/');
        if (!out.has(first) || rest.length) out.set(first, rest.length ? 'dir' : 'file');
      }
      if (!out.size && dir) throw new Error(`${dir} is not in ${ref}`);
      return [...out].map(([name, kind]) => ({ name, kind }));
    },
    readText: async (path) => {
      const oid = files.get(path);
      return oid ? repo.text(oid) : undefined;
    },
  };
  return { fs, readBytes: (path) => repo.bytes(commit, path) };
}

/** Each component's source files in a project or branch (an object with its children's files), keyed type:name. */
export async function componentFilePaths(
  fs: ProjectFs,
  info: ProjectInfo,
  components: Array<{ type: string; name: string }>
): Promise<Map<string, string[]>> {
  const dirs = info.packageDirectories.map((d) => d.path);
  const wanted = new Set(components.map((c) => `${c.type}:${c.name}`));
  const objects = new Set(components.filter((c) => c.type === 'CustomObject').map((c) => c.name));
  const result = new Map<string, string[]>();
  const add = (key: string, path: string): void => {
    result.set(key, [...(result.get(key) ?? []), path]);
  };
  for (const path of await projectFiles(fs, info)) {
    const c = resolveComponent(path, dirs);
    if (!c) continue;
    const key = `${c.type}:${c.name}`;
    if (wanted.has(key)) add(key, path);
    else if (c.object && objects.has(c.object)) add(`CustomObject:${c.object}`, path);
  }
  return result;
}

/** A file's bytes from a picked folder (binary static resources survive, unlike text). */
export async function folderBytes(root: FolderHandle, path: string): Promise<Uint8Array> {
  const parts = path.split('/').filter(Boolean);
  let dir = root;
  // eslint-disable-next-line no-await-in-loop
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  const file = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

/** The .forceignore of the project as a matcher (nothing ignored when there is none). */
export async function projectIgnore(fs: ProjectFs, path?: string): Promise<(file: string) => boolean> {
  const text = await fs.readText(checkForceignore(path)).catch(() => undefined);
  if (!text) return () => false;
  const rules = ignore().add(text);
  return (file) => {
    try {
      return rules.ignores(file);
    } catch {
      return false;
    }
  };
}

export type ProjectPackageInput = {
  fs: ProjectFs;
  info: ProjectInfo;
  deploy: Array<{ type: string; name: string }>;
  remove?: Array<{ type: string; name: string }>;
  removeWhen?: 'post' | 'pre';
  apiVersion: string;
  forceignore?: string;
  /** The bytes of a file, when the project can give them (a folder): static resources may be binary. */
  readBytes?: (path: string) => Promise<Uint8Array>;
  /** The project's files when already listed (many packages in a row). */
  allFiles?: string[];
};

/** The Metadata API zip of components of the project. */
export async function projectMetadataZip(input: ProjectPackageInput): Promise<ConvertResult> {
  const { fs, info, readBytes } = input;
  const all = input.allFiles ?? (await projectFiles(fs, info));
  const ignored = await projectIgnore(fs, input.forceignore);
  const files = all.filter((f) => !ignored(f));
  const deploy = withObjectChildren(
    input.deploy,
    files,
    info.packageDirectories.map((d) => d.path)
  );
  const read =
    readBytes ??
    (async (path: string): Promise<Uint8Array> => new TextEncoder().encode((await fs.readText(path)) ?? ''));
  const result = await toMetadataFormat({
    deploy,
    remove: input.remove,
    removeWhen: input.removeWhen,
    files,
    read,
    packageDirs: info.packageDirectories.map((d) => d.path),
    apiVersion: input.apiVersion,
  });
  // "No source file" for a component whose files are all ignored: say it is the .forceignore
  if (files.length < all.length) {
    const left = await toMetadataFormat({
      deploy: result.notConverted.filter((c) => c.reason === 'no source file for it'),
      files: all,
      read: async () => new Uint8Array(),
      packageDirs: info.packageDirectories.map((d) => d.path),
      apiVersion: input.apiVersion,
    });
    const inIgnore = new Set(left.deployed.map((c) => `${c.type}:${c.name}`));
    for (const c of result.notConverted)
      if (inIgnore.has(`${c.type}:${c.name}`)) c.reason = `in ${checkForceignore(input.forceignore)}`;
  }
  return result;
}

/**
 * An object of the project is its folder: deploying it sends its fields, record types, validation rules… too, as the
 * CLI's deploy of CustomObject:X does; an object folder with no object file of its own (a standard object's fields)
 * is just those children.
 */
function withObjectChildren(
  deploy: Array<{ type: string; name: string }>,
  files: string[],
  packageDirs: string[]
): Array<{ type: string; name: string }> {
  const objects = new Set(deploy.filter((c) => c.type === 'CustomObject').map((c) => c.name));
  if (!objects.size) return deploy;
  const out = [...deploy];
  const keys = new Set(deploy.map((c) => `${c.type}:${c.name}`));
  const own = new Set<string>();
  const withChildren = new Set<string>();
  for (const path of files) {
    const c = resolveComponent(path, packageDirs);
    if (!c) continue;
    if (c.type === 'CustomObject') own.add(c.name);
    else if (c.object && objects.has(c.object)) {
      withChildren.add(c.object);
      const key = `${c.type}:${c.name}`;
      if (!keys.has(key)) {
        keys.add(key);
        out.push({ type: c.type, name: c.name });
      }
    }
  }
  return out.filter((c) => c.type !== 'CustomObject' || own.has(c.name) || !withChildren.has(c.name));
}

const LANGUAGE: Array<[RegExp, CodeFile['language']]> = [
  [/\.(cls|trigger)$/, 'apex'],
  [/\.js$/, 'javascript'],
  [/\.(html|page|component|cmp|app|evt|intf|auradoc|design|tokens)$/, 'html'],
  [/\.css$/, 'css'],
  [/\.json$/, 'json'],
];
const languageOf = (path: string): CodeFile['language'] => LANGUAGE.find(([re]) => re.test(path))?.[1] ?? 'xml';

/** Files of a Metadata API zip as text, without package.xml (binary files are left out). */
export async function zipCodeFiles(zip: Uint8Array, only?: (path: string) => boolean): Promise<CodeFile[]> {
  const out: CodeFile[] = [];
  for (const [inZip, bytes] of await readZip(zip)) {
    // A retrieve may put the files under unpackaged/
    const path = inZip.replace(/^unpackaged\//, '');
    if (path === 'package.xml' || (only && !only(path))) continue;
    const text = new TextDecoder().decode(bytes);
    if (text.includes('\u0000')) continue;
    out.push({ id: path, path, language: languageOf(path), source: text });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

export type ProjectSide = {
  fs: ProjectFs;
  info: ProjectInfo;
  readBytes?: (path: string) => Promise<Uint8Array>;
};

/** One component of the project in the Metadata API's paths (objects/Account.object…), to pair with the org's. */
export async function projectComponentFiles(
  project: ProjectSide,
  component: { type: string; name: string },
  apiVersion: string,
  allFiles?: string[]
): Promise<{ files: CodeFile[]; problem?: string }> {
  const built = await projectMetadataZip({ ...project, deploy: [component], apiVersion, allFiles });
  if (built.notConverted.length) return { files: [], problem: built.notConverted[0].reason };
  return { files: await zipCodeFiles(built.zip) };
}

/** Where a component is, between a project (or branch) and an org, with both versions' files. */
export type OrgCheck = {
  status: 'same' | 'different' | 'not in org' | 'only in org' | 'in neither';
  org: CodeFile[];
  repo: CodeFile[];
};

/** XML lines indented by nesting, so one block reads the same wherever it came from. */
function reindentXml(xml: string): string {
  let depth = 0;
  return xml
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      if (/^<\//.test(line)) depth = Math.max(0, depth - 1);
      const out = `${'    '.repeat(depth)}${line}`;
      if (/^<[^/!?][^>]*[^/]>$/.test(line) && !/<\/[^>]+>$/.test(line)) depth++;
      return out;
    })
    .join('\n');
}

/** XML laid out one tag per line and indented by nesting: a compact file and the org's expanded one read the same. */
export function normalizeXml(xml: string): string {
  return reindentXml(xml.replace(/>\s*</g, '>\n<'));
}

/** One child (a field, a record type…) of an object's file: just its block, so a field compares with a field. */
function childBlock(xml: string, type: string, name: string): string | undefined {
  const element = CHILD_ELEMENTS[type];
  const child = name.split('.').slice(1).join('.');
  for (const m of xml.matchAll(new RegExp(`<${element}>[\\s\\S]*?</${element}>`, 'g')))
    if (new RegExp(`<fullName>${child.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</fullName>`).test(m[0]))
      return reindentXml(m[0]);
  return undefined;
}

/** One component's files as compared: an object's child as its own block, XML laid out the same way everywhere. */
function comparable(c: { type: string; name: string }, files: CodeFile[]): CodeFile[] {
  const own = CHILD_ELEMENTS[c.type]
    ? files.flatMap((f) => {
        const block = childBlock(f.source, c.type, c.name);
        return block ? [{ ...f, source: block }] : [];
      })
    : files;
  return own.map((f) => (f.language === 'xml' ? { ...f, source: normalizeXml(f.source) } : f));
}

/** Components' files in an org (one retrieve), keyed type:name, ready to compare. */
export async function orgComponentFiles(
  client: SalesforceClient,
  components: Array<{ type: string; name: string }>,
  onProgress?: (status: string) => void
): Promise<Map<string, CodeFile[]>> {
  const result = new Map<string, CodeFile[]>();
  if (!components.length) return result;
  const retrieved = await retrieveZip(
    client,
    components.map((c) => ({ type: c.type, fullName: c.name })),
    { onProgress: (s) => onProgress?.(`Retrieving ${components.length} component(s) from the org: ${s}`) }
  );
  const files = retrieved.zipFile ? await zipCodeFiles(fromBase64(retrieved.zipFile)) : [];
  const pathsOf = new Map<string, string[]>();
  for (const f of retrieved.files) {
    const key = `${f.type}:${f.fullName}`;
    pathsOf.set(key, [...(pathsOf.get(key) ?? []), f.fileName.replace(/^unpackaged\//, '').replace(/\/$/, '')]);
  }
  for (const c of components) {
    const paths = pathsOf.get(`${c.type}:${c.name}`) ?? [];
    const own = files.filter((f) =>
      paths.some((p) => f.path === p || f.path === `${p}-meta.xml` || f.path.startsWith(`${p}/`))
    );
    result.set(`${c.type}:${c.name}`, comparable(c, own));
  }
  return result;
}

/** Components' files in a project or branch, keyed type:name, ready to compare with an org's. */
export async function projectSideFiles(
  project: ProjectSide,
  components: Array<{ type: string; name: string }>,
  apiVersion: string
): Promise<Map<string, CodeFile[]>> {
  const result = new Map<string, CodeFile[]>();
  const all = await projectFiles(project.fs, project.info);
  for (const c of components) {
    // eslint-disable-next-line no-await-in-loop
    const files = (await projectComponentFiles(project, c, apiVersion, all)).files;
    result.set(`${c.type}:${c.name}`, comparable(c, files));
  }
  return result;
}

/** Where a component is, from its files on each side. */
export function checkStatus(org: CodeFile[], repo: CodeFile[]): OrgCheck['status'] {
  if (!org.length) return repo.length ? 'not in org' : 'in neither';
  if (!repo.length) return 'only in org';
  return pairsSame(pairCodeFiles(org, repo)) ? 'same' : 'different';
}

/**
 * Components of a project or branch against an org: one retrieve from the org, each component converted from the
 * project, file by file — same or different, or on one side only. An object's child (a field) compares as its block.
 */
export async function checkComponentsWithOrg(
  client: SalesforceClient,
  project: ProjectSide,
  components: Array<{ type: string; name: string }>,
  onProgress?: (status: string) => void
): Promise<Map<string, OrgCheck>> {
  const result = new Map<string, OrgCheck>();
  if (!components.length) return result;
  const org = await orgComponentFiles(client, components, onProgress);
  onProgress?.(`Comparing ${components.length} component(s) with the org…`);
  const repo = await projectSideFiles(project, components, await client.version());
  for (const c of components) {
    const key = `${c.type}:${c.name}`;
    const o = org.get(key) ?? [];
    const r = repo.get(key) ?? [];
    result.set(key, { status: checkStatus(o, r), org: o, repo: r });
  }
  return result;
}

/** Same or different for components of one type in both the org and the project (Compare content). */
export async function compareTypeWithProject(
  client: SalesforceClient,
  project: ProjectSide,
  type: string,
  names: string[],
  onProgress?: (status: string) => void
): Promise<Map<string, 'same' | 'different'>> {
  const checked = await checkComponentsWithOrg(
    client,
    project,
    names.map((name) => ({ type, name })),
    onProgress
  );
  const result = new Map<string, 'same' | 'different'>();
  for (const [key, c] of checked)
    if (c.status === 'same' || c.status === 'different') result.set(key.slice(type.length + 1), c.status);
  return result;
}

/** The tests that reach the Apex of a package, from the project's Apex. */
export async function projectTests(
  fs: ProjectFs,
  info: ProjectInfo,
  components: Array<{ type: string; name: string }>
): Promise<TestSelection> {
  const files = await projectFiles(fs, info);
  const sources = await apexSourcesFromFiles(files, async (p) => (await fs.readText(p)) ?? '');
  return testsForPackage(sources, components);
}

/**
 * The components of files in Metadata API format (an AI draft, edited files): what package.xml lists. An object file
 * holding only fields lists those fields; the labels file lists its labels; a bundle is its folder.
 */
export function metadataComponentsOf(
  files: Array<{ path: string; content: string }>
): Array<{ type: string; name: string }> {
  const out = new Map<string, { type: string; name: string }>();
  const add = (type: string, name: string): void => {
    out.set(`${type}:${name}`, { type, name });
  };
  for (const { path, content } of files) {
    const [folder, ...rest] = path.split('/');
    const type = FOLDER_TYPES[folder];
    if (!type || !rest.length) continue;
    if (type === 'LightningComponentBundle' || type === 'AuraDefinitionBundle') {
      add(type, rest[0]);
      continue;
    }
    if (type === 'CustomLabels') {
      for (const m of content.matchAll(/<labels>[\s\S]*?<fullName>([^<]+)<\/fullName>/g))
        add('CustomLabel', m[1].trim());
      continue;
    }
    const file = rest.join('/').replace(/-meta\.xml$/, '');
    const name = file.replace(/\.[^./]+$/, '');
    if (type === 'CustomObject') {
      const inner = content.replace(/<(fields|recordTypes|listViews|validationRules|webLinks)>[\s\S]*?<\/\1>/g, '');
      const children = [...content.matchAll(/<fields>[\s\S]*?<fullName>([^<]+)<\/fullName>/g)].map((m) => m[1].trim());
      // Only fields (adding them to an object): the fields, not the object
      if (children.length && !/<label>/.test(inner)) children.forEach((f) => add('CustomField', `${name}.${f}`));
      else add(type, name);
      continue;
    }
    add(type, name);
  }
  return [...out.values()];
}

/** Every custom label of a project or branch (all its labels files), by name. */
export async function projectLabels(fs: ProjectFs, info: ProjectInfo): Promise<string[]> {
  const dirs = info.packageDirectories.map((d) => d.path);
  const names = new Set<string>();
  for (const path of await projectFiles(fs, info)) {
    if (!resolveComponent(path, dirs)?.labels) continue;
    // eslint-disable-next-line no-await-in-loop
    for (const name of labelBlocks(await fs.readText(path)).keys()) names.add(name);
  }
  return [...names].sort();
}

export type ProjectDependency = { type: string; name: string };

/** How other files refer to a component: its name, and the forms LWC, Aura and labels use. */
/** Types named after their object (Case's sharing rules…): nothing refers to them by name. */
const NAMED_BY_OBJECT = new Set([
  'SharingRules',
  'Workflow',
  'AssignmentRules',
  'AutoResponseRules',
  'EscalationRules',
  'CustomObjectTranslation',
  'TopicsForObjects',
]);

function referencesTo(c: { type: string; name: string }): string[] {
  const { type, name } = c;
  if (NAMED_BY_OBJECT.has(type)) return [];
  const last = name.split('.').pop() ?? name;
  const kebab = name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const forms: Record<string, string[]> = {
    LightningComponentBundle: [`c-${kebab}`, `c/${name}`],
    AuraDefinitionBundle: [`c:${name}`],
    CustomLabel: [`Label.${name}`, `c.${name}`],
    // A field is named by its API name (Score__c) or with its object (Account.Score__c)
    CustomField: [name, last],
  };
  return (forms[type] ?? [name]).filter((t) => t.length >= 3);
}

const mentions = (text: string, token: string): boolean =>
  new RegExp(`(?<![\\w])${token.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&')}(?![\\w])`).test(text);

/**
 * What a component of the project uses and what uses it, read from the project's own files (for components the org
 * does not have yet, where Salesforce's dependency tracking cannot help): a name, a tag or a label referred to.
 */
export async function projectDependencies(
  fs: ProjectFs,
  info: ProjectInfo,
  component: { type: string; name: string }
): Promise<{ uses: ProjectDependency[]; usedBy: ProjectDependency[] }> {
  const dirs = info.packageDirectories.map((d) => d.path);
  // Every component with the text of its files (each label its own block); static resources are not read
  const texts = new Map<string, { type: string; name: string; text: string }>();
  for (const path of await projectFiles(fs, info)) {
    const c = resolveComponent(path, dirs);
    if (!c || c.type === 'StaticResource') continue;
    // eslint-disable-next-line no-await-in-loop
    const raw = (await fs.readText(path)) ?? '';
    // A file's <fullName> is its own name (or its parts'), never a reference to something else
    const text = c.labels ? raw : raw.replace(/<fullName>[^<]*<\/fullName>/g, '');
    if (c.labels) {
      for (const [name, block] of labelBlocks(text))
        texts.set(`CustomLabel:${name}`, {
          type: 'CustomLabel',
          name,
          text: block.replace(/<fullName>[^<]*<\/fullName>/g, ''),
        });
      continue;
    }
    const key = `${c.type}:${c.name}`;
    const found = texts.get(key);
    if (found) found.text += `\n${text}`;
    else texts.set(key, { type: c.type, name: c.name, text });
  }
  const self = `${component.type}:${component.name}`;
  const own = texts.get(self)?.text ?? '';
  const mine = referencesTo(component);
  const uses: ProjectDependency[] = [];
  const usedBy: ProjectDependency[] = [];
  for (const [key, other] of texts) {
    if (key === self) continue;
    // An object's own fields are part of it, not dependencies
    if (component.type === 'CustomObject' && other.name.startsWith(`${component.name}.`)) continue;
    if (referencesTo(other).some((t) => mentions(own, t))) uses.push({ type: other.type, name: other.name });
    if (mine.some((t) => mentions(other.text, t))) usedBy.push({ type: other.type, name: other.name });
  }
  const order = (a: ProjectDependency, b: ProjectDependency): number =>
    a.type.localeCompare(b.type) || a.name.localeCompare(b.name);
  return { uses: uses.sort(order), usedBy: usedBy.sort(order) };
}
