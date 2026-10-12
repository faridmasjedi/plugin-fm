import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { runProcess } from './scriptRunner.js';

/**
 * Playwright end-to-end scenarios against a Salesforce org. Tests log in through the
 * org's frontdoor URL (as `sf org open` does), so no passwords are stored anywhere.
 */

export const E2E_DIR = '.fm/e2e';
export const E2E_TEST_DIR = 'tests/e2e';

export type E2eTest = {
  title: string;
  file: string;
  status: string;
  durationMs: number;
  error?: string;
  retries: number;
};

export type E2eResult = {
  org: string;
  passed: boolean;
  exitCode: number;
  stats: { passed: number; failed: number; flaky: number; skipped: number; durationMs: number };
  tests: E2eTest[];
  reportDir: string;
  resultsFile: string;
};

/** Frontdoor URL (with a fresh session) and instance URL from the Salesforce CLI. */
export function orgSession(cwd: string, org: string): { frontdoorUrl: string; instanceUrl: string; username: string } {
  const res = spawnSync('sf', ['org', 'open', '--url-only', '--target-org', org, '--json'], { cwd, encoding: 'utf8' });
  const parsed = JSON.parse(res.stdout || '{}') as {
    status?: number;
    result?: { url?: string; username?: string };
    message?: string;
  };
  if (parsed.status !== 0 || !parsed.result?.url)
    throw new Error(parsed.message ?? `Could not open a session for ${org}.`);
  const url = new URL(parsed.result.url);
  return { frontdoorUrl: parsed.result.url, instanceUrl: url.origin, username: parsed.result.username ?? org };
}

type PwSuite = { title?: string; file?: string; specs?: PwSpec[]; suites?: PwSuite[] };
type PwSpec = {
  title: string;
  file?: string;
  tests?: Array<{
    status?: string;
    results?: Array<{ status: string; duration: number; error?: { message?: string } }>;
  }>;
};
type PwReport = {
  suites?: PwSuite[];
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number; duration?: number };
};

/** Flattens Playwright's JSON report into one row per test. */
export function parsePlaywrightReport(report: PwReport): Pick<E2eResult, 'stats' | 'tests'> {
  const tests: E2eTest[] = [];
  const walk = (suite: PwSuite, path: string[]): void => {
    const here = suite.title ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const results = test.results ?? [];
        const last = results[results.length - 1];
        const status =
          test.status === 'expected'
            ? 'passed'
            : test.status === 'unexpected'
            ? 'failed'
            : test.status ?? last?.status ?? 'unknown';
        tests.push({
          title: [...here.slice(1), spec.title].join(' › '),
          file: spec.file ?? suite.file ?? '',
          status,
          durationMs: results.reduce((sum, r) => sum + (r.duration ?? 0), 0),
          error: results
            .find((r) => r.error)
            // eslint-disable-next-line no-control-regex -- strips ANSI colours from Playwright messages
            ?.error?.message?.replace(/\u001b\[[0-9;]*m/g, '')
            .slice(0, 2000),
          retries: Math.max(0, results.length - 1),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  const s = report.stats ?? {};
  return {
    stats: {
      passed: s.expected ?? 0,
      failed: s.unexpected ?? 0,
      flaky: s.flaky ?? 0,
      skipped: s.skipped ?? 0,
      durationMs: Math.round(s.duration ?? 0),
    },
    tests,
  };
}

export async function runE2e(options: {
  cwd: string;
  org: string;
  grep?: string;
  project?: string;
  headed?: boolean;
  onOutput?: (chunk: string) => void;
}): Promise<E2eResult> {
  const { cwd, org } = options;
  const session = orgSession(cwd, org);
  const outDir = resolve(cwd, E2E_DIR);
  // Reports hold screenshots and traces of the org: keep them out of git
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(join(outDir, '.gitignore')))
    writeFileSync(join(outDir, '.gitignore'), '# Test reports with org data: never commit\n*\n');
  const resultsFile = join(outDir, 'results.json');
  const reportDir = join(outDir, 'report');

  const args = ['playwright', 'test', '--reporter=json,html'];
  if (options.grep) args.push('--grep', options.grep);
  if (options.project) args.push('--project', options.project);
  if (options.headed) args.push('--headed');

  const res = await runProcess('npx', args, {
    cwd,
    env: {
      ...process.env,
      SF_FRONTDOOR_URL: session.frontdoorUrl,
      SF_INSTANCE_URL: session.instanceUrl,
      SF_USERNAME: session.username,
      FM_TARGET_ORG: org,
      PLAYWRIGHT_JSON_OUTPUT_NAME: resultsFile,
      PLAYWRIGHT_HTML_REPORT: reportDir,
      PLAYWRIGHT_HTML_OPEN: 'never',
    },
    onOutput: options.onOutput,
  });

  const parsed = existsSync(resultsFile)
    ? parsePlaywrightReport(JSON.parse(readFileSync(resultsFile, 'utf8')) as PwReport)
    : { stats: { passed: 0, failed: 0, flaky: 0, skipped: 0, durationMs: 0 }, tests: [] };
  return {
    org,
    passed: res.exitCode === 0 && parsed.stats.failed === 0,
    exitCode: res.exitCode,
    ...parsed,
    reportDir: relative(cwd, reportDir),
    resultsFile: relative(cwd, resultsFile),
  };
}

/** Spec files under tests/e2e. */
export function listSpecs(cwd: string): string[] {
  const root = resolve(cwd, E2E_TEST_DIR);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(spec|test)\.[cm]?[jt]s$/.test(entry)) out.push(relative(cwd, full).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

export const PLAYWRIGHT_CONFIG = `import { defineConfig, devices } from '@playwright/test';

// Scenarios run against the org given to 'sf fm e2e run --target-org <org>'.
// SF_FRONTDOOR_URL / SF_INSTANCE_URL are provided by plugin-fm; no passwords are stored.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  use: {
    baseURL: process.env.SF_INSTANCE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Video needs Playwright's ffmpeg (npx playwright install); off when using a system browser
    video: process.env.PW_CHANNEL ? 'off' : 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL } }],
});
`;

export const FIXTURES_TS = `import { test as base, expect } from '@playwright/test';

/** A page that is already logged in to the target org (via the frontdoor URL). */
export const test = base.extend({
  page: async ({ page }, use) => {
    const frontdoor = process.env.SF_FRONTDOOR_URL;
    if (!frontdoor) throw new Error('Run the tests with: sf fm e2e run --target-org <org>');
    await page.goto(frontdoor);
    await page.waitForURL(/lightning\\.force\\.com|\\/lightning\\//, { timeout: 60_000 });
    await use(page);
  },
});

export { expect };
`;

export const SMOKE_SPEC_TS = `import { test, expect } from './fixtures';

test.describe('Smoke', () => {
  test('the home page loads', async ({ page }) => {
    await page.goto('/lightning/page/home');
    await expect(page.locator('one-app-nav-bar, .slds-global-header')).toBeVisible();
  });

  test('a Case can be opened from the Cases list', async ({ page }) => {
    await page.goto('/lightning/o/Case/list');
    await expect(page.getByRole('heading', { name: /Cases/ })).toBeVisible();
  });
});
`;
