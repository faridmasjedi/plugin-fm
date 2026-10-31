import { labelBlocks, manifestXml, resolveComponent, type SourceComponent } from './sourcePackage.js';
import { makeZip, type ZipEntry } from './zip.js';

/**
 * Source format → Metadata API format, in the browser: what the Metadata API deploy needs from a project's files, like
 * the CLI's conversion. Most types are the same files in the same folders; the differences:
 * - a component that is only its -meta.xml (a permission set, a layout) becomes that file without "-meta.xml";
 * - an object's fields, record types and the like (one file each) go back into objects/<Object>.object;
 * - labels go into labels/CustomLabels.labels with only the labels in the package;
 * - a static resource folder (or file) becomes staticresources/<name>.resource, zipped when it is a folder.
 * Types that need more (Experience sites, object translations) are named as not converted, never guessed.
 */

const NS = 'http://soap.sforce.com/2006/04/metadata';

/** Object children → their element in the object's file. */
const CHILD_ELEMENTS: Record<string, string> = {
  BusinessProcess: 'businessProcesses',
  CompactLayout: 'compactLayouts',
  CustomField: 'fields',
  FieldSet: 'fieldSets',
  Index: 'indexes',
  ListView: 'listViews',
  RecordType: 'recordTypes',
  SharingReason: 'sharingReasons',
  ValidationRule: 'validationRules',
  WebLink: 'webLinks',
};

/** Types not converted yet: the package names them instead of sending something wrong. */
const NOT_CONVERTED = new Set(['ExperienceBundle', 'CustomObjectTranslation', 'DigitalExperienceBundle']);

export type ConvertInput = {
  /** Components to deploy (package.xml) and to delete (destructiveChanges.xml). */
  deploy: Array<{ type: string; name: string }>;
  remove?: Array<{ type: string; name: string }>;
  /** Deletions after the deploy (the default) or before it. */
  removeWhen?: 'post' | 'pre';
  /** Every file of the source (repository paths). */
  files: string[];
  read: (path: string) => Promise<Uint8Array>;
  packageDirs: string[];
  apiVersion: string;
};

export type ConvertResult = {
  /** Metadata API zip: package.xml (+ destructiveChanges) at the root, then the type folders. */
  zip: Uint8Array;
  /** Components that could not be converted, with why: they are not in the zip. */
  notConverted: Array<{ type: string; name: string; reason: string }>;
  /** What went into package.xml. */
  deployed: Array<{ type: string; name: string }>;
};

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const keyOf = (c: { type: string; name: string }): string => `${c.type}:${c.name}`;

/** The inside of a file's root element (an object child's XML without its declaration and root tag). */
export function innerXml(xml: string): string {
  const body = xml.replace(/^\s*<\?xml[^>]*\?>\s*/, '');
  const open = /^<([\w:]+)[^>]*>/.exec(body);
  if (!open) return body.trim();
  const end = body.lastIndexOf(`</${open[1]}>`);
  return body.slice(open[0].length, end < 0 ? undefined : end).trim();
}

/** The labels file with only some labels, for labels/CustomLabels.labels. */
export function labelsFile(xml: string, names: Set<string>): string {
  const kept = [...labelBlocks(xml).keys()].filter((n) => names.has(n));
  const blocks = [...String(xml).matchAll(/<labels>[\s\S]*?<\/labels>/g)]
    .map((m) => m[0])
    .filter((b) => kept.includes(/<fullName>([^<]+)<\/fullName>/.exec(b)?.[1]?.trim() ?? ''));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="${NS}">\n    ${blocks.join(
    '\n    '
  )}\n</CustomLabels>\n`;
}

/** Turns a package of source components into a Metadata API zip. */
export async function toMetadataFormat(input: ConvertInput): Promise<ConvertResult> {
  const { deploy, remove = [], removeWhen = 'post', files, read, packageDirs, apiVersion } = input;
  // Every file of the source, by the component it belongs to
  const byKey = new Map<string, { component: SourceComponent; files: string[] }>();
  for (const path of files) {
    const c = resolveComponent(path, packageDirs);
    if (!c) continue;
    const key = keyOf(c);
    const found = byKey.get(key);
    if (found) found.files.push(path);
    else byKey.set(key, { component: c, files: [path] });
  }
  const wanted = new Set(deploy.map(keyOf));
  const entries: ZipEntry[] = [];
  const notConverted: ConvertResult['notConverted'] = [];
  const deployed: ConvertResult['deployed'] = [];
  const add = (path: string, content: string | Uint8Array): void => {
    if (!entries.some((e) => e.path === path)) entries.push({ path, content });
  };
  /** The path inside the zip: the type folder and what follows it (classes/Hello.cls). */
  const inZip = (path: string, comp: SourceComponent): string =>
    `${comp.typeFolder ?? ''}${path.slice((comp.base ?? '').length)}`;

  // Labels: one file with just the labels of the package
  const labels = deploy.filter((c) => c.type === 'CustomLabel');
  if (labels.length) {
    const labelFiles = files.filter((f) => resolveComponent(f, packageDirs)?.labels);
    const names = new Set(labels.map((l) => l.name));
    let blocks = '';
    const found = new Set<string>();
    for (const f of labelFiles) {
      // eslint-disable-next-line no-await-in-loop
      const xml = text(await read(f));
      for (const [name] of labelBlocks(xml)) if (names.has(name)) found.add(name);
      blocks += innerXml(labelsFile(xml, names));
    }
    add(
      'labels/CustomLabels.labels',
      `<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="${NS}">\n    ${blocks}\n</CustomLabels>\n`
    );
    for (const l of labels) {
      if (found.has(l.name)) deployed.push(l);
      else notConverted.push({ ...l, reason: 'not in the labels file' });
    }
  }

  // Objects: the object's own file (when it is in the package) and the children of the package
  const objects = new Map<string, { own?: string; children: string[] }>();
  const objectOf = (name: string): { own?: string; children: string[] } => {
    const found = objects.get(name);
    if (found) return found;
    const fresh = { children: [] as string[] };
    objects.set(name, fresh);
    return fresh;
  };

  for (const c of deploy) {
    if (c.type === 'CustomLabel') continue;
    const source = byKey.get(keyOf(c));
    if (!source) {
      notConverted.push({ ...c, reason: 'no source file for it' });
      continue;
    }
    if (NOT_CONVERTED.has(c.type)) {
      notConverted.push({ ...c, reason: `${c.type} is not converted yet` });
      continue;
    }
    const comp = source.component;
    const childElement = CHILD_ELEMENTS[c.type];
    if (childElement && comp.object) {
      // eslint-disable-next-line no-await-in-loop
      const xml = text(await read(source.files[0]));
      objectOf(comp.object).children.push(`    <${childElement}>\n        ${innerXml(xml)}\n    </${childElement}>`);
      deployed.push(c);
      continue;
    }
    if (c.type === 'CustomObject') {
      // eslint-disable-next-line no-await-in-loop
      objectOf(c.name).own = text(await read(source.files[0]));
      deployed.push(c);
      continue;
    }
    if (c.type === 'StaticResource') {
      const meta = source.files.find((f) => f.endsWith('.resource-meta.xml'));
      const content = source.files.filter((f) => f !== meta);
      if (!meta || !content.length) {
        notConverted.push({ ...c, reason: 'a static resource needs its file (or folder) and its .resource-meta.xml' });
        continue;
      }
      const single = content.length === 1 && !content[0].startsWith(`${comp.folder ?? ''}/`);
      const bytes = single
        ? // eslint-disable-next-line no-await-in-loop
          await read(content[0])
        : makeZip(
            // eslint-disable-next-line no-await-in-loop
            await Promise.all(
              content.map(async (f) => ({ path: f.slice((comp.folder ?? '').length + 1), content: await read(f) }))
            )
          );
      add(`staticresources/${c.name}.resource`, bytes);
      // eslint-disable-next-line no-await-in-loop
      add(`staticresources/${c.name}.resource-meta.xml`, await read(meta));
      deployed.push(c);
      continue;
    }
    for (const f of source.files) {
      const zipPath = inZip(f, comp);
      // A component that is only its -meta.xml: the file without "-meta.xml" (X.permissionset-meta.xml → X.permissionset)
      const onlyMeta = source.files.length === 1 && f.endsWith('-meta.xml') && !comp.folder;
      // A folder of reports (reports/Sales.reportFolder-meta.xml) is reports/Sales-meta.xml
      const folderMeta = /\.(report|dashboard|document|email)Folder-meta\.xml$/.exec(f);
      const path = folderMeta
        ? zipPath.replace(/\.\w+Folder-meta\.xml$/, '-meta.xml')
        : onlyMeta
        ? zipPath.replace(/-meta\.xml$/, '')
        : zipPath;
      // eslint-disable-next-line no-await-in-loop
      add(path, await read(f));
    }
    deployed.push(c);
  }

  for (const [name, { own, children }] of objects) {
    const base = own ? innerXml(own) : '';
    add(
      `objects/${name}.object`,
      `<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="${NS}">\n${[base ? `    ${base}` : '', ...children]
        .filter(Boolean)
        .join('\n')}\n</CustomObject>\n`
    );
  }

  const removing = remove.filter((c) => !wanted.has(keyOf(c)));
  entries.unshift({ path: 'package.xml', content: manifestXml(deployed, apiVersion) });
  if (removing.length)
    entries.push({
      path: removeWhen === 'pre' ? 'destructiveChangesPre.xml' : 'destructiveChangesPost.xml',
      content: manifestXml(removing, apiVersion),
    });
  return { zip: makeZip(entries), notConverted, deployed };
}
