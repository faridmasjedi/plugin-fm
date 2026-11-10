import type { SalesforceClient } from './client.js';
import { dmlObjects, stripCommentsAndStrings, type ApexSource } from './apexGraph.js';
import { apexSourcesFromOrg } from './dependentTests.js';
import { saveOrder, type SaveStep } from './operations.js';

/**
 * What a step of a save runs, one level at a time: a trigger → the methods it calls → what those call and the records
 * they write (→ the triggers and flows of that object); a flow → its Apex actions, subflows and the records it writes.
 * Read from the code and the flow definitions (calls through interfaces or dynamic Apex cannot be told).
 */
export type AutoNode = {
  /** The same thing has the same id wherever it shows (to mark repeats). */
  id: string;
  kind: 'trigger' | 'method' | 'class' | 'flow' | 'writes' | 'action' | 'missing';
  label: string;
  /** Its name as the org has it: Class.method, the object, the flow's API name. */
  ref?: string;
  detail?: string;
  /** Has something under it to open. */
  opens: boolean;
  /** Not active: it does not run. */
  off?: boolean;
};

type Method = { name: string; body: string; invocable: boolean };
type Unit = {
  name: string;
  kind: 'class' | 'trigger';
  code: string;
  /** lower-case method name → its overloads */
  methods: Map<string, Method[]>;
  /** lower-case variable / field name → lower-case class name */
  vars: Map<string, string>;
};

const NOT_METHODS = new Set([
  'if',
  'for',
  'while',
  'catch',
  'switch',
  'return',
  'new',
  'else',
  'when',
  'do',
  'try',
  'finally',
  'throw',
  'system',
  'super',
  'this',
]);

/** The block from the "{" at `open` to its "}". */
function block(code: string, open: number): string {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++;
    else if (code[i] === '}' && --depth === 0) return code.slice(open, i + 1);
  }
  return code.slice(open);
}

/** The methods of a class (and its inner classes), each with its signature and body. */
export function apexMethods(code: string): Map<string, Method[]> {
  const out = new Map<string, Method[]>();
  const re =
    /((?:@\w+(?:\s*\([^)]*\))?\s*)*)(?:\b(?:public|private|protected|global|static|override|virtual|abstract|webservice|testmethod|final|with sharing|without sharing)\s+)*([\w.<>,[\]\s]+?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w.,\s]+)?\{/g;
  for (const m of code.matchAll(re)) {
    const type = m[2].trim().split(/\s+/).pop()!.toLowerCase();
    const name = m[3];
    if (NOT_METHODS.has(name.toLowerCase()) || ['new', 'return', 'else', 'class', 'interface'].includes(type)) continue;
    const start = (m.index ?? 0) + m[0].length - 1;
    const body = `${m[0].slice(m[1].length)}${block(code, start).slice(1)}`;
    const k = name.toLowerCase();
    out.set(k, [...(out.get(k) ?? []), { name, body, invocable: /@InvocableMethod/i.test(m[1]) }]);
  }
  return out;
}

/** Variables and fields declared with a known class as their type: name → class. */
function classVars(code: string, classes: Map<string, Unit>): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of code.matchAll(/\b([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*(?:=|;|,|\))/g)) {
    const type = m[1].toLowerCase();
    if (classes.has(type) && classes.get(type)!.kind === 'class') out.set(m[2].toLowerCase(), type);
  }
  return out;
}

const methodId = (cls: string, method: string): string => `method:${cls.toLowerCase()}.${method.toLowerCase()}`;

export class AutomationTree {
  private apex?: Promise<Map<string, Unit>>;
  private readonly saves = new Map<string, Promise<SaveStep[]>>();
  private readonly flows = new Map<string, Promise<Record<string, unknown> | undefined>>();

  public constructor(private readonly client: SalesforceClient, private readonly sources?: ApexSource[]) {}

  /** The tree's first node for a step of the save (a trigger or a flow), when it runs anything we can open. */
  public static rootOf(step: SaveStep): AutoNode | undefined {
    if (!step.ref) return undefined;
    if (step.kind.startsWith('Apex trigger'))
      return { id: `trigger:${step.ref.toLowerCase()}`, kind: 'trigger', label: step.ref, opens: true };
    if (step.kind.startsWith('Flow'))
      return {
        id: `flow:${step.ref.toLowerCase()}`,
        kind: 'flow',
        label: step.name,
        ref: step.ref,
        detail: step.ref,
        opens: true,
      };
    return undefined;
  }

  /** What runs under a node. */
  public async children(node: AutoNode): Promise<AutoNode[]> {
    const [kind, ...rest] = node.id.split(':');
    // The org's own spelling for queries; the lower-case id for the Apex read here
    const ref = rest.join(':');
    const name = node.ref ?? ref;
    if (kind === 'trigger') {
      const unit = (await this.units()).get(ref);
      return unit ? this.fromCode(unit.code, unit) : [missing(node.label, 'trigger')];
    }
    if (kind === 'method') {
      const [cls, method] = ref.split('.');
      const unit = (await this.units()).get(cls);
      const bodies = unit?.methods.get(method) ?? [];
      if (!unit || !bodies.length) return [missing(node.label, 'method')];
      return this.fromCode(bodies.map((b) => b.body).join('\n'), unit);
    }
    if (kind === 'class') {
      const unit = (await this.units()).get(ref);
      if (!unit) return [missing(node.label, 'class')];
      return [...unit.methods.values()].map(([m]) => ({
        id: methodId(unit.name, m.name),
        kind: 'method',
        label: `${unit.name}.${m.name}()`,
        opens: true,
      }));
    }
    if (kind === 'writes') return this.objectAutomation(name);
    if (kind === 'flow') return this.fromFlow(name);
    return [];
  }

  private units(): Promise<Map<string, Unit>> {
    this.apex ??= (async () => {
      const sources = this.sources ?? (await apexSourcesFromOrg(this.client));
      const units = new Map<string, Unit>();
      for (const s of sources) {
        const code = stripCommentsAndStrings(s.body);
        units.set(s.name.toLowerCase(), {
          name: s.name,
          kind: s.kind,
          code,
          methods: s.kind === 'class' ? apexMethods(code) : new Map(),
          vars: new Map(),
        });
      }
      for (const u of units.values()) u.vars = classVars(u.code, units);
      return units;
    })();
    return this.apex;
  }

  /** The methods a piece of Apex calls, the classes it creates, and the objects it writes. */
  private async fromCode(code: string, own: Unit): Promise<AutoNode[]> {
    const units = await this.units();
    const out = new Map<string, AutoNode>();
    const method = (cls: Unit, name: string): void => {
      const found = cls.methods.get(name.toLowerCase())?.[0];
      if (!found) return;
      const id = methodId(cls.name, found.name);
      if (!out.has(id)) out.set(id, { id, kind: 'method', label: `${cls.name}.${found.name}()`, opens: true });
    };
    // The body without its own signature: a method does not call itself by being declared
    const body = code.replace(/^[^{]*\{/, '{');
    const vars = new Map([...own.vars, ...classVars(code, units)]);
    for (const m of body.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)\s*\(/g)) {
      const left = m[1].toLowerCase();
      const cls = left === 'this' ? own : units.get(left) ?? units.get(vars.get(left) ?? '');
      if (cls?.kind === 'class') method(cls, m[2]);
    }
    for (const m of body.matchAll(/\bnew\s+([A-Za-z_]\w*)\s*\(/g)) {
      const cls = units.get(m[1].toLowerCase());
      if (cls?.kind !== 'class' || cls === own) continue;
      const id = `class:${cls.name.toLowerCase()}`;
      if (cls.methods.has(cls.name.toLowerCase())) method(cls, cls.name);
      else if (!out.has(id)) out.set(id, { id, kind: 'class', label: `new ${cls.name}()`, opens: true });
    }
    // Calls of the class's own methods, without a "ClassName." in front
    if (own.kind === 'class')
      for (const m of body.matchAll(/(?<![\w.])([A-Za-z_]\w*)\s*\(/g))
        if (!NOT_METHODS.has(m[1].toLowerCase()) && own.methods.has(m[1].toLowerCase())) method(own, m[1]);
    for (const object of dmlObjects(code)) {
      const id = `writes:${object.toLowerCase()}`;
      out.set(id, {
        id,
        kind: 'writes',
        label: `writes ${object}`,
        ref: object,
        detail: 'its triggers and flows run',
        opens: true,
      });
    }
    return [...out.values()];
  }

  /** The triggers and record-triggered flows of an object the code or a flow writes. */
  private async objectAutomation(objectKey: string): Promise<AutoNode[]> {
    if (!/^\w+$/.test(objectKey)) return [];
    if (!this.saves.has(objectKey))
      this.saves.set(
        objectKey,
        saveOrder(this.client, objectKey).then((r) => r.steps)
      );
    const steps = await this.saves.get(objectKey)!;
    // A trigger with before and after events is one node with both
    const out = new Map<string, AutoNode>();
    for (const s of steps) {
      const root = AutomationTree.rootOf(s);
      if (!root) continue;
      const known = out.get(root.id);
      const detail = [known?.detail, `${s.when} · ${s.events}`].filter(Boolean).join(' | ');
      out.set(root.id, { ...root, detail, off: !s.active });
    }
    return out.size
      ? [...out.values()]
      : [{ id: `none:${objectKey}`, kind: 'missing', label: 'no triggers or flows', opens: false }];
  }

  private flowMetadata(apiName: string): Promise<Record<string, unknown> | undefined> {
    if (!this.flows.has(apiName))
      this.flows.set(
        apiName,
        (async () => {
          if (!/^\w+$/.test(apiName)) return undefined;
          // Raw: the definition is one nested object (the query helper flattens nested objects into columns)
          const read = async (where: string) => {
            const soql = `SELECT Id, Metadata FROM Flow WHERE Definition.DeveloperName = '${apiName}'${where} ORDER BY VersionNumber DESC LIMIT 1`;
            const page = await this.client.tooling<{ records: Array<{ Metadata?: Record<string, unknown> }> }>(
              'GET',
              `/query?q=${encodeURIComponent(soql)}`
            );
            return page.records[0];
          };
          // The active version, or the latest when none is active
          const row = (await read(" AND Status = 'Active'")) ?? (await read(''));
          return row?.Metadata;
        })()
      );
    return this.flows.get(apiName)!;
  }

  /** A flow's Apex actions, subflows, other actions, and the records it creates, updates or deletes. */
  private async fromFlow(apiName: string): Promise<AutoNode[]> {
    const meta = await this.flowMetadata(apiName);
    if (!meta) return [missing(apiName, 'flow')];
    const list = (key: string): Array<Record<string, unknown>> => {
      const v = meta[key];
      return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : v ? [v as Record<string, unknown>] : [];
    };
    const start = (meta.start ?? {}) as Record<string, unknown>;
    const out = new Map<string, AutoNode>();
    const units = await this.units();
    for (const a of list('actionCalls')) {
      const name = String(a.actionName ?? '');
      if (a.actionType === 'apex') {
        const cls = units.get(name.toLowerCase());
        const invocable = cls && [...cls.methods.values()].flat().find((m) => m.invocable);
        const id = invocable ? methodId(cls.name, invocable.name) : `class:${name.toLowerCase()}`;
        out.set(id, {
          id,
          kind: invocable ? 'method' : 'class',
          label: invocable ? `${cls.name}.${invocable.name}()` : name,
          detail: `Apex action · ${String(a.label ?? '')}`,
          opens: Boolean(cls),
        });
      } else {
        out.set(`action:${name}:${String(a.label)}`, {
          id: `action:${name.toLowerCase()}`,
          kind: 'action',
          label: name,
          detail: `${String(a.actionType ?? 'action')} · ${String(a.label ?? '')}`,
          opens: false,
        });
      }
    }
    for (const s of list('subflows')) {
      const name = String(s.flowName ?? '');
      out.set(`flow:${name.toLowerCase()}`, {
        id: `flow:${name.toLowerCase()}`,
        kind: 'flow',
        label: name,
        ref: name,
        detail: `subflow · ${String(s.label ?? '')}`,
        opens: true,
      });
    }
    const writes = (key: string, verb: string): void => {
      for (const r of list(key)) {
        // Updating the record that started the flow: its own object
        const object = String(r.object ?? (/\$Record/.test(String(r.inputReference ?? '')) ? start.object ?? '' : ''));
        if (!object) continue;
        const id = `writes:${object.toLowerCase()}`;
        const known = out.get(id);
        out.set(id, {
          id,
          kind: 'writes',
          label: `writes ${object}`,
          ref: object,
          detail: [known?.detail, `${verb}: ${String(r.label ?? r.name ?? '')}`].filter(Boolean).join(' · '),
          opens: true,
        });
      }
    };
    writes('recordCreates', 'creates');
    writes('recordUpdates', 'updates');
    writes('recordDeletes', 'deletes');
    return out.size
      ? [...out.values()]
      : [{ id: `none:${apiName}`, kind: 'missing', label: 'runs no Apex, subflows or record changes', opens: false }];
  }
}

const missing = (name: string, what: string): AutoNode => ({
  id: `missing:${what}:${name.toLowerCase()}`,
  kind: 'missing',
  label: `${name}: the ${what} could not be read (managed package, or no access)`,
  opens: false,
});
