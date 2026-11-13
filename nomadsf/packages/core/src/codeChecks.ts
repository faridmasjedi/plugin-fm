import type { SalesforceClient } from './client.js';
import { query } from './query.js';

/**
 * Develop › Code checks: a short list of well-known mistakes in Apex, triggers, Visualforce, LWC and Aura — each with
 * why it matters and how to fix it. Pattern rules read line by line, not a full scanner (Checkmarx, Salesforce Code
 * Analyzer): a finding is a place to look at, and a clean result is not a guarantee.
 */

export type CheckKind = 'Apex class' | 'Apex trigger' | 'Visualforce' | 'LWC' | 'Aura';
export type CheckFile = { kind: CheckKind; name: string; path?: string; text: string };
export type Severity = 'High' | 'Medium' | 'Low';
export type CodeFinding = {
  severity: Severity;
  rule: string;
  kind: CheckKind;
  name: string;
  path?: string;
  line: number;
  code: string;
  why: string;
  fix: string;
};

type Rule = {
  id: string;
  severity: Severity;
  kinds: CheckKind[];
  /** Skips test classes. */
  notTests?: boolean;
  why: string;
  fix: string;
  /** A line that breaks the rule (the whole file is there for context). */
  test: (line: string, ctx: { text: string; exposed: boolean }) => boolean;
};

const ID_PREFIXES = '(?:001|003|005|006|00e|00G|00Q|012|0PS|01p|00D|500|a0[0-9A-Za-z])';
const RULES: Rule[] = [
  {
    id: 'SOQL injection',
    severity: 'High',
    kinds: ['Apex class', 'Apex trigger'],
    why: 'A query built from text joined with values can be changed by whoever sends the values.',
    fix: 'Use bind variables (:value) with Database.queryWithBinds, or String.escapeSingleQuotes on every value.',
    test: (l) =>
      /Database\.(query|countQuery|getQueryLocator)\s*\(|Search\.query\s*\(/.test(l) &&
      /\+/.test(l) &&
      !/escapeSingleQuotes|queryWithBinds/.test(l),
  },
  {
    id: 'Secret in the code',
    severity: 'High',
    kinds: ['Apex class', 'Apex trigger', 'LWC', 'Aura', 'Visualforce'],
    why: 'A password, key or token written in the code is readable by anyone who can see the code, in every org it is deployed to.',
    fix: 'Keep it in a named credential (callouts) or a protected custom setting / custom metadata.',
    test: (l) =>
      /\b(password|passwd|secret|api_?key|access_?token|client_?secret)\w*\s*[:=]\s*['"][^'"]{6,}['"]/i.test(l),
  },
  {
    id: 'Unescaped output',
    severity: 'High',
    kinds: ['Visualforce'],
    why: 'escape="false" writes the value as HTML: a value with a script in it runs in the user’s browser (XSS).',
    fix: 'Remove escape="false", or encode the value with HTMLENCODE / JSENCODE.',
    test: (l) => /escape\s*=\s*["']false["']/i.test(l),
  },
  {
    id: 'Unescaped HTML',
    severity: 'High',
    kinds: ['Aura'],
    why: 'aura:unescapedHtml shows the value as HTML: a value with a script in it can run (XSS).',
    fix: 'Show the value as text, or clean it on the server first.',
    test: (l) => /<aura:unescapedHtml/i.test(l),
  },
  {
    id: 'HTML from a string',
    severity: 'High',
    kinds: ['LWC', 'Aura'],
    why: 'innerHTML / outerHTML / insertAdjacentHTML turn text into HTML: text from a user or a record can run a script (XSS).',
    fix: 'Set textContent, or build the elements in the template.',
    test: (l) => /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(/.test(l),
  },
  {
    id: 'Code from a string',
    severity: 'High',
    kinds: ['LWC', 'Aura', 'Visualforce'],
    why: 'eval() and new Function() run text as code.',
    fix: 'Parse data with JSON.parse; call functions directly.',
    test: (l) => /\beval\s*\(|new\s+Function\s*\(/.test(l),
  },
  {
    id: 'Page parameter not encoded',
    severity: 'Medium',
    kinds: ['Visualforce'],
    why: 'A URL parameter written into the page without encoding can carry a script (XSS).',
    fix: 'Wrap it: {!HTMLENCODE($CurrentPage.parameters.x)}, or JSENCODE inside <script>.',
    test: (l) => /\{!\s*\$CurrentPage\.parameters/i.test(l) && !/ENCODE\s*\(/i.test(l),
  },
  {
    id: 'Without sharing',
    severity: 'Medium',
    kinds: ['Apex class'],
    notTests: true,
    why: 'The class sees every record, whatever the user may see.',
    fix: 'Use "with sharing" (or "inherited sharing"); keep "without sharing" for a small, reviewed class that needs it.',
    test: (l) => /\bwithout\s+sharing\b/i.test(l),
  },
  {
    id: 'Hard-coded Id',
    severity: 'Medium',
    kinds: ['Apex class', 'Apex trigger', 'LWC', 'Aura'],
    notTests: true,
    why: 'Record Ids differ between orgs: the code breaks after a deploy or a sandbox refresh.',
    fix: 'Look the record up by a name or developer name, or keep the Id in custom metadata.',
    test: (l) => new RegExp(`['"]${ID_PREFIXES}[0-9A-Za-z]{12}(?:[0-9A-Za-z]{3})?['"]`).test(l),
  },
  {
    id: 'Hard-coded endpoint',
    severity: 'Low',
    kinds: ['Apex class'],
    notTests: true,
    why: 'A URL in the code must be changed in code for each environment, and needs a remote site setting.',
    fix: "Use a named credential: setEndpoint('callout:My_Credential/path').",
    test: (l) => /setEndpoint\s*\(\s*['"]https?:\/\//i.test(l),
  },
  {
    id: 'Empty catch',
    severity: 'Low',
    kinds: ['Apex class', 'Apex trigger'],
    notTests: true,
    why: 'The error is swallowed: nobody learns that something failed.',
    fix: 'Log it, rethrow it, or show it to the user.',
    test: (l) => /catch\s*\([^)]*\)\s*\{\s*\}/.test(l),
  },
  {
    id: 'Manual DOM',
    severity: 'Low',
    kinds: ['LWC'],
    why: 'lwc:dom="manual" leaves the element to your own code, outside Locker / Lightning Web Security checks of the template.',
    fix: 'Keep it for third-party libraries; never put user text there as HTML.',
    test: (l) => /lwc:dom\s*=\s*["']manual["']/.test(l),
  },
];

/** Every inline query of a file ([SELECT …], over as many lines as it takes) with the line it starts on. */
function inlineQueries(text: string): Array<{ line: number; soql: string }> {
  const out: Array<{ line: number; soql: string }> = [];
  for (const m of text.matchAll(/\[\s*SELECT\b[\s\S]*?\]/gi))
    out.push({ line: text.slice(0, m.index).split(/\r?\n/).length - 1, soql: m[0] });
  return out;
}

/** Queries and DML inside a for/while loop: a governor limit waiting to be hit. */
function inLoops(file: CheckFile): CodeFinding[] {
  if (file.kind !== 'Apex class' && file.kind !== 'Apex trigger') return [];
  const out: CodeFinding[] = [];
  const lines = file.text.split(/\r?\n/);
  const queryStarts = new Set(inlineQueries(file.text).map((q) => q.line));
  // Loop bodies by brace depth: the depth at which each loop's block opened
  const loops: number[] = [];
  let depth = 0;
  let pendingLoop = false;
  lines.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '').replace(/'(?:[^'\\]|\\.)*'/g, "''");
    if (/^\s*(for|while)\s*\(/.test(line) || /\b(for|while)\s*\(/.test(line)) pendingLoop = true;
    const inLoop = loops.length > 0;
    if (inLoop && queryStarts.has(i) && !/^\s*for\s*\(/.test(line))
      out.push(
        finding(
          file,
          i,
          raw,
          'Medium',
          'Query in a loop',
          'Each pass runs one more query: 100 is the limit per transaction.',
          'Query once before the loop, into a Map, and read from it inside.'
        )
      );
    if (
      (inLoop && /^\s*(insert|update|delete|upsert|undelete)\s+\w/i.test(line)) ||
      (inLoop && /Database\.(insert|update|delete|upsert)\s*\(/.test(line))
    )
      out.push(
        finding(
          file,
          i,
          raw,
          'Medium',
          'DML in a loop',
          'Each pass saves once more: 150 is the limit per transaction.',
          'Collect the records in a list and save the list once, after the loop.'
        )
      );
    for (const ch of line) {
      if (ch === '{') {
        depth++;
        if (pendingLoop) {
          loops.push(depth);
          pendingLoop = false;
        }
      } else if (ch === '}') {
        if (loops.length && loops[loops.length - 1] === depth) loops.pop();
        depth--;
      }
    }
    if (pendingLoop && /;\s*$/.test(line) && !/\bfor\s*\(.*;.*;/.test(line)) pendingLoop = false;
  });
  return out;
}

function finding(
  file: CheckFile,
  index: number,
  code: string,
  severity: Severity,
  rule: string,
  why: string,
  fix: string
): CodeFinding {
  return {
    severity,
    rule,
    kind: file.kind,
    name: file.name,
    path: file.path,
    line: index + 1,
    code: code.trim().slice(0, 200),
    why,
    fix,
  };
}

const isTest = (f: CheckFile): boolean => f.kind === 'Apex class' && /@isTest\b/i.test(f.text);
const isExposed = (f: CheckFile): boolean =>
  f.kind === 'Apex class' && /@AuraEnabled|@RemoteAction|\bwebservice\b|@RestResource|@InvocableMethod/i.test(f.text);

/** Every finding in the files, the most serious first. */
export function checkCode(files: CheckFile[]): CodeFinding[] {
  const out: CodeFinding[] = [];
  const rank: Record<Severity, number> = { High: 0, Medium: 1, Low: 2 };
  for (const file of files) {
    const test = isTest(file);
    const ctx = { text: file.text, exposed: isExposed(file) };
    const lines = file.text.split(/\r?\n/);
    for (const rule of RULES) {
      if (!rule.kinds.includes(file.kind) || (rule.notTests && test)) continue;
      lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (rule.test(line, ctx)) out.push(finding(file, i, line, rule.severity, rule.id, rule.why, rule.fix));
      });
    }
    if (!test) out.push(...inLoops(file));
    // A method called from a page or the API, querying with the class's rights instead of the user's
    if (!test && ctx.exposed && !/stripInaccessible/.test(file.text))
      for (const q of inlineQueries(file.text))
        if (!/WITH\s+(USER_MODE|SECURITY_ENFORCED)/i.test(q.soql))
          out.push(
            finding(
              file,
              q.line,
              q.soql.replace(/\s+/g, ' '),
              'Medium',
              'No access check',
              'A method called from a page or the API runs this query with the class’s rights, not the user’s: fields and objects the user cannot see can come back.',
              'Add WITH USER_MODE to the query (or Security.stripInaccessible on the result).'
            )
          );
  }
  return out.sort(
    (a, b) =>
      rank[a.severity] - rank[b.severity] ||
      a.rule.localeCompare(b.rule) ||
      a.name.localeCompare(b.name) ||
      a.line - b.line
  );
}

/** The org's own code (no managed packages): Apex classes and triggers, Visualforce, LWC and Aura sources. */
export async function orgCodeFiles(client: SalesforceClient, kinds: CheckKind[]): Promise<CheckFile[]> {
  const want = new Set(kinds);
  const read = async (soql: string, map: (r: Record<string, unknown>) => CheckFile) =>
    (await query(client, soql, { tooling: true, maxRows: 20_000 })).rows.map(map);
  const parts = await Promise.all([
    want.has('Apex class')
      ? read('SELECT Name, Body FROM ApexClass WHERE NamespacePrefix = null', (r) => ({
          kind: 'Apex class',
          name: String(r.Name),
          text: String(r.Body ?? ''),
        }))
      : [],
    want.has('Apex trigger')
      ? read('SELECT Name, Body FROM ApexTrigger WHERE NamespacePrefix = null', (r) => ({
          kind: 'Apex trigger',
          name: String(r.Name),
          text: String(r.Body ?? ''),
        }))
      : [],
    want.has('Visualforce')
      ? Promise.all([
          read('SELECT Name, Markup FROM ApexPage WHERE NamespacePrefix = null', (r) => ({
            kind: 'Visualforce',
            name: `${String(r.Name)}.page`,
            text: String(r.Markup ?? ''),
          })),
          read('SELECT Name, Markup FROM ApexComponent WHERE NamespacePrefix = null', (r) => ({
            kind: 'Visualforce',
            name: `${String(r.Name)}.component`,
            text: String(r.Markup ?? ''),
          })),
        ]).then((x) => x.flat())
      : [],
    want.has('LWC')
      ? read(
          "SELECT FilePath, Source FROM LightningComponentResource WHERE LightningComponentBundle.NamespacePrefix = null AND (Format = 'js' OR Format = 'html')",
          (r) => ({ kind: 'LWC', name: String(r.FilePath).replace(/^lwc\//, ''), text: String(r.Source ?? '') })
        )
      : [],
    want.has('Aura')
      ? read(
          'SELECT AuraDefinitionBundle.DeveloperName, DefType, Source FROM AuraDefinition WHERE AuraDefinitionBundle.NamespacePrefix = null',
          (r) => ({
            kind: 'Aura',
            name: `${String(r['AuraDefinitionBundle.DeveloperName'])} · ${String(r.DefType).toLowerCase()}`,
            text: String(r.Source ?? ''),
          })
        )
      : [],
  ]);
  return parts.flat();
}

/** Which kind a project file is (by its path), or undefined when it is not code this checks. */
export function checkKindOf(path: string): CheckKind | undefined {
  if (/\/classes\/[^/]+\.cls$/.test(path)) return 'Apex class';
  if (/\/triggers\/[^/]+\.trigger$/.test(path)) return 'Apex trigger';
  if (/\/(pages|components)\/[^/]+\.(page|component)$/.test(path)) return 'Visualforce';
  if (/\/lwc\/[^/]+\/[^/]+\.(js|html)$/.test(path) && !/__tests__|\.test\.js$/.test(path)) return 'LWC';
  if (/\/aura\/[^/]+\/[^/]+\.(cmp|app|evt|js)$/.test(path)) return 'Aura';
  return undefined;
}
