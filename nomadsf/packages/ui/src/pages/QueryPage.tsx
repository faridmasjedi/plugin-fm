import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { OnMount } from '@monaco-editor/react';
import {
  addToSelect,
  describeGlobal,
  describeSObject,
  idColumns,
  exportSavedQueries,
  importSavedQueries,
  lookupIdNames,
  mainSObject,
  openQuery,
  withIdNames,
  type IdNameLookup,
  queryMore,
  removeSavedQuery,
  SAVED_QUERIES_FILE,
  upsertSavedQuery,
  type FieldSummary,
  type QueryCursor,
  type SavedQuery,
  type SObjectSummary,
} from '@nomadsf/core';
import { askAi } from '../components/AiHelp';
import { CodeEditor } from '../components/CodeEditor';
import { DataTable, EmptyHint, download } from '../components/DataTable';
import { QueryExport } from '../components/QueryExport';
import { RelatedFields } from '../components/RelatedFields';
import { storage, useStudio } from '../context';
import { monaco } from '../monaco';
import { useProject } from '../project';

/** Rows kept in the browser before asking to load more (memory guard). */
const BATCH = 100_000;

/** Named queries kept in this browser, exportable as nomadsf-queries.json to share with the team. */
function SavedQueries({
  soql,
  tooling,
  saved,
  setSaved,
  name,
  setName,
  pickers,
}: {
  soql: string;
  tooling: boolean;
  saved: SavedQuery[];
  setSaved: (list: SavedQuery[]) => void;
  name: string;
  setName: (name: string) => void;
  /** The Saved… and History… menus, first in the row. */
  pickers: ReactNode;
}) {
  const project = useProject();
  const [message, setMessage] = useState('');
  const current = saved.find((q) => q.name.toLowerCase() === name.trim().toLowerCase());
  const fileInput = useRef<HTMLInputElement>(null);

  const update = (next: SavedQuery[], note = '') => {
    setSaved(next);
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
        <b title="Queries kept in this browser">Saved queries</b>
        {pickers}
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
          {current ? 'Update saved query' : 'Save query'}
        </button>
        {current && (
          <button
            onClick={() => {
              update(removeSavedQuery(saved, current.name), `Deleted “${current.name}”.`);
              setName('');
            }}
          >
            Delete
          </button>
        )}
        {message && <span className="muted">{message}</span>}
        <span className="grow" />
        <button
          disabled={!saved.length}
          onClick={() => download(SAVED_QUERIES_FILE, exportSavedQueries(saved), 'application/json')}
          title={`Download all saved queries as ${SAVED_QUERIES_FILE}, to share or keep`}
        >
          Download file
        </button>
        <button
          title={`Add the queries from a ${SAVED_QUERIES_FILE} file (same names are updated)`}
          onClick={() => fileInput.current?.click()}
        >
          Load file…
        </button>
        {project.source && (
          <button
            title={`Add the queries from ${SAVED_QUERIES_FILE} at the root of the project (shared with the team in git)`}
            onClick={() => void fromProject()}
          >
            Load from project
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
  const project = useProject();
  const [question, setQuestion] = useState('');
  const [saved, setSavedState] = useState<SavedQuery[]>(() => storage.get('query.saved', []));
  const [savedName, setSavedName] = useState('');
  const setSaved = (list: SavedQuery[]) => {
    setSavedState(list);
    storage.set('query.saved', list);
  };
  const [asking, setAsking] = useState(false);
  const [soql, setSoql] = useState<string>(() =>
    storage.get('query.soql', 'SELECT Id, Name, CreatedDate\nFROM Account\nORDER BY CreatedDate DESC\nLIMIT 100')
  );
  const [tooling, setTooling] = useState<boolean>(() => storage.get('query.tooling', false));
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [history, setHistory] = useState<string[]>(() => storage.get('query.history', []));
  const [result, setResult] = useState<QueryCursor | null>(null);
  const [ranSoql, setRanSoql] = useState('');
  const [loading, setLoading] = useState(false);
  // Names for Id columns SOQL cannot follow (e.g. LoginHistory.UserId)
  const [idNames, setIdNames] = useState<boolean>(() => storage.get('query.idNames', false));
  const [lookup, setLookup] = useState<IdNameLookup | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  // Fields of the records Id columns point to, chosen per object (Related fields…)
  const [related, setRelatedState] = useState<Record<string, string[]>>(() => storage.get('query.related', {}));
  const setRelated = (next: Record<string, string[]>) => {
    setRelatedState(next);
    storage.set('query.related', next);
  };
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [links, setLinks] = useState<Record<string, string>>({});
  // Each load has a token; Stop or a new query changes it and the old loop ends
  const loadToken = useRef(0);
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
        const fieldsOf = async (sobject: string): Promise<FieldSummary[]> => {
          let list = fields.current.get(sobject);
          if (!list) {
            try {
              list = (await describeSObject(client, sobject, tooling)).fields;
            } catch {
              list = [];
            }
            fields.current.set(sobject, list);
          }
          return list;
        };
        // Account.Owner.| : follow each relationship from the FROM object to the object it points to
        let sobject = from;
        const path = /((?:[A-Za-z_]\w*\.)+)\w*$/.exec(before)?.[1];
        for (const step of path ? path.slice(0, -1).split('.') : []) {
          // eslint-disable-next-line no-await-in-loop
          const link = (await fieldsOf(sobject)).find(
            (f) => f.relationshipName?.toLowerCase() === step.toLowerCase() && f.referenceTo.length
          );
          if (!link) return { suggestions: [] };
          sobject = link.referenceTo[0];
        }
        const list = await fieldsOf(sobject);
        return {
          suggestions: [
            ...list.map((f) => ({
              label: f.name,
              detail: `${f.type}${f.referenceTo.length ? ` → ${f.referenceTo.join(', ')}` : ''} · ${f.label}`,
              kind: f.referenceTo.length
                ? monaco.languages.CompletionItemKind.Reference
                : monaco.languages.CompletionItemKind.Field,
              insertText: f.name,
              range,
            })),
            // Relationship names (Account, Owner…): typing the dot lists that object's fields
            ...list
              .filter((f) => f.relationshipName && f.referenceTo.length)
              .map((f) => ({
                label: `${f.relationshipName}.`,
                detail: `→ ${f.referenceTo.join(', ')} fields`,
                kind: monaco.languages.CompletionItemKind.Module,
                insertText: `${f.relationshipName}.`,
                command: { id: 'editor.action.triggerSuggest', title: 'Fields' },
                range,
              })),
          ],
        };
      },
    });
    return () => provider.dispose();
  }, [client, tooling]);

  /** Reads more pages until everything is loaded, Stop is pressed, or `limit` rows are in the browser. */
  const loadRest = useCallback(
    async (start: QueryCursor, limit: number) => {
      let cursor = start;
      const token = ++loadToken.current;
      setLoading(true);
      try {
        while (cursor.next && loadToken.current === token && cursor.rows.length < limit) {
          // eslint-disable-next-line no-await-in-loop
          const nextPage = await queryMore(client, cursor);
          if (loadToken.current !== token) break;
          cursor = nextPage;
          setResult(cursor);
        }
      } catch (e) {
        setError((e as Error).message);
      } finally {
        if (loadToken.current === token) setLoading(false);
      }
    },
    [client]
  );

  // Once rows stop loading, look up names and chosen fields for their Id columns. The same
  // choice reuses the last lookup (only Ids not seen before); another choice reads again.
  const lookupChoice = JSON.stringify({ idNames, related });
  const lookupFor = useRef('');
  useEffect(() => {
    const wanted = idNames || relatedOpen || Object.values(related).some((f) => f.length);
    if (!wanted || !result || loading || running) return;
    let canceled = false;
    const known = lookupFor.current === lookupChoice ? lookup ?? undefined : undefined;
    setLookingUp(true);
    lookupIdNames(client, result.columns, result.rows, { known, names: idNames, related })
      .then((found) => {
        if (canceled) return;
        lookupFor.current = lookupChoice;
        setLookup(found);
      })
      .catch(() => undefined)
      .finally(() => !canceled && setLookingUp(false));
    return () => {
      canceled = true;
    };
    // `lookup` is an input to the next lookup, not a trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, result, loading, running, lookupChoice, relatedOpen]);

  // Id columns SOQL can follow from the FROM object (AccountId -> Account), for "Add to the query"
  const sobject = result?.sobject;
  useEffect(() => {
    setLinks({});
    if (!sobject || tooling) return;
    describeSObject(client, sobject)
      .then((d) =>
        setLinks(
          Object.fromEntries(
            d.fields.filter((f) => f.relationshipName && f.referenceTo.length).map((f) => [f.name, f.relationshipName!])
          )
        )
      )
      .catch(() => undefined);
  }, [client, sobject, tooling]);

  const shown = useMemo(
    () =>
      result && lookup
        ? withIdNames(result.columns, result.rows, lookup)
        : { columns: result?.columns ?? [], rows: result?.rows ?? [] },
    [result, lookup]
  );
  const hasIds = useMemo(() => (result ? idColumns(result.columns, result.rows).length > 0 : false), [result]);

  /** Runs the selected text, else the whole editor; `given`: this query instead (Add to the query). */
  const run = useCallback(
    async (given?: string) => {
      const editor = editorRef.current;
      const selection = editor?.getSelection();
      const text =
        given ?? (selection && !selection.isEmpty() ? editor?.getModel()?.getValueInRange(selection) ?? soql : soql);
      if (!text.trim()) return;
      loadToken.current++;
      setLoading(false);
      setRunning(true);
      setError('');
      try {
        const first = await openQuery(client, text, { tooling, includeDeleted });
        setResult(first);
        setRanSoql(text);
        setLookup(null);
        const next = [text, ...history.filter((h) => h !== text)].slice(0, 30);
        setHistory(next);
        storage.set('query.history', next);
        setRunning(false);
        await loadRest(first, BATCH);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setRunning(false);
      }
    },
    [client, soql, tooling, includeDeleted, history, loadRest]
  );

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
      <SavedQueries
        soql={soql}
        tooling={tooling}
        saved={saved}
        setSaved={setSaved}
        name={savedName}
        setName={setSavedName}
        pickers={
          <>
            <select
              className="menu-select"
              value=""
              title="Saved queries"
              onChange={(e) => {
                const query = saved.find((q) => q.name === e.target.value);
                if (!query) return;
                setSoql(query.soql);
                setTooling(query.tooling);
                setSavedName(query.name);
              }}
            >
              <option value="">{saved.length ? `Saved (${saved.length})…` : 'Saved…'}</option>
              {saved.map((q) => (
                <option key={q.name} value={q.name}>
                  {q.name}
                  {q.tooling ? ' · Tooling' : ''}
                </option>
              ))}
            </select>
            <select
              className="menu-select"
              value=""
              onChange={(e) => e.target.value && setSoql(history[Number(e.target.value)])}
            >
              <option value="">History…</option>
              {history.map((h, i) => (
                <option key={i} value={i}>
                  {h.replace(/\s+/g, ' ').slice(0, 70)}
                </option>
              ))}
            </select>
          </>
        }
      />
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
        <label
          className="check"
          title="Adds name columns next to Id columns SOQL cannot follow, e.g. LoginHistory.UserId → Name, Username"
        >
          <input
            type="checkbox"
            checked={idNames}
            onChange={(e) => {
              setIdNames(e.target.checked);
              storage.set('query.idNames', e.target.checked);
            }}
          />{' '}
          Names for Ids
        </label>
        <button onClick={() => void allFields()}>All fields</button>
        <button className={`primary ${running ? 'working' : ''}`} disabled={running} onClick={() => void run()}>
          {running ? 'Running…' : 'Run ⌘⏎'}
        </button>
      </div>
      {project.aiReady && (
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
      )}
      <div className="editor-box small">
        <CodeEditor language="soql" value={soql} onChange={setSoql} onMount={onMount} />
      </div>
      {error && <div className="error">{error}</div>}
      {result && result.totalSize === 0 && !running && <EmptyHint />}
      {result && (
        <div className="card">
          <div className="form query-more">
            {loading ? (
              <>
                <span className="muted">
                  Loading… {result.rows.length.toLocaleString()} of {result.totalSize.toLocaleString()}
                </span>
                <button
                  onClick={() => {
                    loadToken.current++;
                    setLoading(false);
                  }}
                >
                  Stop
                </button>
              </>
            ) : result.next ? (
              <>
                <span className="muted">
                  {result.rows.length.toLocaleString()} of {result.totalSize.toLocaleString()} rows loaded.
                </span>
                <button onClick={() => void loadRest(result, result.rows.length + BATCH)}>
                  Load next {Math.min(BATCH, result.totalSize - result.rows.length).toLocaleString()}
                </button>
              </>
            ) : null}
            <span className="grow" />
            {lookingUp && <span className="muted">Looking up names…</span>}
            {hasIds && (
              <button
                className={relatedOpen ? 'active' : ''}
                title="Add fields of the records the Id columns point to, e.g. AccountId → Account Industry, UserId → User Email"
                onClick={() => setRelatedOpen(!relatedOpen)}
              >
                Related fields…
              </button>
            )}
            <QueryExport
              soql={ranSoql}
              cursor={{ ...result, columns: shown.columns, rows: shown.rows }}
              includeDeleted={includeDeleted}
            />
          </div>
          {relatedOpen && (
            <RelatedFields
              client={client}
              objects={lookup?.objects ?? {}}
              links={links}
              related={related}
              onChange={setRelated}
              onAddToQuery={(fields, target) => {
                try {
                  const next = addToSelect(ranSoql, fields);
                  setRelated({ ...related, [target]: [] });
                  setSoql(next);
                  setRelatedOpen(false);
                  void run(next);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            />
          )}
          <DataTable
            name={result.sobject ?? 'query'}
            columns={shown.columns}
            rows={shown.rows}
            instanceUrl={org.instanceUrl}
            note={
              <>
                · {result.totalSize.toLocaleString()} in the org · {(result.durationMs / 1000).toFixed(1)} s
              </>
            }
          />
        </div>
      )}
    </div>
  );
}
