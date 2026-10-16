/* eslint-disable camelcase -- request fields follow the Claude API wire format */
import Anthropic from '@anthropic-ai/sdk';
import { resolveApiKey } from './credentials.js';
import type { AiChat, AiConfig, AiToolDefinition, AiToolResult, AiTurn } from './types.js';

/**
 * Claude via the official SDK, with a manual tool loop so the caller can gate
 * every tool call. History is append-only: each response's full content is sent back.
 */
export function createAnthropicChat(config: AiConfig, system: string, tools: AiToolDefinition[]): AiChat {
  const apiKey = resolveApiKey(config).key;
  // Without a key in the configured variable or a connected key the SDK resolves ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile
  const client = new Anthropic({
    ...(apiKey ? { apiKey } : {}),
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
  });

  // Server-side fallbacks retry a safety decline on another Claude model; only on the Claude API itself
  const useFallbacks = !config.baseUrl && config.model.startsWith('claude-');
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  const toolDefs: Anthropic.Beta.BetaTool[] = tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
  }));

  const request = async (): Promise<AiTurn> => {
    try {
      // pause_turn: the server paused a long turn; send the history back to let it continue
      for (let attempt = 0; attempt < 5; attempt++) {
        // eslint-disable-next-line no-await-in-loop
        const response = await client.beta.messages.create({
          model: config.model,
          max_tokens: config.maxTokens ?? 16_000,
          system,
          ...(toolDefs.length ? { tools: toolDefs } : {}),
          messages,
          output_config: { effort: config.effort ?? 'high' },
          ...(useFallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        });
        messages.push({ role: 'assistant', content: response.content });
        if (response.stop_reason === 'pause_turn') continue;

        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        const toolCalls = response.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
          .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));

        let stop: AiTurn['stop'] = 'done';
        if (response.stop_reason === 'refusal') stop = 'refusal';
        else if (response.stop_reason === 'max_tokens') stop = 'truncated';
        else if (toolCalls.length > 0) stop = 'tool_calls';
        return { text, toolCalls: stop === 'tool_calls' ? toolCalls : [], stop, model: response.model };
      }
      throw new Error('Claude paused the turn too many times.');
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        throw new Error(
          `Claude rejected the credentials. Connect Claude in the NomadSF app (AI page), set ${
            config.apiKeyEnv ?? 'ANTHROPIC_API_KEY'
          }, or log in with 'ant auth login'.`
        );
      }
      throw error;
    }
  };

  return {
    send(text: string): Promise<AiTurn> {
      messages.push({ role: 'user', content: text });
      return request();
    },
    sendToolResults(results: AiToolResult[]): Promise<AiTurn> {
      // All results of one turn go back in a single user message
      messages.push({
        role: 'user',
        content: results.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        })),
      });
      return request();
    },
  };
}
