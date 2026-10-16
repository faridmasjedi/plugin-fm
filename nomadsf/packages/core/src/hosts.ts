/**
 * Maps the host of any Salesforce page (Lightning, Setup, Visualforce, Experience
 * builder) to the My Domain API host whose `sid` cookie authorizes API calls.
 */
export function apiHostFor(pageHost: string): string | undefined {
  const host = pageHost.toLowerCase();
  if (host.endsWith('.my.salesforce.com')) return host;
  const rules: Array<[RegExp, string]> = [
    [/\.lightning\.force\.com$/, '.my.salesforce.com'],
    [/\.my\.salesforce-setup\.com$/, '.my.salesforce.com'],
    // orgname--c.vf.force.com, orgname--pkg.sandbox.vf.force.com -> orgname(.sandbox).my.salesforce.com
    [/--[\w]+(\.sandbox|\.develop|\.scratch)?\.vf\.force\.com$/, '$1.my.salesforce.com'],
    [/\.vf\.force\.com$/, '.my.salesforce.com'],
    [/\.my\.site\.com$/, '.my.salesforce.com'],
  ];
  for (const [pattern, replacement] of rules) {
    if (pattern.test(host)) return host.replace(pattern, replacement);
  }
  // Classic instance hosts (na1.salesforce.com, cs42.salesforce.com)
  if (/^[a-z]+\d+\.salesforce\.com$/.test(host)) return host;
  return undefined;
}

export function isSalesforceHost(host: string): boolean {
  return apiHostFor(host) !== undefined;
}
