import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import {
  describeGlobal,
  describeSObject,
  exportSavedQueries,
  importSavedQueries,
  mainSObject,
  query,
  removeSavedQuery,
  SAVED_QUERIES_FILE,
  upsertSavedQuery,
  type FieldSummary,
  type QueryResult,
  type SavedQuery,
  type SObjectSummary,
} from '@nomadsf/core';
import { askAi } from '../components/AiHelp';
import { CodeEditor } from '../components/CodeEditor';
import { DataTable, download } from '../components/DataTable';
import { storage, useStudio } from '../context';
import { monaco } from '../monaco';
import { useProject } from '../project';

/** Named queries kept in this browser, exportable as nomadsf-queries.json to share with the team. */
function SavedQueries({
  soql,
  tooling,
  onLoad,
}: {
  soql: string;
  tooling: boolean;
  onLoad: (query: SavedQuery) => void;
}) {
  const project = useProject();
  const [saved, setSaved] = useState<SavedQuery[]>(() => storage.get('query.saved', []));
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const update = (next: SavedQuery[], note = '') => {
    setSaved(next);
    storage.set('query.saved', next);
    setMessage(note);
  };
  const attempt = (action: () => void) => {
    try {
      action();
    } catch (e) {
      setMessage(`❌ ${(e as Error).message}`);
    }
  };
  const merge = (text: string, from: string) =>
    attempt(() => {
      const { list, added } = importSavedQueries(saved, text);
      update(list, `Imported ${added} ${added === 1 ? 'query' : 'queries'} from ${from}.`);
    });
  const fromProject = async () => {
    const text = await project.source?.fs.readText(SAVED_QUERIES_FILE);
    if (text) merge(text, SAVED_QUERIES_FILE);
    else setMessage(`No ${SAVED_QUERIES_FILE} at the root of ${project.source?.name ?? 'the project'}.`);
  };

  return (
    <div className="card saved-queries">
      <div className="form">
        <input
          placeholder="Name this query"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) =>
            e.key === 'Enter' &&
            attempt(() => update(upsertSavedQuery(saved, { name, soql, tooling }), `Saved “${name.trim()}”.`))
          }
        />
        <button
          disabled={!name.trim()}
          onClick={() =>
            attempt(() => update(upsertSavedQuery(saved, { name, soql, tooling }), `Saved “${name.trim()}”.`))
          }
        >
          Save query
        </button>
        <span className="grow" />
        <button
          disabled={!saved.length}
          onClick={() => download(SAVED_QUERIES_FILE, exportSavedQueries(saved), 'application/json')}
        >
          Export
        </button>
        <button onClick={() => fileInput.current?.click()}>Import…</button>
        {project.source && (
          <button title={`Read ${SAVED_QUERIES_FILE} from the project`} onClick={() => void fromProject()}>
            From project
          </button>
        )}
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) void file.text().then((text) => merge(text, file.name));
            e.target.value = '';
          }}
        />
      </div>
      {saved.length > 0 ? (
        <div className="chips">
          {saved.map((q) => (
            <span key={q.name} className="chip saved" title={q.soql}>
              <button
                className="link"
                onClick={() => {
                  setName(q.name);
                  onLoad(q);
                }}
              >
                {q.name}
                {q.tooling ? ' · tooling' : ''}
              </button>
              <button
                className="link"
                aria-label={`Delete ${q.name}`}
                onClick={() => update(removeSavedQuery(saved, q.name), `Deleted “${q.name}”.`)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      ) : (
        <span className="muted">No saved queries yet.</span>
      )}
      {message && <span className="muted">{message}</span>}
    </div>
  );
}

/** Objects the question is about: names or labels mentioned (also plural), plus the current FROM. */
function objectsInQuestion(question: string, objects: SObjectSummary[], current?: string): string[] {
  const words = new Set(question.toLowerCase().match(/[a-z_][\w]*/g) ?? []);
  const hits = objects
    .filter((o) => {
      const names = [o.name.toLowerCase(), o.label.toLowerCase()];
      return names.some(
        (n) =>
          words.has(n) ||
          words.has(`${n}s`) ||
          words.has(n.replace(/y$/, 'ies')) ||
          (n.includes(' ') && question.toLowerCase().includes(n))
      );
    })
    .map((o) => o.name);
  return [...new Set([...(current ? [current] : []), ...hits])].slice(0, 5);
}

export function QueryPage() {
  const { client, org, hostKind } = useStudio();
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
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

  // Plain-English question -> SOQL, using this org's objects and fields
  const askSoql = async () => {
    setAsking(true);
    setError('');
    try {
      const mentioned = objectsInQuestion(question, objects.current, mainSObject(soql));
      const described = await Promise.all(
        mentioned.map(async (name) => {
          const d = await describeSObject(client, name, tooling).catch(() => undefined);
          return d
            ? `${d.name} (${d.label}): ${d.fields
                .map(
                  (f) =>
                    `${f.name} ${f.type}${
                      f.referenceTo.length ? `→${f.referenceTo.join('/')} as ${f.relationshipName ?? ''}` : ''
                    }`
                )
                .join(', ')}`
            : '';
        })
      );
      const schema = `${described.filter(Boolean).join('\n\n')}\n\nOther objects: ${objects.current
        .map((o) => o.name)
        .join(', ')
        .slice(0, 20_000)}`;
      const answer = await askAi(hostKind, { task: 'soql', question, schema });
      if (answer.soql) setSoql(answer.soql);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setAsking(false);
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
      <div className="form ai-ask">
        <input
          placeholder="✦ Ask in plain English, e.g. accounts in Sydney created this year with their open opportunities"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && question.trim() && void askSoql()}
        />
        <button
          disabled={!question.trim() || asking}
          onClick={() => void askSoql()}
          title="Sends the question and the names of this org's objects and fields to the AI connected in NomadSF"
        >
          {asking ? 'Writing…' : '✦ Write SOQL'}
        </button>
      </div>
      <SavedQueries
        soql={soql}
        tooling={tooling}
        onLoad={(q) => {
          setSoql(q.soql);
          setTooling(q.tooling);
        }}
      />
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
