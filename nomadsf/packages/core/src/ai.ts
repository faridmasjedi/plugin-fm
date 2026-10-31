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
  | 'pick-data'
  | 'explain-load-failures'
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
  | 'write-class'
  | 'explain-diff'
  | 'write-metadata'
  | 'change-metadata'
  | 'map-csv';
const MAX_INPUT = 60_000;

const SYSTEM: Record<BrowserAiTask, string> = {
  'pick-data':
    'You choose Salesforce objects for a data backup or a data copy between orgs. Answer with one ```json code block and nothing else, holding {"objects": [{"name": "<API name>", "where": "<SOQL condition without WHERE, or empty>", "fields": {"mode": "all" | "only" | "except", "fields": ["<field API names>"]}, "relatedOnly": true | false}], "note": "<one short sentence on what you chose>"}. Use only object API names from the list given. Conditions use standard fields (CreatedDate, LastModifiedDate, Name, IsClosed, StageName…) or fields the request names, with SOQL date literals (LAST_N_DAYS:n, LAST_N_YEARS:n, THIS_YEAR). Keep fields {"mode": "all"} unless the request asks to include or leave out fields. For a copy, set relatedOnly true on objects that should only bring records linked to the objects before them (children such as Contacts of the chosen Accounts); the first, root objects get relatedOnly false. Do not add objects the request does not need.',
  'explain-load-failures':
    'You are a Salesforce data migration expert. These records failed to load into the target org. Group the failures by cause (validation rules, required fields, duplicates or duplicate rules, picklist values, field permissions or read-only fields, invalid lookups, record types, triggers or flows), say what each cause means and how to fix it (map or fill a field, add the picklist value, bypass or adjust the rule for the load, give the user access, load the parent first…). Be concise; most frequent cause first.',
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
  'explain-diff':
    'You are a senior Salesforce developer. A unified diff of one file follows: lines starting with - are the version in the org, lines starting with + the version in the project (repository). Explain what changed in plain words, grouped by purpose (behaviour, queries, security, tests, formatting only). Then say which side looks newer, and anything risky about deploying the project version (removed logic, changed signatures other code may call, missing tests). Be concise.',
  'write-metadata':
    'You write new Salesforce metadata as the files of a Metadata API deploy (metadata format, NOT source format: no force-app, no -meta.xml on XML-only types). Answer with one ```json code block and nothing else, holding {"type": "<metadata type of the main component, e.g. ApexTrigger>", "name": "<its fullName>", "files": [{"path": "<folder>/<file>", "content": "<the whole file>"}], "note": "<one short sentence>"}. Paths: classes/<Name>.cls + classes/<Name>.cls-meta.xml; triggers/<Name>.trigger + .trigger-meta.xml; pages/<Name>.page + .page-meta.xml; components/<Name>.component + .component-meta.xml; lwc/<name>/<name>.js, .html, optional .css, and <name>.js-meta.xml (isExposed true, targets lightning__RecordPage, lightning__AppPage, lightning__HomePage unless asked otherwise); aura/<name>/<name>.cmp (+ <name>.cmp-meta.xml, <name>Controller.js, <name>Helper.js as needed); a field: objects/<Object>.object holding a CustomObject with only its <fields> element; permissionsets/<Name>.permissionset; layouts/<Object>-<Layout name>.layout; flows/<Name>.flow; labels/CustomLabels.labels; other types in their usual Metadata API folder. Every -meta.xml and XML file starts with <?xml version="1.0" encoding="UTF-8"?> and uses xmlns="http://soap.sforce.com/2006/04/metadata"; use the API version given. Apex is bulk-safe (no SOQL or DML in loops), with sharing unless asked otherwise; a trigger stays thin and calls a handler class (include the class files when you write one). Use only objects and fields that exist (given) unless the request creates them. Add a test class for new Apex when the request is for production code.',
  'change-metadata':
    'You change one Salesforce metadata component. You get its files as the Metadata API returns them, then the change wanted. Answer with one ```json code block and nothing else, holding {"files": [{"path": "<the same path>", "content": "<the whole new file>"}], "note": "<one short sentence on what you changed>"}. Return only the files you change, each complete, with the same paths; keep everything else in them exactly as it was (order, values, formatting). Do not invent fields, objects or values that the request or the files do not name.',
  'map-csv':
    'You map the columns of a CSV file to the fields of a Salesforce object for a data load. Answer with one ```json code block and nothing else, holding {"mapping": {"<column exactly as given>": "<field API name, or empty to skip>"}, "note": "<one short sentence>"}. Use only field API names from the list given; match by meaning (labels, abbreviations, other languages), not only by spelling; a column holding record Ids of the object maps to Id; a lookup column maps to the lookup field (…Id or …__c). Leave a column empty when no field fits; never map two columns to one field.',
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

export type MetadataDraft = {
  type: string;
  name: string;
  files: Array<{ path: string; content: string }>;
  note: string;
};

/** Paths a draft may write: a metadata folder, then names (no going up, no absolute paths, no package.xml). */
const DRAFT_PATH = /^[A-Za-z][\w]*\/(?:[\w.\- ]+\/)*[\w.\- ]+$/;

/** The metadata files inside an AI answer ({"type","name","files"} in a json block), checked. */
export function parseMetadataDraft(answer: string): MetadataDraft {
  let parsed: { type?: unknown; name?: unknown; files?: unknown; note?: unknown };
  try {
    parsed = JSON.parse(extractCode(answer)) as typeof parsed;
  } catch {
    throw new Error('The AI did not answer with files; try rephrasing.');
  }
  const files = (Array.isArray(parsed.files) ? parsed.files : [])
    .map((f) => ({
      path: String((f as { path?: unknown }).path ?? '').trim(),
      content: String((f as { content?: unknown }).content ?? ''),
    }))
    .filter((f) => f.path);
  if (!files.length) throw new Error('The AI answered without files; try rephrasing.');
  for (const f of files)
    if (!DRAFT_PATH.test(f.path) || f.path.split('/').includes('..') || /(^|\/)package\.xml$/.test(f.path))
      throw new Error(`The AI suggested a path the Studio does not write: ${f.path}`);
  return {
    type: String(parsed.type ?? '').trim(),
    name: String(parsed.name ?? '').trim(),
    files,
    note: String(parsed.note ?? '').trim(),
  };
}

/** The column → field mapping inside an AI answer, kept to the columns and fields given. */
export function parseCsvMapping(
  answer: string,
  columns: string[],
  fields: string[]
): { mapping: Record<string, string>; note: string } {
  let parsed: { mapping?: Record<string, unknown>; note?: unknown };
  try {
    parsed = JSON.parse(extractCode(answer)) as typeof parsed;
  } catch {
    throw new Error('The AI did not answer with a mapping; try again.');
  }
  const known = new Map(fields.map((f) => [f.toLowerCase(), f]));
  const used = new Set<string>();
  const mapping: Record<string, string> = {};
  for (const column of columns) {
    const field = known.get(
      String(parsed.mapping?.[column] ?? '')
        .trim()
        .toLowerCase()
    );
    if (field && !used.has(field)) {
      mapping[column] = field;
      used.add(field);
    }
  }
  return { mapping, note: String(parsed.note ?? '').trim() };
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
  if (task === 'write-metadata') {
    const request = String(input.question ?? '').trim();
    if (!request) throw new Error('Say what you want.');
    const schema = String(input.schema ?? '').trim();
    return {
      system: SYSTEM[task],
      message: `${input.kind ? `Kind: ${String(input.kind)}\n` : ''}API version: ${String(
        input.apiVersion ?? '62.0'
      )}\n${schema ? `Objects and fields available:\n${schema.slice(0, MAX_INPUT)}\n` : ''}\nRequest: ${request}`,
    };
  }
  if (task === 'change-metadata') {
    const request = String(input.question ?? '').trim();
    if (!request) throw new Error('Say what to change.');
    if (!text.trim()) throw new Error('Open a component first.');
    return {
      system: SYSTEM[task],
      message: `Component: ${String(input.type ?? '')} ${String(input.name ?? '')}\nFiles:\n${text.slice(
        0,
        MAX_INPUT
      )}\n\nChange: ${request}`,
    };
  }
  if (task === 'map-csv') {
    return {
      system: SYSTEM[task],
      message: `Object: ${String(input.object ?? '')} (${String(input.operation ?? 'insert')})\nFields: ${String(
        input.fields ?? ''
      ).slice(0, MAX_INPUT / 2)}\nCSV columns: ${String(input.columns ?? '')}\nFirst rows:\n${String(
        input.sample ?? ''
      ).slice(0, 4000)}${input.question ? `\n\nAlso: ${String(input.question)}` : ''}`,
    };
  }
  if (task === 'write-apex' || task === 'rest-request' || task === 'write-class' || task === 'pick-data') {
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
