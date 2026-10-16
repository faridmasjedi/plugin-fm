import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  describeMetadata,
  listMetadata,
  packageXml,
  retrieveZip,
  type HttpRequest,
} from '../src/index.js';

function fake(handler: (body: string) => string) {
  const calls: HttpRequest[] = [];
  const client = new SalesforceClient(async (r) => {
    calls.push(r);
    return { status: 200, headers: {}, body: handler(r.body ?? '') };
  }, '62.0');
  return { client, calls };
}

const props = (type: string, fullName: string) =>
  `<result><fileName>x</fileName><fullName>${fullName}</fullName><id>01p</id><lastModifiedByName>Ada</lastModifiedByName><lastModifiedDate>2026-01-01T00:00:00.000Z</lastModifiedDate><manageableState>unmanaged</manageableState><type>${type}</type></result>`;

describe('metadata', () => {
  it('describes types with folder flags and child types', async () => {
    const { client, calls } = fake(
      () =>
        '<describeMetadataResponse><result><metadataObjects><childXmlNames>CustomField</childXmlNames><childXmlNames>ValidationRule</childXmlNames><directoryName>objects</directoryName><inFolder>false</inFolder><xmlName>CustomObject</xmlName></metadataObjects><metadataObjects><directoryName>reports</directoryName><inFolder>true</inFolder><xmlName>Report</xmlName></metadataObjects></result></describeMetadataResponse>'
    );
    const types = await describeMetadata(client);
    expect(types).toEqual([
      {
        xmlName: 'CustomObject',
        directoryName: 'objects',
        inFolder: false,
        childXmlNames: ['CustomField', 'ValidationRule'],
      },
      { xmlName: 'Report', directoryName: 'reports', inFolder: true, childXmlNames: [] },
    ]);
    expect(calls[0].path).toBe('/services/Soap/m/62.0');
  });

  it('lists folder types folder by folder, three queries per call', async () => {
    const { client, calls } = fake((body) => {
      if (body.includes('<met:type>ReportFolder</met:type>'))
        return ['F1', 'F2', 'F3', 'F4'].map((f) => props('ReportFolder', f)).join('');
      const folders = [...body.matchAll(/<met:folder>(\w+)<\/met:folder>/g)].map((m) => m[1]);
      return folders.map((f) => props('Report', `${f}/Sales`)).join('');
    });
    const list = await listMetadata(client, 'Report', true);
    expect(list.filter((c) => c.type === 'Report').map((c) => c.fullName)).toEqual([
      'F1/Sales',
      'F2/Sales',
      'F3/Sales',
      'F4/Sales',
    ]);
    expect(list.filter((c) => c.type === 'ReportFolder')).toHaveLength(4);
    expect(calls).toHaveLength(3); // folders + 2 batches (3 + 1)
  });

  it('builds a sorted package.xml', () => {
    expect(
      packageXml(
        [
          { type: 'ApexClass', fullName: 'B' },
          { type: 'ApexClass', fullName: 'A' },
          { type: 'Flow', fullName: 'F&G' },
        ],
        '62.0'
      )
    ).toBe(
      `<?xml version="1.0" encoding="UTF-8"?>
<Package xmlns="http://soap.sforce.com/2006/04/metadata">
    <types>
        <members>A</members>
        <members>B</members>
        <name>ApexClass</name>
    </types>
    <types>
        <members>F&amp;G</members>
        <name>Flow</name>
    </types>
    <version>62.0</version>
</Package>
`
    );
  });

  it('retrieves a zip after polling the status', async () => {
    let checks = 0;
    const { client, calls } = fake((body) => {
      if (body.includes('<met:retrieve>'))
        return '<retrieveResponse><result><done>false</done><id>09S000000000001</id><state>Queued</state></result></retrieveResponse>';
      checks++;
      return checks < 2
        ? '<result><done>false</done><id>09S000000000001</id><status>InProgress</status></result>'
        : `<result><done>true</done><fileProperties><fileName>unpackaged/classes/A.cls</fileName><fullName>A</fullName><type>ApexClass</type></fileProperties><id>09S000000000001</id><status>Succeeded</status><zipFile>UEsDBA==</zipFile></result>`;
    });
    const r = await retrieveZip(client, [{ type: 'ApexClass', fullName: 'A' }], { pollMs: 1 });
    expect(r).toMatchObject({ id: '09S000000000001', status: 'Succeeded', zipFile: 'UEsDBA==' });
    expect(r.files[0]).toMatchObject({ fullName: 'A', type: 'ApexClass' });
    expect(calls[0].body).toContain(
      '<met:types><met:members>A</met:members><met:name>ApexClass</met:name></met:types>'
    );
    expect(calls[0].body).toContain('<met:singlePackage>true</met:singlePackage>');
  });
});
