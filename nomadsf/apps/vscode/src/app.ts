/**
 * Links into the Studio shipped with the extension (a tool, a record, a query) and the list of its pages. Kept free of
 * the VS Code API so it is easy to test.
 */

export const GUIDE_URL = 'https://faridmasjedi.github.io/plugin-fm/guide.html';

const ID = /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/;

type StudioTarget =
  | { kind: 'studio'; page?: string }
  | { kind: 'record'; id: string }
  | { kind: 'query'; soql: string };

/** The Studio's #link for a target: a tool, a record or a query ('' = the last tool used). */
export function studioHash(target: StudioTarget): string {
  switch (target.kind) {
    case 'studio':
      return target.page ?? '';
    case 'record':
      if (!ID.test(target.id)) throw new Error('Select a 15- or 18-character record Id.');
      return `record=${target.id}`;
    case 'query':
      if (!/^\s*select\b/i.test(target.soql)) throw new Error('Select a SOQL query (SELECT …).');
      return `query=${encodeURIComponent(target.soql.trim())}`;
  }
}

export const STUDIO_PAGES = [
  ['code', 'Code', 'Develop'],
  ['apex', 'Execute Apex', 'Develop'],
  ['codechecks', 'Code checks', 'Develop'],
  ['apextests', 'Apex tests', 'Develop'],
  ['logs', 'Debug logs', 'Develop'],
  ['jobs', 'Jobs', 'Develop'],
  ['automation', 'Save order', 'Develop'],
  ['flows', 'Flows', 'Develop'],
  ['events', 'Events', 'Develop'],
  ['rest', 'REST Explorer', 'Develop'],
  ['query', 'Query', 'Data'],
  ['record', 'Record', 'Data'],
  ['data', 'Import / Update / Delete', 'Data'],
  ['lookup', 'Lookup', 'Data'],
  ['schema', 'Schema', 'Data'],
  ['fields', 'Field usage', 'Data'],
  ['customsettings', 'Custom settings', 'Data'],
  ['backup', 'Backup and restore', 'Data'],
  ['lifecycle', 'Lifecycle', 'Data'],
  ['access', 'Users', 'Access'],
  ['permissions', 'Access sets', 'Access'],
  ['groups', 'Groups & queues', 'Access'],
  ['bulkaccess', 'Assign in bulk', 'Access'],
  ['objectaccess', 'Object access', 'Access'],
  ['compare', 'Compare', 'Access'],
  ['secdash', 'Dashboard', 'Security'],
  ['timeline', 'Timeline', 'Security'],
  ['eventlogs', 'Event logs', 'Security'],
  ['whocansee', 'Who can see', 'Access'],
  ['integration', 'Integration check', 'Security'],
  ['sharing', 'Sharing', 'Security'],
  ['health', 'Org health', 'Security'],
  ['audit', 'Logins & audit', 'Security'],
  ['company', 'Company information', 'Org'],
  ['limits', 'Limits', 'Org'],
  ['licenses', 'Licenses', 'Org'],
  ['apps', 'Apps & credentials', 'Org'],
  ['metadata', 'Metadata', 'Org'],
  ['deployments', 'Deployments', 'Org'],
  ['orgdiff', 'Compare metadata (two orgs)', 'Compare & Deploy'],
  ['orgaccess', 'Compare access (two orgs)', 'Compare & Deploy'],
  ['orgapps', 'Compare apps (two orgs)', 'Compare & Deploy'],
  ['migrate', 'Copy records (two orgs)', 'Compare & Deploy'],
  ['project', 'Project (org ↔ project)', 'Compare & Deploy'],
  ['branchorg', 'Branch ↔ Org', 'Compare & Deploy'],
  ['package', 'Branch ↔ Branch (package.xml)', 'Compare & Deploy'],
  ['files', 'Open a file', 'Compare & Deploy'],
  ['manifest', 'Check a manifest', 'Compare & Deploy'],
  ['csvcompare', 'Compare with CSV', 'Compare & Deploy'],
  ['sandbox', 'Sandbox refresh', 'Compare & Deploy'],
  ['settings', 'Orgs', 'Settings'],
  ['settingsai', 'AI', 'Settings'],
  ['settingsproject', 'Project', 'Settings'],
  ['myaccess', 'Your access', 'Settings'],
  ['activity', 'Activity', 'Settings'],
] as const;

/** The system's own "open this link" command, with the link as one argument (no shell). */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}
