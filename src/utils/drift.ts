import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Drift: differences between what the repository says and what the org has, usually changes
 * made directly in Setup. Files are matched by their path from the metadata type folder
 * (classes/A.cls, objects/Account/fields/X.field-meta.xml), so the package directory layout
 * of the repository and of the retrieve do not matter.
 */

export type DriftItem = { key: string; status: 'changed' | 'only-in-org' | 'only-in-repo'; repoPath?: string };
export type DriftReport = {
  compared: number;
  changed: DriftItem[];
  onlyInOrg: DriftItem[];
  onlyInRepo: DriftItem[];
  drift: boolean;
};

/** Type folders as they appear in source format (subset that matters for drift). */
const TYPE_FOLDERS = new Set([
  'applications',
  'aura',
  'classes',
  'components',
  'contentassets',
  'customMetadata',
  'customPermissions',
  'dashboards',
  'documents',
  'duplicateRules',
  'email',
  'experiences',
  'flexipages',
  'flows',
  'globalValueSets',
  'groups',
  'labels',
  'layouts',
  'lwc',
  'matchingRules',
  'messageChannels',
  'namedCredentials',
  'objects',
  'objectTranslations',
  'omniDataTransforms',
  'omniIntegrationProcedures',
  'omniScripts',
  'omniUiCard',
  'pages',
  'pathAssistants',
  'permissionsetgroups',
  'permissionsets',
  'profiles',
  'queues',
  'quickActions',
  'remoteSiteSettings',
  'reports',
  'reportTypes',
  'roles',
  'sharingRules',
  'standardValueSets',
  'staticresources',
  'tabs',
  'translations',
  'triggers',
  'workflows',
  'genAiFunctions',
  'genAiPlannerBundles',
  'genAiPlugins',
  'genAiPromptTemplates',
  'externalCredentials',
  'platformEventChannels',
  'cachePartitions',
]);

/** Key of a source file: its path from the type folder, or undefined when it is not metadata. */
export function metadataKey(path: string): string | undefined {
  const parts = path.split(/[\\/]/);
  const index = parts.findIndex((p) => TYPE_FOLDERS.has(p));
  return index >= 0 && index < parts.length - 1 ? parts.slice(index).join('/') : undefined;
}

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) visit(full);
      else out.push(full);
    }
  };
  visit(root);
  return out;
}

/** Ignores formatting a retrieve changes: line endings, trailing spaces, whitespace between XML tags. */
export function normalize(content: string, xml: boolean): string {
  const text = content
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
  return xml ? text.replace(/>\s+</g, '><') : text;
}

export function compareTrees(repoRoots: string[], orgRoot: string, base = ''): DriftReport {
  const repo = new Map<string, string>();
  for (const root of repoRoots) {
    for (const file of walk(root)) {
      const key = metadataKey(relative(root, file).split(sep).join('/'));
      if (key) repo.set(key, file);
    }
  }
  const org = new Map<string, string>();
  for (const file of walk(orgRoot)) {
    const key = metadataKey(relative(orgRoot, file).split(sep).join('/'));
    if (key) org.set(key, file);
  }
  const shown = (file: string): string => (base ? relative(base, file).split(sep).join('/') : file);
  const changed: DriftItem[] = [];
  const onlyInOrg: DriftItem[] = [];
  for (const [key, orgFile] of org) {
    const repoFile = repo.get(key);
    if (!repoFile) {
      onlyInOrg.push({ key, status: 'only-in-org' });
      continue;
    }
    const xml = key.endsWith('.xml');
    if (normalize(readFileSync(repoFile, 'utf8'), xml) !== normalize(readFileSync(orgFile, 'utf8'), xml)) {
      changed.push({ key, status: 'changed', repoPath: shown(repoFile) });
    }
  }
  const onlyInRepo = [...repo]
    .filter(([key]) => !org.has(key))
    .map(([key, file]) => ({ key, status: 'only-in-repo' as const, repoPath: shown(file) }));
  const sort = (items: DriftItem[]): DriftItem[] => items.sort((a, b) => a.key.localeCompare(b.key));
  return {
    compared: org.size,
    changed: sort(changed),
    onlyInOrg: sort(onlyInOrg),
    onlyInRepo: sort(onlyInRepo),
    drift: changed.length + onlyInOrg.length + onlyInRepo.length > 0,
  };
}

export function driftMarkdown(report: DriftReport, org: string): string {
  const section = (title: string, items: DriftItem[]): string =>
    items.length
      ? `\n### ${title} (${items.length})\n\n${items
          .slice(0, 200)
          .map((i) => `- \`${i.key}\``)
          .join('\n')}\n`
      : '';
  return `## Drift: ${org}\n\n${
    report.drift ? '⚠️ The org differs from the repository.' : '✅ The org matches the repository.'
  } Compared ${report.compared} file(s).\n${section('Changed in the org', report.changed)}${section(
    'In the org, not in the repository',
    report.onlyInOrg
  )}${section('In the repository, missing in the org', report.onlyInRepo)}`;
}
