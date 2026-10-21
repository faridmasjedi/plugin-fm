#!/usr/bin/env node
// Sets one version on everything a release ships: the sf fm plugin, the browser extension,
// the VS Code extension and the desktop app. The release workflow runs it with the tag's
// version (v1.1.0 → 1.1.0); run it by hand to sync main: node scripts/set-version.mjs 1.1.0
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = (process.argv[2] ?? '').replace(/^v/, '');
// Chrome accepts 1–4 dot-separated numbers; VS Code needs semver: plain x.y.z suits both
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/set-version.mjs <major.minor.patch>');
  process.exit(1);
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'package.json',
  'nomadsf/apps/extension/package.json',
  'nomadsf/apps/vscode/package.json',
  'nomadsf/apps/desktop/package.json',
];
for (const file of files) {
  const path = join(root, file);
  const text = readFileSync(path, 'utf8');
  // Only the top-level "version" (keeps formatting and the rest of the file as is)
  const next = text.replace(/^(\s{2}"version":\s*")[^"]*(")/m, `$1${version}$2`);
  if (next === text && !text.includes(`"version": "${version}"`)) throw new Error(`No version field in ${file}`);
  writeFileSync(path, next);
  console.log(`${file}: ${version}`);
}
