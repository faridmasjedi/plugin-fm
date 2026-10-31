/**
 * What runs when Apex runs: a graph of classes and triggers built from their source.
 *
 * Edges, from a unit to what it can make run:
 * - calls: the unit names another class (new X(), X.method(), X as a type);
 * - dml:   the unit inserts/updates/deletes records of an object, so that object's triggers fire.
 *
 * Tests for a component are the test classes that reach it through those edges, so a trigger is covered by the tests
 * that write its object, directly or through the classes they call. Apex is case-insensitive: units are keyed in
 * lower case and shown with the name of their file. Parsing is lexical (no compiler), so dynamic calls
 * (Type.forName, Database.insert on a List<SObject>) are not seen; "// @tests: A, B" comments add tests by hand.
 * Ported from NomadSF Release Hub (sf nomad deps).
 */

export type ApexSource = { name: string; kind: 'class' | 'trigger'; body: string; file?: string };

export type ApexUnit = {
  name: string;
  kind: 'class' | 'trigger';
  file?: string;
  isTest: boolean;
  /** Trigger: the object it is on, and its events. */
  sobject?: string;
  events?: string[];
  /** Classes it names. */
  references: string[];
  /** Objects it writes (insert, update, upsert, delete, undelete, merge). */
  dml: string[];
  /** Test classes named in a "@tests" comment. */
  declaredTests: string[];
};

export type Edge = { to: string; via: 'calls' | 'dml'; sobject?: string };

export type ApexGraph = {
  units: Map<string, ApexUnit>;
  /** unit → what it can make run */
  down: Map<string, Edge[]>;
  /** unit → what can make it run */
  up: Map<string, Edge[]>;
  triggersByObject: Map<string, string[]>;
};

export type DepNode = {
  name: string;
  kind: 'class' | 'trigger' | 'unknown';
  isTest: boolean;
  sobject?: string;
  via?: 'calls' | 'dml';
  /** The object written, for dml edges. */
  dmlObject?: string;
  children: DepNode[];
  /** Already shown higher up in the tree: not expanded again. */
  repeated?: boolean;
  /** Stopped at --depth. */
  truncated?: boolean;
};

export type TestsForComponent = {
  name: string;
  kind: 'class' | 'trigger' | 'unknown';
  tests: string[];
  declared: string[];
};

export type TestSelection = {
  tests: string[];
  components: TestsForComponent[];
  /** Components no test reaches. */
  uncovered: string[];
};

const key = (name: string): string => name.toLowerCase();

/** Removes comments and the contents of string literals, keeping line breaks. */
export function stripCommentsAndStrings(code: string): string {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') i++;
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        if (code[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      out += ' ';
    } else if (c === "'") {
      i++;
      while (i < code.length && code[i] !== "'") i += code[i] === '\\' ? 2 : 1;
      i++;
      out += "''";
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** "@tests: A, B" / "* @tests A B" lines of the source. */
export function declaredTests(code: string): string[] {
  const found: string[] = [];
  for (const line of code.split('\n')) {
    const m = /@tests\b\s*:?\s*(.*)$/i.exec(line);
    if (!m) continue;
    for (const name of m[1].replace(/\*\/.*$/, '').split(/[\s,]+/)) if (/^\w+$/.test(name)) found.push(name);
  }
  return [...new Set(found)];
}

/** The text of the first argument of a call whose "(" is at `open`. */
function firstArgument(code: string, open: number): string {
  let depth = 0;
  for (let i = open + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}' || c === '>') {
      if (depth === 0) return code.slice(open + 1, i);
      depth--;
    } else if (c === ',' && depth === 0) return code.slice(open + 1, i);
  }
  return '';
}

/** The record type of a declared type: List<X>, Set<X>, X[] → X; Map<K, V> → V. */
export function elementType(type: string): string {
  const t = type.replace(/\s+/g, '');
  const map = /^Map<[^,]+,(.+)>$/i.exec(t);
  if (map) return elementType(map[1]);
  const generic = /^(?:List|Set|Iterable)<(.+)>$/i.exec(t);
  if (generic) return elementType(generic[1]);
  return t.replace(/\[\]$/, '');
}

const NOT_TYPES = new Set([
  'return',
  'new',
  'else',
  'throw',
  'final',
  'static',
  'public',
  'private',
  'global',
  'insert',
  'update',
  'upsert',
  'delete',
  'undelete',
  'merge',
]);

/** The object type written by a DML expression, when it can be told from the code. */
export function dmlTarget(expression: string, code: string): string | undefined {
  const expr = expression.trim();
  const created = /^new\s+([\w.]+(?:\s*<[^>]*>)?)\s*(?:\(|\[|\{)/i.exec(expr);
  if (created) return elementType(created[1]);
  const query = /^\[\s*select\b[\s\S]*?\bfrom\s+(\w+)/i.exec(expr);
  if (query) return query[1];
  const variable = /^([A-Za-z_]\w*)/.exec(expr)?.[1];
  if (!variable) return undefined;
  const declaration = new RegExp(
    `([A-Za-z_][\\w.]*(?:\\s*<[^;=(){}]*?>)?(?:\\s*\\[\\s*\\])?)\\s+${variable}\\s*(?:=|;|,|\\)|:)`,
    'gi'
  );
  let type: string | undefined;
  for (const m of code.matchAll(declaration)) if (!NOT_TYPES.has(m[1].toLowerCase())) type = m[1];
  if (!type) return undefined;
  const element = elementType(type);
  return /^(SObject|Object)$/i.test(element) ? undefined : element;
}

/** Objects written by the code. */
export function dmlObjects(code: string): string[] {
  const found = new Set<string>();
  const add = (expression: string): void => {
    const target = dmlTarget(expression, code);
    if (target && /^[A-Za-z]\w*$/.test(target)) found.add(target);
  };
  for (const m of code.matchAll(/(?<![.\w])(insert|update|upsert|delete|undelete|merge)\s+([^;]+);/gi)) add(m[2]);
  for (const m of code.matchAll(
    /\bDatabase\s*\.\s*(?:insert|update|upsert|delete|undelete|merge)(?:Async|Immediate)?\s*\(/gi
  )) {
    add(firstArgument(code, (m.index ?? 0) + m[0].length - 1));
  }
  return [...found];
}

/** Parses one class or trigger; `classes` are the known class names (lower case). */
export function parseApex(source: ApexSource, classes: Set<string>): ApexUnit {
  const code = stripCommentsAndStrings(source.body);
  const unit: ApexUnit = {
    name: source.name,
    kind: source.kind,
    file: source.file,
    isTest: /@istest\b/i.test(code) || /\btestmethod\b/i.test(code),
    references: [],
    dml: dmlObjects(code),
    declaredTests: declaredTests(source.body),
  };
  if (source.kind === 'trigger') {
    const header = /\btrigger\s+\w+\s+on\s+([\w.]+)\s*\(([^)]*)\)/i.exec(code);
    if (header) {
      unit.sobject = header[1];
      unit.events = header[2]
        .split(',')
        .map((e) => e.trim().replace(/\s+/g, ' ').toLowerCase())
        .filter(Boolean);
    }
  }
  const self = key(source.name);
  const references = new Map<string, string>();
  // An identifier right after "." is a member (obj.Name), not a class
  for (const m of code.matchAll(/(\.\s*)?\b([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    if (m[1]) continue;
    const k = key(m[2]);
    if (k !== self && classes.has(k) && !references.has(k)) references.set(k, m[2]);
  }
  unit.references = [...references.keys()];
  return unit;
}

export function buildGraph(sources: ApexSource[]): ApexGraph {
  const classes = new Set(sources.filter((s) => s.kind === 'class').map((s) => key(s.name)));
  const units = new Map<string, ApexUnit>();
  for (const source of sources) units.set(key(source.name), parseApex(source, classes));

  const triggersByObject = new Map<string, string[]>();
  for (const [k, unit] of units) {
    if (unit.kind !== 'trigger' || !unit.sobject) continue;
    const object = key(unit.sobject);
    triggersByObject.set(object, [...(triggersByObject.get(object) ?? []), k]);
  }

  const down = new Map<string, Edge[]>();
  const up = new Map<string, Edge[]>();
  const link = (from: string, edge: Edge): void => {
    if (from === edge.to) return;
    down.set(from, [...(down.get(from) ?? []), edge]);
    up.set(edge.to, [...(up.get(edge.to) ?? []), { ...edge, to: from }]);
  };
  for (const [k, unit] of units) {
    for (const ref of unit.references) if (units.get(ref)?.kind === 'class') link(k, { to: ref, via: 'calls' });
    for (const object of unit.dml) {
      for (const trigger of triggersByObject.get(key(object)) ?? [])
        link(k, { to: trigger, via: 'dml', sobject: object });
    }
  }
  return { units, down, up, triggersByObject };
}

/**
 * The tree from a unit: "down" is what can run when it runs, "up" is what can make it run.
 * Each unit is expanded once; later occurrences are marked repeated.
 */
export function dependencyTree(graph: ApexGraph, name: string, direction: 'down' | 'up', maxDepth = 10): DepNode {
  const expanded = new Set<string>();
  const visit = (k: string, depth: number, edge?: Edge): DepNode => {
    const unit = graph.units.get(k);
    const node: DepNode = {
      name: unit?.name ?? k,
      kind: unit?.kind ?? 'unknown',
      isTest: unit?.isTest ?? false,
      sobject: unit?.sobject,
      via: edge?.via,
      dmlObject: edge?.sobject,
      children: [],
    };
    if (expanded.has(k)) return { ...node, repeated: true };
    expanded.add(k);
    const edges = (direction === 'down' ? graph.down : graph.up).get(k) ?? [];
    if (edges.length && depth >= maxDepth) return { ...node, truncated: true };
    const seen = new Set<string>();
    for (const e of [...edges].sort((a, b) => sortName(graph, a.to).localeCompare(sortName(graph, b.to)))) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      node.children.push(visit(e.to, depth + 1, e));
    }
    return node;
  };
  return visit(key(name), 0);
}

const sortName = (graph: ApexGraph, k: string): string => graph.units.get(k)?.name ?? k;

/** Test classes that reach the unit (through calls and DML), plus its "@tests" and naming-convention tests. */
export function testsReaching(graph: ApexGraph, name: string, maxDepth = Infinity): string[] {
  const start = key(name);
  const tests = new Set<string>();
  const seen = new Set([start]);
  let frontier = [start];
  if (graph.units.get(start)?.isTest) tests.add(start);
  for (let depth = 0; frontier.length && depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const k of frontier) {
      for (const edge of graph.up.get(k) ?? []) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        if (graph.units.get(edge.to)?.isTest) tests.add(edge.to);
        next.push(edge.to);
      }
    }
    frontier = next;
  }
  for (const convention of [`${name}Test`, `${name}_Test`, `${name}Tests`, `Test${name}`, `Test_${name}`]) {
    if (graph.units.get(key(convention))?.isTest) tests.add(key(convention));
  }
  return [...tests].map((k) => graph.units.get(k)?.name ?? k);
}

/** Tests to run for changed components: what reaches each of them, and what each one declares. */
export function selectTests(graph: ApexGraph, names: string[], maxDepth = Infinity): TestSelection {
  const components: TestsForComponent[] = [];
  const all = new Set<string>();
  for (const name of [...new Set(names)]) {
    const unit = graph.units.get(key(name));
    const declared = unit?.declaredTests ?? [];
    const tests = [...new Set([...testsReaching(graph, name, maxDepth), ...declared])].sort();
    tests.forEach((t) => all.add(t));
    components.push({ name: unit?.name ?? name, kind: unit?.kind ?? 'unknown', tests, declared });
  }
  return {
    tests: [...all].sort((a, b) => a.localeCompare(b)),
    components,
    uncovered: components.filter((c) => !c.tests.length).map((c) => c.name),
  };
}

// ---------- reading sources ----------

/** Classes and triggers of the org (Tooling API records with Name and Body; managed ones have no body). */
export function sourcesFromRecords(
  classes: Array<{ Name: string; Body?: string }>,
  triggers: Array<{ Name: string; Body?: string }>
): ApexSource[] {
  const usable = (r: { Body?: string }): boolean => Boolean(r.Body) && r.Body !== '(hidden)';
  return [
    ...classes.filter(usable).map((r) => ({ name: r.Name, kind: 'class' as const, body: r.Body ?? '' })),
    ...triggers.filter(usable).map((r) => ({ name: r.Name, kind: 'trigger' as const, body: r.Body ?? '' })),
  ];
}
