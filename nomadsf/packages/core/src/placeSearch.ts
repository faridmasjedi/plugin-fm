/**
 * Finding a place from what someone wants to do ("stop a batch job", "who can edit cases"): their words against each
 * place's phrases, forgiving word forms (deploying → deploy), common Salesforce synonyms (perm set → permission set),
 * small typos and word order. No AI, nothing sent anywhere.
 */

const STOP = new Set(
  'a an the to of in on for from with and or my our your i we me is are be do does can could should would want need how what which who where why when it its this that these those there here into by at as all any some see show find get let please about one'.split(
    ' '
  )
);

/** Words that mean the same here: each maps to one form. */
const SAME: Record<string, string> = {
  permset: 'permissionset',
  permsets: 'permissionset',
  psg: 'permissionsetgroup',
  perm: 'permission',
  perms: 'permission',
  access: 'permission',
  rights: 'permission',
  privilege: 'permission',
  remove: 'delete',
  erase: 'delete',
  purge: 'delete',
  wipe: 'delete',
  drop: 'delete',
  kill: 'stop',
  abort: 'stop',
  cancel: 'stop',
  halt: 'stop',
  sandbox: 'org',
  environment: 'org',
  instance: 'org',
  production: 'org',
  prod: 'org',
  uat: 'org',
  diff: 'compare',
  difference: 'compare',
  differences: 'compare',
  differ: 'compare',
  versus: 'compare',
  vs: 'compare',
  release: 'deploy',
  push: 'deploy',
  ship: 'deploy',
  pull: 'retrieve',
  fetch: 'retrieve',
  download: 'export',
  extract: 'export',
  load: 'import',
  upload: 'import',
  dataloader: 'import',
  insert: 'import',
  upsert: 'import',
  csv: 'csv',
  excel: 'csv',
  spreadsheet: 'csv',
  repo: 'project',
  repository: 'project',
  git: 'branch',
  branches: 'branch',
  apex: 'apex',
  soql: 'query',
  sql: 'query',
  search: 'query',
  record: 'record',
  records: 'record',
  rows: 'record',
  batch: 'job',
  queueable: 'job',
  future: 'job',
  scheduled: 'schedule',
  cron: 'schedule',
  trigger: 'trigger',
  flow: 'flow',
  flows: 'flow',
  workflow: 'automation',
  process: 'automation',
  automations: 'automation',
  log: 'log',
  logs: 'log',
  debug: 'log',
  trace: 'log',
  login: 'login',
  logged: 'login',
  logon: 'login',
  logins: 'login',
  signin: 'login',
  users: 'user',
  people: 'user',
  person: 'user',
  member: 'user',
  members: 'user',
  backup: 'backup',
  restore: 'backup',
  snapshot: 'backup',
  anonymize: 'anonymize',
  mask: 'anonymize',
  gdpr: 'anonymize',
  scramble: 'anonymize',
  limit: 'limit',
  limits: 'limit',
  storage: 'storage',
  space: 'storage',
  copy: 'copy',
  clone: 'copy',
  migrate: 'copy',
  move: 'copy',
  seed: 'copy',
  field: 'field',
  fields: 'field',
  column: 'field',
  columns: 'field',
  object: 'object',
  objects: 'object',
  table: 'object',
  sobject: 'object',
  id: 'id',
  ids: 'id',
  test: 'test',
  tests: 'test',
  coverage: 'coverage',
  oauth: 'connectedapp',
  connectedapp: 'connectedapp',
  token: 'connectedapp',
  tokens: 'connectedapp',
  edit: 'change',
  update: 'change',
  modify: 'change',
  change: 'change',
  set: 'change',
  ai: 'ai',
  llm: 'ai',
  gpt: 'ai',
  claude: 'ai',
};

/** Two-word names written as one (permission set → permissionset). */
const JOINED: Array<[RegExp, string]> = [
  [/\bpermission set groups?\b/g, 'permissionsetgroup'],
  [/\bperm(?:ission)? sets?\b/g, 'permissionset'],
  [/\bconnected apps?\b/g, 'connectedapp'],
  [/\bsign ?in\b/g, 'signin'],
  [/\bdata ?loader\b/g, 'dataloader'],
  [/\brecord ?types?\b/g, 'recordtype'],
  [/\bpage ?layouts?\b/g, 'layout'],
  [/\bvalidation rules?\b/g, 'validationrule'],
  [/\bpackage\.xml\b/g, 'packagexml'],
  [/\bdestructive ?changes\b/g, 'destructive'],
];

/** A word's base: plural and -ing / -ed endings off (deploying → deploy, users → user). */
export function stem(word: string): string {
  // A last e off too, so save / saved / saving meet (sav)
  const end = (x: string): string => (x.length > 3 && x.endsWith('e') ? x.slice(0, -1) : x);
  const w = word.toLowerCase();
  if (SAME[w]) return end(SAME[w]);
  let base = w;
  if (base.length > 5 && base.endsWith('ing')) base = base.slice(0, -3);
  else if (base.length > 4 && base.endsWith('ied')) base = `${base.slice(0, -3)}y`;
  else if (base.length > 4 && base.endsWith('ed')) base = base.slice(0, -2);
  else if (base.length > 4 && base.endsWith('ies')) base = `${base.slice(0, -3)}y`;
  else if (base.length > 3 && base.endsWith('es') && /(ss|x|ch|sh)es$/.test(base)) base = base.slice(0, -2);
  else if (base.length > 3 && base.endsWith('s') && !base.endsWith('ss')) base = base.slice(0, -1);
  return end(SAME[base] ?? base);
}

/** The meaningful words of a text, as stems. */
export function words(text: string): string[] {
  let t = text.toLowerCase();
  for (const [re, joined] of JOINED) t = t.replace(re, joined);
  return t
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/** Two orgs or two users named ("prod and uat", "ann and bob"…) mean the places for two of them. */
const PAIRS = new Set([stem('org'), stem('user')]);

/** At most one letter added, removed, changed or two swapped. */
function nearlySame(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 5) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  if (a.slice(i + 1) === b.slice(i + 1)) return true;
  if (a.slice(i) === b.slice(i + 1) || a.slice(i + 1) === b.slice(i)) return true;
  return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

/** How well one typed word matches a place's words: 1 the same, less for a start or a typo. */
function wordScore(typed: string, known: string[]): number {
  let best = 0;
  for (const k of known) {
    if (k === typed) return 1;
    if (typed.length >= 3 && k.startsWith(typed)) best = Math.max(best, 0.75);
    else if (k.length >= 4 && typed.startsWith(k)) best = Math.max(best, 0.6);
    else if (nearlySame(typed, k)) best = Math.max(best, 0.7);
  }
  return best;
}

export type Place = {
  /** What it does, in the words people use ("stop a running batch job"). */
  say: string;
  /** More words that should find it. */
  also?: string;
};

/**
 * The places that fit what was typed, best first, with a score 0–1: how much of what was typed they cover (words
 * of `say` count more than `also`).
 */
export function rankPlaces<T extends Place>(typed: string, places: T[], max = 8): Array<{ place: T; score: number }> {
  const typedWords = words(typed);
  const twice = typedWords.some((w, i) => PAIRS.has(w) && typedWords.indexOf(w) !== i);
  const parsed = places.map((place) => ({ place, main: words(place.say), more: words(place.also ?? '') }));
  // Words no place knows (a name, an object: "ann", "opportunity") do not count against a place
  const known = [...new Set(parsed.flatMap((p) => [...p.main, ...p.more]))];
  const asked = [...new Set([...typedWords, ...(twice ? ['two'] : [])])].filter((w) => wordScore(w, known) > 0);
  if (!asked.length) return [];
  const out: Array<{ place: T; score: number }> = [];
  for (const { place, main, more } of parsed) {
    let total = 0;
    for (const w of asked) total += Math.max(wordScore(w, main), 0.8 * wordScore(w, more));
    // Covering every word typed matters most; then how much of the place's own phrase was asked for
    const ownMatched = main.filter((m) => asked.some((w) => wordScore(w, [m]) > 0)).length;
    const score = total / asked.length + 0.1 * (main.length ? ownMatched / main.length : 0) - 0.1;
    if (total > 0) out.push({ place, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}
