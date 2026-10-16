/* eslint-disable camelcase -- request fields follow the Chat Completions wire format */
import { PROVIDER_PRESETS } from './config.js';
import { resolveApiKey } from './credentials.js';
import type { AiChat, AiConfig, AiToolDefinition, AiToolResult, AiTurn } from './types.js';

/**
 * Chat Completions adapter for OpenAI-compatible endpoints: OpenAI, Azure OpenAI,
 * Gemini (OpenAI compatibility endpoint), Mistral, Groq, OpenRouter, Ollama, or any
 * gateway/self-hosted model exposing the same API.
 */

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    }
  | { role: 'tool'; tool_call_id: string; content: string };

type ChatCompletion = {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
    };
  }>;
  error?: { message?: string };
};

export function createOpenAiCompatibleChat(config: AiConfig, system: string, tools: AiToolDefinition[]): AiChat {
  const preset = PROVIDER_PRESETS[config.provider];
  const apiKey = preset.auth === 'none' ? undefined : resolveApiKey(config).key;
  if (preset.auth !== 'none' && !apiKey) {
    throw new Error(
      `Connect ${preset.label} in the NomadSF app (AI page) or set the ${
        config.apiKeyEnv ?? 'API key'
      } environment variable.`
    );
  }

  // Azure: baseUrl is the deployment URL, e.g. https://<resource>.openai.azure.com/openai/deployments/<name>?api-version=...
  const url = new URL(config.baseUrl!.replace(/\/$/, '') + '/chat/completions');
  if (config.provider === 'azure-openai' && config.baseUrl!.includes('?')) {
    const [base, query] = config.baseUrl!.split('?');
    url.href = `${base.replace(/\/$/, '')}/chat/completions?${query}`;
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (apiKey && preset.auth === 'api-key') headers['api-key'] = apiKey;
  else if (apiKey) headers.authorization = `Bearer ${apiKey}`;

  const messages: ChatMessage[] = [{ role: 'system', content: system }];
  const toolDefs = tools.map((t) => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.inputSchema },
  }));

  const request = async (): Promise<AiTurn> => {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: config.model, messages, tools: toolDefs, max_tokens: config.maxTokens ?? 16_000 }),
    });
    const body = (await res.json().catch(() => ({}))) as ChatCompletion;
    if (!res.ok) {
      throw new Error(`${preset.label} returned ${res.status}: ${body.error?.message ?? res.statusText}`);
    }

    const choice = body.choices?.[0];
    const message = choice?.message ?? {};
    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: message.tool_calls });

    const toolCalls = (message.tool_calls ?? []).map((call) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(call.function.arguments ? call.function.arguments : '{}') as Record<string, unknown>;
      } catch {
        input = { __invalidJson: call.function.arguments };
      }
      return { id: call.id, name: call.function.name, input };
    });

    let stop: AiTurn['stop'] = 'done';
    if (Boolean(message.refusal) || choice?.finish_reason === 'content_filter') stop = 'refusal';
    else if (choice?.finish_reason === 'length') stop = 'truncated';
    else if (toolCalls.length > 0) stop = 'tool_calls';
    return {
      text: message.content ?? message.refusal ?? '',
      toolCalls: stop === 'tool_calls' ? toolCalls : [],
      stop,
      model: body.model ?? config.model,
    };
  };

  return {
    send(text: string): Promise<AiTurn> {
      messages.push({ role: 'user', content: text });
      return request();
    },
    sendToolResults(results: AiToolResult[]): Promise<AiTurn> {
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
      }
      return request();
    },
  };
}
