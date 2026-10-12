import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { PIPELINE_EVENTS, STAGE_USES, type PipelineConfig, type StageConfig } from './types.js';

export const DEFAULT_PIPELINE_FILES = ['.fm/pipeline.yml', '.fm/pipeline.yaml', '.fm/pipeline.json'];

export class PipelineConfigError extends Error {}

export function loadPipelineConfig(path: string): PipelineConfig {
  if (!existsSync(path)) throw new PipelineConfigError(`Pipeline file not found: ${path}`);
  const raw = parse(readFileSync(path, 'utf8')) as Partial<PipelineConfig> | null;
  return validatePipelineConfig(raw ?? {});
}

export function validatePipelineConfig(raw: Partial<PipelineConfig>): PipelineConfig {
  const errors: string[] = [];
  if (!Array.isArray(raw.stages) || raw.stages.length === 0) errors.push('"stages" must be a non-empty list.');

  const ids = new Set<string>();
  (raw.stages ?? []).forEach((stage: Partial<StageConfig>, index) => {
    const where = `stages[${index}]${stage.id ? ` (${stage.id})` : ''}`;
    if (!stage.id || !/^[A-Za-z0-9_-]+$/.test(stage.id))
      errors.push(`${where}: "id" is required (letters, digits, - and _).`);
    else if (ids.has(stage.id)) errors.push(`${where}: duplicate id.`);
    else ids.add(stage.id);

    if (!stage.uses || !(STAGE_USES as readonly string[]).includes(stage.uses)) {
      errors.push(`${where}: "uses" must be one of ${STAGE_USES.join(', ')}.`);
    }
    if (stage.uses === 'ai-runbook' && !stage.with?.['target-org']) {
      errors.push(`${where}: "with.target-org" is required for uses: ai-runbook.`);
    }
    if (stage.uses === 'tag' && !stage.with?.branch) {
      errors.push(`${where}: "with.branch" is required for uses: tag.`);
    }
    if ((stage.uses === 'script' || stage.uses === 'shell' || stage.uses === 'ai-runbook') && !stage.run) {
      errors.push(`${where}: "run" is required for uses: ${stage.uses}.`);
    }
    const events = stage.on;
    if (
      events !== undefined &&
      (!Array.isArray(events) || events.some((e) => !(PIPELINE_EVENTS as readonly string[]).includes(e)))
    ) {
      errors.push(`${where}: "on" must be a list of ${PIPELINE_EVENTS.join(', ')}.`);
    }
    if (stage.if && !['success', 'failure', 'always'].includes(stage.if)) {
      errors.push(`${where}: "if" must be success, failure or always.`);
    }
  });

  if (errors.length > 0) throw new PipelineConfigError(`Invalid pipeline file:\n  - ${errors.join('\n  - ')}`);
  return { name: raw.name ?? 'Salesforce pipeline', ...raw } as PipelineConfig;
}

const FALSY = new Set(['', 'false', '0', 'no', 'off', 'null', 'undefined']);

/** Truthiness for `when:` values: false, 0, empty and "false"/"no"/"off" strings are false. */
export function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0) return false;
  if (typeof value === 'string') return !FALSY.has(value.trim().toLowerCase());
  return true;
}

export type InterpolationContext = {
  env: NodeJS.ProcessEnv;
  run: Record<string, string>;
  stages: Record<string, { status: string; result?: unknown }>;
};

function lookup(context: InterpolationContext, expression: string): unknown {
  const path = expression.trim().split('.');
  let value: unknown = context;
  for (const key of path) {
    if (value === null || value === undefined || typeof value !== 'object') return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * Replaces ${env.X}, ${run.id|release|branch|commit} and ${stages.<id>.result.<path>}.
 * A string that is exactly one expression keeps the value's type (e.g. booleans).
 */
export function interpolate<T>(value: T, context: InterpolationContext): T {
  if (typeof value === 'string') {
    const whole = /^\$\{([^}]+)\}$/.exec(value);
    if (whole) {
      const resolved = lookup(context, whole[1]);
      if (resolved === undefined) throw new PipelineConfigError(`Cannot resolve \${${whole[1]}}`);
      return resolved as T;
    }
    return value.replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
      const resolved = lookup(context, expr);
      if (resolved === undefined) throw new PipelineConfigError(`Cannot resolve \${${expr}}`);
      return String(resolved);
    }) as T;
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v as unknown, context)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, context)])) as T;
  }
  return value;
}

/**
 * Converts a `with:` map into CLI arguments: true -> --flag, false/null -> omitted,
 * arrays -> repeated flags, anything else -> --flag value.
 */
export function toArgv(withFlags: Record<string, unknown> = {}): string[] {
  const argv: string[] = [];
  for (const [key, value] of Object.entries(withFlags)) {
    if (value === false || value === null || value === undefined) continue;
    if (value === true) argv.push(`--${key}`);
    else if (Array.isArray(value)) value.forEach((v) => argv.push(`--${key}`, String(v)));
    else argv.push(`--${key}`, String(value));
  }
  return argv;
}
