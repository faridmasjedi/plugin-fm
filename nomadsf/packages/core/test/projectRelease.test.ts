import { describe, expect, it } from 'vitest';
import {
  projectComponentFiles,
  projectMetadataZip,
  projectTests,
  readZip,
  type ProjectFs,
  type ProjectInfo,
} from '../src/index.js';

const d = 'force-app/main/default';
const files: Record<string, string> = {
  '.forceignore': '**/Secret.cls*\n',
  [`${d}/classes/Hello.cls`]: 'public class Hello { }',
  [`${d}/classes/Hello.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/classes/HelloTest.cls`]: '@isTest class HelloTest { static void t() { new Hello(); } }',
  [`${d}/classes/HelloTest.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/classes/Secret.cls`]: 'public class Secret {}',
  [`${d}/classes/Secret.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/layouts/Account-Main.layout-meta.xml`]: '<Layout/>',
  [`${d}/objects/Account/fields/Score__c.field-meta.xml`]: '<CustomField><fullName>Score__c</fullName></CustomField>',
  [`${d}/objects/Case/validationRules/Need.validationRule-meta.xml`]:
    '<ValidationRule><fullName>Need</fullName></ValidationRule>',
};

const fs: ProjectFs = {
  name: 'demo',
  list: async (dir) => {
    const names = new Map<string, 'file' | 'dir'>();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${dir}/`)) continue;
      const [first, ...rest] = path.slice(dir.length + 1).split('/');
      names.set(first, rest.length ? 'dir' : 'file');
    }
    return [...names].map(([name, kind]) => ({ name, kind }));
  },
  readText: async (path) => files[path],
};
const info = { name: 'demo', packageDirectories: [{ path: 'force-app', types: [] }] } as unknown as ProjectInfo;

describe('a package from the project on disk', () => {
  it('converts every type, and leaves out what the .forceignore names', async () => {
    const result = await projectMetadataZip({
      fs,
      info,
      deploy: [
        { type: 'ApexClass', name: 'Hello' },
        { type: 'Layout', name: 'Account-Main' },
        { type: 'ApexClass', name: 'Secret' },
      ],
      remove: [{ type: 'ApexClass', name: 'Old' }],
      apiVersion: '62.0',
    });
    const zip = await readZip(result.zip);
    expect([...zip.keys()].sort()).toEqual([
      'classes/Hello.cls',
      'classes/Hello.cls-meta.xml',
      'destructiveChangesPost.xml',
      'layouts/Account-Main.layout',
      'package.xml',
    ]);
    expect(result.notConverted).toEqual([{ type: 'ApexClass', name: 'Secret', reason: 'in .forceignore' }]);
  });

  it("sends an object folder's fields and rules, as the CLI does for CustomObject:X", async () => {
    const result = await projectMetadataZip({
      fs,
      info,
      deploy: [{ type: 'CustomObject', name: 'Account' }],
      apiVersion: '62.0',
    });
    expect(result.deployed).toEqual([{ type: 'CustomField', name: 'Account.Score__c' }]);
    expect(result.notConverted).toEqual([]);
    const zip = await readZip(result.zip);
    expect(new TextDecoder().decode(zip.get('objects/Account.object'))).toContain('<fullName>Score__c</fullName>');
  });

  it("gives a component's files in the org's paths, to pair with what the org returns", async () => {
    const layout = await projectComponentFiles({ fs, info }, { type: 'Layout', name: 'Account-Main' }, '62.0');
    expect(layout.files.map((f) => [f.path, f.language, f.source])).toEqual([
      ['layouts/Account-Main.layout', 'xml', '<Layout/>'],
    ]);
    const cls = await projectComponentFiles({ fs, info }, { type: 'ApexClass', name: 'Hello' }, '62.0');
    expect(cls.files.map((f) => `${f.path}:${f.language}`)).toEqual([
      'classes/Hello.cls:apex',
      'classes/Hello.cls-meta.xml:xml',
    ]);
    expect((await projectComponentFiles({ fs, info }, { type: 'Flow', name: 'Nope' }, '62.0')).problem).toBe(
      'no source file for it'
    );
  });

  it('finds the tests that reach its classes', async () => {
    const found = await projectTests(fs, info, [{ type: 'ApexClass', name: 'Hello' }]);
    expect(found.tests).toEqual(['HelloTest']);
  });
});
