/**
 * Filter logic of a table, as in Salesforce list views and reports: the filters are numbered 1, 2, 3… and the logic
 * combines them — "1 OR 2", "(1 AND 2) OR NOT 3". Empty logic means every filter (AND).
 */

export type FilterLogic = (results: boolean[]) => boolean;

type Token = { kind: 'num'; n: number } | { kind: 'op'; op: 'AND' | 'OR' | 'NOT' } | { kind: '(' | ')' };

function tokens(text: string): Token[] {
  const out: Token[] = [];
  const re = /\s*(\d+|AND\b|OR\b|NOT\b|&&|\|\||[()!])\s*/giy;
  let at = 0;
  while (at < text.length) {
    re.lastIndex = at;
    const m = re.exec(text);
    if (!m) {
      if (/^\s*$/.test(text.slice(at))) break;
      throw new Error(`Not understood: “${text.slice(at).trim().split(/\s+/)[0]}”. Use numbers, AND, OR, NOT and ( ).`);
    }
    at = re.lastIndex;
    const t = m[1].toUpperCase();
    if (/^\d+$/.test(t)) out.push({ kind: 'num', n: Number(t) });
    else if (t === '(' || t === ')') out.push({ kind: t });
    else
      out.push({
        kind: 'op',
        op: t === '&&' ? 'AND' : t === '||' ? 'OR' : t === '!' ? 'NOT' : (t as 'AND' | 'OR' | 'NOT'),
      });
  }
  return out;
}

/**
 * Reads the logic for `count` filters. Throws with a plain message when it cannot be read (a number with no filter,
 * a missing bracket, AND and OR mixed without brackets…).
 */
export function parseFilterLogic(text: string, count: number): FilterLogic {
  if (!text.trim()) return (r) => r.every(Boolean);
  const list = tokens(text);
  let i = 0;
  const peek = (): Token | undefined => list[i];
  type Node = (r: boolean[]) => boolean;

  const atom = (): Node => {
    const t = list[i++];
    if (!t) throw new Error('The logic ends too early.');
    if (t.kind === 'num') {
      if (t.n < 1 || t.n > count) throw new Error(`There is no filter ${t.n} (filters are 1 to ${count}).`);
      const k = t.n - 1;
      return (r) => r[k] ?? true;
    }
    if (t.kind === 'op' && t.op === 'NOT') {
      const inner = atom();
      return (r) => !inner(r);
    }
    if (t.kind === '(') {
      const inner = expr();
      if (list[i++]?.kind !== ')') throw new Error('A “(” is not closed.');
      return inner;
    }
    throw new Error(t.kind === 'op' ? `“${t.op}” needs a filter number before it.` : 'A “)” has no “(”.');
  };
  const expr = (): Node => {
    const parts = [atom()];
    let op: 'AND' | 'OR' | undefined;
    for (let t = peek(); t && t.kind === 'op' && t.op !== 'NOT'; t = peek()) {
      if (op && op !== t.op) throw new Error('Mixing AND and OR needs brackets, e.g. 1 OR (2 AND 3).');
      op = t.op;
      i++;
      parts.push(atom());
    }
    return op === 'OR' ? (r) => parts.some((p) => p(r)) : (r) => parts.every((p) => p(r));
  };

  const root = expr();
  if (i < list.length) {
    const t = list[i];
    throw new Error(t.kind === ')' ? 'A “)” has no “(”.' : 'Put AND or OR between filters.');
  }
  return root;
}
