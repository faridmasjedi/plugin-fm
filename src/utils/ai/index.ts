import { createAnthropicChat } from './anthropic.js';
import { createOpenAiCompatibleChat } from './openaiCompatible.js';
import type { AiChat, AiConfig, AiToolDefinition } from './types.js';

export { loadAiConfig, describeAiConfig, PROVIDER_PRESETS, AI_CONFIG_FILE, AiConfigError } from './config.js';
export {
  connectedProviders,
  githubCliToken,
  removeConnectedKey,
  resolveApiKey,
  saveConnectedKey,
  type KeySource,
} from './credentials.js';
export type { AiChat, AiConfig, AiToolCall, AiToolDefinition, AiToolResult, AiTurn, AiProviderId } from './types.js';

/** Opens a chat with the configured provider. */
export function createChat(config: AiConfig, system: string, tools: AiToolDefinition[]): AiChat {
  return config.provider === 'anthropic'
    ? createAnthropicChat(config, system, tools)
    : createOpenAiCompatibleChat(config, system, tools);
}
