import { useEffect, useState } from 'react';
import { AI_PRESETS, aiTest, type AiProvider, type AiSettings } from '@nomadsf/core';
import { aiUsable, loadExtensionAi, openRouterSignIn, requestProviderAccess, saveExtensionAi } from '../extensionAi';

const PROVIDERS = Object.keys(AI_PRESETS) as AiProvider[];

/** Settings → AI (extension): connect the person's own AI with a key, an OpenRouter sign-in, Ollama or any endpoint. */
export function AiSettingsCard() {
  const [saved, setSaved] = useState<AiSettings | null>(null);
  const [provider, setProvider] = useState<AiProvider>('anthropic');
  const [model, setModel] = useState(AI_PRESETS.anthropic.model);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadExtensionAi().then((s) => {
      setSaved(s);
      if (s) {
        setProvider(s.provider);
        setModel(s.model);
        setBaseUrl(s.baseUrl ?? '');
      }
    });
  }, []);

  const preset = AI_PRESETS[provider];
  const draft = (): AiSettings => ({
    provider,
    model: model.trim(),
    baseUrl: baseUrl.trim() || undefined,
    // A new key replaces the stored one; empty keeps it (same provider)
    apiKey: apiKey.trim() || (saved?.provider === provider ? saved.apiKey : undefined),
  });

  const connect = async (settings = draft()) => {
    setBusy(true);
    setStatus('Checking the connection…');
    try {
      if (!(await requestProviderAccess(settings))) throw new Error('Chrome access to the provider was not allowed.');
      const reply = await aiTest(settings);
      await saveExtensionAi(settings);
      setSaved(settings);
      setApiKey('');
      setStatus(`✓ Connected · ${reply.model} answered "${reply.text.trim().slice(0, 20)}"`);
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const signIn = async () => {
    setBusy(true);
    setStatus('Finish the sign-in in the OpenRouter window…');
    try {
      const key = await openRouterSignIn();
      setBusy(false);
      await connect({ provider: 'openrouter', model: model.trim() || AI_PRESETS.openrouter.model, apiKey: key });
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
      setBusy(false);
    }
  };

  return (
    <div className="card section">
      <h3>AI</h3>
      <p className="muted" style={{ margin: 0 }}>
        Your own AI for ✦ Write SOQL, Explain a debug log and Explain failed tests. The key stays in this extension
        (websites cannot read it) and goes only to the provider you choose.
      </p>
      {saved && aiUsable(saved) ? (
        <div className="form">
          <span>
            In use: <b>{AI_PRESETS[saved.provider].label}</b> · <span className="mono">{saved.model}</span>
            {saved.apiKey ? ' · key saved' : ''}
          </span>
          <button
            onClick={() => {
              void saveExtensionAi(null);
              setSaved(null);
              setStatus('Disconnected; the key was removed.');
            }}
          >
            Disconnect
          </button>
        </div>
      ) : (
        <p className="muted" style={{ margin: 0 }}>
          <b>No AI connected.</b> Without one the ✦ buttons use the NomadSF CLI app's AI when it runs, or stay hidden.
        </p>
      )}
      <div className="form">
        <label>
          Provider
          <select
            value={provider}
            onChange={(e) => {
              const next = e.target.value as AiProvider;
              setProvider(next);
              setModel(saved?.provider === next ? saved.model : AI_PRESETS[next].model);
              setBaseUrl(saved?.provider === next ? saved.baseUrl ?? '' : '');
              setApiKey('');
              setStatus('');
            }}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {AI_PRESETS[p].label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Model
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="model name" />
        </label>
        {(provider === 'custom' || provider === 'ollama') && (
          <label>
            Endpoint
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={preset.baseUrl || 'https://gateway.example.com/v1'}
              style={{ minWidth: 300 }}
            />
          </label>
        )}
        {preset.key !== 'none' && (
          <label>
            {preset.key === 'optional' ? 'Key (if your endpoint needs one)' : 'API key'}
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                saved?.provider === provider && saved.apiKey ? '•••••• (saved; type to replace)' : 'paste the key'
              }
              style={{ minWidth: 260 }}
            />
          </label>
        )}
      </div>
      <div className="form">
        <button className="primary" disabled={busy} onClick={() => void connect()}>
          {saved?.provider === provider ? 'Save and test' : 'Connect and test'}
        </button>
        {provider === 'openrouter' && (
          <button disabled={busy} onClick={() => void signIn()}>
            Sign in with OpenRouter
          </button>
        )}
        {preset.keyPage && (
          <a href={preset.keyPage} target="_blank" rel="noreferrer">
            get a key ↗
          </a>
        )}
        <span className="muted">{status}</span>
      </div>
      {provider === 'ollama' && (
        <p className="muted" style={{ margin: 0 }}>
          Ollama must allow the extension: start it with <code>OLLAMA_ORIGINS=chrome-extension://* ollama serve</code>.
        </p>
      )}
      {provider === 'github-models' && (
        <p className="muted" style={{ margin: 0 }}>
          Use a fine-grained GitHub token with the "Models: read" permission.
        </p>
      )}
    </div>
  );
}
