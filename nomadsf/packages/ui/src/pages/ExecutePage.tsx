import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import {
  DEFAULT_LOG_LEVELS,
  executeAnonymous,
  extractCode,
  type ExecuteAnonymousResult,
  type LogLevels,
} from '@nomadsf/core';
import { AiAsk, AiExplain } from '../components/AiHelp';
import { CodeEditor } from '../components/CodeEditor';
import { LogViewer } from '../components/LogViewer';
import { storage, useStudio } from '../context';
import { monaco } from '../monaco';

const PRESETS: Record<string, { label: string; levels: LogLevels }> = {
  default: { label: 'Default (Developer Console)', levels: DEFAULT_LOG_LEVELS },
  debug: {
    label: 'Debug only',
    levels: {
      Apex_code: 'DEBUG',
      System: 'NONE',
      Db: 'NONE',
      Workflow: 'NONE',
      Validation: 'NONE',
      Callout: 'NONE',
      Apex_profiling: 'NONE',
      Visualforce: 'NONE',
    },
  },
  finest: {
    label: 'Finest (everything)',
    levels: {
      ...DEFAULT_LOG_LEVELS,
      Apex_code: 'FINEST',
      Db: 'FINEST',
      System: 'FINE',
      Apex_profiling: 'FINEST',
      Callout: 'FINEST',
    },
  },
};

const SAMPLE = `// Runs as anonymous Apex in the selected org (Ctrl/Cmd + Enter)
List<Account> accounts = [SELECT Id, Name FROM Account ORDER BY CreatedDate DESC LIMIT 5];
for (Account a : accounts) {
    System.debug(a.Name);
}
System.debug('SOQL used: ' + Limits.getQueries());
`;

export function ExecutePage() {
  const { client, org, confirmRisky } = useStudio();
  const [code, setCode] = useState<string>(() => storage.get('apex.code', SAMPLE));
  const [preset, setPreset] = useState<string>(() => storage.get('apex.preset', 'default'));
  const [history, setHistory] = useState<string[]>(() => storage.get('apex.history', []));
  const [result, setResult] = useState<ExecuteAnonymousResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  useEffect(() => storage.set('apex.code', code), [code]);
  useEffect(() => storage.set('apex.preset', preset), [preset]);

  const run = useCallback(
    async (selectionOnly: boolean) => {
      const editor = editorRef.current;
      const selection = editor?.getSelection();
      const source =
        selectionOnly && selection && !selection.isEmpty()
          ? editor?.getModel()?.getValueInRange(selection) ?? code
          : code;
      if (!source.trim() || !(await confirmRisky('Run anonymous Apex'))) return;
      setRunning(true);
      setError('');
      const model = editor?.getModel();
      if (model) monaco.editor.setModelMarkers(model, 'apex', []);
      try {
        const r = await executeAnonymous(client, source, PRESETS[preset]?.levels);
        setResult(r);
        if (!r.compiled && model && r.line) {
          monaco.editor.setModelMarkers(model, 'apex', [
            {
              severity: monaco.MarkerSeverity.Error,
              message: r.compileProblem ?? 'Compile error',
              startLineNumber: r.line,
              startColumn: r.column ?? 1,
              endLineNumber: r.line,
              endColumn: (r.column ?? 1) + 20,
            },
          ]);
          editor?.revealLineInCenter(r.line);
        }
        const next = [source, ...history.filter((h) => h !== source)].slice(0, 20);
        setHistory(next);
        storage.set('apex.history', next);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setRunning(false);
      }
    },
    [client, code, preset, history, confirmRisky]
  );

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run(false));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => void run(true));
  };
  // Keep the shortcut bound to the latest run() (it closes over state)
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run(false));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => void run(true));
  }, [run]);

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Execute Anonymous</h2>
        <span className="muted">on {org.label}</span>
        <span className="grow" />
        <label>
          Log levels{' '}
          <select value={preset} onChange={(e) => setPreset(e.target.value)}>
            {Object.entries(PRESETS).map(([id, p]) => (
              <option key={id} value={id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <select
          className="menu-select"
          value=""
          onChange={(e) => e.target.value && setCode(history[Number(e.target.value)])}
        >
          <option value="">History…</option>
          {history.map((h, i) => (
            <option key={i} value={i}>
              {h.replace(/\s+/g, ' ').slice(0, 70)}
            </option>
          ))}
        </select>
        <button onClick={() => void run(true)} disabled={running} title="Ctrl/Cmd + Shift + Enter">
          Run selection
        </button>
        <button className="primary" onClick={() => void run(false)} disabled={running} title="Ctrl/Cmd + Enter">
          {running ? 'Running…' : 'Execute ⌘⏎'}
        </button>
      </div>
      <AiAsk
        task="write-apex"
        placeholder="✦ Describe the Apex you need, e.g. deactivate users who have not logged in for 90 days"
        button="Write Apex"
        what="your request"
        onAnswer={(answer) =>
          setCode(
            `// ✦ Written by AI (${
              answer.model
            }). Read it before you run it: nothing runs until you press Execute.\n${extractCode(answer.text)}\n`
          )
        }
      />
      <div className="editor-box">
        <CodeEditor language="apex" value={code} onChange={setCode} onMount={onMount} />
      </div>
      {error && <div className="error">{error}</div>}
      {result && (
        <div className="card">
          <div className="result-head">
            {!result.compiled ? (
              <span className="pill bad">
                Compile error{result.line ? ` · line ${result.line}:${result.column ?? ''}` : ''}
              </span>
            ) : result.success ? (
              <span className="pill good">Success</span>
            ) : (
              <span className="pill bad">Exception</span>
            )}
            <span className="muted">{result.durationMs} ms round trip</span>
          </div>
          {result.compileProblem && <div className="error">{result.compileProblem}</div>}
          {result.exceptionMessage && (
            <div className="error">
              {result.exceptionMessage}
              {result.exceptionStackTrace && <pre>{result.exceptionStackTrace}</pre>}
            </div>
          )}
          {(!result.compiled || !result.success) && (
            <div className="chips">
              <AiExplain
                task="explain-apex-error"
                label="Explain this error"
                what="the code and the error"
                getText={() => code}
                getExtra={() =>
                  `Error: ${result.compileProblem ?? result.exceptionMessage ?? ''}${
                    result.line ? ` (line ${result.line})` : ''
                  }\n${result.exceptionStackTrace ?? ''}`
                }
                useCode={{ label: 'Use the fixed code', apply: (fixed) => setCode(`${fixed}\n`) }}
              />
            </div>
          )}
          {result.compiled && <LogViewer log={result.log} name="execute-anonymous" />}
        </div>
      )}
    </div>
  );
}
