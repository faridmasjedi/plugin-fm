import type { SalesforceClient } from './client.js';
import { listMetadata, packageXml, retrieveZip, type MetadataComponent } from './metadata.js';
import { fromBase64, makeZip, readZip, toBase64 } from './zip.js';

/**
 * Differences between two orgs (sandbox ↔ sandbox, sandbox ↔ production): which components
 * exist where, which differ in content, and a deployable package of the difference.
 */

const FOLDER_BASED = new Set(['Report', 'Dashboard', 'Document', 'EmailTemplate']);

export type OrgDiffStatus = 'only in source' | 'only in target' | 'in both' | 'different' | 'same';
export type OrgDiffRow = { type: string; name: string; status: OrgDiffStatus; key: string };

/** Your own components (no installed packages or other namespaces). */
const own = (c: MetadataComponent): boolean =>
  (!c.manageableState || c.manageableState === 'unmanaged') && !c.namespacePrefix;

/** Lists the chosen types in both orgs. */
export async function compareOrgs(
  source: SalesforceClient,
  target: SalesforceClient,
  types: string[],
  onProgress?: (done: number, total: number, type: string) => void
): Promise<{ rows: OrgDiffRow[]; skipped: number }> {
  const rows: OrgDiffRow[] = [];
  let skipped = 0;
  for (let i = 0; i < types.length; i++) {
    const type = types[i];
    onProgress?.(i, types.length, type);
    const folder = FOLDER_BASED.has(type);
    // eslint-disable-next-line no-await-in-loop
    const [a, b] = await Promise.all([listMetadata(source, type, folder), listMetadata(target, type, folder)]);
    const left = a.filter((c) => c.type === type);
    const right = b.filter((c) => c.type === type);
    skipped += left.filter((c) => !own(c)).length + right.filter((c) => !own(c)).length;
    const inSource = new Set(left.filter(own).map((c) => c.fullName));
    const inTarget = new Set(right.filter(own).map((c) => c.fullName));
    for (const name of [...new Set([...inSource, ...inTarget])].sort()) {
      const status: OrgDiffStatus =
        inSource.has(name) && inTarget.has(name) ? 'in both' : inSource.has(name) ? 'only in source' : 'only in target';
      rows.push({ type, name, status, key: `${type}:${name}` });
    }
  }
  onProgress?.(types.length, types.length, '');
  return { rows, skipped };
}

/** Ignores formatting a retrieve can change: line endings, trailing spaces, whitespace between tags. */
export function sameContent(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (!a || !b) return a === b;
  const text = (bytes: Uint8Array): string =>
    new TextDecoder()
      .decode(bytes)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+$/gm, '')
      .replace(/>\s+</g, '><')
      .trim();
  return text(a) === text(b);
}

/** Files of each component in a retrieved zip: its file, its -meta.xml, or everything under a bundle folder. */
/**
 * The component a retrieved file belongs to. A bundle (Aura, LWC…) is listed file by file
 * ("acmeWelcome/acmeWelcome.cmp"): it is the bundle, with its whole folder.
 */
function componentOf(props: MetadataComponent): MetadataComponent {
  if (!props.type.endsWith('Bundle') || !props.fullName.includes('/')) return props;
  const name = props.fullName.split('/')[0];
  const folder = props.fileName.slice(0, props.fileName.indexOf(`/${name}/`) + name.length + 1);
  return { ...props, fullName: name, fileName: folder };
}

function filesOf(component: MetadataComponent, zip: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  const main = component.fileName.replace(/^unpackaged\//, '');
  for (const [path, data] of zip) {
    const p = path.replace(/^unpackaged\//, '');
    if (p === main || p === `${main}-meta.xml` || p.startsWith(`${main}/`)) out.set(p, data);
  }
  return out;
}

const CHUNK = 500;

/** Retrieves the components from both orgs (in chunks) and marks each as different or same. */
export async function compareContent(
  source: SalesforceClient,
  target: SalesforceClient,
  rows: OrgDiffRow[],
  onProgress?: (done: number, total: number) => void
): Promise<Map<string, 'different' | 'same'>> {
  const result = new Map<string, 'different' | 'same'>();
  const both = rows.filter((r) => r.status === 'in both' || r.status === 'different' || r.status === 'same');
  for (let i = 0; i < both.length; i += CHUNK) {
    onProgress?.(i, both.length);
    const chunk = both.slice(i, i + CHUNK).map((r) => ({ type: r.type, fullName: r.name }));
    // eslint-disable-next-line no-await-in-loop
    const [a, b] = await Promise.all([retrieveZip(source, chunk), retrieveZip(target, chunk)]);
    // eslint-disable-next-line no-await-in-loop
    const [zipA, zipB] = await Promise.all([
      a.zipFile ? readZip(fromBase64(a.zipFile)) : new Map<string, Uint8Array>(),
      b.zipFile ? readZip(fromBase64(b.zipFile)) : new Map<string, Uint8Array>(),
    ]);
    const propsB = new Map(b.files.map(componentOf).map((f) => [`${f.type}:${f.fullName}`, f]));
    const propsA = new Map(a.files.map(componentOf).map((f) => [`${f.type}:${f.fullName}`, f]));
    for (const fa of propsA.values()) {
      const key = `${fa.type}:${fa.fullName}`;
      const fb = propsB.get(key);
      if (!fb || fa.type === 'Package') continue;
      const filesA = filesOf(fa, zipA);
      const filesB = filesOf(fb, zipB);
      const paths = new Set([...filesA.keys(), ...filesB.keys()]);
      const same = [...paths].every((p) => sameContent(filesA.get(p), filesB.get(p)));
      result.set(key, same ? 'same' : 'different');
    }
  }
  onProgress?.(both.length, both.length);
  return result;
}

export type DiffPackage = { packageXml: string; destructiveXml?: string; zipBase64: string; components: number };

/**
 * A deployable package of the difference: the chosen components retrieved from the source
 * (metadata format, package.xml at the root), plus destructiveChangesPost.xml for deletions.
 */
export async function buildDiffPackage(
  source: SalesforceClient,
  deploy: Array<{ type: string; name: string }>,
  remove: Array<{ type: string; name: string }> = [],
  onProgress?: (status: string) => void,
  /** Deletions after the deploy (destructiveChangesPost.xml) or before it (destructiveChangesPre.xml). */
  removeWhen: 'pre' | 'post' = 'post'
): Promise<DiffPackage> {
  if (!deploy.length && !remove.length) throw new Error('Choose components for the package.');
  const version = await source.version();
  const files = new Map<string, Uint8Array>();
  const deployComponents = deploy.map((d) => ({ type: d.type, fullName: d.name }));
  if (deploy.length) {
    const retrieved = await retrieveZip(source, deployComponents, {
      onProgress: (s) => onProgress?.(`Retrieving from the source: ${s}`),
    });
    if (!retrieved.zipFile) throw new Error(retrieved.errorMessage ?? 'The source org returned no files.');
    const zip = await readZip(fromBase64(retrieved.zipFile));
    // Only the files of the chosen components (a retrieve can bring related ones)
    const wanted = new Set(deploy.map((d) => `${d.type}:${d.name}`));
    for (const props of retrieved.files.map(componentOf)) {
      if (!wanted.has(`${props.type}:${props.fullName}`)) continue;
      for (const [path, data] of filesOf(props, zip)) files.set(path, data);
    }
  }
  // The manifest always lists exactly what was chosen
  const manifest = packageXml(deployComponents, version);
  files.set('package.xml', new TextEncoder().encode(manifest));
  const destructiveXml = remove.length
    ? packageXml(
        remove.map((r) => ({ type: r.type, fullName: r.name })),
        version
      )
    : undefined;
  if (destructiveXml)
    files.set(
      removeWhen === 'pre' ? 'destructiveChangesPre.xml' : 'destructiveChangesPost.xml',
      new TextEncoder().encode(destructiveXml)
    );
  return {
    packageXml: manifest,
    destructiveXml,
    zipBase64: toBase64(makeZip([...files].map(([path, content]) => ({ path, content })))),
    components: deploy.length + remove.length,
  };
}
