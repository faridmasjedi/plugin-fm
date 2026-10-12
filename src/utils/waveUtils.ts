import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import ignore from 'ignore';
import { MetadataResolver, RegistryAccess } from '@salesforce/source-deploy-retrieve';
import { parse } from 'yaml';

/**
 * Deployment waves: the changed files are split into ordered artifacts that are
 * deployed one after another (e.g. Data Cloud -> everything else -> OmniStudio).
 */

export const TYPE_GROUPS: Record<string, string[]> = {
  'data-cloud': [
    'ActivationPlatform',
    'DataCalcInsightTemplate',
    'DataConnectorIngestApi',
    'DataConnectorS3',
    'DataKitObjectDependency',
    'DataKitObjectTemplate',
    'DataObjectBuildOrgTemplate',
    'DataObjectSearchIndexConf',
    'DataPackageKitDefinition',
    'DataPackageKitObject',
    'DataSource',
    'DataSourceBundleDefinition',
    'DataSourceObject',
    'DataSourceTenant',
    'DataSrcDataModelFieldMap',
    'DataStreamDefinition',
    'DataStreamTemplate',
    'ExternalDataConnector',
    'ExternalDataTranObject',
    'InternalDataConnector',
    'MarketSegmentDefinition',
    'MktCalcInsightObjectDef',
    'MktDataConnection',
    'MktDataConnectionSrcParam',
    'MktDataTranObject',
    'ObjectSourceTargetMap',
  ],
  omnistudio: [
    'OmniDataTransform',
    'OmniExtTrackingDef',
    'OmniIntegrationProcedure',
    'OmniInteractionAccessConfig',
    'OmniInteractionConfig',
    'OmniScript',
    'OmniTrackingGroup',
    'OmniUiCard',
    'OmniscriptDefinition',
  ],
  agentforce: [
    'AiAuthoringBundle',
    'AiEvaluationDefinition',
    'Bot',
    'BotBlock',
    'BotTemplate',
    'BotVersion',
    'GenAiFunction',
    'GenAiPlanner',
    'GenAiPlannerBundle',
    'GenAiPlugin',
    'GenAiPromptTemplate',
    'GenAiPromptTemplateActv',
  ],
};

export type WaveConfig = {
  id: string;
  name?: string;
  description?: string;
  /** Metadata type names; '@data-cloud', '@omnistudio', '@agentforce' expand to built-in groups. */
  types?: string[];
  /** .gitignore-style path patterns, relative to the repository root. */
  paths?: string[];
  /** Catch-all wave for everything no other wave claims. Exactly one wave has it. */
  default?: boolean;
};

export type WavesConfig = { waves: WaveConfig[] };

export const DEFAULT_WAVES_FILES = ['.fm/waves.yml', '.fm/waves.yaml'];

export const DEFAULT_WAVES: WavesConfig = {
  waves: [
    { id: 'data-cloud', name: 'Data Cloud', types: ['@data-cloud'] },
    { id: 'core', name: 'Core metadata', default: true },
    { id: 'omnistudio', name: 'OmniStudio', types: ['@omnistudio'] },
  ],
};

export function validateWaves(config: Partial<WavesConfig>): WavesConfig {
  const errors: string[] = [];
  const waves = config.waves ?? [];
  if (waves.length === 0) errors.push('"waves" must be a non-empty list.');
  const ids = new Set<string>();
  for (const [index, wave] of waves.entries()) {
    if (!wave.id || !/^[A-Za-z0-9_-]+$/.test(wave.id))
      errors.push(`waves[${index}]: "id" is required (letters, digits, - and _).`);
    else if (ids.has(wave.id)) errors.push(`waves[${index}]: duplicate id "${wave.id}".`);
    else ids.add(wave.id);
    for (const type of wave.types ?? []) {
      if (type.startsWith('@') && !TYPE_GROUPS[type.slice(1)]) {
        errors.push(
          `waves[${index}]: unknown type group "${type}" (use ${Object.keys(TYPE_GROUPS)
            .map((g) => `@${g}`)
            .join(', ')}).`
        );
      }
    }
  }
  if (waves.filter((w) => w.default).length !== 1) errors.push('Exactly one wave must have "default: true".');
  if (errors.length > 0) throw new Error(`Invalid waves file:\n  - ${errors.join('\n  - ')}`);
  return { waves };
}

export function loadWaves(path?: string): WavesConfig {
  if (!path) return DEFAULT_WAVES;
  return validateWaves((parse(readFileSync(path, 'utf8')) as Partial<WavesConfig> | null) ?? {});
}

export function findWavesFile(cwd: string): string | undefined {
  return DEFAULT_WAVES_FILES.map((f) => resolve(cwd, f)).find((p) => existsSync(p));
}

function expandTypes(types: string[] = []): Set<string> {
  return new Set(types.flatMap((t) => (t.startsWith('@') ? TYPE_GROUPS[t.slice(1)] ?? [] : [t])));
}

/**
 * Resolves the metadata type of a file. Existing files use the source resolver;
 * deleted files fall back to the registry (file suffix, then folder name).
 */
export class MetadataTypeDetector {
  private readonly resolver = new MetadataResolver();
  private readonly registry = new RegistryAccess();
  private readonly byDirectory = new Map<string, string>();

  public constructor(private readonly cwd: string) {
    for (const type of Object.values(this.registry.getRegistry().types)) {
      this.byDirectory.set(type.directoryName, type.name);
    }
  }

  public typeOf(file: string): string | undefined {
    const fullPath = resolve(this.cwd, file);
    if (existsSync(fullPath)) {
      try {
        const [component] = this.resolver.getComponentsFromPath(fullPath);
        if (component) return (component.parent?.type ?? component.type).name;
      } catch {
        // Fall through to the registry lookup
      }
    }

    const name = basename(file).replace(/-meta\.xml$/, '');
    const suffix = name.includes('.') ? name.substring(name.lastIndexOf('.') + 1) : undefined;
    if (suffix) {
      const type = this.registry.getTypeBySuffix(suffix);
      if (type) return (this.registry.getParentType(type.id) ?? type).name;
    }
    // Walk up the folders: force-app/main/default/<directoryName>/...
    for (let dir = dirname(file); dir && dir !== '.' && dir !== '/'; dir = dirname(dir)) {
      const type = this.byDirectory.get(basename(dir));
      if (type) return type;
    }
    return undefined;
  }
}

export type WaveAssignment = {
  wave: WaveConfig;
  index: number;
  changedFiles: string[];
  deletedFiles: string[];
  /** Metadata types found in this wave's files. */
  types: string[];
};

/**
 * Splits changed and deleted files into waves. A file goes to the first wave (in file
 * order) whose paths or types match it; anything unmatched goes to the default wave.
 */
export function assignWaves(
  files: { changedFiles: string[]; deletedFiles: string[] },
  config: WavesConfig,
  detector: { typeOf: (file: string) => string | undefined }
): WaveAssignment[] {
  const matchers = config.waves.map((wave) => ({
    wave,
    paths: wave.paths?.length ? ignore().add(wave.paths) : undefined,
    types: expandTypes(wave.types),
  }));
  const assignments = config.waves.map((wave, index) => ({
    wave,
    index,
    changedFiles: [] as string[],
    deletedFiles: [] as string[],
    types: new Set<string>(),
  }));
  const defaultIndex = config.waves.findIndex((w) => w.default);

  const place = (file: string, kind: 'changedFiles' | 'deletedFiles'): void => {
    const type = detector.typeOf(file);
    const index = matchers.findIndex(
      (m) => !m.wave.default && ((m.paths?.ignores(file) ?? false) || (type !== undefined && m.types.has(type)))
    );
    const target = assignments[index === -1 ? defaultIndex : index];
    target[kind].push(file);
    if (type) target.types.add(type);
  };
  files.changedFiles.forEach((f) => place(f, 'changedFiles'));
  files.deletedFiles.forEach((f) => place(f, 'deletedFiles'));

  return assignments.map((a) => ({ ...a, types: [...a.types].sort() }));
}

/** Which well-known product areas a set of metadata types touches. */
export function detectProductAreas(types: string[]): { dataCloud: boolean; agentforce: boolean; omnistudio: boolean } {
  const has = (group: string): boolean => types.some((t) => TYPE_GROUPS[group].includes(t));
  return { dataCloud: has('data-cloud'), agentforce: has('agentforce'), omnistudio: has('omnistudio') };
}
