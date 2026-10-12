/**
 * Provider-neutral contract between the runbook agent and an AI provider.
 * Each adapter keeps its own native, append-only conversation history.
 */

export type AiToolDefinition = {
  name: string;
  description: string;
  /** JSON Schema of the input object. */
  inputSchema: Record<string, unknown>;
};

export type AiToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type AiToolResult = {
  id: string;
  content: string;
  isError?: boolean;
};

export type AiTurn = {
  /** Text the model wrote this turn. */
  text: string;
  toolCalls: AiToolCall[];
  /** done: final answer; tool_calls: run the calls and continue; refusal / truncated: stop. */
  stop: 'done' | 'tool_calls' | 'refusal' | 'truncated';
  /** Model that produced the turn (can differ from the configured one after a fallback). */
  model: string;
};

export type AiChat = {
  /** Sends the first user message (or a follow-up message). */
  send(text: string): Promise<AiTurn>;
  /** Returns tool results for every call of the previous turn. */
  sendToolResults(results: AiToolResult[]): Promise<AiTurn>;
};

export type AiProviderId =
  | 'anthropic'
  | 'openai'
  | 'azure-openai'
  | 'gemini'
  | 'mistral'
  | 'groq'
  | 'openrouter'
  | 'ollama'
  | 'openai-compatible';

export type AiConfig = {
  provider: AiProviderId;
  model: string;
  /** API base URL (proxies, gateways, self-hosted or Azure endpoints). */
  baseUrl?: string;
  /** Name of the environment variable holding the API key. Keys are never stored in files. */
  apiKeyEnv?: string;
  /** Claude only: low | medium | high | xhigh | max. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTokens?: number;
};
