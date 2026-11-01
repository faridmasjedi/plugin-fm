import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  buildDiffPackage,
  compareContent,
  compareOrgs,
  fromBase64,
  readZip,
  sameContent,
  type HttpRequest,
} from '../src/index.js';

/** A deflated zip made by the system zip tool, base64. */
function zipOf(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'nsf-orgdiff-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(dir, 'src', path, '..'), { recursive: true });
      writeFileSync(join(dir, 'src', path), content);
    }
    execFileSync('zip', ['-q', '-r', '-9', join(dir, 'out.zip'), '.'], { cwd: join(dir, 'src') });
    return readFileSync(join(dir, 'out.zip')).toString('base64');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A fake org: lists components and answers retrieves with the given files. Like Salesforce, a retrieve lists a
 * bundle file by file ("card/card.js"), while listMetadata names the bundle.
 */
function org(
  components: Array<{ type: string; fullName: string; fileName: string; ns?: string }>,
  files: Record<string, string>
) {
  const zip = zipOf(files);
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const body = r.body ?? '';
    const xml = (s: string) => ({ status: 200, headers: {}, body: s });
    if (body.includes('<met:listMetadata>')) {
      const type = /<met:type>(\w+)<\/met:type>/.exec(body)?.[1];
      return xml(
        components
          .filter((c) => c.type === type)
          .map(
            (c) =>
              `<result><fullName>${c.fullName}</fullName><type>${c.type}</type><fileName>${c.fileName}</fileName>${
                c.ns ? `<namespacePrefix>${c.ns}</namespacePrefix><manageableState>installed</manageableState>` : ''
              }</result>`
          )
          .join('')
      );
    }
    if (body.includes('<met:retrieve>')) return xml('<result><id>09S1</id></result>');
    if (body.includes('checkRetrieveStatus')) {
      const props = components
        .flatMap((c) =>
          c.type.endsWith('Bundle')
            ? Object.keys(files)
                .filter((f) => f.startsWith(`unpackaged/${c.fileName}/`) && !f.endsWith('-meta.xml'))
                .map((f) => ({
                  ...c,
                  fullName: f.slice(`unpackaged/${c.fileName}/`.length).replace(/^/, `${c.fullName}/`),
                  fileName: f.slice('unpackaged/'.length),
                }))
            : [c]
        )
        .map(
          (c) =>
            `<fileProperties><fullName>${c.fullName}</fullName><type>${c.type}</type><fileName>unpackaged/${c.fileName}</fileName></fileProperties>`
        )
        .join('');
      return xml(`<result><done>true</done><status>Succeeded</status><zipFile>${zip}</zipFile>${props}</result>`);
    }
    return xml('<result/>');
  }, '62.0');
  return client;
}

describe('org diff', () => {
  const sourceComponents = [
    { type: 'ApexClass', fullName: 'A', fileName: 'classes/A.cls' },
    { type: 'ApexClass', fullName: 'B', fileName: 'classes/B.cls' },
    { type: 'ApexClass', fullName: 'New', fileName: 'classes/New.cls' },
    { type: 'ApexClass', fullName: 'Pkg', fileName: 'classes/pkg__Pkg.cls', ns: 'pkg' },
    { type: 'LightningComponentBundle', fullName: 'card', fileName: 'lwc/card' },
    { type: 'AuraDefinitionBundle', fullName: 'welcome', fileName: 'aura/welcome' },
  ];
  const targetComponents = [
    { type: 'ApexClass', fullName: 'A', fileName: 'classes/A.cls' },
    { type: 'ApexClass', fullName: 'B', fileName: 'classes/B.cls' },
    { type: 'ApexClass', fullName: 'Old', fileName: 'classes/Old.cls' },
    { type: 'LightningComponentBundle', fullName: 'card', fileName: 'lwc/card' },
  ];
  const source = org(sourceComponents, {
    'unpackaged/package.xml': '<Package/>',
    'unpackaged/classes/A.cls': 'class A {}\n',
    'unpackaged/classes/A.cls-meta.xml': '<ApexClass>\n  <status>Active</status>\n</ApexClass>',
    'unpackaged/classes/B.cls': 'class B { /* v2 */ }',
    'unpackaged/classes/New.cls': 'class New {}',
    'unpackaged/lwc/card/card.js': 'export default 1;',
    'unpackaged/lwc/card/card.js-meta.xml': '<LightningComponentBundle/>',
    'unpackaged/aura/welcome/welcome.cmp': '<aura:component/>',
    'unpackaged/aura/welcome/welcomeController.js': '({})',
    'unpackaged/aura/welcome/welcome.cmp-meta.xml': '<AuraDefinitionBundle/>',
  });
  const target = org(targetComponents, {
    'unpackaged/package.xml': '<Package/>',
    'unpackaged/classes/A.cls': 'class A {}\r\n',
    'unpackaged/classes/A.cls-meta.xml': '<ApexClass><status>Active</status></ApexClass>',
    'unpackaged/classes/B.cls': 'class B {}',
    'unpackaged/lwc/card/card.js': 'export default 2;',
  });

  it('reads deflated zips', async () => {
    const files = await readZip(fromBase64(zipOf({ 'a/b.txt': 'hello hello hello hello', 'c.txt': 'x' })));
    expect(new TextDecoder().decode(files.get('a/b.txt'))).toBe('hello hello hello hello');
    expect([...files.keys()].sort()).toEqual(['a/b.txt', 'c.txt']);
    expect(sameContent(new TextEncoder().encode('<a>\n <b/>\n</a>'), new TextEncoder().encode('<a><b/></a>'))).toBe(
      true
    );
  });

  it('lists what is where, without installed packages', async () => {
    const { rows, skipped } = await compareOrgs(source, target, ['ApexClass', 'LightningComponentBundle']);
    expect(rows.map((r) => `${r.name}:${r.status}`)).toEqual([
      'A:in both',
      'B:in both',
      'New:only in source',
      'Old:only in target',
      'card:in both',
    ]);
    expect(skipped).toBe(1);
  });

  it('compares content (ignoring line endings / XML whitespace), including bundles', async () => {
    const { rows } = await compareOrgs(source, target, ['ApexClass', 'LightningComponentBundle']);
    const content = await compareContent(source, target, rows);
    expect(Object.fromEntries(content)).toEqual({
      'ApexClass:A': 'same',
      'ApexClass:B': 'different',
      'LightningComponentBundle:card': 'different',
    });
  });

  it('builds a deployable zip with package.xml and deletions', async () => {
    const pkg = await buildDiffPackage(
      source,
      [{ type: 'ApexClass', name: 'New' }],
      [{ type: 'ApexClass', name: 'Old' }]
    );
    const files = await readZip(fromBase64(pkg.zipBase64));
    expect([...files.keys()].sort()).toEqual(['classes/New.cls', 'destructiveChangesPost.xml', 'package.xml']);
    expect(pkg.packageXml).toMatch(/<members>New<\/members>\s*<name>ApexClass<\/name>/);
    expect(new TextDecoder().decode(files.get('destructiveChangesPost.xml'))).toMatch(
      /<members>Old<\/members>\s*<name>ApexClass<\/name>/
    );
    expect(pkg.components).toBe(2);
    await expect(buildDiffPackage(source, [])).rejects.toThrow('Choose');
  });

  it('packs a bundle with all its files (a retrieve lists them one by one)', async () => {
    const pkg = await buildDiffPackage(source, [
      { type: 'AuraDefinitionBundle', name: 'welcome' },
      { type: 'LightningComponentBundle', name: 'card' },
    ]);
    expect([...(await readZip(fromBase64(pkg.zipBase64))).keys()].sort()).toEqual([
      'aura/welcome/welcome.cmp',
      'aura/welcome/welcome.cmp-meta.xml',
      'aura/welcome/welcomeController.js',
      'lwc/card/card.js',
      'lwc/card/card.js-meta.xml',
      'package.xml',
    ]);
  });
});
