// The Agent: sentences become NomadQA steps, through the person's own AI (no package: plain fetch).
// The AI only writes steps; NomadQA checks them, the person reviews them, and only then do they run.
import { ACTIONS, problem } from './steps.js';

export const PROVIDERS = {
  anthropic: { label: 'Anthropic (Claude)', base: 'https://api.anthropic.com', model: 'claude-sonnet-5-5' },
  openai: { label: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  openrouter: { label: 'OpenRouter', base: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-5.5' },
  custom: { label: 'Any OpenAI-compatible endpoint', base: '', model: '' },
};

const GUIDE = `You write automated UI tests for Salesforce Lightning as NomadQA steps (JSON).
Steps name things the way a person sees them: buttons and tabs by their text, fields by their label. Never CSS
selectors, never ids from the page.

Actions:
${Object.entries(ACTIONS)
  .map(([k, a]) => `- ${k}: ${a.say}. Fields: ${a.fields.join(', ') || '—'}${a.also ? ` (${a.also})` : ''}`)
  .join('\n')}

Rules:
- Start with "data" when the test needs records to exist (a recipe: {name, nodes:[{id, object, count, parentId?,
  parentField?, rules:{Field:{kind:'fixed'|'pattern'|'auto', value}}}]}); its records are then {{a-1}} (the Id) and
  {{a-1.Name}} (a value). They are deleted after the test.
- Open pages with {"action":"open","path":"/lightning/o/Account/list"} or {"action":"open","record":"{{a-1}}"} or
  {"action":"open","object":"Account","name":"Acme"}.
- After a change, CHECK it: an "expect" (toast "was created" / "was saved", a field value, a title) and, when records
  change, a "query" with a SELECT that must find the right count.
- Use the org's real object and field labels given below. Values in plain text.
- Answer with JSON only: {"name": "...", "steps": [ ... ]}.`;

/** Asks the AI for a test from sentences; returns { test, problems: [{i, problem}] }. */
export async function stepsFromWords(settings, words, { objects = [], fetchImpl = fetch } = {}) {
  const context = objects.length
    ? `\nObjects in this org (label = API name):\n${objects
        .slice(0, 300)
        .map((o) => `${o.label} = ${o.name}`)
        .join('\n')}`
    : '';
  const text = await ask(settings, GUIDE + context, words, fetchImpl);
  const json = firstJson(text);
  if (!json || !Array.isArray(json.steps))
    throw new Error('The AI did not answer with steps. Try saying it another way.');
  const test = {
    nomadqa: 'test',
    version: 1,
    name: String(json.name ?? 'Test from the Agent'),
    cleanup: true,
    steps: json.steps,
  };
  return { test, problems: test.steps.map((s, i) => ({ i, problem: problem(s) })).filter((p) => p.problem) };
}

/** The first JSON object in a text (the AI may wrap it in prose or a code block). */
export function firstJson(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(s.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function ask(settings, system, user, fetchImpl) {
  const p = PROVIDERS[settings.provider] ?? PROVIDERS.custom;
  const base = (settings.base || p.base).replace(/\/$/, '');
  const model = settings.model || p.model;
  if (!settings.key && settings.provider !== 'custom') throw new Error('Add your AI key in Settings first.');
  if (settings.provider === 'anthropic') {
    const res = await fetchImpl(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({ model, max_tokens: 4000, system, messages: [{ role: 'user', content: user }] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error?.message ?? `The AI answered ${res.status}.`);
    return data.content?.map((c) => c.text ?? '').join('') ?? '';
  }
  if (!base) throw new Error('Give the endpoint address in Settings.');
  const res = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(settings.key ? { authorization: `Bearer ${settings.key}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message ?? `The AI answered ${res.status}.`);
  return data.choices?.[0]?.message?.content ?? '';
}
