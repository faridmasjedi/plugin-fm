// Writes packages/core/src/sourceRegistry.ts from the Salesforce CLI's own metadata registry
// (@salesforce/source-deploy-retrieve), so NomadSF knows every type's source folder and file ending the way the CLI
// does. Run after updating that package: node tools/gen-source-registry.mjs
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../../package.json', import.meta.url)));
const registry = require('@salesforce/source-deploy-retrieve/lib/src/registry/metadataRegistry.json');
const { version } = require('@salesforce/source-deploy-retrieve/package.json');

/** How a type's components sit in source: one file, a file with its -meta.xml beside, a folder, … */
const KIND = {
  none: 'file',
  default: 'file',
  matchingContentFile: 'content',
  bundle: 'bundle',
  decomposed: 'decomposed',
  mixedContent: 'mixed',
  digitalExperience: 'dx',
};

// Types with a source folder (a few bundles have no file ending: they are known by their folder alone)
const types = Object.values(registry.types).filter((t) => t.directoryName);
const folders = {};
const inFolder = {};
const bySuffix = {};
const suffixCount = {};
for (const t of types) if (t.suffix) suffixCount[t.suffix] = (suffixCount[t.suffix] ?? 0) + 1;
for (const t of types.sort((a, b) => a.name.localeCompare(b.name))) {
  const kind = KIND[t.strategies?.adapter ?? 'none'] ?? 'file';
  // A folder shared by several types (reports and report folders…) belongs to the one that is not a folder type
  if (!folders[t.directoryName] || (/Folder$/.test(folders[t.directoryName][0]) && !/Folder$/.test(t.name)))
    folders[t.directoryName] = [t.name, kind];
  if (t.suffix) inFolder[`${t.directoryName}/${t.suffix}`] = t.name;
  // By its ending alone: only an ending no other type has, of a type that may live outside its folder
  if (
    t.suffix &&
    suffixCount[t.suffix] === 1 &&
    !t.strictDirectoryName &&
    !t.folderType &&
    (kind === 'file' || kind === 'content')
  )
    bySuffix[t.suffix] = [t.name, t.directoryName, kind];
}

// One entry per line, quoted the way the code style does it
const key = (k) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`);
const value = (v) => (Array.isArray(v) ? `[${v.map((x) => `'${x}'`).join(', ')}]` : `'${v}'`);
const json = (o) =>
  `{\n${Object.entries(o)
    .map(([k, v]) => `  ${key(k)}: ${value(v)},`)
    .join('\n')}\n}`;
const out = `// Generated from @salesforce/source-deploy-retrieve ${version} by tools/gen-source-registry.mjs — do not edit.
// Every metadata type's source folder and file ending, as the Salesforce CLI knows them.

export type RegistryKind = 'file' | 'content' | 'bundle' | 'decomposed' | 'mixed' | 'dx';

/** Source folder → [type, how its components sit there]. */
export const REGISTRY_FOLDERS: Record<string, [string, RegistryKind]> = ${json(folders)};

/** "folder/ending" → type: for a folder several types share (wave, email, reports…). */
export const REGISTRY_IN_FOLDER: Record<string, string> = ${json(inFolder)};

/** File ending → [type, folder, kind]: one-file types that may be kept outside their folder (endings no other type has). */
export const REGISTRY_SUFFIXES: Record<string, [string, string, RegistryKind]> = ${json(bySuffix)};
`;
const target = fileURLToPath(new URL('../packages/core/src/sourceRegistry.ts', import.meta.url));
writeFileSync(target, out);
console.log(
  `${target}: ${Object.keys(folders).length} folders, ${Object.keys(inFolder).length} folder/endings, ${
    Object.keys(bySuffix).length
  } endings (registry ${version})`
);
