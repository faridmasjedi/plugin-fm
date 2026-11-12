import type { OnMount } from '@monaco-editor/react';

type Editor = Parameters<OnMount>[0];

/** A piece of help at the cursor (its ${1:n} selected to type over), or a whole example: undoable with ⌘Z. */
export function insertSnippet(editor: Editor | null, snippet: string, replaceAll = false): void {
  if (!editor) return;
  editor.focus();
  const model = editor.getModel();
  if (replaceAll && model) editor.setSelection(model.getFullModelRange());
  const snippets = editor.getContribution('snippetController2') as { insert(text: string): void } | null;
  if (snippets) snippets.insert(snippet);
  else
    editor.executeEdits('help', [
      { range: editor.getSelection()!, text: snippet.replace(/\$\{\d+:([^}]*)\}/g, '$1'), forceMoveMarkers: true },
    ]);
}
