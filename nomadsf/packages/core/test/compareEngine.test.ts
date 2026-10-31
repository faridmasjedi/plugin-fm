import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CompareEngine,
  manifestXml,
  readZip,
  resolveComponent,
  type ComparedPackage,
  type FolderHandle,
} from '../src/index.js';

// Compare & package on a real git repository, read the way the browser and VS Code read a folder
const expectDeep = (a: unknown, b: unknown): void => expect(a).toEqual(b);
const expectEq = (a: unknown, b: unknown): void => expect(a).toBe(b);
const expectOk = (a: unknown): void => expect(a).toBeTruthy();
const expectMatch = (a: string, re: RegExp): void => expect(a).toMatch(re);
const expectNoMatch = (a: string, re: RegExp): void => expect(a).not.toMatch(re);
const expectRejects = (p: Promise<unknown>, re: RegExp): Promise<void> => expect(p).rejects.toThrow(re);

/** A folder handle over Node's file system; writes replace the whole file, as VS Code's do. */
function nodeHandle(path: string, name = path.split('/').pop() ?? path): FolderHandle {
  const notFound = (): Error => new Error('not found');
  return {
    name,
    async getDirectoryHandle(child, options) {
      const full = join(path, child);
      if (!existsSync(full)) {
        if (!options?.create) throw notFound();
        mkdirSync(full);
      }
      if (!statSync(full).isDirectory()) throw notFound();
      return nodeHandle(full, child);
    },
    async getFileHandle(child, options) {
      const full = join(path, child);
      if (!existsSync(full)) {
        if (!options?.create) throw notFound();
        writeFileSync(full, '');
      }
      if (!statSync(full).isFile()) throw notFound();
      return {
        async getFile() {
          const bytes = readFileSync(full);
          const stat = statSync(full);
          return {
            size: stat.size,
            lastModified: stat.mtimeMs,
            text: async () => bytes.toString('utf8'),
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer,
          };
        },
        async createWritable() {
          let content = '';
          return {
            write: async (data: string) => void (content += data),
            close: async () => writeFileSync(full, content),
          };
        },
      };
    },
    async *entries() {
      for (const entry of readdirSync(path)) yield [entry, null] as [string, unknown];
    },
    async requestPermission() {
      return 'granted';
    },
  };
}

describe('compare & package on a folder', () => {
  let dir: string;
  let repo: string;
  let engine: CompareEngine;
  const d = 'force-app/main/default';
  const sh = (...args: string[]): string => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  const write = (path: string, text: string): void => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const labels = (entries: Array<[string, string]>): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n${entries
      .map(([n, v]) => `    <labels>\n        <fullName>${n}</fullName>\n        <value>${v}</value>\n    </labels>\n`)
      .join('')}</CustomLabels>\n`;
  const lwc = (name: string, extra: Record<string, string> = {}): void => {
    write(`${d}/lwc/${name}/${name}.html`, '<template></template>');
    write(`${d}/lwc/${name}/${name}.js`, 'export default class {}');
    write(`${d}/lwc/${name}/${name}.js-meta.xml`, '<LightningComponentBundle/>');
    for (const [f, t] of Object.entries(extra)) write(`${d}/lwc/${name}/${f}`, t);
  };
  const field = (name: string, type: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>${name}</fullName>\n    <label>${name}</label>\n    <type>${type}</type>\n</CustomField>\n`;
  const classText = (name: string, body: string): string =>
    `public with sharing class ${name} {\n${Array.from({ length: 12 }, (_, i) => `    // line ${i}\n`).join(
      ''
    )}${body}\n}\n`;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'folder-engine-'));
    repo = join(dir, 'project');
    mkdirSync(repo);
    sh('init', '-q', '-b', 'main');
    sh('config', 'user.email', 't@example.com');
    sh('config', 'user.name', 'T');
    write(
      'sfdx-project.json',
      '{"packageDirectories":[{"path":"force-app","default":true}],"sourceApiVersion":"62.0"}'
    );
    write('README.md', 'hi');
    write(
      `${d}/labels/CustomLabels.labels-meta.xml`,
      labels([
        ['Kept', 'a'],
        ['Changed', 'b'],
        ['Removed', 'c'],
      ])
    );
    write(`${d}/classes/Hello.cls`, classText('Hello', ''));
    write(`${d}/classes/Hello.cls-meta.xml`, '<ApexClass/>');
    write(`${d}/classes/Old.cls`, classText('Old', '    void run() {}'));
    write(`${d}/classes/Old.cls-meta.xml`, '<ApexClass/>');
    write(`${d}/objects/Account/fields/Gone__c.field-meta.xml`, field('Gone__c', 'Checkbox'));
    write(`${d}/objects/Legacy__c/Legacy__c.object-meta.xml`, '<CustomObject/>');
    write(`${d}/objects/Legacy__c/fields/Code__c.field-meta.xml`, '<CustomField/>');
    lwc('cssGone', { 'cssGone.css': '.x{}' });
    lwc('nested', { 'utils/helper.js': 'export const x = 1;' });
    lwc('metaGone');
    lwc('allGone');
    write(`${d}/experiences/Site1.site-meta.xml`, '<ExperienceBundle/>');
    write(`${d}/experiences/Site1/views/home.json`, '{}');
    write(`${d}/experiences/Site1/views/about.json`, '{"about":1}');
    write(`${d}/staticresources/assets.resource-meta.xml`, '<StaticResource/>');
    write(`${d}/staticresources/assets/a.css`, 'a{}');
    write(`${d}/staticresources/assets/b.css`, 'b{}');
    sh('add', '.');
    sh('commit', '-qm', 'base');
    sh('checkout', '-qb', 'feature');
    write(
      `${d}/labels/CustomLabels.labels-meta.xml`,
      labels([
        ['Kept', 'a'],
        ['Changed', 'B!'],
        ['Added', 'd'],
      ])
    );
    write(`${d}/classes/Hello.cls`, classText('Hello', '    Integer x;'));
    // Old renamed to Newer, a line changed
    unlinkSync(join(repo, `${d}/classes/Old.cls`));
    unlinkSync(join(repo, `${d}/classes/Old.cls-meta.xml`));
    write(`${d}/classes/Newer.cls`, classText('Newer', '    void run() {}'));
    write(`${d}/classes/Newer.cls-meta.xml`, '<ApexClass/>');
    write(`${d}/objects/Account/fields/Score__c.field-meta.xml`, field('Score__c', 'Number'));
    unlinkSync(join(repo, `${d}/objects/Account/fields/Gone__c.field-meta.xml`));
    rmSync(join(repo, `${d}/objects/Legacy__c`), { recursive: true });
    unlinkSync(join(repo, `${d}/lwc/cssGone/cssGone.css`));
    unlinkSync(join(repo, `${d}/lwc/nested/utils/helper.js`));
    unlinkSync(join(repo, `${d}/lwc/metaGone/metaGone.js-meta.xml`));
    rmSync(join(repo, `${d}/lwc/allGone`), { recursive: true });
    unlinkSync(join(repo, `${d}/experiences/Site1/views/about.json`));
    unlinkSync(join(repo, `${d}/staticresources/assets/b.css`));
    write('README.md', 'changed, not metadata');
    sh('add', '-A');
    sh('commit', '-qm', 'feature');
    // main moves on after feature branched: a pull request leaves this out
    sh('checkout', '-q', 'main');
    write(`${d}/classes/OnMainOnly.cls`, classText('OnMainOnly', ''));
    write(`${d}/classes/OnMainOnly.cls-meta.xml`, '<ApexClass/>');
    sh('add', '.');
    sh('commit', '-qm', 'main moves on');
    engine = new CompareEngine(nodeHandle(repo));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const changeOf = (pkg: ComparedPackage): Record<string, string> =>
    Object.fromEntries(pkg.components.map((c) => [`${c.type}:${c.name}`, c.change]));

  it('reads branches, tags and the branch checked out from the folder', async () => {
    const refs = await engine.refs();
    expectDeep(refs.branches, ['feature', 'main']);
    expectDeep(refs.tags, []);
    expectEq(await engine.currentBranch(), 'main');
  });

  it('like a pull request: what feature brings into main, by the Salesforce rules', async () => {
    const pkg = await engine.compare({ source: 'feature', target: 'main' });
    expectDeep(changeOf(pkg), {
      'ApexClass:Hello': 'changed',
      'ApexClass:Newer': 'added',
      'ApexClass:Old': 'deleted',
      'CustomField:Account.Gone__c': 'deleted',
      'CustomField:Account.Score__c': 'added',
      'CustomLabel:Added': 'added',
      'CustomLabel:Changed': 'changed',
      'CustomLabel:Removed': 'deleted',
      // the object goes, and its field with it (not listed on its own)
      'CustomObject:Legacy__c': 'deleted',
      'ExperienceBundle:Site1': 'changed',
      'LightningComponentBundle:allGone': 'deleted',
      'LightningComponentBundle:cssGone': 'changed',
      'LightningComponentBundle:metaGone': 'deleted',
      'LightningComponentBundle:nested': 'changed',
      'StaticResource:assets': 'changed',
    });
    // OnMainOnly came to main after feature branched: not part of what feature brings
    expectEq(changeOf(pkg)['ApexClass:OnMainOnly'], undefined);
    expectDeep(pkg.renames, [
      {
        from: { type: 'ApexClass', name: 'Old', files: [`${d}/classes/Old.cls`, `${d}/classes/Old.cls-meta.xml`] },
        to: { type: 'ApexClass', name: 'Newer' },
      },
    ]);
    const metaGone = pkg.components.find((c) => c.name === 'metaGone')!;
    expectMatch(metaGone.note ?? '', /lwc\/metaGone\/metaGone\.html/);
    expectOk(pkg.files.some((f) => f.path === 'README.md' && f.group === 'notMetadata'));
  });

  it('a deleted file of a component that still exists deploys its whole new version', async () => {
    const pkg = await engine.compare({ source: 'feature', target: 'main' });
    const deployOf = (name: string): string[] => pkg.components.find((c) => c.name === name)!.deploy;
    expectDeep(deployOf('Site1'), [`${d}/experiences/Site1/views/home.json`, `${d}/experiences/Site1.site-meta.xml`]);
    expectDeep(deployOf('assets').sort(), [
      `${d}/staticresources/assets.resource-meta.xml`,
      `${d}/staticresources/assets/a.css`,
    ]);
    expectOk(deployOf('nested').includes(`${d}/lwc/nested/nested.js-meta.xml`));
  });

  it('everything that differs: main as it is now, so its own new class shows as deleted', async () => {
    const pkg = await engine.compare({ source: 'feature', target: 'main', how: 'direct' });
    expectEq(changeOf(pkg)['ApexClass:OnMainOnly'], 'deleted');
  });

  it('the zip: manifests with the API version, files from the source commit, left-out components gone', async () => {
    const pkg = await engine.compare({ source: 'feature', target: 'main' });
    const { bytes, name } = await engine.download(pkg.id, { files: true, exclude: ['ApexClass:Hello'] });
    expectEq(name, 'feature-package.zip');
    const text = Buffer.from(bytes).toString('latin1');
    expectMatch(text, /<version>62\.0<\/version>/);
    expectMatch(text, /manifest\/destructiveChanges\.xml/);
    expectMatch(text, /classes\/Newer\.cls/);
    expectNoMatch(text, /classes\/Hello\.cls/);
    expectNoMatch(text, /<members>Hello<\/members>/);
  });

  it('a file diff, and only files of the package', async () => {
    const pkg = await engine.compare({ source: 'feature', target: 'main' });
    const diff = await engine.diff(pkg.id, `${d}/classes/Hello.cls`);
    expectMatch(diff, /\+ {4}Integer x;/);
    await expectRejects(engine.diff(pkg.id, 'sfdx-project.json'), /not part of this comparison/);
  });

  it('every changed file in its list: deployed, deleted, ignored (changed or deleted), not metadata', async () => {
    write('.forceignore', `${d}/lwc/cssGone/**\n${d}/classes/Hello.cls\n`);
    const pkg = await engine.compare({ source: 'feature', target: 'main' });
    unlinkSync(join(repo, '.forceignore'));
    const group = (g: string): string[] =>
      pkg.files.filter((f) => f.group === g).map((f) => `${f.status} ${f.path.replace(`${d}/`, '')}`);
    expectDeep(group('ignoredDeploy'), ['M classes/Hello.cls']);
    expectDeep(group('ignoredDestructive'), ['D lwc/cssGone/cssGone.css']);
    expectDeep(group('notMetadata'), ['M README.md']);
    expectOk(group('deploy').includes('A classes/Newer.cls'));
    // a deleted file of a component that stays is deployed (the component whole), with a note
    const helper = pkg.files.find((f) => f.path.endsWith('nested/utils/helper.js'))!;
    expectDeep(
      [helper.group, helper.status, helper.note],
      ['deploy', 'D', 'deleted file: the component is deployed whole']
    );
    expectOk(group('destructive').includes('D classes/Old.cls'));
    // the labels file is in both lists: labels sent and labels removed
    const labels = pkg.files.filter((f) => f.path.endsWith('.labels-meta.xml'));
    expectDeep(
      labels.map((f) => [f.group, f.labels]),
      [
        ['deploy', { added: ['Added'], changed: ['Changed'] }],
        ['destructive', { removed: ['Removed'] }],
      ]
    );
    // the object's field deleted with it points to the object
    const legacyField = pkg.files.find((f) => f.path.endsWith('Legacy__c/fields/Code__c.field-meta.xml'))!;
    expectDeep(legacyField.components, ['CustomObject:Legacy__c']);
  });

  it('.forceignore: ignored files leave the package; a rename kept for good is added once', async () => {
    write('.forceignore', `${d}/lwc/cssGone/**\n`);
    const pkg = await engine.compare({ source: 'feature', target: 'main' });
    expectEq(changeOf(pkg)['LightningComponentBundle:cssGone'], undefined);
    const files = [`${d}/classes/Old.cls`, `${d}/classes/Old.cls-meta.xml`];
    expectDeep(await engine.ignoreRenamed(pkg.id, files), files);
    expectDeep(await engine.ignoreRenamed(pkg.id, files), []);
    expectEq(
      readFileSync(join(repo, '.forceignore'), 'utf8'),
      `${d}/lwc/cssGone/**\n# Renamed away; kept in the org (NomadSF)\n${files.join('\n')}\n`
    );
    await expectRejects(engine.ignoreRenamed(pkg.id, ['sfdx-project.json']), /Only old files/);
    unlinkSync(join(repo, '.forceignore'));
  });

  it('builds the Metadata API zip to validate or deploy, from the source commit', async () => {
    const pkg = await engine.compare({ source: 'feature', target: 'main' });
    const { zip, notConverted, deployed } = await engine.metadataZip(pkg.id, {
      exclude: ['ApexClass:Hello'],
      removeWhen: 'pre',
    });
    const files = await readZip(zip);
    const text = (p: string): string => new TextDecoder().decode(files.get(p));
    expect([...files.keys()]).toContain('classes/Newer.cls');
    expect([...files.keys()]).not.toContain('classes/Hello.cls');
    // the field of Account goes into Account's object file; the labels file has only the labels sent
    expect(text('objects/Account.object')).toContain('<fullName>Score__c</fullName>');
    expect(text('labels/CustomLabels.labels')).toContain('<fullName>Added</fullName>');
    expect(text('labels/CustomLabels.labels')).not.toContain('<fullName>Kept</fullName>');
    // the static resource folder is zipped; the deletions run before the deploy
    expect([...files.keys()]).toContain('staticresources/assets.resource');
    expect(text('destructiveChangesPre.xml')).toContain('<members>Old</members>');
    expect(text('package.xml')).toContain('<version>62.0</version>');
    expect(notConverted.map((c) => c.type)).toEqual(['ExperienceBundle']);
    expect(deployed.some((c) => c.name === 'Newer')).toBe(true);
  });

  it('finds the tests for the package from the source commit', async () => {
    const pkg = await engine.compare({ source: 'feature', target: 'main' });
    const found = await engine.findTests(pkg.id);
    // no test class in this repository: the Apex is named as not reached
    expect(found.tests).toEqual([]);
    expect(found.uncovered).toEqual(expect.arrayContaining(['Hello', 'Newer']));
  });

  it('says why it cannot compare', async () => {
    await expectRejects(engine.compare({ source: 'nope', target: 'main' }), /No branch, tag or commit called nope/);
    await expectRejects(engine.compare({ source: 'main', target: 'main' }), /main already has everything in main/);
  });

  it('resolves the names Salesforce uses, and builds a manifest', () => {
    const r = (p: string) => resolveComponent(`${d}/${p}`, ['force-app'])!;
    expectEq(r('reports/Sales/Pipeline.report-meta.xml').name, 'Sales/Pipeline');
    expectEq(r('customMetadata/Cfg.Default.md-meta.xml').name, 'Cfg.Default');
    expectEq(r('layouts/Account-Account Layout.layout-meta.xml').name, 'Account-Account Layout');
    expectEq(resolveComponent('scripts/x.apex', ['force-app']), undefined);
    expectEq(
      manifestXml(
        [
          { type: 'B', name: 'y' },
          { type: 'A', name: 'x&y' },
        ],
        '62.0'
      ),
      '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <types>\n        <members>x&amp;y</members>\n        <name>A</name>\n    </types>\n    <types>\n        <members>y</members>\n        <name>B</name>\n    </types>\n    <version>62.0</version>\n</Package>\n'
    );
  });
});
