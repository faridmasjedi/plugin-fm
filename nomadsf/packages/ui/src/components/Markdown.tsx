import type { ReactNode } from 'react';

/**
 * The Markdown of an AI answer, shown as text: headings, paragraphs, lists, tables, code blocks, **bold**, *italic*,
 * `code` and line breaks. Built as React elements — the answer is never put in the page as HTML.
 */

/** **bold**, *italic*, `code` and <br> inside a line. */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|<br\s*\/?>)/gi;
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith('**')) out.push(<strong key={k}>{t.slice(2, -2)}</strong>);
    else if (/^<br/i.test(t)) out.push(<br key={k} />);
    else out.push(<em key={k}>{t.slice(1, -1)}</em>);
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
const isTableRow = (line: string): boolean => /^\s*\|.*\|\s*$/.test(line);
const isSeparator = (line: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  let n = 0;
  const key = (): string => `b${n++}`;
  while (i < lines.length) {
    const line = lines[i];
    // ```lang … ```
    const fence = /^\s*```\s*([\w-]*)/.exec(line);
    if (fence) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i += 1;
      blocks.push(
        <pre key={key()} className="ai-code" data-lang={fence[1] || undefined}>
          {code.join('\n').replace(/<br\s*\/?>/gi, '\n')}
        </pre>
      );
      continue;
    }
    // | a | b | then |---|---|
    if (isTableRow(line) && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      const k = key();
      blocks.push(
        <div key={k} className="md-table">
          <table>
            <thead>
              <tr>
                {head.map((h, c) => (
                  <th key={c}>{inline(h, `${k}h${c}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, c) => (
                    <td key={c}>{inline(r[c] ?? '', `${k}r${ri}c${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    // # Heading
    const heading = /^\s*(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const k = key();
      const level = heading[1].length;
      blocks.push(level <= 2 ? <h4 key={k}>{inline(heading[2], k)}</h4> : <h5 key={k}>{inline(heading[2], k)}</h5>);
      i += 1;
      continue;
    }
    // - item / 1. item
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i]))
        items.push(lines[i++].replace(/^\s*([-*+]|\d+[.)])\s+/, ''));
      const k = key();
      const list = items.map((it, j) => <li key={j}>{inline(it, `${k}i${j}`)}</li>);
      blocks.push(ordered ? <ol key={k}>{list}</ol> : <ul key={k}>{list}</ul>);
      continue;
    }
    if (!line.trim() || /^\s*\|?\s*$/.test(line)) {
      i += 1;
      continue;
    }
    // A paragraph: lines until a blank line or another block
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*```/.test(lines[i]) &&
      !/^\s*#{1,4}\s/.test(lines[i]) &&
      !/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) &&
      !(isTableRow(lines[i]) && i + 1 < lines.length && isSeparator(lines[i + 1]))
    )
      para.push(lines[i++]);
    const k = key();
    blocks.push(<p key={k}>{inline(para.join(' '), k)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
