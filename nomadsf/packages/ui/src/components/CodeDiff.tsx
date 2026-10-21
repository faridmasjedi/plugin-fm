import { useEffect, useRef, useState } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import { registerLanguages } from '../monaco';
import { inVsCode } from '../embed';
import { useTheme } from '../theme';
import type { CodeEditorProps } from './CodeEditor';

registerLanguages();

type DiffEditorInstance = Parameters<DiffOnMount>[0];

/**
 * Two versions of a file side by side (read-only), changed lines highlighted, with buttons to
 * jump between changes. Used for org ↔ project; any two texts work.
 */
export function CodeDiff({
  original,
  modified,
  language,
  labels,
}: {
  original: string;
  modified: string;
  language: CodeEditorProps['language'];
  labels: [string, string];
}) {
  const theme = useTheme();
  const editor = useRef<DiffEditorInstance | null>(null);
  const [sideBySide, setSideBySide] = useState(true);
  const [ignoreSpaces, setIgnoreSpaces] = useState(true);
  const [changes, setChanges] = useState<number | null>(null);
  const at = useRef(-1);

  // The library disposes the models while the diff widget still holds them (a console error):
  // let go of them first (this cleanup runs before the library's)
  useEffect(() => () => editor.current?.setModel(null), []);

  const jump = (step: 1 | -1) => {
    const list = editor.current?.getLineChanges() ?? [];
    if (!list.length) return;
    at.current = (at.current + step + list.length) % list.length;
    const change = list[at.current];
    // A deletion has no lines on the right: show it on the left
    const removed = change.modifiedEndLineNumber === 0;
    const side = removed ? editor.current!.getOriginalEditor() : editor.current!.getModifiedEditor();
    const line = Math.max(1, removed ? change.originalStartLineNumber : change.modifiedStartLineNumber);
    side.revealLineInCenter(line);
    side.setPosition({ lineNumber: line, column: 1 });
  };

  return (
    <div className="code-diff">
      <div className="toolbar diff-bar">
        <span className="diff-label">
          <span className="diff-side old">−</span> {labels[0]}
        </span>
        <span className="diff-label">
          <span className="diff-side new">+</span> {labels[1]}
        </span>
        <span className="grow" />
        <span className="muted">
          {changes === null ? '' : changes === 0 ? 'No differences' : `${changes} change${changes === 1 ? '' : 's'}`}
        </span>
        <button disabled={!changes} onClick={() => jump(-1)} title="Previous change">
          ↑
        </button>
        <button disabled={!changes} onClick={() => jump(1)} title="Next change">
          ↓
        </button>
        <label className="check">
          <input type="checkbox" checked={ignoreSpaces} onChange={(e) => setIgnoreSpaces(e.target.checked)} /> Ignore
          spaces
        </label>
        <label className="check">
          <input type="checkbox" checked={sideBySide} onChange={(e) => setSideBySide(e.target.checked)} /> Side by side
        </label>
      </div>
      <div className="editor-box tall">
        <DiffEditor
          original={original}
          modified={modified}
          language={language}
          height="100%"
          theme={theme === 'dark' ? 'nomad-dark' : 'nomad-light'}
          onMount={(e) => {
            editor.current = e;
            at.current = -1;
            const count = () => setChanges(e.getLineChanges()?.length ?? null);
            e.onDidUpdateDiff(count);
            // A small diff can be ready before the listener is attached
            setTimeout(count, 300);
          }}
          options={{
            readOnly: true,
            originalEditable: false,
            contextmenu: !inVsCode(),
            renderSideBySide: sideBySide,
            ignoreTrimWhitespace: ignoreSpaces,
            minimap: { enabled: false },
            fontSize: 13,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderOverviewRuler: true,
          }}
        />
      </div>
    </div>
  );
}
