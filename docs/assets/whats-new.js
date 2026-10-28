// What each version brought, in a few words (shown on the download section).
// New changes go under "next"; the newest release without its own entry shows them.
// After publishing a release, rename "next" to that version (e.g. "2.2.0").
window.NOMADSF_WHATS_NEW = {
  next: [
    'Query: saved queries, history and files on top; run options next to the editor',
    'Record: find a user by name, and a Me button',
    'Import / Update / Delete: upsert matches by Id or an External ID field you pick from a list',
    'Objects you type are listed exact match first, then names that start with it',
    'Field pickers (backup, migrate, lifecycle) no longer overlap; show labels, API names or both',
    'Deployments show their Id; a spinner shows while NomadSF waits for Salesforce',
    'VS Code: Salesforce links with a query string (and Log in as) open the right page',
    'Apex editor suggests the names used in your code; Execute Apex asks for the org name',
  ],
  '2.1.0': [
    'VS Code extension works on its own: no Salesforce CLI, no sf fm plugin, no local port',
    'Log in to an org from VS Code',
  ],
  '2.0.0': [
    'Access hub: access overview, object access and your own access',
    'Org to org hub: compare, migrate, access and connected apps for a pair of orgs',
    'Edit permissions; every change asks for approval',
  ],
  '1.2.1': ['Cleaner recordings in the guide'],
  '1.2.0': [
    'Automation: what runs when a record is saved',
    'Jobs, deployment history and quick deploy',
    'Record history and a schema explorer',
    'Who has it, compare access, org health with licenses',
  ],
  '1.1.0': [
    'Everything a user has; connected apps and OAuth usage',
    'Destructive changes from metadata and the project',
    'Schedules every N hours, days, weeks or months',
    'A guide section and recording for every tool',
  ],
  '1.0.1': ['Select and copy record Ids; right-click copy and paste in VS Code'],
  '1.0.0': [
    'First release: one version for the plugin, browser extension and VS Code',
    'Approvals inside the page; copy, paste, links and downloads in VS Code',
  ],
};
