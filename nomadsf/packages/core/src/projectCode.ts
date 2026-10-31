import type { SalesforceClient } from './client.js';
import { openCode, type CodeFile, type CodeItem, type CodeKind } from './code.js';
import { packageXml } from './metadata.js';
import type { ProjectFs, ProjectInfo } from './project.js';
import { query } from './query.js';
import { makeZip, toBase64 } from './zip.js';

/**
 * The code of the project (a folder or a GitHub branch) next to the org's: the same files as
 * the Code page opens, their differences, and a deployable package. Code is stored the same
 * way in a DX project and in a Metadata API package (classes/A.cls + A.cls-meta.xml,
 * lwc/name/…), so no conversion is needed.
 */

type CodeLayout = { type: string; folder: string; ext?: string; bundle?: boolean };

export const CODE_LAYOUT: Record<CodeKind, CodeLayout> = {
  ApexClass: { type: 'ApexClass', folder: 'classes', ext: 'cls' },
  ApexTrigger: { type: 'ApexTrigger', folder: 'triggers', ext: 'trigger' },
  ApexPage: { type: 'ApexPage', folder: 'pages', ext: 'page' },
  ApexComponent: { type: 'ApexComponent', folder: 'components', ext: 'component' },
  LWC: { type: 'LightningComponentBundle', folder: 'lwc', bundle: true },
  Aura: { type: 'AuraDefinitionBundle', folder: 'aura', bundle: true },
};

/** Code kind of a metadata type (ApexClass, LightningComponentBundle…), if it is code. */
export function codeKindOf(type: string): CodeKind | undefined {
  return (Object.keys(CODE_LAYOUT) as CodeKind[]).find((k) => CODE_LAYOUT[k].type === type);
}

/** Component name -> the project folders that may hold it (a type can live in several package directories). */
export type ProjectCodeIndex = Map<string, string[]>;

export function projectCodeIndex(info: ProjectInfo | undefined, kind: CodeKind): ProjectCodeIndex {
  const index: ProjectCodeIndex = new Map();
  const { type, folder } = CODE_LAYOUT[kind];
  for (const dir of info?.packageDirectories ?? []) {
    for (const summary of dir.types) {
      if (summary.type !== type) continue;
      const folders = summary.paths.filter((p) => p.split('/').pop() === folder);
      for (const name of summary.names) index.set(name, [...(index.get(name) ?? []), ...folders]);
    }
  }
  return index;
}

const LANGUAGE: Record<string, CodeFile['language']> = {
  cls: 'apex',
  trigger: 'apex',
  page: 'html',
  component: 'html',
  js: 'javascript',
  html: 'html',
  css: 'css',
  xml: 'xml',
  json: 'json',
  cmp: 'html',
  app: 'html',
  evt: 'html',
  intf: 'html',
  auradoc: 'html',
  design: 'xml',
  svg: 'xml',
  tokens: 'xml',
};

const languageOf = (path: string): CodeFile['language'] =>
  path.endsWith('-meta.xml') ? 'xml' : LANGUAGE[path.split('.').pop() ?? ''] ?? 'html';

/** Files the org never holds in a bundle: Jest tests (Aura's -meta.xml is shown from the bundle record). */
const skippedInBundle = (_kind: CodeKind, rel: string): boolean => rel.split('/').includes('__tests__');

async function listFiles(fs: ProjectFs, dir: string, depth = 0): Promise<string[]> {
  if (depth > 3) return [];
  const out: string[] = [];
  for (const entry of await fs.list(dir)) {
    const path = `${dir}/${entry.name}`;
    // eslint-disable-next-line no-await-in-loop
    if (entry.kind === 'dir') out.push(...(await listFiles(fs, path, depth + 1)));
    else out.push(path);
  }
  return out;
}

/**
 * The project's files of a component, with the same paths as openCode gives for the org's
 * (A.cls, lwc/name/name.js, aura/name/nameController.js), so the two can be paired.
 */
export async function readProjectCode(
  fs: ProjectFs,
  kind: CodeKind,
  name: string,
  folders: string[]
): Promise<CodeFile[]> {
  const layout = CODE_LAYOUT[kind];
  for (const folder of folders) {
    if (!layout.bundle) {
      const file = `${name}.${layout.ext!}`;
      // eslint-disable-next-line no-await-in-loop
      const source = await fs.readText(`${folder}/${file}`);
      if (source !== undefined)
        return [{ id: `project:${folder}/${file}`, path: file, language: languageOf(file), source }];
      continue;
    }
    let paths: string[];
    try {
      // eslint-disable-next-line no-await-in-loop
      paths = await listFiles(fs, `${folder}/${name}`);
    } catch {
      continue;
    }
    const files: CodeFile[] = [];
    for (const full of paths) {
      const rel = full.slice(folder.length + 1);
      if (skippedInBundle(kind, rel)) continue;
      // eslint-disable-next-line no-await-in-loop
      const source = await fs.readText(full);
      if (source === undefined) continue;
      files.push({ id: `project:${full}`, path: `${layout.folder}/${rel}`, language: languageOf(rel), source });
    }
    if (files.length) return files.sort((a, b) => a.path.localeCompare(b.path));
  }
  return [];
}

/** Ignores what saving or retrieving can change: line endings, trailing spaces, blank lines at the ends. */
export const normalizeCode = (text: string): string =>
  text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();

export const sameCode = (a: string, b: string): boolean => normalizeCode(a) === normalizeCode(b);

export type FileDiffStatus = 'same' | 'different' | 'only in org' | 'only in project';
export type CodePair = { path: string; status: FileDiffStatus; org?: CodeFile; project?: CodeFile };

/** Pairs the org's and the project's files of one component by path. */
export function pairCodeFiles(org: CodeFile[], project: CodeFile[]): CodePair[] {
  const byPath = new Map<string, CodePair>();
  for (const f of org) byPath.set(f.path, { path: f.path, status: 'only in org', org: f });
  for (const f of project) {
    const pair = byPath.get(f.path);
    if (pair) {
      pair.project = f;
      pair.status = sameCode(pair.org!.source, f.source) ? 'same' : 'different';
    } else byPath.set(f.path, { path: f.path, status: 'only in project', project: f });
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export const pairsSame = (pairs: CodePair[]): boolean => pairs.every((p) => p.status === 'same');

/**
 * Same or different, for every component in both the org and the project. Apex and
 * Visualforce bodies come in one query per kind; LWC and Aura bundles one by one.
 */
export async function checkCodeContent(
  client: SalesforceClient,
  fs: ProjectFs,
  kind: CodeKind,
  items: CodeItem[],
  index: ProjectCodeIndex,
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, 'same' | 'different'>> {
  const result = new Map<string, 'same' | 'different'>();
  const both = items.filter((i) => index.has(i.name));
  const layout = CODE_LAYOUT[kind];
  let bodies: Map<string, string> | undefined;
  if (!layout.bundle) {
    const field = kind === 'ApexPage' || kind === 'ApexComponent' ? 'Markup' : 'Body';
    const rows = await query(client, `SELECT Name, ${field} FROM ${kind} WHERE NamespacePrefix = null`, {
      tooling: true,
      maxRows: 10_000,
    });
    bodies = new Map(rows.rows.map((r) => [String(r.Name), String(r[field] ?? '')]));
  }
  const total = both.length;
  let done = 0;
  const next = async (): Promise<void> => {
    for (let item = both.shift(); item; item = both.shift()) {
      onProgress?.(done, total);
      /* eslint-disable no-await-in-loop */
      const project = await readProjectCode(fs, kind, item.name, index.get(item.name)!);
      const org = bodies
        ? [
            {
              id: item.id,
              path: project[0]?.path ?? '',
              language: 'apex' as const,
              source: bodies.get(item.name) ?? '',
            },
          ]
        : await openCode(client, item);
      /* eslint-enable no-await-in-loop */
      result.set(item.name, project.length && pairsSame(pairCodeFiles(org, project)) ? 'same' : 'different');
      done++;
    }
  };
  // A few at a time: the org and GitHub are both called per component
  await Promise.all([next(), next(), next(), next()]);
  onProgress?.(total, total);
  return result;
}

export type CodePackage = { zipBase64: string; packageXml: string; components: number; files: number };

/** A deployable package of project code (each component with its -meta.xml), for deployZip. */
export async function projectCodePackage(
  fs: ProjectFs,
  info: ProjectInfo,
  components: Array<{ type: string; name: string }>,
  apiVersion: string
): Promise<CodePackage> {
  const files: Record<string, string> = {};
  const members: Array<{ type: string; fullName: string }> = [];
  for (const c of components) {
    const kind = codeKindOf(c.type);
    if (!kind) throw new Error(`${c.type} is not code; deploy it with the NomadSF CLI app.`);
    const layout = CODE_LAYOUT[kind];
    const folders = projectCodeIndex(info, kind).get(c.name) ?? [];
    let found = false;
    for (const folder of folders) {
      if (layout.bundle) {
        let paths: string[];
        try {
          // eslint-disable-next-line no-await-in-loop
          paths = await listFiles(fs, `${folder}/${c.name}`);
        } catch {
          continue;
        }
        for (const full of paths) {
          const rel = full.slice(folder.length + 1);
          if (rel.split('/').includes('__tests__')) continue;
          // eslint-disable-next-line no-await-in-loop
          const text = await fs.readText(full);
          if (text !== undefined) files[`${layout.folder}/${rel}`] = text;
        }
        found = paths.length > 0;
      } else {
        const file = `${c.name}.${layout.ext!}`;
        // eslint-disable-next-line no-await-in-loop
        const [body, meta] = await Promise.all([
          fs.readText(`${folder}/${file}`),
          fs.readText(`${folder}/${file}-meta.xml`),
        ]);
        if (body === undefined) continue;
        files[`${layout.folder}/${file}`] = body;
        // A component without its -meta.xml gets a minimal one (the org's API version)
        files[`${layout.folder}/${file}-meta.xml`] =
          meta ??
          `<?xml version="1.0" encoding="UTF-8"?>\n<${c.type} xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>${apiVersion}</apiVersion>\n    <status>Active</status>\n</${c.type}>\n`;
        found = true;
      }
      if (found) break;
    }
    if (!found) throw new Error(`${c.type} ${c.name} was not found in the project.`);
    members.push({ type: c.type, fullName: c.name });
  }
  const manifest = packageXml(members, apiVersion);
  const zip = makeZip([
    { path: 'package.xml', content: manifest },
    ...Object.entries(files).map(([path, content]) => ({ path, content })),
  ]);
  return {
    zipBase64: toBase64(zip),
    packageXml: manifest,
    components: members.length,
    files: Object.keys(files).length,
  };
}

/** A unified diff (3 lines of context) of two texts, for reading or for the AI. Large files are cut. */
export function unifiedDiff(a: string, b: string, labels: [string, string] = ['org', 'project'], context = 3): string {
  const x = normalizeCode(a).split('\n');
  const y = normalizeCode(b).split('\n');
  // Longest common subsequence on the lines; trimmed to keep the table small
  const max = 4000;
  const left = x.slice(0, max);
  const right = y.slice(0, max);
  const n = left.length;
  const m = right.length;
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const ops: Array<{ op: ' ' | '-' | '+'; line: string; a: number; b: number }> = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && left[i] === right[j]) ops.push({ op: ' ', line: left[i], a: i++, b: j++ });
    // Removed lines before added ones, as diffs usually show them
    else if (i < n && (j >= m || table[i + 1][j] >= table[i][j + 1]))
      ops.push({ op: '-', line: left[i], a: i++, b: j });
    else ops.push({ op: '+', line: right[j], a: i, b: j++ });
  }
  const out = [`--- ${labels[0]}`, `+++ ${labels[1]}`];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].op === ' ') continue;
    const start = Math.max(0, k - context);
    let end = k;
    // Extend the hunk while changes are close together
    while (end < ops.length && (ops[end].op !== ' ' || ops.slice(end, end + context * 2 + 1).some((o) => o.op !== ' ')))
      end++;
    end = Math.min(ops.length, end + context);
    const hunk = ops.slice(start, end);
    const aLines = hunk.filter((o) => o.op !== '+').length;
    const bLines = hunk.filter((o) => o.op !== '-').length;
    out.push(`@@ -${hunk[0].a + 1},${aLines} +${hunk[0].b + 1},${bLines} @@`);
    for (const o of hunk) out.push(`${o.op}${o.line}`);
    k = end - 1;
  }
  if (x.length > max || y.length > max) out.push(`… (only the first ${max} lines compared)`);
  return out.length === 2 ? '' : out.join('\n');
}
