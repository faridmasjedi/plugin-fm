/**
 * AI help straight from the browser (the extension): the person's own provider and key, no
 * NomadSF CLI app. Claude speaks its Messages API; everyone else the OpenAI Chat Completions
 * format (OpenAI, Gemini, Mistral, Groq, OpenRouter, GitHub Models, Ollama, custom endpoints).
 * The prompts match the CLI app's (src/utils/ai/assist.ts in plugin-fm).
 */

export type AiProvider =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'mistral'
  | 'groq'
  | 'openrouter'
  | 'github-models'
  | 'ollama'
  | 'custom';

export type AiPreset = {
  label: string;
  baseUrl: string;
  /** Suggested model (the person can type another). */
  model: string;
  key: 'required' | 'optional' | 'none';
  keyPage?: string;
};

export const AI_PRESETS: Record<AiProvider, AiPreset> = {
  anthropic: {
    label: 'Anthropic Claude',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-opus-5-5',
    key: 'required',
    keyPage: 'https://console.anthropic.com/settings/keys',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1',
    key: 'required',
    keyPage: 'https://platform.openai.com/api-keys',
  },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-pro',
    key: 'required',
    keyPage: 'https://aistudio.google.com/apikey',
  },
  mistral: {
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    key: 'required',
    keyPage: 'https://console.mistral.ai/api-keys',
  },
  groq: {
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile',
    key: 'required',
    keyPage: 'https://console.groq.com/keys',
  },
  openrouter: {
    label: 'OpenRouter (many models, one account)',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-opus-5.5',
    key: 'required',
    keyPage: 'https://openrouter.ai/settings/keys',
  },
  'github-models': {
    label: 'GitHub Models (your GitHub / Copilot plan)',
    baseUrl: 'https://models.github.ai/inference',
    model: 'openai/gpt-4.1',
    key: 'required',
    keyPage: 'https://github.com/settings/personal-access-tokens/new',
  },
  ollama: {
    label: 'Ollama (a model on this computer)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.1',
    key: 'none',
  },
  custom: {
    label: 'Custom (your model or company gateway, OpenAI format)',
    baseUrl: '',
    model: '',
    key: 'optional',
  },
};

export type AiSettings = { provider: AiProvider; model: string; baseUrl?: string; apiKey?: string };

export type AiReply = { text: string; model: string };

type Fetch = typeof fetch;

export function aiBaseUrl(settings: AiSettings): string {
  const url = (settings.baseUrl || AI_PRESETS[settings.provider].baseUrl).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(url)) throw new Error('Set the endpoint URL (https://…).');
  return url;
}

async function readError(res: Response, label: string): Promise<Error> {
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } | string; message?: string };
  const message = typeof body.error === 'string' ? body.error : body.error?.message ?? body.message ?? res.statusText;
  if (res.status === 401 || res.status === 403)
    return new Error(`${label} refused the key (${res.status}): ${message}`);
  return new Error(`${label} returned ${res.status}: ${message}`);
}

/** One question, one answer. */
export async function aiChat(
  settings: AiSettings,
  system: string,
  message: string,
  options: { maxTokens?: number; fetchImpl?: Fetch } = {}
): Promise<AiReply> {
  const preset = AI_PRESETS[settings.provider];
  if (!preset) throw new Error('Unknown AI provider.');
  if (!settings.model.trim()) throw new Error('Choose a model.');
  if (preset.key === 'required' && !settings.apiKey) throw new Error(`Connect ${preset.label} with a key first.`);
  const doFetch = options.fetchImpl ?? fetch;
  const base = aiBaseUrl(settings);
  const maxTokens = options.maxTokens ?? 4000;

  if (settings.provider === 'anthropic') {
    const res = await doFetch(`${base}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey ?? '',
        'anthropic-version': '2023-06-01',
        // Calls come from the person's own browser with their own key
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: settings.model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: message }],
      }),
    });
    if (!res.ok) throw await readError(res, preset.label);
    const body = (await res.json()) as {
      model?: string;
      stop_reason?: string;
      content?: Array<{ type: string; text?: string }>;
    };
    if (body.stop_reason === 'refusal') throw new Error('The model declined this request.');
    return {
      text: (body.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('\n'),
      model: body.model ?? settings.model,
    };
  }

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
  if (settings.provider === 'openrouter') headers['X-Title'] = 'NomadSF';
  const res = await doFetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: message },
      ],
    }),
  });
  if (!res.ok) throw await readError(res, preset.label);
  const body = (await res.json()) as {
    model?: string;
    choices?: Array<{ finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }>;
  };
  const choice = body.choices?.[0];
  if (choice?.message?.refusal || choice?.finish_reason === 'content_filter')
    throw new Error('The model declined this request.');
  return { text: choice?.message?.content ?? '', model: body.model ?? settings.model };
}

// ---------- the Studio's AI tasks ----------

export type BrowserAiTask =
  | 'explain-log'
  | 'explain-test'
  | 'soql'
  | 'write-apex'
  | 'explain-apex-error'
  | 'rest-request'
  | 'explain-response'
  | 'explain-code'
  | 'review-code'
  | 'write-test'
  | 'explain-compile'
  | 'write-class';
const MAX_INPUT = 60_000;

const SYSTEM: Record<BrowserAiTask, string> = {
  'explain-log':
    'You are a senior Salesforce developer. Explain this Apex debug log to a colleague: what ran, what failed and why (exceptions, governor limits, validation or DML errors), and the most likely fix with the class and line. Be concise; use short sections: Summary, Problem, Fix. If nothing failed, say so and point out anything risky (limits near maximum, many SOQL or DML in loops).',
  'explain-test':
    'You are a senior Salesforce developer. Explain why these Apex tests failed, using the messages and stack traces. For each failure give the cause and a concrete fix (code or data setup). Be concise.',
  'write-apex':
    'You write anonymous Apex for the Salesforce Developer Console. Answer with one ```apex code block and nothing else (comments inside the code are fine). Bulk-safe: no SOQL or DML inside loops; respect governor limits; use LIMIT on queries; print results with System.debug. If the request changes data, add a comment at the top saying what changes, and keep it reversible where possible. Use only standard objects and the fields given unless the request names others.',
  'explain-apex-error':
    'You are a senior Salesforce developer. This anonymous Apex failed to compile or threw an exception. Explain the cause in one or two sentences, then give the corrected code in one ```apex code block.',
  'rest-request':
    'You build Salesforce REST API requests. Answer with one ```json code block and nothing else, holding {"method": "GET|POST|PATCH|PUT|DELETE", "path": "/services/data/vXX.X/...", "body": {...} or null}. Use vXX.X for the API version. Prefer the standard resources: query (?q= with + for spaces), sobjects/<Object>, sobjects/<Object>/<Id>, sobjects/<Object>/describe, limits, recent, tooling/query, composite. Use only fields that exist on the object.',
  'explain-response':
    'You explain Salesforce REST API responses to an admin or developer. Summarise what the response says in plain words: the key values, anything notable (errors, limits close to maximum, empty results) and what to do next. Be concise; use a short list.',
  'explain-code':
    'You are a senior Salesforce developer. Explain what this code does for a colleague who has not seen it: purpose, main methods or handlers, data it reads and changes (objects, fields), and when it runs. Be concise; use short sections.',
  'review-code':
    'You are a senior Salesforce developer reviewing code. List concrete problems, most important first, each with the line or method and a fix: SOQL or DML inside loops, missing bulkification, governor limit risks, hard-coded Ids, missing CRUD/FLS checks (WITH USER_MODE / Security.stripInaccessible), sharing (with / without sharing), null handling, exceptions swallowed, recursion in triggers, test-only shortcuts. If the code is fine, say so. Do not rewrite the whole file.',
  'write-test':
    'You write Apex test classes. Answer with one ```apex code block holding a complete @isTest class (no explanation outside the block). Create its own test data (no SeeAllData), use Test.startTest/stopTest, cover the main paths and bulk (200 records) where it matters, and assert results with System.assertEquals. Aim for more than 75% coverage. Name it after the class with the suffix Test.',
  'write-class':
    'You write Salesforce Apex classes. Answer with one ```apex code block holding one complete class and nothing else (short comments inside are fine). Use with sharing unless the request says otherwise; bulk-safe (no SOQL or DML in loops); enforce CRUD/FLS for user-facing code (WITH USER_MODE or Security.stripInaccessible); no hard-coded Ids; clear method names; ApexDoc on public methods. Use the class name the request gives, otherwise a fitting one.',
  'explain-compile':
    'You are a senior Salesforce developer. Explain these compile errors and how to fix each, briefly. Then give the corrected code in one ```apex (or the right language) code block.',
  soql: 'You write Salesforce SOQL. Answer with exactly one SOQL query in a ```sql code block and nothing else. Use only the objects and fields given; use relationship names for lookups; add LIMIT 200 unless the question asks for everything or for a count.',
};

/** Keeps the lines of a debug log that explain what happened (errors, debug, limits, SOQL/DML). */
export function reduceDebugLog(log: string, max = MAX_INPUT): string {
  if (log.length <= max) return log;
  const important =
    /EXCEPTION|FATAL_ERROR|VALIDATION_FAIL|DML_BEGIN|SOQL_EXECUTE_BEGIN|USER_DEBUG|LIMIT_USAGE|CUMULATIVE_LIMIT|CODE_UNIT_STARTED|FLOW_ELEMENT_ERROR|CALLOUT_RESPONSE/;
  const lines = log.split('\n');
  const middle = lines.slice(20, -80).filter((l) => important.test(l));
  const joined = [...lines.slice(0, 20), '…', ...middle, '…', ...lines.slice(-80)].join('\n');
  return joined.length > max ? `${joined.slice(0, max / 2)}\n…\n${joined.slice(-max / 2)}` : joined;
}

/** The first fenced code block of an answer (or the whole answer when there is none). */
export function extractCode(answer: string): string {
  return (/```[\w-]*\s*\n?([\s\S]*?)```/.exec(answer)?.[1] ?? answer).trim();
}

export type RestRequestDraft = { method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'; path: string; body: string };

/** The REST request inside an AI answer ({"method","path","body"} in a json block). */
export function parseRestRequest(answer: string): RestRequestDraft {
  let parsed: { method?: string; path?: string; body?: unknown };
  try {
    parsed = JSON.parse(extractCode(answer)) as typeof parsed;
  } catch {
    throw new Error('The AI did not answer with a request; try rephrasing.');
  }
  const method = String(parsed.method ?? 'GET').toUpperCase();
  if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) throw new Error(`Unsupported method ${method}.`);
  const path = String(parsed.path ?? '');
  if (!path.startsWith('/services/')) throw new Error('The AI suggested a path outside /services/.');
  const body = parsed.body === null || parsed.body === undefined ? '' : JSON.stringify(parsed.body, null, 2);
  return { method: method as RestRequestDraft['method'], path, body };
}

/** The SOQL inside a ```sql block (or the whole answer). */
export function extractSoql(answer: string): string {
  return (/```(?:sql|soql)?\s*([\s\S]*?)```/i.exec(answer)?.[1] ?? answer).trim();
}

export function aiTaskPrompt(task: BrowserAiTask, input: Record<string, unknown>): { system: string; message: string } {
  const text = String(input.text ?? '');
  if (!SYSTEM[task]) throw new Error('This AI task needs the NomadSF CLI app.');
  if (task === 'soql') {
    const question = String(input.question ?? '').trim();
    if (!question) throw new Error('Ask a question.');
    return {
      system: SYSTEM.soql,
      message: `Objects and fields available:\n${String(input.schema ?? '').slice(
        0,
        MAX_INPUT
      )}\n\nQuestion: ${question}`,
    };
  }
  if (task === 'write-apex' || task === 'rest-request' || task === 'write-class') {
    const request = String(input.question ?? '').trim();
    if (!request) throw new Error('Say what you want.');
    const schema = String(input.schema ?? '').trim();
    return {
      system: SYSTEM[task],
      message: `${schema ? `Objects and fields available:\n${schema.slice(0, MAX_INPUT)}\n\n` : ''}Request: ${request}`,
    };
  }
  if (!text.trim()) throw new Error('Nothing to send.');
  // Code tasks: the code plus any extra context (errors, the class name…)
  const extra = String(input.extra ?? '').trim();
  return {
    system: SYSTEM[task],
    message:
      task === 'explain-log'
        ? `Debug log:\n${reduceDebugLog(text)}`
        : extra
        ? `${extra}\n\n${text.slice(0, MAX_INPUT)}`
        : text.length > MAX_INPUT
        ? `…${text.slice(-MAX_INPUT)}`
        : text,
  };
}

export type BrowserAiAnswer = AiReply & { provider: string; sentChars: number; soql?: string };

export async function aiAssist(
  settings: AiSettings,
  task: BrowserAiTask,
  input: Record<string, unknown>,
  fetchImpl?: Fetch
): Promise<BrowserAiAnswer> {
  const { system, message } = aiTaskPrompt(task, input);
  const reply = await aiChat(settings, system, message, { fetchImpl });
  return {
    ...reply,
    provider: AI_PRESETS[settings.provider].label,
    sentChars: message.length,
    ...(task === 'soql' ? { soql: extractSoql(reply.text) } : {}),
  };
}

/** Sends a tiny request to check the provider, key and model. */
export async function aiTest(settings: AiSettings, fetchImpl?: Fetch): Promise<AiReply> {
  return aiChat(settings, 'Reply with the single word OK.', 'Say OK.', { maxTokens: 16, fetchImpl });
}

// ---------- OpenRouter sign-in (PKCE) ----------

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/** Sign-in address and the verifier to finish it with (OpenRouter returns ?code= to callbackUrl). */
export async function openRouterAuthStart(callbackUrl: string): Promise<{ url: string; verifier: string }> {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const url = new URL('https://openrouter.ai/auth');
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), verifier };
}

/** Exchanges the code for a key of the person's OpenRouter account. */
export async function openRouterAuthFinish(code: string, verifier: string, fetchImpl?: Fetch): Promise<string> {
  const res = await (fetchImpl ?? fetch)('https://openrouter.ai/api/v1/auth/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (!res.ok) throw await readError(res, 'OpenRouter');
  const key = ((await res.json()) as { key?: string }).key;
  if (!key) throw new Error('OpenRouter did not return a key.');
  return key;
}
