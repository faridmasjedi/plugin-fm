import { describe, expect, it } from 'vitest';
import { innerXml, labelsFile, readZip, toMetadataFormat } from '../src/index.js';

const d = 'force-app/main/default';
const source: Record<string, string> = {
  'sfdx-project.json': '{}',
  [`${d}/classes/Hello.cls`]: 'public class Hello {}',
  [`${d}/classes/Hello.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/permissionsets/Admin.permissionset-meta.xml`]: '<PermissionSet><label>Admin</label></PermissionSet>',
  [`${d}/objects/Account/Account.object-meta.xml`]:
    '<?xml version="1.0"?>\n<CustomObject xmlns="x"><label>Account</label></CustomObject>',
  [`${d}/objects/Account/fields/Score__c.field-meta.xml`]:
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>Score__c</fullName>\n    <type>Number</type>\n</CustomField>\n',
  [`${d}/objects/Account/recordTypes/Big.recordType-meta.xml`]: '<RecordType><fullName>Big</fullName></RecordType>',
  [`${d}/objects/Legacy__c/Legacy__c.object-meta.xml`]: '<CustomObject><label>Legacy</label></CustomObject>',
  [`${d}/objects/Legacy__c/fields/Code__c.field-meta.xml`]: '<CustomField><fullName>Code__c</fullName></CustomField>',
  [`${d}/labels/CustomLabels.labels-meta.xml`]:
    '<?xml version="1.0" encoding="UTF-8"?>\n<CustomLabels xmlns="http://soap.sforce.com/2006/04/metadata">\n    <labels>\n        <fullName>A</fullName>\n        <value>a</value>\n    </labels>\n    <labels>\n        <fullName>B</fullName>\n        <value>b</value>\n    </labels>\n</CustomLabels>\n',
  [`${d}/lwc/board/board.js`]: 'export default class {}',
  [`${d}/lwc/board/board.js-meta.xml`]: '<LightningComponentBundle/>',
  [`${d}/lwc/board/utils/helper.js`]: 'export const x = 1;',
  [`${d}/lwc/board/__tests__/board.test.js`]: 'test()',
  [`${d}/lwc/jsconfig.json`]: '{}',
  [`${d}/staticresources/assets.resource-meta.xml`]: '<StaticResource/>',
  [`${d}/staticresources/assets/a.css`]: 'a{}',
  [`${d}/staticresources/assets/img/b.css`]: 'b{}',
  [`${d}/staticresources/logo.png`]: 'PNG',
  [`${d}/staticresources/logo.resource-meta.xml`]: '<StaticResource/>',
  [`${d}/reports/Sales.reportFolder-meta.xml`]: '<ReportFolder/>',
  [`${d}/reports/Sales/Pipeline.report-meta.xml`]: '<Report/>',
  [`${d}/customMetadata/Cfg.Default.md-meta.xml`]: '<CustomMetadata/>',
  [`${d}/experiences/Site1.site-meta.xml`]: '<ExperienceBundle/>',
  [`${d}/experiences/Site1/views/home.json`]: '{}',
};
const read = async (path: string): Promise<Uint8Array> => new TextEncoder().encode(source[path]);
const convert = (
  deploy: Array<{ type: string; name: string }>,
  extra: Partial<Parameters<typeof toMetadataFormat>[0]> = {}
) =>
  toMetadataFormat({
    deploy,
    files: Object.keys(source),
    read,
    packageDirs: ['force-app'],
    apiVersion: '62.0',
    ...extra,
  });
const unzip = async (zip: Uint8Array): Promise<Record<string, string>> =>
  Object.fromEntries([...(await readZip(zip))].map(([p, b]) => [p, new TextDecoder().decode(b)]));

describe('source → Metadata API format', () => {
  it('keeps code as it is and turns a -meta.xml-only component into its file', async () => {
    const { zip, deployed, notConverted } = await convert([
      { type: 'ApexClass', name: 'Hello' },
      { type: 'PermissionSet', name: 'Admin' },
      { type: 'CustomMetadata', name: 'Cfg.Default' },
    ]);
    const files = await unzip(zip);
    expect(Object.keys(files).sort()).toEqual([
      'classes/Hello.cls',
      'classes/Hello.cls-meta.xml',
      'customMetadata/Cfg.Default.md',
      'package.xml',
      'permissionsets/Admin.permissionset',
    ]);
    expect(files['package.xml']).toContain('<members>Hello</members>');
    expect(files['package.xml']).toContain('<version>62.0</version>');
    expect(deployed).toHaveLength(3);
    expect(notConverted).toEqual([]);
  });

  it("puts an object's fields back into the object's file, with or without the object itself", async () => {
    const fieldOnly = await unzip((await convert([{ type: 'CustomField', name: 'Account.Score__c' }])).zip);
    expect(fieldOnly['objects/Account.object']).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fields>\n        <fullName>Score__c</fullName>\n    <type>Number</type>\n    </fields>\n</CustomObject>\n'
    );
    const whole = await unzip(
      (
        await convert([
          { type: 'CustomObject', name: 'Legacy__c' },
          { type: 'CustomField', name: 'Legacy__c.Code__c' },
          { type: 'RecordType', name: 'Account.Big' },
        ])
      ).zip
    );
    expect(whole['objects/Legacy__c.object']).toContain('<label>Legacy</label>');
    expect(whole['objects/Legacy__c.object']).toContain(
      '<fields>\n        <fullName>Code__c</fullName>\n    </fields>'
    );
    expect(whole['objects/Account.object']).toContain('<recordTypes>');
    expect(whole['objects/Account.object']).not.toContain('<label>Account</label>');
  });

  it('sends only the labels of the package', async () => {
    const files = await unzip((await convert([{ type: 'CustomLabel', name: 'B' }])).zip);
    expect(files['labels/CustomLabels.labels']).toContain('<fullName>B</fullName>');
    expect(files['labels/CustomLabels.labels']).not.toContain('<fullName>A</fullName>');
    expect(labelsFile(source[`${d}/labels/CustomLabels.labels-meta.xml`], new Set(['A']))).not.toContain('>B<');
  });

  it('keeps bundles whole, zips a static resource folder, and renames a single-file one', async () => {
    const { zip } = await convert([
      { type: 'LightningComponentBundle', name: 'board' },
      { type: 'StaticResource', name: 'assets' },
      { type: 'StaticResource', name: 'logo' },
    ]);
    const files = await unzip(zip);
    expect(files['lwc/board/utils/helper.js']).toBe('export const x = 1;');
    expect(Object.keys(files).filter((f) => f.includes('__tests__') || f.includes('jsconfig'))).toEqual([]);
    expect(files['lwc/board/board.js-meta.xml']).toBe('<LightningComponentBundle/>');
    expect(files['staticresources/logo.resource']).toBe('PNG');
    expect(files['staticresources/assets.resource-meta.xml']).toBe('<StaticResource/>');
    // The folder is zipped inside the package, its files relative to the folder
    const folder = (await readZip(zip)).get('staticresources/assets.resource')!;
    expect([...(await readZip(folder)).keys()].sort()).toEqual(['a.css', 'img/b.css']);
  });

  it('names report folders as the API does, and says what it cannot convert yet', async () => {
    const result = await convert([
      { type: 'Report', name: 'Sales' },
      { type: 'Report', name: 'Sales/Pipeline' },
      { type: 'ExperienceBundle', name: 'Site1' },
      { type: 'ApexClass', name: 'Missing' },
    ]);
    const files = await unzip(result.zip);
    expect(files['reports/Sales-meta.xml']).toBe('<ReportFolder/>');
    expect(files['reports/Sales/Pipeline.report']).toBe('<Report/>');
    expect(result.notConverted.map((c) => `${c.name}: ${c.reason}`)).toEqual([
      'Site1: ExperienceBundle is not converted yet',
      'Missing: no source file for it',
    ]);
    expect(files['package.xml']).not.toContain('Site1');
  });

  it('adds the deletions after the deploy, or before it', async () => {
    const post = await unzip(
      (
        await convert([{ type: 'ApexClass', name: 'Hello' }], { remove: [{ type: 'ApexClass', name: 'Old' }] })
      ).zip
    );
    expect(post['destructiveChangesPost.xml']).toContain('<members>Old</members>');
    const pre = await unzip(
      (
        await convert([], { remove: [{ type: 'ApexClass', name: 'Old' }], removeWhen: 'pre' })
      ).zip
    );
    expect(pre['destructiveChangesPre.xml']).toContain('<members>Old</members>');
    expect(pre['package.xml']).not.toContain('<types>');
  });

  it('reads the inside of a root element', () => {
    expect(innerXml('<?xml version="1.0"?>\n<A x="1">\n  <b>1</b>\n</A>\n')).toBe('<b>1</b>');
  });
});
