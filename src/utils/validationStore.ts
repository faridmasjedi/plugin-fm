import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * "Validate on the pull request, quick deploy on merge": a successful validation is recorded
 * against a fingerprint of the exact package it validated. A later deployment of the same
 * package to the same org reuses it (quick deploy, no second test run). Recorded in
 * .fm/validations.json and, for CI where jobs do not share files, optionally as a git tag.
 */

export const VALIDATION_TAG_PREFIX = 'sf-validation';
const STORE = '.fm/validations.json';
/** Salesforce keeps a validation usable for quick deploy for 10 days. */
const MAX_AGE_MS = 10 * 24 * 60 * 60 * 1000;

export type ValidationRecord = {
  orgId: string;
  fingerprint: string;
  validationId: string;
  at: string;
  commit?: string;
};

/** SHA-256 over every file of the package directory (paths and contents), order-independent. */
export function packageFingerprint(dir: string): string {
  const root = resolve(dir);
  if (!existsSync(root)) throw new Error(`Package directory not found: ${dir}`);
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  const hash = createHash('sha256');
  for (const file of files.map((f) => relative(root, f).split(sep).join('/')).sort()) {
    hash.update(`${file}\0`);
    hash.update(readFileSync(join(root, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readStore(cwd: string): ValidationRecord[] {
  try {
    return JSON.parse(readFileSync(resolve(cwd, STORE), 'utf8')) as ValidationRecord[];
  } catch {
    return [];
  }
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const tagName = (orgId: string, fingerprint: string): string =>
  `${VALIDATION_TAG_PREFIX}/${orgId.slice(0, 15)}/${fingerprint.slice(0, 16)}`;

export function recordValidation(
  cwd: string,
  record: Omit<ValidationRecord, 'at'>,
  options: { tag?: boolean; push?: boolean; remote?: string } = {}
): ValidationRecord {
  const entry = { ...record, at: new Date().toISOString() };
  const path = resolve(cwd, STORE);
  mkdirSync(dirname(path), { recursive: true });
  const kept = readStore(cwd).filter(
    (r) => Date.now() - Date.parse(r.at) < MAX_AGE_MS && r.fingerprint !== record.fingerprint
  );
  writeFileSync(path, `${JSON.stringify([entry, ...kept].slice(0, 50), null, 2)}\n`);
  if (options.tag) {
    const name = tagName(record.orgId, record.fingerprint);
    git(['tag', '-f', '-a', name, '-m', JSON.stringify(entry)], cwd);
    if (options.push) git(['push', '-f', options.remote ?? 'origin', `refs/tags/${name}`], cwd);
  }
  return entry;
}

function fromTag(cwd: string, orgId: string, fingerprint: string, remote: string): ValidationRecord | undefined {
  const name = tagName(orgId, fingerprint);
  const read = (): string => git(['tag', '-l', '--format=%(contents)', name], cwd);
  try {
    let message = read();
    if (!message) {
      git(['fetch', '--quiet', remote, `+refs/tags/${name}:refs/tags/${name}`], cwd);
      message = read();
    }
    return message ? (JSON.parse(message) as ValidationRecord) : undefined;
  } catch {
    return undefined;
  }
}

/** A usable validation of this exact package in this org (younger than 10 days), if any. */
export function findValidation(
  cwd: string,
  orgId: string,
  fingerprint: string,
  remote = 'origin'
): ValidationRecord | undefined {
  const fresh = (r?: ValidationRecord): ValidationRecord | undefined =>
    r && r.orgId === orgId && r.fingerprint === fingerprint && Date.now() - Date.parse(r.at) < MAX_AGE_MS
      ? r
      : undefined;
  return (
    fresh(readStore(cwd).find((r) => r.orgId === orgId && r.fingerprint === fingerprint)) ??
    fresh(fromTag(cwd, orgId, fingerprint, remote))
  );
}
