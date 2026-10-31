import { useContext, useState } from 'react';
import { StudioContext } from '../context';
import { aiAssist, aiTaskPrompt, extractCode, type BrowserAiTask } from '@nomadsf/core';
import { aiUsable, loadExtensionAi } from '../extensionAi';
import { localAppBase, useProject } from '../project';
import type { HostKind } from '../host';

const APP_TASKS = new Set(['explain-log', 'explain-test', 'soql']);

export type AiAnswer = { text: string; model: string; provider: string; sentChars: number; soql?: string };

/**
 * Asks the AI: in the extension, its own connection from Settings → AI if there is one; otherwise
 * the AI connected in the local NomadSF app (keys stay there).
 */
export async function askAi(hostKind: HostKind, body: Record<string, unknown>, route = 'ai/assist'): Promise<AiAnswer> {
  // The extension's own AI (Settings → AI) answers directly; otherwise the CLI app's AI
  if (hostKind === 'extension' && route === 'ai/assist') {
    const own = await loadExtensionAi();
    if (aiUsable(own)) return aiAssist(own!, String(body.task) as BrowserAiTask, body);
  }
  // Tasks the app knows by name; newer ones go as a ready-made prompt
  if (route === 'ai/assist' && !APP_TASKS.has(String(body.task))) {
    const { system, message } = aiTaskPrompt(String(body.task) as BrowserAiTask, body);
    body = { task: 'chat', system, message };
  }
  const base = localAppBase(hostKind);
  if (base === undefined)
    throw new Error(
      hostKind === 'extension'
        ? 'AI help needs an AI provider: connect one in Settings › AI.'
        : 'AI help is not available in VS Code yet.'
    );
  let res: Response;
  try {
    res = await fetch(`${base}/api/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fm-dashboard': '1' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      'AI help runs through the local NomadSF app: start `sf fm dashboard`, then connect an AI on its AI page.'
    );
  }
  const answer = (await res.json().catch(() => ({}))) as AiAnswer & { error?: string };
  // An app started before AI help existed answers 404: it has to be restarted (or updated)
  if (res.status === 404) {
    throw new Error(
      'The running NomadSF app is older than this Studio and has no AI help yet. Restart `sf fm dashboard` (update the plugin first if needed).'
    );
  }
  if (!res.ok || answer.error) throw new Error(answer.error ?? res.statusText);
  return answer;
}

/** "Explain with AI" button plus its answer, for a piece of text (a log, failures…). */
export function AiExplain({
  task,
  getText,
  getExtra,
  label = 'Explain with AI',
  what,
  useCode,
}: {
  task: string;
  getText: () => string;
  /** Extra context sent before the text (errors, the class name…). */
  getExtra?: () => string;
  label?: string;
  /** What gets sent, for the notice (e.g. "the debug log"). */
  what: string;
  /** Answers with code get a button that hands the code over (e.g. into the editor). */
  useCode?: { label: string; apply: (code: string) => void };
}) {
  const hostKind = useContext(StudioContext)?.hostKind ?? 'app';
  const { aiReady } = useProject();
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setAnswer(await askAi(hostKind, { task, text: getText(), extra: getExtra?.() ?? '' }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // AI help runs through the NomadSF CLI app with an AI the person connected there
  if (!aiReady) return null;

  return (
    <div className="ai-help">
      <button onClick={() => void run()} disabled={busy} title={`Sends ${what} to the AI connected in NomadSF`}>
        {busy ? 'Asking AI…' : `✦ ${label}`}
      </button>
      {error && <div className="error">{error}</div>}
      {answer && <AiAnswerView answer={answer} what={what} onClose={() => setAnswer(null)} useCode={useCode} />}
    </div>
  );
}

/**
 * A request in plain words for the AI (✦ Write Apex, ✦ Build the request…). `build` adds context
 * (e.g. the org's fields); `onAnswer` puts the result where it belongs (never runs it).
 */
export function AiAsk({
  task,
  placeholder,
  button,
  what,
  build,
  onAnswer,
}: {
  task: string;
  placeholder: string;
  button: string;
  what: string;
  build?: (question: string) => Promise<Record<string, unknown>>;
  onAnswer: (answer: AiAnswer) => void;
}) {
  const hostKind = useContext(StudioContext)?.hostKind ?? 'app';
  const { aiReady } = useProject();
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!aiReady) return null;

  const ask = async () => {
    if (!question.trim()) return;
    setBusy(true);
    setError('');
    try {
      const extra = build ? await build(question) : {};
      onAnswer(await askAi(hostKind, { task, question, ...extra }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="form ai-ask">
        <input
          placeholder={placeholder}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void ask()}
        />
        <button
          disabled={!question.trim() || busy}
          onClick={() => void ask()}
          title={`Sends ${what} to the AI you connected`}
        >
          {busy ? 'Writing…' : `✦ ${button}`}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </>
  );
}

export function AiAnswerView({
  answer,
  what,
  onClose,
  useCode,
}: {
  answer: AiAnswer;
  what: string;
  onClose: () => void;
  useCode?: { label: string; apply: (code: string) => void };
}) {
  const hasCode = /```/.test(answer.text);
  return (
    <div className="card ai-answer">
      <div className="toolbar">
        <b>✦ AI</b>
        <span className="muted">
          {answer.provider} · {answer.model} · sent {what} ({answer.sentChars.toLocaleString()} characters)
        </span>
        <span className="grow" />
        {useCode && hasCode && (
          <button className="primary" onClick={() => useCode.apply(extractCode(answer.text))}>
            {useCode.label}
          </button>
        )}
        <button onClick={() => void navigator.clipboard.writeText(answer.text)}>Copy</button>
        <button onClick={onClose}>Close</button>
      </div>
      <div className="ai-text">
        {/* Text and fenced code blocks (```lang … ```) */}
        {answer.text.split(/```[\w-]*\n?/).map((part, i) =>
          i % 2 === 1 ? (
            <pre key={i} className="ai-code">
              {part.replace(/\n$/, '')}
            </pre>
          ) : (
            part.trim() && <span key={i}>{part}</span>
          )
        )}
      </div>
    </div>
  );
}
