import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import {
  describeGlobal,
  describeSObject,
  mainSObject,
  query,
  type FieldSummary,
  type QueryResult,
  type SObjectSummary,
} from '@nomadsf/core';
import { CodeEditor } from '../components/CodeEditor';
import { DataTable } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { monaco } from '../monaco';

export function QueryPage() {
  const { client, org } = useStudio();
  const [soql, setSoql] = useState<string>(() =>
    storage.get('query.soql', 'SELECT Id, Name, CreatedDate\nFROM Account\nORDER BY CreatedDate DESC\nLIMIT 100')
  );
  const [tooling, setTooling] = useState<boolean>(() => storage.get('query.tooling', false));
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [maxRows, setMaxRows] = useState(10_000);
  const [history, setHistory] = useState<string[]>(() => storage.get('query.history', []));
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);
  const objects = useRef<SObjectSummary[]>([]);
  const fields = useRef(new Map<string, FieldSummary[]>());
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  useEffect(() => storage.set('query.soql', soql), [soql]);
  useEffect(() => {
    storage.set('query.tooling', tooling);
    objects.current = [];
    fields.current.clear();
    describeGlobal(client, tooling)
      .then((list) => (objects.current = list))
      .catch(() => undefined);
  }, [client, tooling]);

  // Autocomplete: objects after FROM, fields of the FROM object elsewhere
  useEffect(() => {
    const provider = monaco.languages.registerCompletionItemProvider('soql', {
      triggerCharacters: [' ', ',', '.'],
      provideCompletionItems: async (model, position) => {
        const text = model.getValue();
        const before = model.getValueInRange({
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        });
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        if (/\bfrom\s+\w*$/i.test(before)) {
          return {
            suggestions: objects.current.map((o) => ({
              label: o.name,
              detail: o.label,
              kind: monaco.languages.CompletionItemKind.Class,
              insertText: o.name,
              range,
            })),
          };
        }
        const from = mainSObject(text);
        if (!from) return { suggestions: [] };
        let list = fields.current.get(from);
        if (!list) {
          try {
            list = (await describeSObject(client, from, tooling)).fields;
            fields.current.set(from, list);
          } catch {
            list = [];
          }
        }
        return {
          suggestions: list.map((f) => ({
            label: f.name,
            detail: `${f.type}${f.referenceTo.length ? ` → ${f.referenceTo.join(', ')}` : ''} · ${f.label}`,
            kind: f.referenceTo.length
              ? monaco.languages.CompletionItemKind.Reference
              : monaco.languages.CompletionItemKind.Field,
            insertText: f.name,
            range,
          })),
        };
      },
    });
    return () => provider.dispose();
  }, [client, tooling]);

  const run = useCallback(async () => {
    const editor = editorRef.current;
    const selection = editor?.getSelection();
    const text = selection && !selection.isEmpty() ? editor?.getModel()?.getValueInRange(selection) ?? soql : soql;
    if (!text.trim()) return;
    setRunning(true);
    setError('');
    try {
      setResult(await query(client, text, { tooling, includeDeleted, maxRows }));
      const next = [text, ...history.filter((h) => h !== text)].slice(0, 30);
      setHistory(next);
      storage.set('query.history', next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRunning(false);
    }
  }, [client, soql, tooling, includeDeleted, maxRows, history]);

  const allFields = async () => {
    const from = mainSObject(soql);
    if (!from) {
      setError('Write FROM <Object> first.');
      return;
    }
    try {
      const described = await describeSObject(client, from, tooling);
      setSoql(
        `SELECT ${described.fields
          .filter((f) => f.type !== 'base64')
          .map((f) => f.name)
          .join(', ')}\nFROM ${from}\nLIMIT 200`
      );
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const onMount: OnMount = (editor) => {
    editorRef.current = editor;
  };
  useEffect(() => {
    editorRef.current?.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void run());
  }, [run]);

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Query</h2>
        <span className="grow" />
        <label className="check">
          <input type="checkbox" checked={tooling} onChange={(e) => setTooling(e.target.checked)} /> Tooling API
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={includeDeleted}
            disabled={tooling}
            onChange={(e) => setIncludeDeleted(e.target.checked)}
          />{' '}
          Deleted &amp; archived
        </label>
        <select value={maxRows} onChange={(e) => setMaxRows(Number(e.target.value))}>
          {[2000, 10_000, 50_000].map((n) => (
            <option key={n} value={n}>
              max {n.toLocaleString()}
            </option>
          ))}
        </select>
        <select value="" onChange={(e) => e.target.value && setSoql(history[Number(e.target.value)])}>
          <option value="">History…</option>
          {history.map((h, i) => (
            <option key={i} value={i}>
              {h.replace(/\s+/g, ' ').slice(0, 70)}
            </option>
          ))}
        </select>
        <button onClick={() => void allFields()}>All fields</button>
        <button className="primary" disabled={running} onClick={() => void run()}>
          {running ? 'Running…' : 'Run ⌘⏎'}
        </button>
      </div>
      <div className="editor-box small">
        <CodeEditor language="soql" value={soql} onChange={setSoql} onMount={onMount} />
      </div>
      {error && <div className="error">{error}</div>}
      {result && (
        <div className="card">
          <DataTable
            name={result.sobject ?? 'query'}
            columns={result.columns}
            rows={result.rows}
            instanceUrl={org.instanceUrl}
            note={
              <>
                · {result.durationMs} ms
                {result.truncated ? ` · ${result.totalSize.toLocaleString()} in the org (raise max rows)` : ''}
              </>
            }
          />
        </div>
      )}
    </div>
  );
}
