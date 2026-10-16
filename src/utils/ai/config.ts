import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { resolveApiKey, type KeySource } from './credentials.js';
import type { AiConfig, AiProviderId } from './types.js';

export const AI_CONFIG_FILE = '.fm/ai.yml';

export type ProviderPreset = {
  label: string;
  /** OpenAI-compatible chat completions base URL; undefined for the Claude SDK. */
  baseUrl?: string;
  apiKeyEnv?: string;
  /** Default model, only where we can name one with confidence. */
  defaultModel?: string;
  /** How the key is sent for OpenAI-compatible endpoints. */
  auth?: 'bearer' | 'api-key' | 'none';
};

export const PROVIDER_PRESETS: Record<AiProviderId, ProviderPreset> = {
  anthropic: { label: 'Anthropic Claude', apiKeyEnv: 'ANTHROPIC_API_KEY', defaultModel: 'claude-opus-5-5' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', auth: 'bearer' },
  'azure-openai': { label: 'Azure OpenAI', apiKeyEnv: 'AZURE_OPENAI_API_KEY', auth: 'api-key' },
  gemini: {
    label: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    apiKeyEnv: 'GEMINI_API_KEY',
    auth: 'bearer',
  },
  mistral: { label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY', auth: 'bearer' },
  groq: { label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', auth: 'bearer' },
  openrouter: {
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    auth: 'bearer',
  },
  'github-models': {
    label: 'GitHub Models (your GitHub / Copilot plan)',
    baseUrl: 'https://models.github.ai/inference',
    apiKeyEnv: 'GITHUB_MODELS_TOKEN',
    auth: 'bearer',
  },
  ollama: { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', auth: 'none' },
  'openai-compatible': { label: 'Custom (OpenAI-compatible)', apiKeyEnv: 'FM_AI_API_KEY', auth: 'bearer' },
};

export class AiConfigError extends Error {}

/**
 * Loads AI settings from .fm/ai.yml, overridden by FM_AI_PROVIDER, FM_AI_MODEL,
 * FM_AI_BASE_URL and FM_AI_API_KEY_ENV. Defaults to Claude.
 */
export function loadAiConfig(cwd: string, overrides: Partial<AiConfig> = {}): AiConfig {
  const path = resolve(cwd, AI_CONFIG_FILE);
  const fromFile = existsSync(path) ? (parse(readFileSync(path, 'utf8')) as Partial<AiConfig> | null) ?? {} : {};
  const env = process.env;
  const merged: Partial<AiConfig> = {
    ...fromFile,
    ...(env.FM_AI_PROVIDER ? { provider: env.FM_AI_PROVIDER as AiProviderId } : {}),
    ...(env.FM_AI_MODEL ? { model: env.FM_AI_MODEL } : {}),
    ...(env.FM_AI_BASE_URL ? { baseUrl: env.FM_AI_BASE_URL } : {}),
    ...(env.FM_AI_API_KEY_ENV ? { apiKeyEnv: env.FM_AI_API_KEY_ENV } : {}),
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)),
  };

  const provider = merged.provider ?? 'anthropic';
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) {
    throw new AiConfigError(
      `Unknown AI provider "${provider}". Use one of: ${Object.keys(PROVIDER_PRESETS).join(', ')}.`
    );
  }
  const model = merged.model ?? preset.defaultModel;
  if (!model) {
    throw new AiConfigError(`Set the model for ${preset.label} in ${AI_CONFIG_FILE} (model: ...) or FM_AI_MODEL.`);
  }
  const baseUrl = merged.baseUrl ?? preset.baseUrl;
  if (provider !== 'anthropic' && !baseUrl) {
    throw new AiConfigError(`Set baseUrl for ${preset.label} in ${AI_CONFIG_FILE} or FM_AI_BASE_URL.`);
  }
  return { ...merged, provider, model, baseUrl, apiKeyEnv: merged.apiKeyEnv ?? preset.apiKeyEnv };
}

/** Describes the configuration without secrets, for logs and the dashboard. */
export function describeAiConfig(config: AiConfig): {
  provider: string;
  label: string;
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKeySet: boolean;
  keySource: KeySource;
} {
  const { source } =
    PROVIDER_PRESETS[config.provider].auth === 'none' ? { source: 'none' as const } : resolveApiKey(config);
  return {
    provider: config.provider,
    label: PROVIDER_PRESETS[config.provider].label,
    model: config.model,
    baseUrl: config.baseUrl,
    apiKeyEnv: config.apiKeyEnv,
    apiKeySet: PROVIDER_PRESETS[config.provider].auth === 'none' || source !== 'none',
    keySource: source,
  };
}
