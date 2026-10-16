import { describe, expect, it } from 'vitest';
import { analyzeProject, parsePackageXml, type ProjectFs } from '../src/index.js';

/** In-memory project: keys are file paths, values file contents. */
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
      return [...names].map(([name, kind]) => ({ name, kind }));
    },
    async readText(path) {
      return files[path];
    },
  };
}

const manifest = `<?xml version="1.0"?><Package xmlns="http://soap.sforce.com/2006/04/metadata">
<types><members>A</members><members>B &amp; C</members><name>ApexClass</name></types>
<types><members>*</members><name>LightningComponentBundle</name></types><version>62.0</version></Package>`;

describe('project analysis', () => {
  it('summarizes package directories, types, components and manifests', async () => {
    const info = await analyzeProject(
      memoryFs({
        'sfdx-project.json': JSON.stringify({
          packageDirectories: [
            { path: 'force-app', default: true },
            { path: 'shared', package: 'Shared', versionNumber: '1.2.0.NEXT' },
          ],
          packageAliases: { Shared: '0Ho000' },
          sourceApiVersion: '62.0',
        }),
        '.git/HEAD': 'ref: refs/heads/feature/x\n',
        'force-app/main/default/classes/A.cls': 'x',
        'force-app/main/default/classes/A.cls-meta.xml': 'x',
        'force-app/main/default/classes/B.cls-meta.xml': 'x',
        'force-app/main/default/lwc/card/card.js': 'x',
        'force-app/main/default/lwc/card/card.js-meta.xml': 'x',
        'force-app/main/default/objects/Account/fields/X__c.field-meta.xml': 'x',
        'force-app/main/default/reports/Sales/Pipeline.report-meta.xml': 'x',
        'shared/classes/Util.cls-meta.xml': 'x',
        'manifest/package.xml': manifest,
        'notes/readme.xml': '<notes/>',
      })
    );
    expect(info).toMatchObject({
      name: 'demo',
      sourceApiVersion: '62.0',
      branch: 'feature/x',
      packageAliases: { Shared: '0Ho000' },
    });
    const main = info.packageDirectories[0];
    expect(main).toMatchObject({ path: 'force-app', default: true, total: 5 });
    expect(Object.fromEntries(main.types.map((t) => [t.type, t.names]))).toEqual({
      ApexClass: ['A', 'B'],
      LightningComponentBundle: ['card'],
      CustomObject: ['Account'],
      Report: ['Sales/Pipeline'],
    });
    expect(info.packageDirectories[1]).toMatchObject({ path: 'shared', package: 'Shared', total: 1 });
    expect(info.manifests).toEqual([{ path: 'manifest/package.xml', types: 2, members: 3 }]);
  });

  it('explains when the folder is not a Salesforce project', async () => {
    await expect(analyzeProject(memoryFs({ 'README.md': '' }))).rejects.toThrow('no sfdx-project.json');
  });

  it('parses package.xml members', () => {
    expect(parsePackageXml(manifest)).toEqual([
      { type: 'ApexClass', members: ['A', 'B & C'] },
      { type: 'LightningComponentBundle', members: ['*'] },
    ]);
  });
});
