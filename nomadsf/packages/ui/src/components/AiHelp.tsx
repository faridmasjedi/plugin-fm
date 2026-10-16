import { useContext, useState } from 'react';
import { StudioContext } from '../context';
import { localAppBase } from '../project';

export type AiAnswer = { text: string; model: string; provider: string; sentChars: number; soql?: string };

/**
 * Asks the AI connected in the local NomadSF app (keys stay there). The extension uses the
 * local app too; without it, AI help explains how to start it.
 */
export async function askAi(
  hostKind: 'app' | 'extension',
  body: Record<string, unknown>,
  route = 'ai/assist'
): Promise<AiAnswer> {
  let res: Response;
  try {
    res = await fetch(`${localAppBase(hostKind)}/api/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-fm-dashboard': '1' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error(
      'AI help runs through the local NomadSF app: start `sf fm dashboard`, then connect an AI on its AI page.'
    );
  }
  const answer = (await res.json()) as AiAnswer & { error?: string };
  if (!res.ok || answer.error) throw new Error(answer.error ?? res.statusText);
  return answer;
}

/** "Explain with AI" button plus its answer, for a piece of text (a log, failures…). */
export function AiExplain({
  task,
  getText,
  label = 'Explain with AI',
  what,
}: {
  task: string;
  getText: () => string;
  label?: string;
  /** What gets sent, for the notice (e.g. "the debug log"). */
  what: string;
}) {
  const hostKind = useContext(StudioContext)?.hostKind ?? 'app';
  const [answer, setAnswer] = useState<AiAnswer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setAnswer(await askAi(hostKind, { task, text: getText() }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ai-help">
      <button onClick={() => void run()} disabled={busy} title={`Sends ${what} to the AI connected in NomadSF`}>
        {busy ? 'Asking AI…' : `✦ ${label}`}
      </button>
      {error && <div className="error">{error}</div>}
      {answer && <AiAnswerView answer={answer} what={what} onClose={() => setAnswer(null)} />}
    </div>
  );
}

export function AiAnswerView({ answer, what, onClose }: { answer: AiAnswer; what: string; onClose: () => void }) {
  return (
    <div className="card ai-answer">
      <div className="toolbar">
        <b>✦ AI</b>
        <span className="muted">
          {answer.provider} · {answer.model} · sent {what} ({answer.sentChars.toLocaleString()} characters)
        </span>
        <span className="grow" />
        <button onClick={() => void navigator.clipboard.writeText(answer.text)}>Copy</button>
        <button onClick={onClose}>Close</button>
      </div>
      <div className="ai-text">{answer.text}</div>
    </div>
  );
}
