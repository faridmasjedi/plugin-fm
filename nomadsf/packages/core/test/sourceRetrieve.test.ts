import { describe, expect, it } from 'vitest';
import { makeZip, mergeLabels, toSourceFormat, type RetrievedProps } from '../src/index.js';

// What the org returns (Metadata API format) next to what a project already has (source format)
const d = 'force-app/main/default';
const project: Record<string, string> = {
  [`${d}/classes/A.cls`]: 'public class A {}\n',
  [`${d}/classes/A.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/objects/Account/fields/Other__c.field-meta.xml`]: '<CustomField/>',
  [`${d}/labels/CustomLabels.labels-meta.xml`]:
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n    <labels>\n        <fullName>Keep</fullName>\n        <value>kept</value>\n    </labels>\n    <labels>\n        <fullName>Hello</fullName>\n        <value>old</value>\n    </labels>\n</CustomLabels>\n',
};
const org: Record<string, string> = {
  'unpackaged/package.xml': '<Package/>',
  'unpackaged/classes/A.cls': 'public class A { /* org */ }',
  'unpackaged/classes/A.cls-meta.xml': '<ApexClass/>',
  'unpackaged/classes/B.cls': 'public class B {}',
  'unpackaged/classes/B.cls-meta.xml': '<ApexClass/>',
  'unpackaged/permissionsets/Sales.permissionset': '<PermissionSet><label>Sales</label></PermissionSet>',
  'unpackaged/objects/Account.object':
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fields>\n        <fullName>Tier__c</fullName>\n        <type>Text</type>\n    </fields>\n    <fields>\n        <fullName>Other__c</fullName>\n    </fields>\n</CustomObject>\n',
  'unpackaged/labels/CustomLabels.labels':
    '<CustomLabels>\n    <labels>\n        <fullName>Hello</fullName>\n        <value>new</value>\n    </labels>\n    <labels>\n        <fullName>Bye</fullName>\n        <value>bye</value>\n    </labels>\n</CustomLabels>',
  'unpackaged/lwc/card/card.js': 'export default 1;',
  'unpackaged/lwc/card/card.js-meta.xml': '<LightningComponentBundle/>',
  'unpackaged/staticresources/Style.resource': 'body{}',
  'unpackaged/staticresources/Style.resource-meta.xml':
    '<StaticResource><contentType>text/css</contentType></StaticResource>',
  'unpackaged/reports/Sales-meta.xml': '<ReportFolder/>',
  'unpackaged/reports/Sales/Pipeline.report': '<Report/>',
};
const props: RetrievedProps[] = [
  { type: 'ApexClass', fullName: 'A', fileName: 'unpackaged/classes/A.cls' },
  { type: 'ApexClass', fullName: 'B', fileName: 'unpackaged/classes/B.cls' },
  { type: 'PermissionSet', fullName: 'Sales', fileName: 'unpackaged/permissionsets/Sales.permissionset' },
  { type: 'CustomField', fullName: 'Account.Tier__c', fileName: 'unpackaged/objects/Account.object' },
  { type: 'CustomLabel', fullName: 'Hello', fileName: 'unpackaged/labels/CustomLabels.labels' },
  { type: 'CustomLabel', fullName: 'Bye', fileName: 'unpackaged/labels/CustomLabels.labels' },
  { type: 'LightningComponentBundle', fullName: 'card/card.js', fileName: 'unpackaged/lwc/card/card.js' },
  { type: 'StaticResource', fullName: 'Style', fileName: 'unpackaged/staticresources/Style.resource' },
  { type: 'ReportFolder', fullName: 'Sales', fileName: 'unpackaged/reports/Sales' },
  { type: 'Report', fullName: 'Sales/Pipeline', fileName: 'unpackaged/reports/Sales/Pipeline.report' },
  { type: 'Package', fullName: 'unpackaged/package.xml', fileName: 'unpackaged/package.xml' },
];

describe('a retrieve into a project', () => {
  it('puts each file where the project keeps it, in source format', async () => {
    const enc = new TextEncoder();
    const { writes, notConverted } = await toSourceFormat({
      zip: makeZip(Object.entries(org).map(([path, content]) => ({ path, content }))),
      props,
      projectFiles: Object.keys(project),
      read: async (p) => (project[p] === undefined ? undefined : enc.encode(project[p])),
      packageDirs: ['force-app'],
      defaultDir: 'force-app',
    });
    expect(notConverted).toEqual([]);
    const at = Object.fromEntries(writes.map((w) => [w.path, w.status]));
    expect(at).toEqual({
      [`${d}/classes/A.cls`]: 'changed',
      [`${d}/classes/A.cls-meta.xml`]: 'same',
      [`${d}/classes/B.cls`]: 'new',
      [`${d}/classes/B.cls-meta.xml`]: 'new',
      [`${d}/permissionsets/Sales.permissionset-meta.xml`]: 'new',
      // Only the retrieved field: the other field already in the project is left alone
      [`${d}/objects/Account/fields/Tier__c.field-meta.xml`]: 'new',
      [`${d}/labels/CustomLabels.labels-meta.xml`]: 'changed',
      [`${d}/lwc/card/card.js`]: 'new',
      [`${d}/lwc/card/card.js-meta.xml`]: 'new',
      [`${d}/staticresources/Style.resource-meta.xml`]: 'new',
      [`${d}/staticresources/Style.css`]: 'new',
      [`${d}/reports/Sales.reportFolder-meta.xml`]: 'new',
      [`${d}/reports/Sales/Pipeline.report-meta.xml`]: 'new',
    });
    const text = (p: string) => new TextDecoder().decode(writes.find((w) => w.path === p)!.content);
    expect(text(`${d}/objects/Account/fields/Tier__c.field-meta.xml`)).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>Tier__c</fullName>\n    <type>Text</type>\n</CustomField>\n'
    );
    const labels = text(`${d}/labels/CustomLabels.labels-meta.xml`);
    expect(labels).toContain('<fullName>Keep</fullName>');
    expect(labels).toContain('<value>new</value>');
    expect(labels).not.toContain('<value>old</value>');
    expect(labels).toContain('<fullName>Bye</fullName>');
    expect(writes.find((w) => w.path === `${d}/classes/A.cls`)!.before).toBe('public class A {}\n');
  });

  it('merges labels: replaced in place, new ones at the end', () => {
    const merged = mergeLabels(
      '<CustomLabels>\n    <labels><fullName>A</fullName><value>1</value></labels>\n</CustomLabels>\n',
      '<CustomLabels><labels><fullName>A</fullName><value>2</value></labels><labels><fullName>B</fullName><value>3</value></labels></CustomLabels>'
    );
    expect(merged).toBe(
      '<CustomLabels>\n    <labels><fullName>A</fullName><value>2</value></labels>\n    <labels><fullName>B</fullName><value>3</value></labels>\n</CustomLabels>\n'
    );
  });
});
