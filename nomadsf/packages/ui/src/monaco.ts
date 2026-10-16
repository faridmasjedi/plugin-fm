// Monaco bundled locally (no CDN): required for the browser extension (MV3 forbids remote code).
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/edcore.main';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};
loader.config({ monaco });

const APEX_KEYWORDS = [
  'abstract',
  'after',
  'before',
  'break',
  'catch',
  'class',
  'continue',
  'delete',
  'do',
  'else',
  'enum',
  'extends',
  'final',
  'finally',
  'for',
  'global',
  'if',
  'implements',
  'insert',
  'instanceof',
  'interface',
  'merge',
  'new',
  'null',
  'on',
  'override',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'testmethod',
  'this',
  'throw',
  'transient',
  'trigger',
  'try',
  'undelete',
  'update',
  'upsert',
  'virtual',
  'void',
  'webservice',
  'when',
  'while',
  'with',
  'without',
  'sharing',
  'inherited',
  'true',
  'false',
  'get',
  'set',
];
const APEX_TYPES = [
  'Blob',
  'Boolean',
  'Date',
  'Datetime',
  'Decimal',
  'Double',
  'Id',
  'Integer',
  'List',
  'Long',
  'Map',
  'Object',
  'Set',
  'SObject',
  'String',
  'Time',
  'Database',
  'System',
  'Schema',
  'Test',
  'UserInfo',
  'Limits',
  'JSON',
  'Math',
  'Http',
  'HttpRequest',
  'HttpResponse',
  'Exception',
  'Messaging',
  'Approval',
  'Trigger',
];
const SOQL_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'IN',
  'LIKE',
  'INCLUDES',
  'EXCLUDES',
  'ORDER',
  'BY',
  'ASC',
  'DESC',
  'NULLS',
  'FIRST',
  'LAST',
  'LIMIT',
  'OFFSET',
  'GROUP',
  'HAVING',
  'ROLLUP',
  'CUBE',
  'TYPEOF',
  'WHEN',
  'THEN',
  'ELSE',
  'END',
  'USING',
  'SCOPE',
  'WITH',
  'SECURITY_ENFORCED',
  'USER_MODE',
  'SYSTEM_MODE',
  'FOR',
  'VIEW',
  'REFERENCE',
  'UPDATE',
  'TRACKING',
  'VIEWSTAT',
  'ALL',
  'ROWS',
  'COUNT',
  'COUNT_DISTINCT',
  'SUM',
  'AVG',
  'MIN',
  'MAX',
  'FIELDS',
  'STANDARD',
  'CUSTOM',
  'TRUE',
  'FALSE',
  'NULL',
  'TODAY',
  'YESTERDAY',
  'TOMORROW',
  'LAST_N_DAYS',
  'NEXT_N_DAYS',
  'THIS_WEEK',
  'LAST_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'THIS_YEAR',
  'LAST_YEAR',
  'FORMAT',
  'toLabel',
  'convertCurrency',
  'CALENDAR_YEAR',
  'CALENDAR_MONTH',
  'DAY_ONLY',
];

let registered = false;

/** Registers Apex and SOQL highlighting (once). */
export function registerLanguages(): void {
  if (registered) return;
  registered = true;

  monaco.languages.register({ id: 'apex' });
  monaco.languages.setMonarchTokensProvider('apex', {
    ignoreCase: true,
    keywords: APEX_KEYWORDS,
    typeKeywords: APEX_TYPES,
    tokenizer: {
      root: [
        [/@\w+/, 'annotation'],
        [/\[/, { token: 'delimiter.bracket', next: '@soql' }],
        [/[a-zA-Z_]\w*/, { cases: { '@keywords': 'keyword', '@typeKeywords': 'type', '@default': 'identifier' } }],
        [/\/\/.*$/, 'comment'],
        [/\/\*/, 'comment', '@comment'],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\d+(\.\d+)?[lLdD]?/, 'number'],
        [/[{}()]/, 'delimiter.bracket'],
      ],
      comment: [
        [/[^/*]+/, 'comment'],
        [/\*\//, 'comment', '@pop'],
        [/[/*]/, 'comment'],
      ],
      // Inline SOQL: [SELECT Id FROM Account]
      soql: [
        [/\]/, { token: 'delimiter.bracket', next: '@pop' }],
        [/[a-zA-Z_]\w*/, { cases: { [`(${SOQL_KEYWORDS.join('|')})`]: 'keyword.soql', '@default': 'identifier' } }],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/:\w+/, 'variable'],
        [/\d+/, 'number'],
      ],
    },
  } as monaco.languages.IMonarchLanguage);
  monaco.languages.setLanguageConfiguration('apex', {
    comments: { lineComment: '//', blockComment: ['/*', '*/'] },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: "'", close: "'", notIn: ['string', 'comment'] },
    ],
  });
  monaco.languages.registerCompletionItemProvider('apex', {
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const snippet = (label: string, insertText: string, detail: string): monaco.languages.CompletionItem => ({
        label,
        kind: monaco.languages.CompletionItemKind.Snippet,
        insertText,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        detail,
        range,
      });
      return {
        suggestions: [
          snippet('debug', 'System.debug(LoggingLevel.DEBUG, ${1:value});', 'System.debug'),
          snippet(
            'query',
            'List<${1:Account}> ${2:records} = [SELECT Id, Name FROM ${1:Account} LIMIT ${3:10}];',
            'SOQL into a list'
          ),
          snippet('for', 'for (${1:Account} ${2:record} : ${3:records}) {\n\t$0\n}', 'for-each loop'),
          snippet('try', 'try {\n\t$0\n} catch (Exception e) {\n\tSystem.debug(e.getMessage());\n}', 'try / catch'),
          snippet(
            'limits',
            "System.debug('SOQL ' + Limits.getQueries() + '/' + Limits.getLimitQueries() + ', CPU ' + Limits.getCpuTime());",
            'Print limits'
          ),
          ...[...APEX_KEYWORDS, ...APEX_TYPES].map((k) => ({
            label: k,
            kind: monaco.languages.CompletionItemKind.Keyword,
            insertText: k,
            range,
          })),
        ],
      };
    },
  });

  monaco.languages.register({ id: 'soql' });
  monaco.languages.setMonarchTokensProvider('soql', {
    ignoreCase: true,
    keywords: SOQL_KEYWORDS,
    tokenizer: {
      root: [
        [/[a-zA-Z_][\w.]*/, { cases: { '@keywords': 'keyword', '@default': 'identifier' } }],
        [/'([^'\\]|\\.)*'/, 'string'],
        [/\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/, 'number'],
        [/\d+(\.\d+)?/, 'number'],
        [/--.*$/, 'comment'],
      ],
    },
  } as monaco.languages.IMonarchLanguage);

  monaco.editor.defineTheme('nomad-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'annotation', foreground: 'c586c0' },
      { token: 'keyword.soql', foreground: '4fc1ff', fontStyle: 'bold' },
      { token: 'variable', foreground: '9cdcfe' },
    ],
    colors: { 'editor.background': '#0f1216' },
  });
  monaco.editor.defineTheme('nomad-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'annotation', foreground: 'af00db' },
      { token: 'keyword.soql', foreground: '0b5cff', fontStyle: 'bold' },
    ],
    colors: {},
  });
}

export { monaco };
