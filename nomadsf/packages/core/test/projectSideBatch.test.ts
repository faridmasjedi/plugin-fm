import { describe, expect, it } from 'vitest';
import {
  normalizeXml,
  projectComponentFiles,
  projectSideFiles,
  type ProjectFs,
  type ProjectInfo,
} from '../src/index.js';

// Thousands of components are converted in one go: each must get the same files as when converted on its own
const d = 'force-app/main/default';
const field = (name: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>${name}</fullName>\n    <type>Number</type>\n</CustomField>\n`;
const files: Record<string, string> = {
  [`${d}/classes/A.cls`]: 'public class A {}',
  [`${d}/classes/A.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/permissionsets/Sales.permissionset-meta.xml`]:
    '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><label>Sales</label></PermissionSet>\n',
  [`${d}/permissionsets/Support.permissionset-meta.xml`]:
    '<?xml version="1.0" encoding="UTF-8"?>\n<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><label>Support</label></PermissionSet>\n',
  [`${d}/lwc/badge/badge.js`]: 'export default class Badge {}\n',
  [`${d}/lwc/badge/badge.js-meta.xml`]: '<LightningComponentBundle/>',
  [`${d}/objects/Account/fields/Score__c.field-meta.xml`]: field('Score__c'),
  [`${d}/objects/Account/fields/Tier__c.field-meta.xml`]: field('Tier__c'),
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

describe('project side in one go', () => {
  it('gives each component the same files as converting it alone', async () => {
    const components = [
      { type: 'ApexClass', name: 'A' },
      { type: 'PermissionSet', name: 'Sales' },
      { type: 'PermissionSet', name: 'Support' },
      { type: 'LightningComponentBundle', name: 'badge' },
      { type: 'CustomField', name: 'Account.Score__c' },
      { type: 'CustomField', name: 'Account.Tier__c' },
      { type: 'PermissionSet', name: 'Missing' },
    ];
    const together = await projectSideFiles({ fs, info }, components, '62.0');
    for (const c of components) {
      const alone = (await projectComponentFiles({ fs, info }, c, '62.0')).files;
      const got = together.get(`${c.type}:${c.name}`) ?? [];
      const shape = (list: Array<{ path: string; source: string }>) =>
        list.map((f) => ({ path: f.path, source: f.path.endsWith('.object') ? '' : normalizeXml(f.source) }));
      expect(
        shape(got)
          .map((f) => f.path)
          .sort(),
        c.name
      ).toEqual(
        shape(alone)
          .map((f) => f.path)
          .sort()
      );
      if (!c.type.startsWith('CustomField')) expect(shape(got), c.name).toEqual(expect.arrayContaining(shape(alone)));
    }
    // A field is just its own block, not its neighbour's
    const score = together.get('CustomField:Account.Score__c')![0].source;
    expect(score).toContain('Score__c');
    expect(score).not.toContain('Tier__c');
    expect(together.get('PermissionSet:Missing')).toEqual([]);
  });
});
