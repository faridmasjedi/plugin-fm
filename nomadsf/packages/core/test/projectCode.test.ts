import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  analyzeProject,
  checkCodeContent,
  codeKindOf,
  fromBase64,
  pairCodeFiles,
  projectCodeIndex,
  projectCodePackage,
  readProjectCode,
  readZip,
  unifiedDiff,
  type HttpRequest,
  type ProjectFs,
} from '../src/index.js';

function memoryFs(files: Record<string, string>): ProjectFs {
  return {
    name: 'demo',
    async list(dir) {
      const prefix = dir ? `${dir}/` : '';
      const names = new Map<string, 'file' | 'dir'>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const [first, ...rest] = path.slice(prefix.length).split('/');
        names.set(first, rest.length ? 'dir' : 'file');
      }
      if (!names.size) throw new Error(`Folder not found: ${dir}`);
      return [...names].map(([name, kind]) => ({ name, kind }));
    },
    async readText(path) {
      return files[path];
    },
  };
}

const base = 'force-app/main/default';
const files = {
  'sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }),
  [`${base}/classes/A.cls`]: 'public class A {\r\n  void run() {}   \r\n}\r\n',
  [`${base}/classes/A.cls-meta.xml`]: '<ApexClass><apiVersion>61.0</apiVersion></ApexClass>',
  [`${base}/classes/B.cls`]: 'public class B { Integer x = 2; }',
  [`${base}/classes/B.cls-meta.xml`]: '<ApexClass/>',
  [`${base}/classes/OnlyHere.cls`]: 'public class OnlyHere {}',
  [`${base}/classes/OnlyHere.cls-meta.xml`]: '<ApexClass/>',
  [`${base}/lwc/card/card.js`]: "import { LightningElement } from 'lwc';",
  [`${base}/lwc/card/card.html`]: '<template></template>',
  [`${base}/lwc/card/card.js-meta.xml`]: '<LightningComponentBundle/>',
  [`${base}/lwc/card/__tests__/card.test.js`]: 'test()',
  [`${base}/aura/box/box.cmp`]: '<aura:component/>',
  [`${base}/aura/box/box.cmp-meta.xml`]: '<AuraDefinitionBundle/>',
};

/** Org with classes A (same as the project but for line endings) and B (different), and an LWC. */
const client = new SalesforceClient(async (r: HttpRequest) => {
  const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
  if (r.path.includes('/tooling/query')) {
    const soql = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    if (soql.includes('FROM ApexClass'))
      return json({
        done: true,
        totalSize: 2,
        records: [
          { attributes: { type: 'ApexClass' }, Name: 'A', Body: 'public class A {\n  void run() {}\n}' },
          { attributes: { type: 'ApexClass' }, Name: 'B', Body: 'public class B { Integer x = 1; }' },
        ],
      });
    if (soql.includes('FROM LightningComponentResource'))
      return json({
        done: true,
        totalSize: 2,
        records: [
          {
            attributes: { type: 'X' },
            Id: '0Rd1',
            FilePath: 'lwc/card/card.js',
            Format: 'js',
            Source: "import { LightningElement } from 'lwc';",
          },
          {
            attributes: { type: 'X' },
            Id: '0Rd2',
            FilePath: 'lwc/card/card.html',
            Format: 'html',
            Source: '<template></template>',
          },
          {
            attributes: { type: 'X' },
            Id: '0Rd3',
            FilePath: 'lwc/card/card.js-meta.xml',
            Format: 'xml',
            Source: '<LightningComponentBundle/>',
          },
        ],
      });
  }
  return { status: 404, headers: {}, body: '[]' };
}, '62.0');

describe('project code', () => {
  it('indexes and reads project code with the same paths as the org', async () => {
    const fs = memoryFs(files);
    const info = await analyzeProject(fs);
    const classes = projectCodeIndex(info, 'ApexClass');
    expect([...classes.keys()].sort()).toEqual(['A', 'B', 'OnlyHere']);
    expect(classes.get('A')).toEqual([`${base}/classes`]);

    const a = await readProjectCode(fs, 'ApexClass', 'A', classes.get('A')!);
    expect(a).toHaveLength(1);
    expect(a[0].path).toBe('A.cls');
    expect(a[0].language).toBe('apex');

    const card = await readProjectCode(fs, 'LWC', 'card', projectCodeIndex(info, 'LWC').get('card')!);
    // Jest tests are not part of the bundle in the org
    expect(card.map((f) => f.path)).toEqual(['lwc/card/card.html', 'lwc/card/card.js', 'lwc/card/card.js-meta.xml']);
    const box = await readProjectCode(fs, 'Aura', 'box', projectCodeIndex(info, 'Aura').get('box')!);
    expect(box.map((f) => f.path)).toEqual(['aura/box/box.cmp', 'aura/box/box.cmp-meta.xml']);
    expect(codeKindOf('LightningComponentBundle')).toBe('LWC');
    expect(codeKindOf('CustomObject')).toBeUndefined();
  });

  it('pairs files, ignoring line endings and trailing spaces', () => {
    const pairs = pairCodeFiles(
      [
        { id: '1', path: 'x.js', language: 'javascript', source: 'a\r\nb  ' },
        { id: '2', path: 'x.html', language: 'html', source: '<p/>' },
      ],
      [
        { id: 'p1', path: 'x.js', language: 'javascript', source: 'a\nb\n' },
        { id: 'p2', path: 'x.css', language: 'css', source: 'p{}' },
      ]
    );
    expect(pairs.map((p) => [p.path, p.status])).toEqual([
      ['x.css', 'only in project'],
      ['x.html', 'only in org'],
      ['x.js', 'same'],
    ]);
  });

  it('checks the content of every component in both', async () => {
    const fs = memoryFs(files);
    const info = await analyzeProject(fs);
    const items = [
      { id: '01p1', name: 'A', kind: 'ApexClass' as const },
      { id: '01p2', name: 'B', kind: 'ApexClass' as const },
      { id: '01p3', name: 'OrgOnly', kind: 'ApexClass' as const },
    ];
    const progress: number[] = [];
    const result = await checkCodeContent(client, fs, 'ApexClass', items, projectCodeIndex(info, 'ApexClass'), (d) =>
      progress.push(d)
    );
    expect(Object.fromEntries(result)).toEqual({ A: 'same', B: 'different' });
    expect(progress.at(-1)).toBe(2);

    const lwc = await checkCodeContent(
      client,
      fs,
      'LWC',
      [{ id: '0Rb000000000001', name: 'card', kind: 'LWC' }],
      projectCodeIndex(info, 'LWC')
    );
    expect(lwc.get('card')).toBe('same');
  });

  it('builds a deployable package of project code', async () => {
    const fs = memoryFs(files);
    const info = await analyzeProject(fs);
    const pkg = await projectCodePackage(
      fs,
      info,
      [
        { type: 'ApexClass', name: 'B' },
        { type: 'LightningComponentBundle', name: 'card' },
      ],
      '62.0'
    );
    expect(pkg.components).toBe(2);
    const zip = await readZip(fromBase64(pkg.zipBase64));
    expect([...zip.keys()].sort()).toEqual([
      'classes/B.cls',
      'classes/B.cls-meta.xml',
      'lwc/card/card.html',
      'lwc/card/card.js',
      'lwc/card/card.js-meta.xml',
      'package.xml',
    ]);
    expect(pkg.packageXml).toContain('<members>card</members>');
    await expect(projectCodePackage(fs, info, [{ type: 'CustomObject', name: 'X' }], '62.0')).rejects.toThrow(
      'not code'
    );
    await expect(projectCodePackage(fs, info, [{ type: 'ApexClass', name: 'Nope' }], '62.0')).rejects.toThrow(
      'not found'
    );
  });

  it('writes a unified diff', () => {
    const lines = 'abcdefghijklmno'.split('');
    const org = lines.join('\n');
    const project = [...lines.slice(0, 3), 'D', ...lines.slice(4), 'p'].join('\n');
    expect(unifiedDiff(org, project)).toBe(
      [
        '--- org',
        '+++ project',
        '@@ -1,7 +1,7 @@',
        ' a',
        ' b',
        ' c',
        '-d',
        '+D',
        ' e',
        ' f',
        ' g',
        '@@ -13,3 +13,4 @@',
        ' m',
        ' n',
        ' o',
        '+p',
      ].join('\n')
    );
    expect(unifiedDiff('same\r\n', 'same')).toBe('');
  });
});
