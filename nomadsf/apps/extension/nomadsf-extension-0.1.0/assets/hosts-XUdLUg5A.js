function t(c) {
  const e = c.toLowerCase();
  if (e.endsWith('.my.salesforce.com')) return e;
  const s = [
    [/\.lightning\.force\.com$/, '.my.salesforce.com'],
    [/\.my\.salesforce-setup\.com$/, '.my.salesforce.com'],
    [/--[\w]+(\.sandbox|\.develop|\.scratch)?\.vf\.force\.com$/, '$1.my.salesforce.com'],
    [/\.vf\.force\.com$/, '.my.salesforce.com'],
    [/\.my\.site\.com$/, '.my.salesforce.com'],
  ];
  for (const [o, r] of s) if (o.test(e)) return e.replace(o, r);
  if (/^[a-z]+\d+\.salesforce\.com$/.test(e)) return e;
}
export { t as a };
