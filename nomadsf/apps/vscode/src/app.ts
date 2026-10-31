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
  ['apextests', 'Apex tests', 'Develop'],
  ['logs', 'Debug logs', 'Develop'],
  ['jobs', 'Jobs', 'Develop'],
  ['automation', 'Automation', 'Develop'],
  ['events', 'Events', 'Develop'],
  ['rest', 'REST Explorer', 'Develop'],
  ['query', 'Query', 'Data'],
  ['record', 'Record', 'Data'],
  ['data', 'Import / Update / Delete', 'Data'],
  ['csvcompare', 'Compare with CSV', 'Data'],
  ['lookup', 'Lookup', 'Data'],
  ['schema', 'Schema', 'Data'],
  ['fields', 'Field usage', 'Data'],
  ['project', 'Project', 'Release'],
  ['package', 'Compare & package', 'Release'],
  ['metadata', 'Metadata', 'Release'],
  ['deployments', 'Deployments', 'Release'],
  ['access', 'Users', 'Access'],
  ['permsets', 'Permission sets', 'Access'],
  ['permissions', 'Permissions', 'Access'],
  ['custperms', 'Custom permissions', 'Access'],
  ['groups', 'Groups & queues', 'Access'],
  ['assigned', 'Assigned users', 'Access'],
  ['objectaccess', 'Object access', 'Access'],
  ['accessmap', 'Overview', 'Access'],
  ['compare', 'Compare', 'Access'],
  ['myaccess', 'Your access', 'Access'],
  ['company', 'Company information', 'Org'],
  ['health', 'Org health', 'Org'],
  ['limits', 'Limits', 'Org'],
  ['apps', 'Connected apps', 'Org'],
  ['audit', 'Logins & audit', 'Org'],
  ['activity', 'Activity', 'Org'],
  ['backup', 'Backup and restore', 'Data protection'],
  ['lifecycle', 'Lifecycle', 'Data protection'],
  ['migrate', 'Migrate', 'Org to org'],
  ['orgdiff', 'Org compare', 'Org to org'],
  ['orgaccess', 'Access', 'Org to org'],
  ['orgapps', 'Connected apps', 'Org to org'],
  ['settings', 'Settings', 'Settings'],
] as const;

/** The system's own "open this link" command, with the link as one argument (no shell). */
export function browserCommand(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  return ['xdg-open', [url]];
}
