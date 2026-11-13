import { describe, expect, it } from 'vitest';
import { customSettingXml, settingValue } from '../src/index.js';

describe('custom settings', () => {
  it('writes the object file of a new setting with its fields', () => {
    const xml = customSettingXml({
      name: 'Billing_Settings__c',
      label: 'Billing <Settings>',
      kind: 'Hierarchy',
      visibility: 'Public',
      fields: [
        { name: 'Endpoint__c', label: 'Endpoint', type: 'Url' },
        { name: 'Retries__c', label: 'Retries', type: 'Number' },
        { name: 'Enabled__c', label: 'Enabled', type: 'Checkbox' },
      ],
    });
    expect(xml).toContain('<customSettingsType>Hierarchy</customSettingsType>');
    expect(xml).toContain('<label>Billing &lt;Settings&gt;</label>');
    expect(xml).toContain('<fullName>Retries__c</fullName>');
    expect(xml).toContain('<precision>18</precision>');
    expect(xml).toContain('<defaultValue>false</defaultValue>');
    expect(xml).toContain('<visibility>Public</visibility>');
  });
  it('reads screen text as the field type wants', () => {
    expect(settingValue('boolean', 'Yes')).toBe(true);
    expect(settingValue('double', '3.5')).toBe(3.5);
    expect(settingValue('string', '  ')).toBeNull();
    expect(settingValue('url', 'https://x')).toBe('https://x');
  });
});
