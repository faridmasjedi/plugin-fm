import type { SalesforceClient } from './client.js';
import { metadataFolder } from './accessMeta.js';
import { deployZip } from './deploy.js';
import { packageXml } from './metadata.js';
import { listMetadata, retrieveZip } from './metadata.js';
import { escapeXml } from './soap.js';
import { fromBase64, makeZip, readZip, toBase64 } from './zip.js';

/**
 * Connected apps and named credentials as configuration: their files from the org (Metadata API), flattened into
 * settings ("oauthConfig › callbackUrl": "https://…") to read, compare between two orgs, change and deploy back.
 * Secrets (client secrets, passwords, private keys) are never in these files: Salesforce does not give them out.
 */

export type ConfigType =
  | 'ConnectedApp'
  | 'NamedCredential'
  | 'ExternalCredential'
  | 'ExternalClientApplication'
  | 'ExtlClntAppOauthSettings'
  | 'ExtlClntAppGlobalOauthSettings'
  | 'ExtlClntAppOauthConfigurablePolicies'
  | 'ExtlClntAppConfigurablePolicies';
export const CONFIG_TYPES: ConfigType[] = [
  'ConnectedApp',
  'ExternalClientApplication',
  'ExtlClntAppOauthSettings',
  'ExtlClntAppGlobalOauthSettings',
  'ExtlClntAppOauthConfigurablePolicies',
  'ExtlClntAppConfigurablePolicies',
  'NamedCredential',
  'ExternalCredential',
];
export type ConfigFile = { type: ConfigType; fullName: string; label: string; xml: string };
export type ConfigSetting = { path: string; value: string };

const TYPE_LABEL: Record<ConfigType, string> = {
  ConnectedApp: 'Connected app',
  NamedCredential: 'Named credential',
  ExternalCredential: 'External credential',
  ExternalClientApplication: 'External client app',
  ExtlClntAppOauthSettings: 'OAuth settings',
  ExtlClntAppGlobalOauthSettings: 'Global OAuth settings',
  ExtlClntAppOauthConfigurablePolicies: 'OAuth policies',
  ExtlClntAppConfigurablePolicies: 'App policies',
};
export const configTypeLabel = (t: ConfigType): string => TYPE_LABEL[t];

/** Every configuration file of these types in the org, read in one retrieve. */
export async function configFiles(client: SalesforceClient, types: ConfigType[]): Promise<ConfigFile[]> {
  const names = (await Promise.all(types.map((t) => listMetadata(client, t).catch(() => [])))).flat();
  if (!names.length) return [];
  const result = await retrieveZip(
    client,
    names.map((n) => ({ type: n.type, fullName: n.fullName })),
    { pollMs: 1000 }
  );
  if (!result.zipFile) throw new Error(result.errorMessage ?? 'The files could not be retrieved.');
  const files = await readZip(fromBase64(result.zipFile));
  const out: ConfigFile[] = [];
  for (const n of names) {
    const entry = [...files.entries()].find(([path]) => {
      const base = path.split('/').pop() ?? '';
      return base.replace(/\.[^.]+$/, '') === n.fullName && !path.endsWith('package.xml');
    });
    if (!entry) continue;
    const xml = new TextDecoder().decode(entry[1]);
    out.push({
      type: n.type as ConfigType,
      fullName: n.fullName,
      label: /<label>([^<]*)<\/label>/.exec(xml)?.[1] ?? n.fullName,
      xml,
    });
  }
  return out.sort((a, b) => a.type.localeCompare(b.type) || a.label.localeCompare(b.label));
}

const unescape = (t: string): string =>
  t
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

type Node = { name: string; text?: string; children: Node[] };

/** A small XML reader for metadata files (elements and text; no attributes needed). */
function parse(xml: string): Node {
  const root: Node = { name: '', children: [] };
  const stack: Node[] = [root];
  const re = /<(\/?)([\w:]+)[^>]*?(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  const body = xml.replace(/<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  while ((m = re.exec(body))) {
    const [, close, name, self, text] = m;
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      if (text.trim()) top.text = (top.text ?? '') + unescape(text.trim());
    } else if (close) stack.pop();
    else {
      const node: Node = { name: name.replace(/^\w+:/, ''), children: [] };
      top.children.push(node);
      if (!self) stack.push(node);
    }
  }
  return root.children[0] ?? root;
}

const KEY_CHILDREN = ['parameterName', 'name', 'fullName', 'developerName', 'principalName', 'sequenceNumber'];

/**
 * The file as settings, by path: "oauthConfig › callbackUrl". Repeated values (scopes) are one setting, sorted;
 * repeated groups (parameters) are told apart by their name ("namedCredentialParameters[Url] › parameterValue").
 */
export function flattenConfig(xml: string): ConfigSetting[] {
  const out: ConfigSetting[] = [];
  const walk = (node: Node, path: string): void => {
    const groups = new Map<string, Node[]>();
    for (const c of node.children) groups.set(c.name, [...(groups.get(c.name) ?? []), c]);
    for (const [name, list] of groups) {
      const at = path ? `${path} › ${name}` : name;
      if (list.every((c) => !c.children.length)) {
        const values = list.map((c) => c.text ?? '');
        out.push({ path: at, value: list.length > 1 ? values.sort().join(', ') : values[0] });
      } else
        list.forEach((c, i) => {
          const key = KEY_CHILDREN.map((k) => c.children.find((x) => x.name === k)?.text).find(Boolean);
          walk(c, list.length > 1 || key ? `${at}[${key ?? i + 1}]` : at);
        });
    }
  };
  walk(parse(xml), '');
  return out.filter((s) => s.path !== 'fullName');
}

export type ConfigDiff = { path: string; a: string; b: string; same: boolean };
export type ConfigComparison = {
  type: ConfigType;
  name: string;
  label: string;
  status: 'same' | 'different' | 'only in A' | 'only in B';
  differences: number;
  a?: ConfigFile;
  b?: ConfigFile;
};

/** Every setting of a file in A and in B, side by side. */
export function diffConfig(a: string | undefined, b: string | undefined, ignore: RegExp = ORG_SPECIFIC): ConfigDiff[] {
  const fa = new Map((a ? flattenConfig(a) : []).map((s) => [s.path, s.value]));
  const fb = new Map((b ? flattenConfig(b) : []).map((s) => [s.path, s.value]));
  return [...new Set([...fa.keys(), ...fb.keys()])].sort().map((path) => {
    const va = fa.get(path) ?? '';
    const vb = fb.get(path) ?? '';
    return { path, a: va, b: vb, same: va === vb || ignore.test(path) };
  });
}

/** The connected apps and credentials of two orgs, by API name: where each is, and how many settings differ. */
export function compareConfigs(a: ConfigFile[], b: ConfigFile[]): ConfigComparison[] {
  const key = (f: ConfigFile) => `${f.type}:${f.fullName.toLowerCase()}`;
  const ia = new Map(a.map((f) => [key(f), f]));
  const ib = new Map(b.map((f) => [key(f), f]));
  return [...new Set([...ia.keys(), ...ib.keys()])]
    .map((k) => {
      const x = ia.get(k);
      const y = ib.get(k);
      const differences = x && y ? diffConfig(x.xml, y.xml).filter((d) => !d.same).length : 0;
      const f = (x ?? y)!;
      return {
        type: f.type,
        name: f.fullName,
        label: f.label,
        status: !y ? 'only in A' : !x ? 'only in B' : differences ? 'different' : 'same',
        differences,
        a: x,
        b: y,
      } as ConfigComparison;
    })
    .sort((p, q) => p.type.localeCompare(q.type) || p.label.localeCompare(q.label));
}

/**
 * Sets one value in a metadata file: an element at a simple path ("oauthConfig › callbackUrl", "label"), added inside
 * its parent when missing. A list (scopes) is given as several values.
 */
export function setConfigValue(xml: string, path: string, value: string | string[]): string {
  const parts = path.split(' › ');
  const leaf = parts.pop()!;
  const values = (Array.isArray(value) ? value : [value]).filter((v) => v !== '');
  // The block to change: the whole file, or the first element of each parent in turn
  let start = xml.indexOf('>', xml.indexOf('<', xml.indexOf('?>') + 2)) + 1;
  let end = xml.lastIndexOf('</');
  for (const raw of parts) {
    // "namedCredentialParameters[Url]": the one of the repeated groups that has a child with that value
    const [, p, key] = /^([\w]+)(?:\[(.+)\])?$/.exec(raw) ?? [, raw, undefined];
    if (key) {
      const re = new RegExp(`<${p}>([\\s\\S]*?)</${p}>`, 'g');
      const scope = xml.slice(start, end);
      let m: RegExpExecArray | null;
      let found = false;
      while ((m = re.exec(scope))) {
        if (new RegExp(`>${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`).test(m[1])) {
          start = start + m.index + p!.length + 2;
          end = start + m[1].length;
          found = true;
          break;
        }
      }
      if (!found) throw new Error(`No ${p} named ${key}.`);
      continue;
    }
    const open = new RegExp(`<${p}>`).exec(xml.slice(start, end));
    if (!open) {
      // A missing parent: added at the end of the current block
      const inner = values.map((v) => `<${leaf}>${escapeXml(v)}</${leaf}>`).join('');
      return `${xml.slice(0, end)}    <${p}>${inner}</${p}>\n${xml.slice(end)}`;
    }
    const from = start + open.index + open[0].length;
    const close = xml.indexOf(`</${p}>`, from);
    start = from;
    end = close;
  }
  const block = xml.slice(start, end);
  const re = new RegExp(`\\s*<${leaf}>[\\s\\S]*?</${leaf}>|\\s*<${leaf}/>`, 'g');
  const indent = /\n(\s*)</.exec(block)?.[1] ?? '        ';
  const added = values.map((v) => `\n${indent}<${leaf}>${escapeXml(v)}</${leaf}>`).join('');
  const first = block.search(re);
  const cleaned = block.replace(re, '');
  const at = first >= 0 ? Math.min(first, cleaned.length) : cleaned.replace(/\s*$/, '').length;
  const next = `${cleaned.slice(0, at)}${added}${cleaned.slice(at)}`;
  return `${xml.slice(0, start)}${next}${xml.slice(end)}`;
}

/** Deploys files back (or into another org) in one deploy: an app with all its parts, or one credential. */
export async function deployConfigs(
  client: SalesforceClient,
  files: Array<Pick<ConfigFile, 'type' | 'fullName' | 'xml'>>,
  options: { checkOnly?: boolean } = {}
): Promise<void> {
  if (!files.length) throw new Error('Nothing to deploy.');
  const version = await client.version();
  const zip = makeZip([
    { path: 'package.xml', content: packageXml(files, version) },
    ...files.map((f) => {
      const [folder, suffix] = metadataFolder(f.type) ?? [];
      if (!folder) throw new Error(`${f.type} cannot be deployed from here.`);
      return { path: `${folder}/${f.fullName}.${suffix}`, content: f.xml };
    }),
  ]);
  const outcome = await deployZip(client, toBase64(zip), { testLevel: 'Default', checkOnly: options.checkOnly });
  if (!outcome.success)
    throw new Error(
      [...outcome.componentFailures.map((f) => `${f.name}: ${f.problem}`), outcome.errorMessage ?? '']
        .filter(Boolean)
        .join('; ') || 'The deploy failed.'
    );
}

/** A file made ready for another org: its consumer key left out (the other org gives its own). */
export const forAnotherOrg = (xml: string): string =>
  xml.replace(/\s*<(consumerKey|oauthLink|orgScopedExternalApp)>[^<]*<\/\1>/g, '');

/** Settings that name this org (its Id, its key): never a difference between two orgs. */
export const ORG_SPECIFIC = /(consumerKey|oauthLink|orgScopedExternalApp)$/;

// ---------- items: an app with its parts, or a credential ----------

export type ConfigKind = 'Connected app' | 'External client app' | 'Named credential' | 'External credential';
export type ConfigItem = { kind: ConfigKind; name: string; label: string; files: ConfigFile[] };

const ECA_PARTS: ConfigType[] = [
  'ExtlClntAppOauthSettings',
  'ExtlClntAppGlobalOauthSettings',
  'ExtlClntAppOauthConfigurablePolicies',
  'ExtlClntAppConfigurablePolicies',
];

/** The files grouped as people think of them: an external client app with its settings and policies, as one. */
export function configItems(files: ConfigFile[]): ConfigItem[] {
  const items: ConfigItem[] = [];
  const apps = files.filter((f) => f.type === 'ExternalClientApplication');
  const ownerOf = (f: ConfigFile): string | undefined => {
    const named = /<externalClientApplication>([^<]+)<\/externalClientApplication>/.exec(f.xml)?.[1];
    if (named) return named;
    // Policies name their app by their own name: <app>_defaultPolicy, <app>_oauth_defaultPolicy
    return apps.map((a) => a.fullName).find((n) => f.fullName.startsWith(`${n}_`));
  };
  for (const app of apps)
    items.push({
      kind: 'External client app',
      name: app.fullName,
      label: app.label,
      files: [app, ...files.filter((f) => ECA_PARTS.includes(f.type) && ownerOf(f) === app.fullName)],
    });
  for (const f of files) {
    if (f.type === 'ConnectedApp') items.push({ kind: 'Connected app', name: f.fullName, label: f.label, files: [f] });
    if (f.type === 'NamedCredential')
      items.push({ kind: 'Named credential', name: f.fullName, label: f.label, files: [f] });
    if (f.type === 'ExternalCredential')
      items.push({ kind: 'External credential', name: f.fullName, label: f.label, files: [f] });
  }
  return items.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}

/** Every setting of an item; an app's parts each under their own heading ("OAuth policies › …"). */
export function itemSettings(item: ConfigItem): ConfigSetting[] {
  return item.files.flatMap((f) =>
    flattenConfig(f.xml).map((s) => ({
      path:
        item.files.length > 1 && f.type !== 'ExternalClientApplication' ? `${TYPE_LABEL[f.type]} › ${s.path}` : s.path,
      value: s.value,
    }))
  );
}

export type ItemComparison = {
  kind: ConfigKind;
  name: string;
  label: string;
  status: 'same' | 'different' | 'only in A' | 'only in B';
  differences: number;
  a?: ConfigItem;
  b?: ConfigItem;
};

/** Settings of an item in A and B, side by side (the consumer key, different in every org, is not a difference). */
export function diffItems(a?: ConfigItem, b?: ConfigItem): ConfigDiff[] {
  const fa = new Map((a ? itemSettings(a) : []).map((s) => [s.path, s.value]));
  const fb = new Map((b ? itemSettings(b) : []).map((s) => [s.path, s.value]));
  return [...new Set([...fa.keys(), ...fb.keys()])].sort().map((path) => {
    const va = fa.get(path) ?? '';
    const vb = fb.get(path) ?? '';
    return { path, a: va, b: vb, same: va === vb || ORG_SPECIFIC.test(path) };
  });
}

/** The apps and credentials of two orgs, by kind and API name. */
export function compareItems(a: ConfigItem[], b: ConfigItem[]): ItemComparison[] {
  const key = (i: ConfigItem) => `${i.kind}:${i.name.toLowerCase()}`;
  const ia = new Map(a.map((i) => [key(i), i]));
  const ib = new Map(b.map((i) => [key(i), i]));
  return [...new Set([...ia.keys(), ...ib.keys()])]
    .map((k) => {
      const x = ia.get(k);
      const y = ib.get(k);
      const differences = x && y ? diffItems(x, y).filter((d) => !d.same).length : 0;
      const f = (x ?? y)!;
      return {
        kind: f.kind,
        name: f.name,
        label: f.label,
        status: !y ? 'only in A' : !x ? 'only in B' : differences ? 'different' : 'same',
        differences,
        a: x,
        b: y,
      } as ItemComparison;
    })
    .sort((p, q) => p.kind.localeCompare(q.kind) || p.label.localeCompare(q.label));
}

/** The OAuth scopes a connected app can ask for (Metadata API names). */
export const OAUTH_SCOPES = [
  'Api',
  'Basic',
  'Chatter',
  'CustomApplications',
  'CustomPermissions',
  'Full',
  'OpenID',
  'RefreshToken',
  'Wave',
  'Web',
  'Pardot',
  'CDPIngest',
  'CDPProfile',
  'CDPQuery',
  'Eclair',
  'Lightning',
  'Content',
  'Address',
  'Email',
  'Phone',
  'Profile',
  'ForgotPassword',
  'Interaction',
  'UserinfoOnly',
  'Visualforce',
] as const;
