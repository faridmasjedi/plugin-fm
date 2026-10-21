import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * Questions inside the page instead of the browser's confirm() and prompt(): those are
 * blocked in VS Code (the Studio runs in a sandboxed webview) and look different in each
 * browser. One question at a time; later ones wait their turn.
 */

type Ask = {
  id: number;
  message: string;
  /** confirm: OK / Cancel. text: an answer. typed: type `expect` to enable the button. */
  kind: 'confirm' | 'text' | 'typed';
  expect?: string;
  initial?: string;
  ok?: string;
  danger?: boolean;
  resolve: (answer: string | null) => void;
};

let queue: Ask[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const emit = (): void => listeners.forEach((l) => l());

function ask(question: Omit<Ask, 'id' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    queue = [...queue, { ...question, id: ++nextId, resolve }];
    emit();
  });
}

/** OK / Cancel. */
export async function askConfirm(message: string, options: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
  return (await ask({ message, kind: 'confirm', ...options })) !== null;
}

/** A short answer (null when cancelled). */
export function askText(message: string, initial = ''): Promise<string | null> {
  return ask({ message, kind: 'text', initial });
}

/** The person types `expect` (an org name) to go ahead. */
export async function askTyped(
  message: string,
  expect: string,
  options: { ok?: string; danger?: boolean } = {}
): Promise<boolean> {
  return (await ask({ message, kind: 'typed', expect, ...options })) === expect;
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Shows the current question; mounted once at the root. */
export function Dialogs() {
  const current = useSyncExternalStore(subscribe, () => queue[0]);
  if (!current) return null;
  return <Question key={current.id} ask={current} />;
}

function Question({ ask: q }: { ask: Ask }) {
  const [value, setValue] = useState(q.initial ?? '');
  const input = useRef<HTMLInputElement>(null);
  const okButton = useRef<HTMLButtonElement>(null);
  const ready = q.kind !== 'typed' || value.trim() === q.expect;

  const answer = (result: string | null): void => {
    queue = queue.slice(1);
    emit();
    q.resolve(result);
  };
  const submit = (): void => {
    if (!ready) return;
    answer(q.kind === 'confirm' ? 'ok' : q.kind === 'typed' ? value.trim() : value);
  };

  useEffect(() => {
    (input.current ?? okButton.current)?.focus();
    input.current?.select();
  }, []);

  return (
    <div
      className="ask-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && answer(null)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') answer(null);
      }}
    >
      <form
        className={`ask${q.danger ? ' danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-label="NomadSF"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <p className="ask-message">{q.message}</p>
        {q.kind === 'typed' && (
          <label className="ask-label">
            Type <b>{q.expect}</b> to confirm
          </label>
        )}
        {q.kind !== 'confirm' && (
          <input
            ref={input}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={q.expect}
            spellCheck={false}
            autoComplete="off"
          />
        )}
        <div className="ask-actions">
          <button type="button" onClick={() => answer(null)}>
            Cancel
          </button>
          <button
            ref={okButton}
            type="submit"
            className={q.danger ? 'primary danger-fill' : 'primary'}
            disabled={!ready}
          >
            {q.ok ?? 'OK'}
          </button>
        </div>
      </form>
    </div>
  );
}
