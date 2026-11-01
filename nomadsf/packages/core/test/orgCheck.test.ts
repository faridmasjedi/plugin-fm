import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  checkComponentsWithOrg,
  makeZip,
  toBase64,
  type HttpRequest,
  type ProjectFs,
  type ProjectInfo,
} from '../src/index.js';

// A project (or branch) against an org: one retrieve, then each component file by file
const d = 'force-app/main/default';
const files: Record<string, string> = {
  [`${d}/classes/Same.cls`]: 'public class Same {}',
  [`${d}/classes/Same.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/classes/Changed.cls`]: 'public class Changed { /* new */ }',
  [`${d}/classes/Changed.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/classes/NewOne.cls`]: 'public class NewOne {}',
  [`${d}/classes/NewOne.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/objects/Account/fields/Score__c.field-meta.xml`]:
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>Score__c</fullName>\n    <type>Number</type>\n</CustomField>\n',
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

/** The org's side: what a retrieve returns (the object file holds every field retrieved, indented its own way). */
const orgFiles: Record<string, string> = {
  'unpackaged/classes/Same.cls': 'public class Same {}',
  'unpackaged/classes/Same.cls-meta.xml': '<ApexClass/>',
  'unpackaged/classes/Changed.cls': 'public class Changed {}',
  'unpackaged/classes/Changed.cls-meta.xml': '<ApexClass/>',
  'unpackaged/classes/OrgOnly.cls': 'public class OrgOnly {}',
  'unpackaged/classes/OrgOnly.cls-meta.xml': '<ApexClass/>',
  'unpackaged/objects/Account.object':
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n  <fields>\n    <fullName>Other__c</fullName>\n  </fields>\n  <fields>\n    <fullName>Score__c</fullName>\n    <type>Number</type>\n  </fields>\n</CustomObject>\n',
};
const props = [
  ['ApexClass', 'Same', 'classes/Same.cls'],
  ['ApexClass', 'Changed', 'classes/Changed.cls'],
  ['ApexClass', 'OrgOnly', 'classes/OrgOnly.cls'],
  ['CustomField', 'Account.Score__c', 'objects/Account.object'],
];
const client = new SalesforceClient(async (r: HttpRequest) => {
  const body = r.body ?? '';
  const xml = (s: string) => ({ status: 200, headers: {}, body: s });
  if (body.includes('<met:retrieve>')) return xml('<result><id>09S1</id></result>');
  if (body.includes('checkRetrieveStatus'))
    return xml(
      `<result><done>true</done><status>Succeeded</status><zipFile>${toBase64(
        makeZip(Object.entries(orgFiles).map(([path, content]) => ({ path, content })))
      )}</zipFile>${props
        .map(
          ([type, name, file]) =>
            `<fileProperties><fullName>${name}</fullName><type>${type}</type><fileName>unpackaged/${file}</fileName></fileProperties>`
        )
        .join('')}</result>`
    );
  return xml('<result/>');
}, '62.0');

describe('a project against an org', () => {
  it('says same, different, only in org, not in org — and compares a field as its block', async () => {
    const checked = await checkComponentsWithOrg(client, { fs, info }, [
      { type: 'ApexClass', name: 'Same' },
      { type: 'ApexClass', name: 'Changed' },
      { type: 'ApexClass', name: 'OrgOnly' },
      { type: 'ApexClass', name: 'NewOne' },
      { type: 'ApexClass', name: 'Nowhere' },
      { type: 'CustomField', name: 'Account.Score__c' },
    ]);
    expect(Object.fromEntries([...checked].map(([k, v]) => [k, v.status]))).toEqual({
      'ApexClass:Same': 'same',
      'ApexClass:Changed': 'different',
      'ApexClass:OrgOnly': 'only in org',
      'ApexClass:NewOne': 'not in org',
      'ApexClass:Nowhere': 'in neither',
      'CustomField:Account.Score__c': 'same',
    });
    const changed = checked.get('ApexClass:Changed')!;
    expect(changed.org.map((f) => f.path)).toEqual(['classes/Changed.cls', 'classes/Changed.cls-meta.xml']);
    expect(changed.repo[0].source).toContain('/* new */');
    expect(checked.get('CustomField:Account.Score__c')!.org[0].source).toBe(
      '<fields>\n    <fullName>Score__c</fullName>\n    <type>Number</type>\n</fields>'
    );
  });
});
