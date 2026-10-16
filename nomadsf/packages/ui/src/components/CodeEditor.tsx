import Editor, { type OnMount } from '@monaco-editor/react';
import { registerLanguages } from '../monaco';
import { useTheme } from '../theme';

registerLanguages();

export type CodeEditorProps = {
  language: 'apex' | 'soql' | 'plaintext' | 'json';
  value: string;
  onChange?: (value: string) => void;
  onMount?: OnMount;
  height?: string | number;
  readOnly?: boolean;
};

export function CodeEditor({ language, value, onChange, onMount, height = '100%', readOnly = false }: CodeEditorProps) {
  const theme = useTheme();
  return (
    <Editor
      language={language}
      value={value}
      height={height}
      theme={theme === 'dark' ? 'nomad-dark' : 'nomad-light'}
      onChange={(v) => onChange?.(v ?? '')}
      onMount={onMount}
      options={{
        readOnly,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false,
        automaticLayout: true,
        wordWrap: language === 'plaintext' ? 'on' : 'off',
        tabSize: 4,
        renderLineHighlight: readOnly ? 'none' : 'line',
      }}
    />
  );
}
