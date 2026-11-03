import { normalizeCode } from './projectCode.js';
import { labelBlocks, resolveComponent, type SourceComponent } from './sourcePackage.js';
import { CHILD_ELEMENTS, innerXml } from './sourceConvert.js';
import { readZip } from './zip.js';

/**
 * Metadata API format → source format, in the browser: what a retrieve from the org becomes in a project, like the
 * CLI's `sf project retrieve start`. The other way round of sourceConvert:
 * - an XML-only component gets "-meta.xml" (permissionsets/X.permissionset → X.permissionset-meta.xml);
 * - an object's file is split into its own file and one file per field, record type, list view…;
 * - labels are merged into the project's labels file (the other labels stay);
 * - a static resource is unpacked into a folder when it is a zip, else one file with its extension;
 * - each file goes where that component already is in the project, else into the default package folder.
 * Nothing is written here: the result says what each file would be, and whether it is new, changed or the same.
 */

const NS = 'http://soap.sforce.com/2006/04/metadata';
const XML = '<?xml version="1.0" encoding="UTF-8"?>';

/** An object child's element → its root tag and file suffix in source format. */
const CHILDREN: Record<string, { root: string; suffix: string; type: string }> = Object.fromEntries(
  Object.entries(CHILD_ELEMENTS).map(([type, element]) => [
    element,
    {
      type,
      root: type,
      // CustomField → .field-meta.xml; the others by name (RecordType → .recordType-meta.xml)
      suffix: type === 'CustomField' ? 'field' : type.charAt(0).toLowerCase() + type.slice(1),
    },
  ])
);

/** Types whose source format is not made here yet: named, never guessed. */
const NOT_CONVERTED = new Set(['ExperienceBundle', 'CustomObjectTranslation', 'DigitalExperienceBundle']);

const FOLDER_SUFFIX: Record<string, string> = {
  reports: 'reportFolder',
  dashboards: 'dashboardFolder',
  documents: 'documentFolder',
  email: 'emailFolder',
};

const EXTENSIONS: Record<string, string> = {
  'application/javascript': 'js',
  'text/javascript': 'js',
  'application/x-javascript': 'js',
  'text/css': 'css',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/csv': 'csv',
  'application/json': 'json',
  'application/xml': 'xml',
  'text/xml': 'xml',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
};

export type RetrievedProps = { type: string; fullName: string; fileName: string };

export type SourceWrite = {
  /** Repository path. */
  path: string;
  content: Uint8Array;
  status: 'new' | 'changed' | 'same';
  /** The component the file belongs to. */
  type: string;
  name: string;
  /** What the project has now (text files), for a difference. */
  before?: string;
};

export type ToSourceInput = {
  /** The retrieve's zip and its file properties (as the Metadata API answers). */
  zip: Uint8Array;
  props: RetrievedProps[];
  /** Every file of the project (repository paths) and how to read one. */
  projectFiles: string[];
  read: (path: string) => Promise<Uint8Array | undefined>;
  packageDirs: string[];
  /** The default package directory (new components go to <dir>/main/default). */
  defaultDir: string;
};

export type ToSourceResult = {
  writes: SourceWrite[];
  notConverted: Array<{ type: string; name: string; reason: string }>;
};

const enc = new TextEncoder();
const dec = new TextDecoder();
const keyOf = (type: string, name: string): string => `${type}:${name}`;
const isText = (path: string): boolean =>
  /\.(xml|cls|trigger|page|component|cmp|app|evt|intf|design|auradoc|tokens|js|html|css|svg|json|txt|csv|md|email)$/.test(
    path
  ) || path.endsWith('-meta.xml');

/** A bundle (Aura, LWC…) is listed file by file ("card/card.js"): it is the bundle. */
function bundleName(p: RetrievedProps): string {
  return p.type.endsWith('Bundle') && p.fullName.includes('/') ? p.fullName.split('/')[0] : p.fullName;
}

/** Top-level <element> blocks of an object file (fields, record types…), with their fullName. */
function childBlocks(xml: string, element: string): Array<{ name: string; block: string }> {
  return [...xml.matchAll(new RegExp(`\\n?[ \\t]*<${element}>[\\s\\S]*?</${element}>`, 'g'))].map((m) => ({
    name: /<fullName>([^<]+)<\/fullName>/.exec(m[0])?.[1]?.trim() ?? '',
    block: m[0],
  }));
}

/** One child block as its own source file (its lines moved one level out). */
function childFile(root: string, block: string): string {
  const inner = innerXml(block.trim())
    .split('\n')
    .map((l) => l.replace(/^ {4}/, ''))
    .join('\n');
  return `${XML}\n<${root} xmlns="${NS}">\n    ${inner}\n</${root}>\n`;
}

/** The labels file of the project with the retrieved labels put in (replaced, or added at the end). */
export function mergeLabels(project: string | undefined, retrieved: string): string {
  let xml = project ?? `${XML}\n<CustomLabels xmlns="${NS}">\n</CustomLabels>\n`;
  for (const m of retrieved.matchAll(/<labels>[\s\S]*?<\/labels>/g)) {
    const name = /<fullName>([^<]+)<\/fullName>/.exec(m[0])?.[1]?.trim();
    if (!name) continue;
    const existing = [...xml.matchAll(/<labels>[\s\S]*?<\/labels>/g)].find(
      (b) => /<fullName>([^<]+)<\/fullName>/.exec(b[0])?.[1]?.trim() === name
    );
    xml = existing
      ? xml.replace(existing[0], m[0])
      : xml.replace(/\s*<\/CustomLabels>\s*$/, `\n    ${m[0]}\n</CustomLabels>\n`);
  }
  return xml;
}

/** Turns a retrieve (Metadata API format) into the files it would be in the project. */
export async function toSourceFormat(input: ToSourceInput): Promise<ToSourceResult> {
  const { props, projectFiles, read, packageDirs, defaultDir } = input;
  const zip = new Map(
    [...(await readZip(input.zip))].map(([path, data]) => [path.replace(/^unpackaged\//, ''), data] as const)
  );
  const notConverted: ToSourceResult['notConverted'] = [];
  const out = new Map<string, { content: Uint8Array; type: string; name: string }>();
  const put = (path: string, content: string | Uint8Array, type: string, name: string): void => {
    out.set(path, { content: typeof content === 'string' ? enc.encode(content) : content, type, name });
  };

  // Where each component is in the project now
  const existing = new Map<string, { component: SourceComponent; files: string[] }>();
  for (const path of projectFiles) {
    const c = resolveComponent(path, packageDirs);
    if (!c) continue;
    const key = keyOf(c.type, c.name);
    const found = existing.get(key);
    if (found) found.files.push(path);
    else existing.set(key, { component: c, files: [path] });
  }
  const fallback = `${defaultDir.replace(/\/$/, '')}/main/default`;
  /** The source path of a Metadata API path (classes/A.cls) for a component: where it is, else the default folder. */
  const target = (type: string, name: string, mdPath: string): string => {
    const at = existing.get(keyOf(type, name))?.component;
    if (at?.base !== undefined && at.typeFolder !== undefined && mdPath.startsWith(at.typeFolder))
      return `${at.base}${mdPath.slice(at.typeFolder.length)}`;
    return `${fallback}/${mdPath}`;
  };
  /** Where a type's folder is in the project (for new children of an object, new labels…). */
  const typeBase = (typeFolder: string): string => {
    for (const { component } of existing.values())
      if (component.typeFolder === typeFolder && component.base !== undefined) return component.base;
    return `${fallback}/${typeFolder}`;
  };

  // The retrieved components (a bundle once), and what they are made of
  const components = new Map<string, { type: string; name: string; files: string[] }>();
  for (const p of props) {
    if (p.type === 'Package') continue;
    const name = bundleName(p);
    const key = keyOf(p.type, name);
    const c = components.get(key) ?? { type: p.type, name, files: [] };
    c.files.push(p.fileName.replace(/^unpackaged\//, ''));
    components.set(key, c);
  }

  // Objects: split each object file into the parts that were retrieved
  const objects = new Map<string, { whole: boolean; children: Set<string> }>();
  const labels: string[] = [];
  for (const c of components.values()) {
    if (NOT_CONVERTED.has(c.type)) {
      notConverted.push({ type: c.type, name: c.name, reason: `${c.type} is not converted yet` });
      continue;
    }
    if (c.type === 'CustomLabel' || c.type === 'CustomLabels') {
      labels.push(c.name);
      continue;
    }
    if (c.type === 'CustomObject' || CHILD_ELEMENTS[c.type]) {
      const object = c.type === 'CustomObject' ? c.name : c.name.split('.')[0];
      const o = objects.get(object) ?? { whole: false, children: new Set<string>() };
      if (c.type === 'CustomObject') o.whole = true;
      else o.children.add(keyOf(c.type, c.name));
      objects.set(object, o);
      continue;
    }
    if (c.type === 'StaticResource') {
      const data = zip.get(`staticresources/${c.name}.resource`);
      const meta = zip.get(`staticresources/${c.name}.resource-meta.xml`);
      if (!data || !meta) {
        notConverted.push({ type: c.type, name: c.name, reason: 'the org returned no file for it' });
        continue;
      }
      const base = typeBase('staticresources');
      put(`${base}/${c.name}.resource-meta.xml`, meta, c.type, c.name);
      const type = /<contentType>([^<]+)<\/contentType>/.exec(dec.decode(meta))?.[1]?.trim() ?? '';
      if (/zip/.test(type)) {
        // eslint-disable-next-line no-await-in-loop
        for (const [inner, bytes] of await readZip(data))
          if (!inner.endsWith('/')) put(`${base}/${c.name}/${inner}`, bytes, c.type, c.name);
      } else {
        const known = existing.get(keyOf(c.type, c.name))?.files.find((f) => !f.endsWith('-meta.xml'));
        put(known ?? `${base}/${c.name}.${EXTENSIONS[type] ?? 'resource'}`, data, c.type, c.name);
      }
      continue;
    }
    // Every other type: its files from the zip (a bundle's whole folder)
    const paths = c.type.endsWith('Bundle')
      ? [...zip.keys()].filter((p) => c.files.some((f) => p.startsWith(`${f.split('/').slice(0, 2).join('/')}/`)))
      : [...new Set(c.files.flatMap((f) => [f, `${f}-meta.xml`]))].filter((p) => zip.has(p));
    if (!paths.length) {
      notConverted.push({ type: c.type, name: c.name, reason: 'the org returned no file for it' });
      continue;
    }
    for (const p of paths) {
      const data = zip.get(p)!;
      const folder = /^(reports|dashboards|documents|email)\/([^/]+)-meta\.xml$/.exec(p);
      const document = /^documents\/(.+)\.([^./]+)-meta\.xml$/.exec(p);
      let source = p;
      if (folder) source = `${folder[1]}/${folder[2]}.${FOLDER_SUFFIX[folder[1]]}-meta.xml`;
      else if (document) source = `documents/${document[1]}.document-meta.xml`;
      // An XML-only component (no file of its own next to its -meta.xml): the file gets "-meta.xml"
      else if (
        !p.endsWith('-meta.xml') &&
        !zip.has(`${p}-meta.xml`) &&
        !c.type.endsWith('Bundle') &&
        !p.startsWith('documents/')
      )
        source = `${p}-meta.xml`;
      put(target(c.type, c.name, source), data, c.type, c.name);
    }
  }

  // Objects → the object's own file (when the object itself was retrieved) and one file per child
  for (const [object, wanted] of objects) {
    const data = zip.get(`objects/${object}.object`);
    if (!data) {
      notConverted.push({ type: 'CustomObject', name: object, reason: 'the org returned no file for it' });
      continue;
    }
    let xml = dec.decode(data);
    const base = existing.get(keyOf('CustomObject', object))?.component.base ?? typeBase('objects');
    const objectFolder = base.endsWith(`/${object}`) ? base : `${base}/${object}`;
    for (const [element, child] of Object.entries(CHILDREN)) {
      for (const { name, block } of childBlocks(xml, element)) {
        xml = xml.replace(block, '');
        const full = `${object}.${name}`;
        if (!wanted.whole && !wanted.children.has(keyOf(child.type, full))) continue;
        const at = existing.get(keyOf(child.type, full))?.files[0];
        put(
          at ?? `${objectFolder}/${element}/${name}.${child.suffix}-meta.xml`,
          childFile(child.root, block),
          child.type,
          full
        );
      }
    }
    if (wanted.whole) {
      const own = xml.replace(/\n\s*\n/g, '\n');
      const at = existing.get(keyOf('CustomObject', object))?.files.find((f) => f.endsWith('.object-meta.xml'));
      put(at ?? `${objectFolder}/${object}.object-meta.xml`, own, 'CustomObject', object);
    }
  }

  // Labels → merged into the project's labels file
  if (labels.length) {
    const retrieved = zip.get('labels/CustomLabels.labels');
    if (!retrieved)
      for (const l of labels) notConverted.push({ type: 'CustomLabel', name: l, reason: 'not retrieved' });
    else {
      const file =
        projectFiles.find((f) => resolveComponent(f, packageDirs)?.labels) ??
        `${typeBase('labels')}/CustomLabels.labels-meta.xml`;
      const now = await read(file);
      const merged = mergeLabels(now ? dec.decode(now) : undefined, dec.decode(retrieved));
      put(file, merged, 'CustomLabel', labels.length === 1 ? labels[0] : `${labels.length} labels`);
      // labelBlocks keeps the merge honest: every retrieved label is in the file
      const inFile = labelBlocks(merged);
      for (const l of labels)
        if (!inFile.has(l)) notConverted.push({ type: 'CustomLabel', name: l, reason: 'not in what the org returned' });
    }
  }

  // New, changed or the same as the project
  const writes: SourceWrite[] = [];
  for (const [path, { content, type, name }] of out) {
    // eslint-disable-next-line no-await-in-loop
    const now = await read(path);
    const text = isText(path);
    const before = now && text ? dec.decode(now) : undefined;
    const same = now
      ? text
        ? normalizeCode(before ?? '') === normalizeCode(dec.decode(content))
        : now.length === content.length && now.every((b, i) => b === content[i])
      : false;
    writes.push({ path, content, type, name, status: !now ? 'new' : same ? 'same' : 'changed', before });
  }
  writes.sort((a, b) => a.path.localeCompare(b.path));
  return { writes, notConverted };
}
