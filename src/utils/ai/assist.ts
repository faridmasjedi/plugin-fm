import { execFileSync } from 'node:child_process';
import { DEPLOY_TAG_PREFIX } from '../deployTagUtils.js';
import { describeAiConfig, loadAiConfig } from './config.js';
import { createChat } from './index.js';

/**
 * One-shot AI help in NomadSF: explain a debug log, a failed test or deployment, write SOQL
 * from a question, draft release notes. Runs in the local app with the connected provider;
 * the input is trimmed to what the task needs before it is sent.
 */

export type AssistTask = 'explain-log' | 'explain-test' | 'explain-deploy' | 'soql' | 'release-notes';
export type AssistAnswer = { text: string; model: string; provider: string; sentChars: number };

const MAX_INPUT = 60_000;
/** git's empty tree, to diff a whole short history. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const SYSTEM: Record<AssistTask, string> = {
  'explain-log':
    'You are a senior Salesforce developer. Explain this Apex debug log to a colleague: what ran, what failed and why (exceptions, governor limits, validation or DML errors), and the most likely fix with the class and line. Be concise; use short sections: Summary, Problem, Fix. If nothing failed, say so and point out anything risky (limits near maximum, many SOQL or DML in loops).',
  'explain-test':
    'You are a senior Salesforce developer. Explain why these Apex tests failed, using the messages and stack traces. For each failure give the cause and a concrete fix (code or data setup). Be concise.',
  'explain-deploy':
    'You are a Salesforce release engineer. Explain why this deployment or validation failed, using the log. List each distinct cause with the component, what it means and the fix (missing dependency, test failure, coverage, API version, permissions…). Be concise and practical.',
  soql: 'You write Salesforce SOQL. Answer with exactly one SOQL query in a ```sql code block and nothing else. Use only the objects and fields given; use relationship names for lookups; add LIMIT 200 unless the question asks for everything or for a count.',
  'release-notes':
    'You write release notes for a Salesforce release. From the commits and changed files, write Markdown with: a one-line summary; sections Features, Fixes, Configuration / metadata changes, Post-deployment steps (only if the changes need manual steps), Risks. Group related commits; name components plainly; no commit hashes.',
};

/** Keeps the lines of a debug log that explain what happened (errors, debug, limits, SOQL/DML). */
export function reduceDebugLog(log: string, max = MAX_INPUT): string {
  if (log.length <= max) return log;
  const important =
    /EXCEPTION|FATAL_ERROR|VALIDATION_FAIL|DML_BEGIN|SOQL_EXECUTE_BEGIN|USER_DEBUG|LIMIT_USAGE|CUMULATIVE_LIMIT|CODE_UNIT_STARTED|FLOW_ELEMENT_ERROR|CALLOUT_RESPONSE/;
  const lines = log.split('\n');
  const head = lines.slice(0, 20);
  const tail = lines.slice(-80);
  const middle = lines.slice(20, -80).filter((l) => important.test(l));
  const joined = [...head, '…', ...middle, '…', ...tail].join('\n');
  return joined.length > max ? `${joined.slice(0, max / 2)}\n…\n${joined.slice(-max / 2)}` : joined;
}

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** Commits and changed files since the last deployment tag of the branch (or the last 30 commits). */
export function releaseContext(cwd: string, from?: string, to = 'HEAD'): { from: string; to: string; text: string } {
  const safe = (ref: string): string => {
    if (!/^[\w./@^~-]+$/.test(ref)) throw new Error(`Invalid git ref: ${ref}`);
    return ref;
  };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  const lastTag = git(['tag', '--list', `${DEPLOY_TAG_PREFIX}/${branch}/*`, '--sort=-creatordate'], cwd).split('\n')[0];
  // Without a tag: the last 30 commits, or the whole history when it is shorter
  const count = Number(git(['rev-list', '--count', safe(to)], cwd)) || 0;
  const base = from ? safe(from) : lastTag || (count > 30 ? `${safe(to)}~30` : EMPTY_TREE);
  const range = base === EMPTY_TREE ? safe(to) : `${base}..${safe(to)}`;
  const commits = git(['log', range, '--no-merges', '--format=- %s (%an)'], cwd);
  const files = git(['diff', '--name-status', base, safe(to)], cwd);
  if (!commits && !files) throw new Error(`No changes in ${range}.`);
  return {
    from: base === EMPTY_TREE ? 'first commit' : base,
    to,
    text: `Range: ${range}\n\nCommits:\n${commits}\n\nChanged files:\n${files.split('\n').slice(0, 400).join('\n')}`,
  };
}

function prompt(task: AssistTask, input: Record<string, unknown>): string {
  const text = String(input.text ?? '');
  switch (task) {
    case 'explain-log':
      return `Debug log:\n${reduceDebugLog(text)}`;
    case 'soql': {
      const question = String(input.question ?? '').trim();
      if (!question) throw new Error('Ask a question.');
      return `Objects and fields available:\n${String(input.schema ?? '').slice(
        0,
        MAX_INPUT
      )}\n\nQuestion: ${question}`;
    }
    default:
      if (!text.trim()) throw new Error('Nothing to send.');
      return text.length > MAX_INPUT ? `…${text.slice(-MAX_INPUT)}` : text;
  }
}

export async function assist(cwd: string, task: AssistTask, input: Record<string, unknown>): Promise<AssistAnswer> {
  if (!SYSTEM[task]) throw new Error('Unknown AI task.');
  const config = loadAiConfig(cwd);
  // Only an AI the person connected themselves (key in their environment or the app); nothing is borrowed
  if (!describeAiConfig(config).apiKeySet) {
    throw new Error(
      'No AI connected. Open AI settings, connect a provider with your own account or key, and press Use.'
    );
  }
  const message = prompt(task, input);
  const chat = createChat({ ...config, maxTokens: Math.min(config.maxTokens ?? 8000, 8000) }, SYSTEM[task], []);
  const turn = await chat.send(message);
  if (turn.stop === 'refusal') throw new Error('The model declined this request.');
  return { text: turn.text, model: turn.model, provider: describeAiConfig(config).label, sentChars: message.length };
}

/** The SOQL inside a ```sql block (or the whole answer). */
export function extractSoql(answer: string): string {
  return (/```(?:sql|soql)?\s*([\s\S]*?)```/i.exec(answer)?.[1] ?? answer).trim();
}
