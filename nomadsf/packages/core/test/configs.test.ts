import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  compareItems,
  configItems,
  diffItems,
  flattenConfig,
  forAnotherOrg,
  itemSettings,
  setConfigValue,
  type ConfigFile,
} from '../src/index.js';

const demo = (p: string) => readFileSync(new URL(`../../../tools/demo/configs/${p}`, import.meta.url), 'utf8');
const fixture = (p: string) => readFileSync(new URL(`./fixtures-configs/${p}`, import.meta.url), 'utf8');
const file = (type: ConfigFile['type'], fullName: string, xml: string): ConfigFile => ({
  type,
  fullName,
  label: /<label>([^<]*)/.exec(xml)?.[1] ?? fullName,
  xml,
});
const side = (v: 'uat' | 'new'): ConfigFile[] => [
  file('NamedCredential', 'Billing', demo(`${v}/namedCredentials/Billing.namedCredential`)),
  file('ExternalCredential', 'Billing_Auth', demo(`${v}/externalCredentials/Billing_Auth.externalCredential`)),
  file('ExternalClientApplication', 'NomadSF_Demo', demo(`eca-${v}/externalClientApps/NomadSF_Demo.eca`)),
  file(
    'ExtlClntAppOauthSettings',
    'NomadSF_Demo_oauth',
    demo(`eca-${v}/extlClntAppOauthSettings/NomadSF_Demo_oauth.ecaOauth`)
  ),
  file(
    'ExtlClntAppGlobalOauthSettings',
    'NomadSF_Demo_glbloauth',
    v === 'uat'
      ? fixture('NomadSF_Demo_glbloauth.ecaGlblOauth')
      : demo('eca-new/extlClntAppGlobalOauthSets/NomadSF_Demo_glbloauth.ecaGlblOauth')
  ),
  file(
    'ExtlClntAppOauthConfigurablePolicies',
    'NomadSF_Demo_oauth_defaultPolicy',
    fixture('NomadSF_Demo_oauth_defaultPolicy.ecaOauthPlcy')
  ),
  file('ExtlClntAppConfigurablePolicies', 'NomadSF_Demo_defaultPolicy', fixture('NomadSF_Demo_defaultPolicy.ecaPlcy')),
];

describe('connected apps and credentials as settings', () => {
  it('flattens a file into settings, repeated groups by name', () => {
    const s = new Map(
      flattenConfig(demo('uat/namedCredentials/Billing.namedCredential')).map((x) => [x.path, x.value])
    );
    expect(s.get('namedCredentialParameters[Url] › parameterValue')).toBe('https://billing-uat.example.com');
    expect(s.get('namedCredentialParameters[ExternalCredential] › externalCredential')).toBe('Billing_Auth');
    expect(s.get('generateAuthorizationHeader')).toBe('true');
  });
  it('groups an external client app with its settings and policies', () => {
    const items = configItems(side('uat'));
    expect(items.map((i) => `${i.kind}:${i.name}:${i.files.length}`)).toEqual([
      'External client app:NomadSF_Demo:5',
      'External credential:Billing_Auth:1',
      'Named credential:Billing:1',
    ]);
    const paths = itemSettings(items[0]).map((x) => x.path);
    expect(paths).toContain('OAuth policies › permittedUsersPolicyType');
    expect(paths).toContain('Global OAuth settings › isPkceRequired');
  });
  it('compares two orgs setting by setting, the consumer key never a difference', () => {
    const cmp = compareItems(configItems(side('uat')), configItems(side('new')));
    expect(cmp.map((c) => `${c.name}:${c.status}`)).toEqual([
      'NomadSF_Demo:different',
      'Billing_Auth:same',
      'Billing:different',
    ]);
    const app = diffItems(cmp[0].a, cmp[0].b)
      .filter((d) => !d.same)
      .map((d) => d.path);
    expect(app).toEqual(
      expect.arrayContaining(['OAuth settings › commaSeparatedOauthScopes', 'Global OAuth settings › isPkceRequired'])
    );
    expect(app.some((p) => /consumerKey/.test(p))).toBe(false);
  });
  it('changes one value, also inside a named group, and leaves the rest', () => {
    const xml = demo('uat/namedCredentials/Billing.namedCredential');
    const out = setConfigValue(
      xml,
      'namedCredentialParameters[Url] › parameterValue',
      'https://billing-v3.example.com'
    );
    expect(out).toContain('<parameterValue>https://billing-v3.example.com</parameterValue>');
    expect(out).toContain('<externalCredential>Billing_Auth</externalCredential>');
    expect(setConfigValue(xml, 'label', 'Billing v3')).toContain('<label>Billing v3</label>');
    const policy = fixture('NomadSF_Demo_oauth_defaultPolicy.ecaOauthPlcy');
    expect(setConfigValue(policy, 'permittedUsersPolicyType', 'AdminApprovedPreAuthorized')).toContain(
      '<permittedUsersPolicyType>AdminApprovedPreAuthorized</permittedUsersPolicyType>'
    );
  });
  it('leaves the consumer key out for another org', () => {
    expect(forAnotherOrg(fixture('NomadSF_Demo_glbloauth.ecaGlblOauth'))).not.toContain('consumerKey');
  });
});
