import { existsSync, readFileSync } from 'node:fs';
import type { Metric, StageUses } from './types.js';

type AnyRecord = Record<string, unknown>;

/** Parses a package.xml into { MetadataType: [members] }. */
export function parsePackageXml(path: string): Record<string, string[]> {
  if (!existsSync(path)) return {};
  const xml = readFileSync(path, 'utf8');
  const components: Record<string, string[]> = {};
  for (const block of xml.matchAll(/<types>([\s\S]*?)<\/types>/g)) {
    const name = /<name>([^<]+)<\/name>/.exec(block[1])?.[1];
    if (!name) continue;
    const members = [...block[1].matchAll(/<members>([^<]+)<\/members>/g)].map((m) => m[1]);
    components[name] = [...(components[name] ?? []), ...members];
  }
  return components;
}

function countMembers(components: Record<string, string[]>): number {
  return Object.values(components).reduce((sum, members) => sum + members.length, 0);
}

function summarizeBuild(result: AnyRecord): { metrics: Metric[]; result: AnyRecord } {
  const stats = (result.statistics ?? {}) as AnyRecord;
  const manifests = (result.manifests ?? {}) as AnyRecord;
  const packageXmls = ([] as unknown[]).concat(manifests.packageXml ?? []).map(String);

  const components: Record<string, string[]> = {};
  for (const path of packageXmls) {
    for (const [type, members] of Object.entries(parsePackageXml(path))) {
      components[type] = [...(components[type] ?? []), ...members];
    }
  }
  const destructive = parsePackageXml(String(manifests.destructiveChangesXml ?? ''));

  // With --waves every wave has its own manifests; show them per wave and in total
  const waves = (result.waves ?? []) as Array<AnyRecord & { manifests?: AnyRecord }>;
  const waveDetails = waves.map((wave) => {
    const waveComponents: Record<string, string[]> = {};
    for (const path of ([] as unknown[]).concat(wave.manifests?.packageXml ?? []).map(String)) {
      for (const [type, members] of Object.entries(parsePackageXml(path))) {
        waveComponents[type] = [...(waveComponents[type] ?? []), ...members];
      }
    }
    const waveDestructive = parsePackageXml(String(wave.manifests?.destructiveChangesXml ?? ''));
    if (!wave.isDefault) {
      for (const [type, members] of Object.entries(waveComponents))
        components[type] = [...(components[type] ?? []), ...members];
      for (const [type, members] of Object.entries(waveDestructive))
        destructive[type] = [...(destructive[type] ?? []), ...members];
    }
    return { ...wave, components: waveComponents, destructive: waveDestructive };
  });

  return {
    metrics: [
      { label: 'Components', value: countMembers(components) },
      {
        label: 'Destructive',
        value: countMembers(destructive),
        tone: countMembers(destructive) > 0 ? 'warn' : 'neutral',
      },
      { label: 'Files changed', value: Number(stats.totalChanged ?? 0) },
      { label: 'Files deleted', value: Number(stats.totalDeleted ?? 0) },
      { label: 'Ignored', value: Number(stats.totalIgnored ?? 0) },
      ...(waves.length ? [{ label: 'Waves', value: waves.filter((w) => w.hasChanges).length }] : []),
    ],
    result: { ...result, components, destructive, ...(waves.length ? { waves: waveDetails } : {}) },
  };
}

function summarizeQuality(result: AnyRecord): { metrics: Metric[]; result: AnyRecord } {
  const counts = (result.counts ?? {}) as Record<string, number>;
  const violations = (result.violations ?? []) as unknown[];
  return {
    metrics: [
      { label: 'Critical', value: counts['1'] ?? 0, tone: (counts['1'] ?? 0) > 0 ? 'bad' : 'good' },
      { label: 'High', value: counts['2'] ?? 0, tone: (counts['2'] ?? 0) > 0 ? 'bad' : 'good' },
      { label: 'Moderate', value: counts['3'] ?? 0, tone: (counts['3'] ?? 0) > 0 ? 'warn' : 'neutral' },
      { label: 'Low / Info', value: (counts['4'] ?? 0) + (counts['5'] ?? 0) },
      { label: 'Files scanned', value: Number(result.filesScanned ?? 0) },
    ],
    // Keep the run file small: the full list stays in quality.json
    result: { ...result, violations: violations.slice(0, 200), violationsTruncated: violations.length > 200 },
  };
}

function summarizeDeploy(result: AnyRecord): { metrics: Metric[]; result: AnyRecord } {
  const metrics: Metric[] = [
    { label: 'Status', value: String(result.status ?? ''), tone: result.status === 'Succeeded' ? 'good' : 'bad' },
    { label: 'Components', value: Number(result.deployedComponents ?? 0) },
    {
      label: 'Failed',
      value: Number(result.failedComponents ?? 0),
      tone: Number(result.failedComponents) > 0 ? 'bad' : 'neutral',
    },
    { label: 'Tests', value: `${Number(result.testsPassed ?? 0)}/${Number(result.testsRun ?? 0)}` },
  ];
  if (result.codeCoverage !== undefined) metrics.push({ label: 'Coverage', value: `${String(result.codeCoverage)}%` });
  return { metrics, result };
}

function summarizeDuplicates(result: AnyRecord): { metrics: Metric[]; result: AnyRecord } {
  const total = Number(result.totalDuplicates ?? 0);
  return { metrics: [{ label: 'Duplicates', value: total, tone: total > 0 ? 'bad' : 'good' }], result };
}

function summarizeRunbook(record: AnyRecord): { metrics: Metric[]; result: AnyRecord } {
  const steps = (record.steps ?? []) as Array<{ status: string }>;
  const actions = (record.actions ?? []) as Array<{ status: string; kind: string }>;
  const done = steps.filter((s) => s.status === 'done').length;
  const pr = record.pullRequest as { url?: string } | undefined;
  return {
    metrics: [
      {
        label: 'Steps done',
        value: `${done}/${steps.length}`,
        tone: steps.some((s) => s.status === 'failed') ? 'bad' : 'neutral',
      },
      { label: 'Org changes', value: actions.filter((a) => a.kind === 'org' && a.status === 'ok').length },
      { label: 'Manual', value: actions.filter((a) => a.kind === 'manual').length },
      {
        label: 'Rejected',
        value: actions.filter((a) => a.status === 'rejected').length,
        tone: actions.some((a) => a.status === 'rejected') ? 'warn' : 'neutral',
      },
      ...(pr?.url ? [{ label: 'Pull request', value: 'opened', tone: 'good' as const }] : []),
    ],
    result: record,
  };
}

function summarizeE2e(record: AnyRecord): { metrics: Metric[]; result: AnyRecord } {
  const stats = (record.stats ?? {}) as Record<string, number>;
  return {
    metrics: [
      { label: 'Passed', value: stats.passed ?? 0, tone: 'good' },
      { label: 'Failed', value: stats.failed ?? 0, tone: (stats.failed ?? 0) > 0 ? 'bad' : 'neutral' },
      { label: 'Flaky', value: stats.flaky ?? 0, tone: (stats.flaky ?? 0) > 0 ? 'warn' : 'neutral' },
      { label: 'Skipped', value: stats.skipped ?? 0 },
    ],
    result: record,
  };
}

const SUMMARIZERS: Partial<Record<StageUses, (record: AnyRecord) => { metrics: Metric[]; result: unknown }>> = {
  build: summarizeBuild,
  quality: summarizeQuality,
  deploy: summarizeDeploy,
  'check-duplicates': summarizeDuplicates,
  'ai-runbook': summarizeRunbook,
  e2e: summarizeE2e,
  drift: (record) => {
    const count = (key: string): number => ((record[key] as unknown[]) ?? []).length;
    return {
      metrics: [
        { label: 'Changed in org', value: count('changed'), tone: count('changed') ? 'bad' : 'good' },
        { label: 'Only in org', value: count('onlyInOrg'), tone: count('onlyInOrg') ? 'warn' : 'neutral' },
        { label: 'Missing in org', value: count('onlyInRepo'), tone: count('onlyInRepo') ? 'warn' : 'neutral' },
        { label: 'Compared', value: Number(record.compared ?? 0) },
      ],
      result: record,
    };
  },
  tag: (record) => ({ metrics: [{ label: 'Tag', value: String(record.tag ?? ''), tone: 'good' }], result: record }),
};

export function summarizeStage(uses: StageUses, result: unknown): { metrics: Metric[]; result: unknown } {
  if (!result || typeof result !== 'object') return { metrics: [], result };
  const record = result as AnyRecord;
  const summarize = SUMMARIZERS[uses];
  if (summarize) return summarize(record);
  return {
    metrics:
      'exitCode' in record
        ? [{ label: 'Exit code', value: Number(record.exitCode), tone: record.exitCode === 0 ? 'good' : 'bad' }]
        : [],
    result,
  };
}
