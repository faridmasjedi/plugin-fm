import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Logger } from './types.js';

export type QualityEngine = 'code-analyzer' | 'pmd' | 'eslint';

/** 1 = Critical, 2 = High, 3 = Moderate, 4 = Low, 5 = Info (Code Analyzer / PMD scale). */
export type Severity = 1 | 2 | 3 | 4 | 5;

export const SEVERITY_LABELS: Record<Severity, string> = {
  1: 'Critical',
  2: 'High',
  3: 'Moderate',
  4: 'Low',
  5: 'Info',
};

export type Violation = {
  engine: QualityEngine;
  rule: string;
  severity: Severity;
  file: string;
  line?: number;
  column?: number;
  message: string;
  url?: string;
};

export type EngineRun = {
  engine: QualityEngine;
  status: 'completed' | 'skipped' | 'error';
  reason?: string;
  /** Sub-engines that could not run (e.g. Code Analyzer's PMD without Java). */
  warnings?: string[];
  filesScanned: number;
  violations: number;
  durationMs: number;
};

export type QualityOptions = {
  cwd: string;
  files: string[];
  engines: QualityEngine[];
  ruleSelectors: string[];
  pmdRuleset?: string;
  codeAnalyzerConfig?: string;
  workDir: string;
};

const APEX_EXTENSIONS = new Set(['.cls', '.trigger']);
const VF_EXTENSIONS = new Set(['.page', '.component']);
const JS_EXTENSIONS = new Set(['.js', '.ts', '.mjs']);
const SCANNABLE_EXTENSIONS = new Set([...APEX_EXTENSIONS, ...VF_EXTENSIONS, ...JS_EXTENSIONS, '.html', '.xml']);

const PMD_RULESET_CANDIDATES = [
  'ruleset.xml',
  'pmd-ruleset.xml',
  'pmd/ruleset.xml',
  'config/pmd/ruleset.xml',
  '.pmd/ruleset.xml',
];
const CODE_ANALYZER_CONFIG_CANDIDATES = ['code-analyzer.yml', 'code-analyzer.yaml'];
const ESLINT_CONFIG_CANDIDATES = [
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  '.eslintrc.json',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc',
];

// PMD category file names -> Code Analyzer rule tags
const PMD_CATEGORY_TAGS: Record<string, string> = {
  bestpractices: 'BestPractices',
  codestyle: 'CodeStyle',
  design: 'Design',
  documentation: 'Documentation',
  errorprone: 'ErrorProne',
  multithreading: 'Multithreading',
  performance: 'Performance',
  security: 'Security',
};

export function findFirstExisting(cwd: string, candidates: string[]): string | undefined {
  return candidates.map((c) => resolve(cwd, c)).find((p) => existsSync(p));
}

export function findPmdRuleset(cwd: string): string | undefined {
  return findFirstExisting(cwd, PMD_RULESET_CANDIDATES);
}

export function findCodeAnalyzerConfig(cwd: string): string | undefined {
  return findFirstExisting(cwd, CODE_ANALYZER_CONFIG_CANDIDATES);
}

export function filterScannableFiles(files: string[], cwd: string): string[] {
  return files.filter((f) => SCANNABLE_EXTENSIONS.has(extname(f)) && existsSync(resolve(cwd, f)));
}

function commandSucceeds(cmd: string, args: string[], cwd: string): boolean {
  const res = spawnSync(cmd, args, { cwd, stdio: 'ignore', timeout: 60_000 });
  return res.status === 0;
}

export function isCodeAnalyzerAvailable(cwd: string): boolean {
  return commandSucceeds('sf', ['code-analyzer', 'run', '--help'], cwd);
}

export function isPmdAvailable(cwd: string): boolean {
  return commandSucceeds('pmd', ['--version'], cwd);
}

function localEslintBin(cwd: string): string | undefined {
  const bin = resolve(cwd, 'node_modules', '.bin', 'eslint');
  return existsSync(bin) ? bin : undefined;
}

export function isEslintAvailable(cwd: string): boolean {
  return Boolean(localEslintBin(cwd)) && Boolean(findFirstExisting(cwd, ESLINT_CONFIG_CANDIDATES));
}

/**
 * Picks engines when the user did not choose any. Code Analyzer already bundles
 * PMD and ESLint, so it is used alone when installed.
 */
export function detectEngines(cwd: string, pmdRuleset?: string): QualityEngine[] {
  if (isCodeAnalyzerAvailable(cwd)) return ['code-analyzer'];
  const engines: QualityEngine[] = [];
  if (pmdRuleset && isPmdAvailable(cwd)) engines.push('pmd');
  if (isEslintAvailable(cwd)) engines.push('eslint');
  return engines;
}

/**
 * Translates a PMD ruleset.xml into Code Analyzer rule selectors so the rules it
 * references are selected (e.g. "pmd:ApexCRUDViolation", "pmd:Security").
 */
export function pmdRulesetToSelectors(rulesetXml: string): string[] {
  const selectors = new Set<string>();
  for (const match of rulesetXml.matchAll(/<rule\s+[^>]*?(ref|name)\s*=\s*"([^"]+)"/g)) {
    const [, attr, value] = match;
    if (attr === 'name') {
      selectors.add(`pmd:${value}`);
      continue;
    }
    const parts = value.split('/');
    const last = parts[parts.length - 1];
    if (last.endsWith('.xml')) {
      const tag = PMD_CATEGORY_TAGS[last.replace('.xml', '').toLowerCase()];
      if (tag) selectors.add(`pmd:${tag}`);
    } else {
      selectors.add(`pmd:${last}`);
    }
  }
  return [...selectors];
}

function toRelative(cwd: string, file: string): string {
  const rel = isAbsolute(file) ? relative(cwd, file) : file;
  return rel.split('\\').join('/');
}

function clampSeverity(value: number): Severity {
  return Math.min(5, Math.max(1, Math.round(value))) as Severity;
}

type CodeAnalyzerJson = {
  violations?: Array<{
    rule: string;
    engine: string;
    severity: number;
    message: string;
    primaryLocationIndex?: number;
    locations?: Array<{ file?: string; startLine?: number; startColumn?: number }>;
    resources?: string[];
  }>;
};

type EngineOutput = { violations: Violation[]; warnings?: string[] };

function runCodeAnalyzer(options: QualityOptions, logger: Logger): EngineOutput {
  const { cwd, files, workDir } = options;
  const outFile = join(workDir, 'code-analyzer-results.json');
  const selectors = [...options.ruleSelectors];
  let configFile = options.codeAnalyzerConfig;

  // A PMD ruleset without a Code Analyzer config: register it and select its rules
  if (options.pmdRuleset && !configFile) {
    configFile = join(workDir, 'code-analyzer.generated.yml');
    writeFileSync(configFile, `engines:\n  pmd:\n    custom_rulesets:\n      - "${options.pmdRuleset}"\n`);
    selectors.push(...pmdRulesetToSelectors(readFileSync(options.pmdRuleset, 'utf8')));
    logger.log(`Using PMD ruleset ${toRelative(cwd, options.pmdRuleset)} with Code Analyzer`);
  }

  const args = ['code-analyzer', 'run', '--workspace', cwd, '--output-file', outFile];
  for (const file of files) args.push('--target', file);
  for (const selector of selectors) args.push('--rule-selector', selector);
  if (configFile) args.push('--config-file', configFile);

  const res = spawnSync('sf', args, { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  if (!existsSync(outFile)) {
    throw new Error(`Code Analyzer did not produce results: ${res.stderr || res.stdout}`);
  }

  const json = JSON.parse(readFileSync(outFile, 'utf8')) as CodeAnalyzerJson;
  const all = json.violations ?? [];

  // Code Analyzer reports engines that could not start (e.g. PMD without Java) as violations
  const isEngineError = (v: { rule: string }): boolean => v.rule.endsWith('EngineError');
  const warnings = all
    .filter(isEngineError)
    .map(
      (v) =>
        `${v.engine} did not run: ${v.message
          .split('\n')[0]
          .replace(/^The engine with name '[^']+' could not be instantiated\. /, '')}`
    );

  const violations = all
    .filter((v) => !isEngineError(v))
    .map((v) => {
      const loc = v.locations?.[v.primaryLocationIndex ?? 0] ?? {};
      return {
        engine: 'code-analyzer',
        rule: `${v.engine}:${v.rule}`,
        severity: clampSeverity(v.severity),
        file: loc.file ? toRelative(cwd, loc.file) : '',
        line: loc.startLine,
        column: loc.startColumn,
        message: v.message,
        url: v.resources?.[0],
      } satisfies Violation;
    });
  return { violations, warnings };
}

type PmdJson = {
  files?: Array<{
    filename: string;
    violations: Array<{
      beginline: number;
      begincolumn: number;
      description: string;
      rule: string;
      priority: number;
      externalInfoUrl?: string;
    }>;
  }>;
};

function runPmd(options: QualityOptions): EngineOutput {
  const { cwd, workDir } = options;
  if (!options.pmdRuleset) throw new Error('PMD needs a ruleset (--pmd-ruleset or ruleset.xml in the repository).');

  const files = options.files.filter((f) => APEX_EXTENSIONS.has(extname(f)) || VF_EXTENSIONS.has(extname(f)));
  if (files.length === 0) return { violations: [] };

  const fileList = join(workDir, 'pmd-files.txt');
  const outFile = join(workDir, 'pmd-results.json');
  writeFileSync(fileList, files.map((f) => resolve(cwd, f)).join('\n'));

  spawnSync(
    'pmd',
    [
      'check',
      '--file-list',
      fileList,
      '-R',
      options.pmdRuleset,
      '-f',
      'json',
      '-r',
      outFile,
      '--no-progress',
      '--no-fail-on-violation',
    ],
    { cwd, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 }
  );
  if (!existsSync(outFile)) throw new Error('PMD did not produce a report.');

  const json = JSON.parse(readFileSync(outFile, 'utf8')) as PmdJson;
  const violations = (json.files ?? []).flatMap((f) =>
    f.violations.map((v) => ({
      engine: 'pmd' as const,
      rule: `pmd:${v.rule}`,
      severity: clampSeverity(v.priority),
      file: toRelative(cwd, f.filename),
      line: v.beginline,
      column: v.begincolumn,
      message: v.description,
      url: v.externalInfoUrl,
    }))
  );
  return { violations };
}

type EslintJson = Array<{
  filePath: string;
  messages: Array<{ ruleId: string | null; severity: number; message: string; line?: number; column?: number }>;
}>;

function runEslint(options: QualityOptions): EngineOutput {
  const { cwd } = options;
  const bin = localEslintBin(cwd);
  if (!bin) throw new Error('ESLint is not installed in this repository (node_modules/.bin/eslint).');

  const files = options.files.filter((f) => JS_EXTENSIONS.has(extname(f)));
  if (files.length === 0) return { violations: [] };

  // ESLint exits 1 when it finds errors, so read stdout regardless of the exit code
  const res = spawnSync(bin, ['--format', 'json', '--no-error-on-unmatched-pattern', ...files], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  if (!res.stdout) throw new Error(`ESLint failed: ${res.stderr}`);

  const json = JSON.parse(res.stdout) as EslintJson;
  const violations = json.flatMap((f) =>
    f.messages.map((m) => ({
      engine: 'eslint' as const,
      rule: `eslint:${m.ruleId ?? 'parse-error'}`,
      severity: (m.severity === 2 ? 2 : 4) as Severity,
      file: toRelative(cwd, f.filePath),
      line: m.line,
      column: m.column,
      message: m.message,
    }))
  );
  return { violations };
}

const ENGINE_RUNNERS: Record<QualityEngine, (options: QualityOptions, logger: Logger) => EngineOutput> = {
  'code-analyzer': runCodeAnalyzer,
  pmd: runPmd,
  eslint: runEslint,
};

export function runQualityEngines(
  options: QualityOptions,
  logger: Logger
): { violations: Violation[]; runs: EngineRun[] } {
  mkdirSync(options.workDir, { recursive: true });
  const violations: Violation[] = [];
  const runs: EngineRun[] = [];

  for (const engine of options.engines) {
    const start = Date.now();
    logger.log(`Running ${engine} on ${options.files.length} file(s)...`);
    try {
      const output = ENGINE_RUNNERS[engine](options, logger);
      violations.push(...output.violations);
      for (const warning of output.warnings ?? []) logger.warn(warning);
      runs.push({
        engine,
        status: 'completed',
        ...(output.warnings?.length ? { warnings: output.warnings } : {}),
        filesScanned: options.files.length,
        violations: output.violations.length,
        durationMs: Date.now() - start,
      });
    } catch (error) {
      logger.warn(`${engine} failed: ${(error as Error).message}`);
      runs.push({
        engine,
        status: 'error',
        reason: (error as Error).message,
        filesScanned: 0,
        violations: 0,
        durationMs: Date.now() - start,
      });
    }
  }

  violations.sort((a, b) => a.severity - b.severity || a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0));
  return { violations, runs };
}

export function countBySeverity(violations: Violation[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const v of violations) counts[v.severity]++;
  return counts;
}

function sarifLevel(severity: Severity): 'error' | 'warning' | 'note' {
  if (severity <= 2) return 'error';
  return severity === 3 ? 'warning' : 'note';
}

/**
 * Builds a SARIF 2.1.0 log (one run per engine) for GitHub code scanning.
 */
export function toSarif(violations: Violation[], engines: QualityEngine[]): Record<string, unknown> {
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: engines.map((engine) => {
      const own = violations.filter((v) => v.engine === engine);
      const rules = [...new Map(own.map((v) => [v.rule, v])).values()].map((v) => ({
        id: v.rule,
        ...(v.url ? { helpUri: v.url } : {}),
      }));
      return {
        tool: { driver: { name: `plugin-fm/${engine}`, rules } },
        results: own.map((v) => ({
          ruleId: v.rule,
          level: sarifLevel(v.severity),
          message: { text: v.message },
          properties: { severity: v.severity },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: v.file },
                region: { startLine: v.line ?? 1, ...(v.column ? { startColumn: v.column } : {}) },
              },
            },
          ],
        })),
      };
    }),
  };
}

export function toMarkdown(
  violations: Violation[],
  runs: EngineRun[],
  threshold: number,
  passed: boolean,
  maxRows = 50
): string {
  const counts = countBySeverity(violations);
  const lines = [
    `## ${passed ? '✅' : '❌'} Code quality`,
    '',
    `Severity threshold: **${threshold} (${SEVERITY_LABELS[threshold as Severity]})** — ${
      passed ? 'no violations at or above it' : 'violations at or above it were found'
    }`,
    '',
    '| Critical | High | Moderate | Low | Info |',
    '|---|---|---|---|---|',
    `| ${counts[1]} | ${counts[2]} | ${counts[3]} | ${counts[4]} | ${counts[5]} |`,
    '',
    '| Engine | Status | Violations | Time |',
    '|---|---|---|---|',
    ...runs.map(
      (r) =>
        `| ${r.engine} | ${r.status}${r.reason ? `: ${r.reason}` : ''} | ${r.violations} | ${(
          r.durationMs / 1000
        ).toFixed(1)}s |`
    ),
  ];

  const warnings = runs.flatMap((r) => r.warnings ?? []);
  if (warnings.length > 0) lines.push('', ...warnings.map((w) => `> ⚠️ ${w}`));

  if (violations.length > 0) {
    lines.push('', '| Severity | Rule | Location | Message |', '|---|---|---|---|');
    for (const v of violations.slice(0, maxRows)) {
      lines.push(
        `| ${SEVERITY_LABELS[v.severity]} | ${v.url ? `[${v.rule}](${v.url})` : v.rule} | \`${v.file}${
          v.line ? `:${v.line}` : ''
        }\` | ${v.message.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`
      );
    }
    if (violations.length > maxRows) lines.push('', `…and ${violations.length - maxRows} more (see quality.json).`);
  }
  return lines.join('\n') + '\n';
}
