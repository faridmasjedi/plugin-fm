import { AI_PRESETS, aiBaseUrl, openRouterAuthFinish, openRouterAuthStart, type AiSettings } from '@nomadsf/core';

/**
 * The extension's own AI connection. Settings and the key live in chrome.storage.local:
 * private to the extension (websites and other extensions cannot read it), never synced or sent
 * anywhere except to the provider the person chose.
 */

const KEY = 'nomadsf.ai';
let cache: AiSettings | null | undefined;
const listeners = new Set<(settings: AiSettings | null) => void>();

const hasChromeStorage = (): boolean => typeof chrome !== 'undefined' && Boolean(chrome.storage?.local);

export async function loadExtensionAi(): Promise<AiSettings | null> {
  if (cache !== undefined) return cache;
  if (!hasChromeStorage()) return (cache = null);
  const stored = (await chrome.storage.local.get(KEY))[KEY] as AiSettings | undefined;
  cache = stored ?? null;
  return cache;
}

export async function saveExtensionAi(settings: AiSettings | null): Promise<void> {
  cache = settings;
  if (hasChromeStorage()) {
    if (settings) await chrome.storage.local.set({ [KEY]: settings });
    else await chrome.storage.local.remove(KEY);
  }
  for (const listener of listeners) listener(settings);
}

export function onExtensionAiChange(listener: (settings: AiSettings | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Ready to use: a model, and a key unless the provider needs none. */
export const aiUsable = (settings: AiSettings | null | undefined): boolean =>
  Boolean(settings?.model && (AI_PRESETS[settings.provider].key !== 'required' || settings.apiKey));

/**
 * Asks Chrome for access to the provider's address only (optional host permission), so the
 * extension does not hold blanket access to every AI site.
 */
export async function requestProviderAccess(settings: AiSettings): Promise<boolean> {
  if (typeof chrome === 'undefined' || !chrome.permissions) return true;
  const origin = `${new URL(aiBaseUrl(settings)).origin}/*`;
  if (await chrome.permissions.contains({ origins: [origin] })) return true;
  return chrome.permissions.request({ origins: [origin] });
}

/** Sign in with OpenRouter in a Chrome window; returns a key for the person's account. */
export async function openRouterSignIn(): Promise<string> {
  if (typeof chrome === 'undefined' || !chrome.permissions) throw new Error('Sign-in works in the extension only.');
  const granted = await chrome.permissions.request({
    permissions: ['identity'],
    origins: ['https://openrouter.ai/*'],
  });
  if (!granted || !chrome.identity) throw new Error('Chrome did not allow the sign-in window.');
  const callback = chrome.identity.getRedirectURL('openrouter');
  const { url, verifier } = await openRouterAuthStart(callback);
  const returned = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  const code = returned ? new URL(returned).searchParams.get('code') : null;
  if (!code) throw new Error('The sign-in was closed before it finished.');
  return openRouterAuthFinish(code, verifier);
}
