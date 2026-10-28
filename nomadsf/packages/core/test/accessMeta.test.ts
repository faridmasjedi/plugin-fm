import { describe, expect, it } from 'vitest';
import { metadataToXml, withRecordTypes } from '../src/index.js';

describe('metadata from the Tooling API', () => {
  it('writes the XML the Metadata API deploys: elements in name order, lists repeated, nulls left out', () => {
    const xml = metadataToXml('Profile', {
      userPermissions: [{ name: 'ApiEnabled', enabled: true }],
      custom: true,
      description: 'Sales & service <EU>',
      urls: null,
      loginHours: null,
      classAccesses: [
        { apexClass: 'A', enabled: true },
        { apexClass: 'B', enabled: false },
      ],
      fieldPermissions: [],
    });
    expect(xml).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <classAccesses>
        <apexClass>A</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <classAccesses>
        <apexClass>B</apexClass>
        <enabled>false</enabled>
    </classAccesses>
    <custom>true</custom>
    <description>Sales &amp; service &lt;EU&gt;</description>
    <userPermissions>
        <enabled>true</enabled>
        <name>ApiEnabled</name>
    </userPermissions>
</Profile>
`);
  });
});

describe('record types of a permission set', () => {
  const file = `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Sales</label>
    <recordTypeVisibilities>
        <recordType>Account.Partner</recordType>
        <visible>true</visible>
    </recordTypeVisibilities>
    <recordTypeVisibilities>
        <recordType>Case.Support</recordType>
        <visible>true</visible>
    </recordTypeVisibilities>
</PermissionSet>
`;
  it('changes only the record types asked for, keeping the rest of the file', () => {
    const out = withRecordTypes(file, [
      { recordType: 'Account.Partner', visible: false },
      { recordType: 'Lead.Web', visible: true },
    ]);
    expect(out).toContain('<label>Sales</label>');
    expect(out).not.toContain('Account.Partner');
    expect(out).toContain('<recordType>Case.Support</recordType>');
    expect(out).toContain('<recordType>Lead.Web</recordType>');
    expect(out.indexOf('Lead.Web')).toBeLessThan(out.indexOf('</PermissionSet>'));
  });
});
