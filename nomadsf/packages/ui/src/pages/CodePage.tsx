import { useCallback, useEffect, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import {
  createApexClass,
  listCode,
  newClassTemplate,
  openCode,
  saveApex,
  saveLwcFile,
  type CodeFile,
  type CodeItem,
  type CodeKind,
  type CompileProblem,
} from '@nomadsf/core';
import { CodeEditor } from '../components/CodeEditor';
import { storage, useStudio } from '../context';
import { monaco } from '../monaco';

const KINDS: Array<{ id: CodeKind; label: string }> = [
  { id: 'ApexClass', label: 'Classes' },
  { id: 'ApexTrigger', label: 'Triggers' },
  { id: 'LWC', label: 'LWC' },
];

/** Developer Console's editor: open, compile and save Apex classes, triggers and LWC files. */
export function CodePage() {
  const studio = useStudio();
  const { client, facts } = studio;
  const [kind, setKind] = useState<CodeKind>(() => storage.get('code.kind', 'ApexClass'));
  const [items, setItems] = useState<CodeItem[] | null>(null);
  const [filter, setFilter] = useState('');
  const [item, setItem] = useState<CodeItem | null>(null);
  const [files, setFiles] = useState<CodeFile[]>([]);
  const [fileIndex, setFileIndex] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [problems, setProblems] = useState<CompileProblem[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const editor = useRef<Parameters<OnMount>[0] | null>(null);
  // Salesforce blocks Apex changes in production; Developer Edition orgs allow them
  const apexLocked = facts ? !facts.isSandbox && !/developer/i.test(facts.organizationType) : false;

  const load = useCallback(async () => {
    setItems(null);
    storage.set('code.kind', kind);
    try {
      setItems(await listCode(client, kind));
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  }, [client, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = files.filter((f) => drafts[f.id] !== undefined && drafts[f.id] !== f.source);

  const switchKind = (next: CodeKind) => {
    if (next === kind || (dirty.length && !confirm('Discard unsaved changes?'))) return;
    setKind(next);
    setItem(null);
    setFiles([]);
    setDrafts({});
    setProblems([]);
    setStatus('');
  };

  const openItem = async (next: CodeItem) => {
    if (dirty.length && !confirm('Discard unsaved changes?')) return;
    setStatus(`Opening ${next.name}…`);
    try {
      setFiles(await openCode(client, next));
      setItem(next);
      setFileIndex(0);
      setDrafts({});
      setProblems([]);
      setStatus('');
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  // Compile problems as squiggles in the editor
  useEffect(() => {
    const model = editor.current?.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'nomadsf',
      problems
        .filter((p) => p.line)
        .map((p) => ({
          severity: monaco.MarkerSeverity.Error,
          message: p.problem,
          startLineNumber: p.line!,
          startColumn: p.column ?? 1,
          endLineNumber: p.line!,
          endColumn: (p.column ?? 1) + 200,
        }))
    );
  }, [problems, fileIndex, files]);

  const compile = async (checkOnly: boolean) => {
    if (!item) return;
    const file = files[0];
    const body = drafts[file.id] ?? file.source;
    if (!checkOnly && !studio.confirmChange(`Save ${item.name} to ${studio.org.label}`)) return;
    setBusy(true);
    setStatus(checkOnly ? 'Compiling…' : 'Saving…');
    try {
      const result = await saveApex(client, item, body, { checkOnly });
      setProblems(result.problems);
      if (result.ok) {
        setStatus(checkOnly ? '✓ Compiles.' : '✓ Saved.');
        if (!checkOnly) {
          studio.logActivity('save code', { kind: item.kind, name: item.name });
          setFiles([{ ...file, source: body }]);
          setDrafts({});
        }
      } else {
        setStatus(`❌ ${result.state}: ${result.problems.length} problem(s)`);
      }
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const saveLwc = async () => {
    if (!item || !dirty.length) return;
    if (!studio.confirmChange(`Save ${dirty.length} file(s) of ${item.name} to ${studio.org.label}`)) return;
    setBusy(true);
    setStatus('Saving…');
    try {
      for (const file of dirty) {
        // eslint-disable-next-line no-await-in-loop
        await saveLwcFile(client, file.id, drafts[file.id]);
      }
      studio.logActivity('save code', { kind: 'LWC', name: item.name, files: dirty.map((f) => f.path) });
      setFiles(files.map((f) => (drafts[f.id] !== undefined ? { ...f, source: drafts[f.id] } : f)));
      setDrafts({});
      setProblems([]);
      setStatus('✓ Saved.');
    } catch (e) {
      // LWC compile errors come back as the save error
      setProblems([{ problem: (e as Error).message }]);
      setStatus(`❌ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const newClass = async () => {
    const name = prompt('Name of the new Apex class:')?.trim();
    if (!name) return;
    if (!/^[A-Za-z]\w{0,39}$/.test(name)) return setStatus('❌ Use letters, digits and _ (max 40).');
    if (!studio.confirmChange(`Create the Apex class ${name} in ${studio.org.label}`)) return;
    try {
      const id = await createApexClass(client, newClassTemplate(name));
      studio.logActivity('create class', { name });
      await load();
      await openItem({ id, name, kind: 'ApexClass' });
    } catch (e) {
      setStatus(`❌ ${(e as Error).message}`);
    }
  };

  const file = files[fileIndex];
  const shown = (items ?? []).filter((i) => i.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="page">
      <div className="toolbar">
        <h2>Code</h2>
        <div className="tabs">
          {KINDS.map((k) => (
            <button key={k.id} className={`tab ${kind === k.id ? 'active' : ''}`} onClick={() => switchKind(k.id)}>
              {k.label}
            </button>
          ))}
        </div>
        <span className="grow" />
        {kind === 'ApexClass' && (
          <button disabled={apexLocked} onClick={() => void newClass()}>
            New class
          </button>
        )}
        {item && item.kind !== 'LWC' && (
          <>
            <button disabled={busy} onClick={() => void compile(true)}>
              Check
            </button>
            <button
              className="primary"
              disabled={busy || apexLocked || !dirty.length}
              onClick={() => void compile(false)}
            >
              Save
            </button>
          </>
        )}
        {item?.kind === 'LWC' && (
          <button className="primary" disabled={busy || !dirty.length} onClick={() => void saveLwc()}>
            Save {dirty.length || ''}
          </button>
        )}
      </div>
      {apexLocked && kind !== 'LWC' && (
        <p className="muted">
          Production org: Salesforce only accepts Apex changes through a deployment. Opening and Check still work.
        </p>
      )}
      {status && <p className="muted">{status}</p>}
      <div className="code-layout">
        <div className="card code-list">
          <input
            placeholder={`Filter ${items?.length ?? ''}`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {items === null && <p className="muted">Loading…</p>}
          <ul>
            {shown.map((i) => (
              <li key={i.id}>
                <button
                  className={item?.id === i.id ? 'active' : ''}
                  onClick={() => void openItem(i)}
                  title={i.lastModified}
                >
                  {i.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="card section">
          {!file ? (
            <p className="muted">
              Open a{' '}
              {KINDS.find((k) => k.id === kind)
                ?.label.toLowerCase()
                .replace(/s$/, '')}{' '}
              on the left.
            </p>
          ) : (
            <>
              {files.length > 1 && (
                <div className="tabs">
                  {files.map((f, i) => (
                    <button
                      key={f.id}
                      className={`tab ${i === fileIndex ? 'active' : ''}`}
                      onClick={() => setFileIndex(i)}
                    >
                      {f.path.split('/').pop()}
                      {drafts[f.id] !== undefined && drafts[f.id] !== f.source ? ' •' : ''}
                    </button>
                  ))}
                </div>
              )}
              <div className="editor-box tall">
                <CodeEditor
                  key={file.id}
                  language={file.language}
                  value={drafts[file.id] ?? file.source}
                  onChange={(v) => setDrafts((d) => ({ ...d, [file.id]: v }))}
                  onMount={(e) => {
                    editor.current = e;
                  }}
                />
              </div>
              {problems.length > 0 && (
                <ul className="problems">
                  {problems.map((p, i) => (
                    <li key={i}>
                      {p.line ? (
                        <button
                          className="link"
                          onClick={() => {
                            editor.current?.revealLineInCenter(p.line!);
                            editor.current?.setPosition({ lineNumber: p.line!, column: p.column ?? 1 });
                            editor.current?.focus();
                          }}
                        >
                          {p.line}:{p.column ?? 1}
                        </button>
                      ) : null}{' '}
                      {p.problem}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
