import type { SalesforceClient } from './client.js';
import { deployFiles } from './accessMeta.js';
import { retrieveZip } from './metadata.js';
import { query } from './query.js';
import { SHARING_MODEL, parseSharingRules } from './sharingTree.js';
import { fromBase64, readZip } from './zip.js';

/**
 * Sharing settings of a whole org: every object's org-wide defaults (internal, external) and its sharing rules
 * (one retrieve for all); two orgs compared object by object and rule by rule; and A's defaults or rules deployed
 * to B.
 */

export type OrgObjectSharing = {
  object: string;
  label: string;
  /** API values (Private, Read, ReadWrite…); shown with sharingModelLabel. */
  internal: string;
  external: string;
  rules: number;
  /** The object's SharingRules file, when it has rules. */
  xml?: string;
};

export const sharingModelLabel = (api: string): string => SHARING_MODEL[api] ?? api;

/** Every object with a sharing model, its defaults and how many sharing rules it has. */
export async function orgSharing(client: SalesforceClient): Promise<OrgObjectSharing[]> {
  const [defaults, retrieved] = await Promise.all([
    query(
      client,
      'SELECT QualifiedApiName, Label, InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE IsCustomizable = true AND IsCustomSetting = false AND InternalSharingModel != null',
      { maxRows: 5000 }
    ),
    retrieveZip(client, [{ type: 'SharingRules', fullName: '*' }]),
  ]);
  const files = retrieved.zipFile ? await readZip(fromBase64(retrieved.zipFile)) : new Map<string, Uint8Array>();
  const xmlOf = new Map<string, string>();
  for (const [path, bytes] of files)
    if (path.endsWith('.sharingRules'))
      xmlOf.set((path.split('/').pop() ?? '').replace(/\.sharingRules$/, ''), new TextDecoder().decode(bytes));
  return defaults.rows
    .map((d) => {
      const object = String(d.QualifiedApiName);
      const xml = xmlOf.get(object);
      const rules = xml ? (xml.match(/<sharing(Criteria|Owner|Guest|Territory)Rules>/g) ?? []).length : 0;
      return {
        object,
        label: String(d.Label ?? object),
        internal: String(d.InternalSharingModel ?? ''),
        external: String(d.ExternalSharingModel ?? ''),
        rules,
        ...(xml && rules ? { xml } : {}),
      };
    })
    .sort((a, b) => a.object.localeCompare(b.object));
}

export type RuleDiff = {
  name: string;
  label: string;
  status: 'only in A' | 'only in B' | 'different' | 'same';
  /** "Criteria · Status equals Escalated → group Support (Read/Write)". */
  a: string;
  b: string;
};

export type SharingDiff = {
  object: string;
  label: string;
  inA: boolean;
  inB: boolean;
  a?: OrgObjectSharing;
  b?: OrgObjectSharing;
  defaultsDiffer: boolean;
  rules: RuleDiff[];
  rulesDiffer: boolean;
};

/** A rule in one line: its kind, which records, with whom and how. */
export function ruleText(r: ReturnType<typeof parseSharingRules>[number]): string {
  return `${r.kind} · ${r.which} → ${r.to.kind.replace(/([A-Z])/g, ' $1').toLowerCase()} ${r.to.name} (${r.access})`
    .replace(/\s+/g, ' ')
    .trim();
}

/** Two orgs' sharing, object by object: defaults and every rule (by API name). */
export function compareSharing(a: OrgObjectSharing[], b: OrgObjectSharing[]): SharingDiff[] {
  const objects = [...new Set([...a.map((x) => x.object), ...b.map((x) => x.object)])].sort();
  return objects.map((object) => {
    const x = a.find((o) => o.object === object);
    const y = b.find((o) => o.object === object);
    const rulesA = new Map(parseSharingRules(x?.xml ?? '').map((r) => [r.name, r]));
    const rulesB = new Map(parseSharingRules(y?.xml ?? '').map((r) => [r.name, r]));
    const rules: RuleDiff[] = [...new Set([...rulesA.keys(), ...rulesB.keys()])].sort().map((name) => {
      const ra = rulesA.get(name);
      const rb = rulesB.get(name);
      const ta = ra ? ruleText(ra) : '';
      const tb = rb ? ruleText(rb) : '';
      return {
        name,
        label: ra?.label ?? rb?.label ?? name,
        status: !rb ? 'only in A' : !ra ? 'only in B' : ta === tb ? 'same' : 'different',
        a: ta,
        b: tb,
      };
    });
    const defaultsDiffer = Boolean(x && y && (x.internal !== y.internal || x.external !== y.external));
    return {
      object,
      label: x?.label ?? y?.label ?? object,
      inA: Boolean(x),
      inB: Boolean(y),
      ...(x ? { a: x } : {}),
      ...(y ? { b: y } : {}),
      defaultsDiffer,
      rules,
      rulesDiffer: rules.some((r) => r.status !== 'same'),
    };
  });
}

export type SharingDeployResult = { done: string[]; failed: Array<{ item: string; error: string }> };

/**
 * Makes B like A: for each object, A's org-wide defaults (B's object file with only its sharing models changed)
 * and/or A's sharing rules file. Rules that are only in B are not in A's file: Salesforce keeps them.
 */
export async function deploySharing(
  clientB: SalesforceClient,
  items: Array<{ diff: SharingDiff; defaults: boolean; rules: boolean }>
): Promise<SharingDeployResult> {
  const out: SharingDeployResult = { done: [], failed: [] };
  const defaults = items.filter((i) => i.defaults && i.diff.a && i.diff.inB);
  if (defaults.length) {
    try {
      const retrieved = await retrieveZip(
        clientB,
        defaults.map((i) => ({ type: 'CustomObject', fullName: i.diff.object }))
      );
      const files = retrieved.zipFile ? await readZip(fromBase64(retrieved.zipFile)) : new Map<string, Uint8Array>();
      const set = (xml: string, tag: string, value: string): string =>
        !value
          ? xml
          : xml.includes(`<${tag}>`)
          ? xml.replace(new RegExp(`<${tag}>[^<]*</${tag}>`), `<${tag}>${value}</${tag}>`)
          : xml.replace('</CustomObject>', `    <${tag}>${value}</${tag}>\n</CustomObject>`);
      const patched: Array<{ fullName: string; xml: string }> = [];
      for (const i of defaults) {
        const file = files.get(`objects/${i.diff.object}.object`);
        if (!file) {
          out.failed.push({ item: `defaults of ${i.diff.object}`, error: 'the object could not be read in B' });
          continue;
        }
        let xml = new TextDecoder().decode(file);
        xml = set(xml, 'sharingModel', i.diff.a!.internal);
        xml = set(xml, 'externalSharingModel', i.diff.a!.external);
        patched.push({ fullName: i.diff.object, xml });
      }
      if (patched.length) {
        const r = await deployFiles(clientB, 'CustomObject', patched);
        if (r.success) out.done.push(...patched.map((p) => `defaults of ${p.fullName}`));
        else out.failed.push({ item: 'defaults', error: r.problems.join('; ') || 'The deploy failed.' });
      }
    } catch (e) {
      out.failed.push({ item: 'defaults', error: (e as Error).message });
    }
  }
  const rules = items.filter((i) => i.rules && i.diff.a?.xml);
  if (rules.length) {
    try {
      const r = await deployFiles(
        clientB,
        'SharingRules',
        rules.map((i) => ({ fullName: i.diff.object, xml: i.diff.a!.xml! }))
      );
      if (r.success) out.done.push(...rules.map((i) => `sharing rules of ${i.diff.object}`));
      else out.failed.push({ item: 'sharing rules', error: r.problems.join('; ') || 'The deploy failed.' });
    } catch (e) {
      out.failed.push({ item: 'sharing rules', error: (e as Error).message });
    }
  }
  return out;
}
