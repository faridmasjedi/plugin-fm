// The guide's recordings, one scene per video. Each opens the Studio fresh against the demo orgs
// (acme-uat is A, acme-dev is B) and uses it like a person would. Writes go to the demo orgs only.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.DEMO_URL ?? 'http://localhost:7171';
const files = join(fileURLToPath(new URL('.', import.meta.url)), '.recordings', 'files');
mkdirSync(files, { recursive: true });

/** A query against a demo org, for Ids the scenes need. */
async function soql(org, q) {
  const res = await fetch(`${BASE}/api/sf/${org}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ method: 'GET', path: `/services/data/v62.0/query?q=${encodeURIComponent(q)}` }),
  });
  return JSON.parse((await res.json()).body).records;
}
const idOf = async (org, q) => (await soql(org, q))[0]?.Id;
/** Changes a record in a demo org, as someone else would (Events hears it). */
async function update(org, sobject, id, fields) {
  await fetch(`${BASE}/api/sf/${org}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      method: 'PATCH',
      path: `/services/data/v62.0/sobjects/${sobject}/${id}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    }),
  });
}
const csv = (name, rows) => {
  const path = join(files, name);
  writeFileSync(path, rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'));
  return path;
};

/** A validation in the shared Validate and deploy panel, waited for and checked. */
async function validate(h, org = 'acme-uat') {
  await h.click(`Validate on ${org}`);
  await h.confirm(org);
  await h.until(/Validation (Succeeded|Failed)/, 300000);
  if (!(await h.page.getByText('✓ Validation Succeeded').count())) {
    // The errors themselves, for whoever reads the failed run
    const panel = await h.page.locator('.release-panel').last().innerText();
    throw new Error(
      `Validation failed: ${panel.slice(panel.indexOf('Validation Failed')).replace(/\s+/g, ' ').slice(0, 900)}`
    );
  }
  await h.settle();
}

// The ✦ answers of the AI scenes (the recorder answers with these; no AI provider is called)
const REVIEW = `**InvoiceService** is bulk-safe and short. Two things to look at:

| # | What | Where | Suggestion |
|---|------|-------|------------|
| 1 | Overdue is decided by today's date in the running user's time zone | \`markOverdue\` | Fine for a nightly batch; say so in a comment |
| 2 | **No check for a missing amount** | \`owedByAccount\` | \`SUM\` skips nulls — a draft without an amount is not counted |

\`\`\`apex
// Invoices without an amount are left out of what an account owes
\`\`\`

**What is fine:**
- \`with sharing\` is declared.
- No SOQL or DML inside loops.
`;
const TRIGGER = {
  type: 'ApexTrigger',
  name: 'InvoiceTrigger',
  note: 'A thin trigger: InvoiceService marks sent invoices past their due date as Overdue when they are updated.',
  files: [
    {
      path: 'triggers/InvoiceTrigger.trigger',
      content:
        'trigger InvoiceTrigger on Invoice__c (before update) {\n    InvoiceService.markOverdue(Trigger.new);\n}\n',
    },
    {
      path: 'triggers/InvoiceTrigger.trigger-meta.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8"?>\n<ApexTrigger xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>62.0</apiVersion>\n    <status>Active</status>\n</ApexTrigger>\n',
    },
  ],
};

/** A hub, tab by tab: what each is for (the guide's video at the top of each hub). */
const hubTour = (id, hub, hash, intro, tabs, { folder = false, other, init } = {}) => ({
  name: `hub-${id}`,
  hash,
  intro,
  folder,
  init,
  run: async (h) => {
    for (const [tab, text] of tabs) {
      await h.tab(hub, tab);
      await h.settle(20000);
      // Real content on every tab: the other org chosen once (B, read only here), the project folder opened once
      if (other) {
        const pick = h.page
          .locator('.pane-body select:visible')
          .filter({ has: h.page.locator('option', { hasText: 'Choose the other org' }) })
          .first();
        if ((await pick.count()) && !(await pick.inputValue())) {
          await h.select(pick, other);
          await h.settle(30000);
        }
      }
      const open = h.page.locator('.pane-body button:visible', { hasText: 'Open the project folder…' }).first();
      if (folder && (await open.count())) {
        await h.press(open);
        await h.settle(30000);
      }
      await h.say(text);
    }
  },
});

export const scenes = [
  hubTour('develop', 'Develop', 'code', 'Develop: code, tests, logs, jobs and automation', [
    ['Code', 'Code: every class, trigger, page and component — with its dependencies'],
    ['Execute Apex', 'Execute Apex: run anonymous Apex'],
    ['Apex tests', 'Apex tests: run tests, see the coverage'],
    ['Code checks', 'Code checks: security mistakes and queries in loops, with the fix'],
    ['Debug logs', 'Debug logs: switch logging on, read a log’s insights'],
    ['Jobs', 'Jobs: scheduled and background Apex'],
    ['Save order', 'Save order: what runs when a record is saved'],
    ['Flows', 'Flows: old versions, old API versions, waiting and failed interviews'],
    ['Events', 'Events: platform events and change events, live'],
    ['REST Explorer', 'REST Explorer: any REST call'],
  ]),
  hubTour('data', 'Data', 'query', 'Data: query, read, change and keep your records', [
    ['Query', 'Query: SOQL with a filterable table'],
    ['Record', 'Record: one record — every field, its children, its history'],
    ['Import / Update / Delete', 'Import / Update / Delete: from a CSV file or a query'],
    ['Lookup', 'Lookup: Ids for the values of a CSV column'],
    ['Schema', 'Schema: fields, relationships, record types'],
    ['Field usage', 'Field usage: how full each field is'],
    ['Custom settings', 'Custom settings: their values by org, profile or user — and new ones'],
    ['Backup', 'Backup: back up and restore, on a schedule'],
    ['Lifecycle', 'Lifecycle: archive, anonymize and delete in steps'],
  ]),
  hubTour('access', 'Access', 'access', 'Access: users, and what they are allowed to do', [
    ['Users', 'Users: a user and everything they have'],
    ['Access sets', 'Access sets: profiles, permission sets, groups, custom permissions'],
    ['Groups & queues', 'Groups & queues: who is in each'],
    ['Assign in bulk', 'Assign in bulk: many permission sets, groups and queues, to many users'],
    ['Object access', 'Object access: who can use an object or a field'],
    ['Compare', 'Compare: two users, profiles or permission sets'],
  ]),
  hubTour('security', 'Security', 'secdash', 'Security: what happened in the org, and how safe it is', [
    ['Dashboard', 'Dashboard: security at a glance'],
    ['Timeline', 'Timeline: everything that happened, in one list'],
    ['Event logs', 'Event logs: logins, API calls, Apex, pages, reports'],
    ['Who can see', 'Who can see: a record, object, field or class — and why'],
    ['Integration check', 'Integration check: why an integration fails, and what to do'],
    ['Sharing', 'Sharing: an object’s sharing, as a tree'],
    ['Org health', 'Org health: Health Check, what is not used'],
    ['Logins & audit', 'Logins & audit: login history, setup audit trail'],
  ]),
  hubTour('org', 'Org', 'company', 'Org: the org itself', [
    ['Company', 'Company: Id, edition, locale, fiscal year'],
    ['Limits', 'Limits: every limit and the storage'],
    ['Licenses', 'Licenses: used, and held without being used'],
    ['Connected apps', 'Connected apps: the apps and their use'],
    ['Metadata', 'Metadata: every component — retrieve, package, deploy'],
    ['Deployments', 'Deployments: the history, and quick deploy'],
  ]),
  hubTour(
    'move',
    'Compare & Deploy',
    'orgdiff',
    'Compare & Deploy: between two places — two orgs, the project, a branch, a file',
    [
      ['Compare metadata', 'Org ↔ Org: compare metadata, and deploy the differences'],
      ['Compare access', 'Compare access: users and permissions in two orgs'],
      ['Compare apps', 'Compare apps: connected apps in two orgs'],
      ['Copy records', 'Copy records: between orgs, every link kept'],
      ['Project', 'Project & git: your project folder against the org'],
      ['Branch ↔ Org', 'Branch ↔ Org: a branch against an org'],
      ['Branch ↔ Branch', 'Branch ↔ Branch: a branch as package.xml and destructiveChanges.xml'],
      ['Open a file', 'Org ↔ File: open a snapshot, workbook, CSV or package.xml'],
      ['Check a manifest', 'Check a manifest: a package.xml against an org'],
      ['Compare with CSV', 'Compare with CSV: a spreadsheet next to the org'],
      ['Sandbox refresh', 'Sandbox refresh: before it, save; after it, put back'],
    ],
    { folder: true, other: 'acme-dev' }
  ),
  hubTour(
    'settings',
    'Settings',
    'settings',
    'Settings: your orgs, your AI, your project — and what you did',
    [
      ['Orgs', 'Orgs: the orgs you are logged in to'],
      ['AI', 'AI: your own AI for the ✦ buttons'],
      ['Project', 'Project: the Salesforce project every page uses'],
      ['Your access', 'Your access: what your user may do here'],
      ['Activity', 'Activity: what you changed or exported with NomadSF'],
    ],
    {
      init: () => {
        window.__nomadsfDemoAiForm = true;
      },
    }
  ),
  {
    name: 'tour',
    hash: 'code',
    intro: 'NomadSF Studio: six hubs for your org, and Settings — each hub with its own tabs',
    run: async (h) => {
      await h.say('Click a hub: its tabs are on the left, each with its own color');
      await h.tab('Data', 'Query');
      await h.tab('Access', 'Users');
      await h.tab('Compare & Deploy', 'Copy records');
      await h.say('« Narrow keeps only the icons — the name shows when the mouse is over one');
      await h.press(h.page.locator('nav.side .nav-width'));
      await h.page.locator('nav.side .hub[data-hub="security"]').hover();
      await h.pause(1400);
      await h.page.locator('nav.side .hub[data-hub="org"]').hover();
      await h.pause(1400);
      await h.press(h.page.locator('nav.side .nav-width'));
      await h.say('⌘K (Ctrl+K): say what you want to do, and go there');
      await h.page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
      await h.pause(600);
      await h.page.keyboard.type('sche', { delay: 120 });
      await h.pause(800);
      await h.page.keyboard.press('Enter');
      await h.pause(2000);
    },
  },
  {
    name: 'query',
    intro: 'Data › Query: SOQL with a table you can filter, sort and export',
    hash: 'query',
    run: async (h) => {
      await h.say('Write the query — fields and objects autocomplete');
      await h.code('SELECT Name, Title, AccountId FROM Contact ORDER BY Name');
      await h.page.keyboard.press('Escape');
      await h.say('Run it: the rows come back as a table');
      await h.click('Run');
      await h.until('rows');
      await h.pause(1200);
      // Fields of the Account each AccountId points to, as new columns (once the Id columns are known)
      await h.page.getByText('Looking up names…').waitFor({ state: 'detached', timeout: 60000 });
      await h.say('Related fields: add the Account’s fields as new columns');
      await h.click('Related fields…');
      const panel = h.page.locator('.related-fields');
      await panel.locator('.field-checks label').first().waitFor({ timeout: 60000 });
      await h.pause(800);
      for (const [filter, field] of [
        ['Industry', 'Industry'],
        ['Tier', 'Customer_Tier__c'],
      ]) {
        await h.type(panel.locator('input[placeholder^="Filter"]'), filter);
        await h.press(
          panel
            .locator('label.check', { has: h.page.locator('.mono', { hasText: new RegExp(`^${field}$`) }) })
            .locator('input')
        );
      }
      await h.settle();
      await h.pause(1500);
      // Or straight into the SOQL: Account.Industry, Account.Customer_Tier__c, and run again
      await h.say('Or put them in the SOQL itself, and run again');
      await h.click('Add to the query instead');
      await h.until('rows');
      await h.settle();
      await h.pause(1800);
    },
  },
  {
    name: 'code',
    intro: 'Develop › Code: every Apex class, trigger, page and component, with what it uses and what uses it',
    hash: 'code',
    run: async (h) => {
      await h.say('Find a class by name');
      await h.type(h.page.locator('input[placeholder^="Filter"]').first(), 'CaseH');
      await h.press(h.page.locator('.pane-body li button', { hasText: /^CaseHandler/ }).first());
      await h.until('beforeInsert');
      await h.pause(1200);
      await h.say('Dependencies: what it uses, and what uses it');
      await h.click('Dependencies');
      await h.until('Used by');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'related',
    intro: 'Data › Record › Related: a record with its children, copied to another org in one go',
    hash: 'record',
    run: async (h) => {
      const acme = await idOf('acme-uat', "SELECT Id FROM Account WHERE Name = 'Northwind Traders' LIMIT 1");
      await h.say('Open an account by its Id');
      await h.type(h.page.locator('input[placeholder^="Record Id"]'), acme);
      await h.click('Show all data');
      await h.until('Open in Salesforce');
      await h.say('Related: its children, counted per object');
      await h.click('Related');
      await h.until('Copy into');
      await h.page
        .getByText('Counting')
        .first()
        .waitFor({ state: 'detached', timeout: 60000 })
        .catch(() => {});
      await h.pause(800);
      const tree = h.page.locator('.record-tree');
      const group = (name) =>
        tree.locator('li').filter({ has: h.page.locator(':scope > label b', { hasText: new RegExp(`^${name}$`) }) });
      await h.say('Tick what to copy: its contacts and its case');
      await h.press(group('Contact').locator(':scope > label input'));
      await h.press(group('Case').locator(':scope > button', { hasText: '▸' }));
      await h.pause(1200);
      await h.press(group('Case').locator('li label input').first());
      await h.pause(600);
      await h.say('Choose the org to copy into');
      await h.select(tree.locator('.copy-bar select'), 'acme-new');
      // New names and e-mails: the people are not copied as they are
      await h.say('Mask personal data: names and e-mails are made up in the copy');
      await h.press(tree.locator('.copy-bar label', { hasText: 'Mask personal data' }).locator('input'));
      await h.say('Copy — NomadSF asks you to type the org’s name first');
      await h.press(tree.locator('.copy-bar button', { hasText: /^Copy$/ }));
      await h.confirm('acme-new');
      await h.until('created', 120000);
      await h.pause(1500);
      await h.say('Changed your mind? Undo this copy deletes what was created');
      await h.click('Undo this copy');
      await h.confirm('acme-new');
      await h.until('deleted', 120000);
    },
  },
  {
    name: 'record',
    intro: 'Data › Record: every field of one record — read it, edit it, open its user',
    hash: 'record',
    run: async (h) => {
      const acme = await idOf('acme-uat', "SELECT Id FROM Account WHERE Name = 'Acme Corp' LIMIT 1");
      await h.type(h.page.locator('input[placeholder^="Record Id"]'), acme);
      await h.click('Show all data');
      await h.until('Open in Salesforce');
      await h.pause(1000);
      await h.say('Filter the fields by name or value');
      await h.type(h.page.locator('input[placeholder="Filter fields and values"]'), 'tier');
      await h.pause(1200);
      await h.say('Edit a value in place (cancelled here)');
      await h.click('Edit');
      await h.select(h.page.locator('table.record select').first(), 'Gold');
      await h.pause(800);
      await h.click('Cancel');
      await h.page.locator('input[placeholder="Filter fields and values"]').fill('');
      await h.say('Open a user: log in as them, or see their access');
      await h.click('Me');
      await h.until('Log in as this user');
      await h.pause(1500);
    },
  },
  {
    name: 'history',
    intro: 'Data › Record › History: what changed on a record, and who changed it',
    hash: 'record',
    run: async (h) => {
      // An invoice whose status and amount changed (tracked fields)
      const [changed] = await soql(
        'acme-uat',
        "SELECT ParentId FROM Invoice__History WHERE Field = 'Status__c' ORDER BY CreatedDate DESC LIMIT 1"
      );
      const invoice = changed.ParentId;
      await h.type(h.page.locator('input[placeholder^="Record Id"]'), invoice);
      await h.click('Show all data');
      await h.until('Open in Salesforce');
      await h.say('History: each tracked change, old and new value');
      await h.click('History');
      await h.until('Status');
      await h.settle();
      await h.pause(2200);
    },
  },
  {
    name: 'data-tool',
    intro: 'Data › Import / Update / Delete: a CSV file into the org',
    hash: 'data',
    run: async (h) => {
      const rows = await soql(
        'acme-uat',
        "SELECT Id, Name, Phone FROM Account WHERE Name IN ('Globex','Initech','Hooli') ORDER BY Name"
      );
      const file = csv('accounts-phones.csv', [
        ['Id', 'Name', 'Phone'],
        ...rows.map((r, i) => [r.Id, r.Name, `+61 2 5550 ${7100 + i}`]),
      ]);
      await h.say('Choose the object and the operation: Update');
      await h.type(h.page.locator('input[placeholder="Account"], input[list]').first(), 'Account');
      await h.select(
        h.page
          .locator('select')
          .filter({ has: h.page.locator('option[value=update]') })
          .first(),
        'update'
      );
      await h.say('Choose the CSV: columns are matched to fields');
      await h.file(h.page.locator('input[type=file]:visible').first(), file);
      await h.settle();
      await h.pause(1600);
      await h.say('Run it — after typing the org’s name');
      await h.click('Run on');
      await h.confirm('acme-uat');
      await h.until('Succeeded', 120000);
      await h.pause(2000);
    },
  },
  {
    name: 'csvcompare',
    intro: 'Compare & Deploy › Compare with CSV: a spreadsheet next to the org, row by row',
    hash: 'csvcompare',
    run: async (h) => {
      const rows = await soql(
        'acme-uat',
        'SELECT Customer_Number__c, Name, Industry FROM Account WHERE Customer_Number__c != null ORDER BY Customer_Number__c LIMIT 5'
      );
      const file = csv('accounts-from-erp.csv', [
        ['Customer_Number__c', 'Name', 'Industry'],
        ...rows.map((r, i) => [r.Customer_Number__c, r.Name, i === 1 ? 'Retail' : r.Industry]),
        ['C-20001', 'Pied Piper', 'Technology'],
      ]);
      await h.say('Choose the CSV file and the object');
      await h.file(h.page.locator('input[type=file]').first(), file);
      await h.pause(1200);
      await h.type(h.page.locator('input[placeholder="e.g. Contact"]'), 'Account');
      await h.page.keyboard.press('Tab');
      await h.settle();
      await h.pause(1600);
      await h.say('Match the rows on a key column');
      await h.choose(h.page.locator('.pane-body select').first(), /Customer Number|Customer_Number__c/);
      await h.say('Compare: same, different, only in the file');
      await h.click('Compare');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'lookup',
    intro: 'Data › Lookup: find the Salesforce Id for each value of a CSV column',
    hash: 'lookup',
    run: async (h) => {
      const file = csv('order-lines.csv', [
        ['Order', 'Customer'],
        ['SO-1001', 'Globex'],
        ['SO-1002', 'Hooli'],
        ['SO-1003', 'Initech'],
        ['SO-1004', 'Wonka Foods'],
      ]);
      await h.say('A CSV with customer names');
      await h.file(h.page.locator('input[type=file]').first(), file);
      await h.pause(1500);
      await h.say('Which column, which object, which field to match');
      await h.select(h.page.locator('.pane-body select').first(), 'Customer');
      await h.type(h.page.locator('input[placeholder="e.g. User"]'), 'Account');
      await h.page.keyboard.press('Tab');
      await h.pause(2000);
      await h.choose(h.page.locator('.pane-body select').nth(1), /Account Name|^Name/);
      await h.pause(1200);
      await h.say('Look up: an Id for each value, ready to download');
      await h.click(/Look up \d+ value/);
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'schema',
    intro: 'Data › Schema: an object’s fields, relationships and record types',
    hash: 'schema',
    run: async (h) => {
      await h.say('Choose an object');
      await h.type(h.page.locator('input[placeholder="Object, e.g. Account"]'), 'Account');
      await h.page.keyboard.press('Enter');
      await h.until('Fields (');
      await h.pause(1200);
      await h.say('Click a field: its type, values and details');
      await h.press(h.page.getByText('Customer_Tier__c', { exact: true }).first());
      await h.pause(1800);
      await h.say('Relationships: lookups and children');
      await h.click('Relationships');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'fields',
    intro: 'Data › Field usage: how full each field is, and who can see it',
    hash: 'fields',
    run: async (h) => {
      await h.type(h.page.locator('input[placeholder="Object, e.g. Account"]'), 'Account');
      await h.page.keyboard.press('Enter');
      await h.settle();
      await h.pause(1600);
      await h.say('Count all: how many records fill each field');
      await h.click('Count all');
      await h.settle();
      await h.pause(1600);
      await h.say('Click a field: its values, and who can see it');
      await h.press(h.page.getByText('Customer_Tier__c', { exact: true }).first());
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'apex',
    intro: 'Develop › Execute Apex: run anonymous Apex and read its debug lines',
    hash: 'apex',
    run: async (h) => {
      await h.code(
        "Integer gold = [SELECT COUNT() FROM Account WHERE Customer_Tier__c = 'Gold'];\nSystem.debug('Gold customers: ' + gold);"
      );
      await h.page.keyboard.press('Escape');
      await h.say('Execute — the debug lines show below');
      await h.click(/^Execute ⌘/);
      await h.confirm('acme-uat');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'apextests',
    intro: 'Develop › Apex tests: run test classes and see the code coverage',
    hash: 'apextests',
    run: async (h) => {
      // Find the test classes by name (a long list in a real org), tick them
      await h.say('Find test classes by name, tick them');
      await h.type(h.page.locator('input[placeholder^="Find test classes"]'), 'account*, casehandler');
      await h.pause(900);
      for (const name of ['AccountServiceTest', 'CaseHandlerTest'])
        await h.press(h.page.locator('tr', { hasText: name }).locator('input[type=checkbox]'));
      await h.say('Run them: each method passes or fails');
      await h.click('Run selected');
      await h.confirm('acme-uat').catch(() => {});
      await h.until('Passed', 180000).catch(() => {});
      await h.settle();
      await h.pause(1600);
      await h.say('Code coverage, class by class');
      await h.click('Code coverage');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'logs',
    intro: 'Develop › Debug logs: switch logging on, do something, read the log',
    hash: 'logs',
    run: async (h) => {
      // Logging on (or already on), then something that writes a log, then the log itself
      await h.say('Switch logging on for your user');
      const on = h.page.locator('button', { hasText: 'On 30 min' });
      if (await on.count()) {
        await h.click('On 30 min');
        await h.confirm('acme-uat').catch(() => {});
        await h.settle();
      }
      await h.pause(1200);
      await h.say('Do something that writes a log');
      await h.tab('Develop', 'Execute Apex');
      await h.code(
        "List<Account> gold = [SELECT Name FROM Account WHERE Customer_Tier__c = 'Gold' LIMIT 5];\nSystem.debug('Gold customers: ' + gold.size());"
      );
      await h.page.keyboard.press('Escape');
      await h.click(/^Execute ⌘/);
      await h.confirm('acme-uat');
      await h.settle();
      await h.pause(800);
      await h.say('Back in Debug logs: open the newest log — it opens on its insights');
      await h.tab('Develop', 'Debug logs');
      await h.click('Refresh');
      await h.settle();
      await h.waiting(() => h.page.locator('.pane-body tbody tr:visible').first().waitFor({ timeout: 60000 }));
      await h.press(h.page.locator('.pane-body tbody tr:visible').first());
      await h.settle();
      await h.pause(2500);
    },
  },
  {
    name: 'jobs',
    intro: 'Develop › Jobs: scheduled and background jobs, yours and Salesforce’s',
    hash: 'jobs',
    run: async (h) => {
      await h.pause(1500);
      await h.say('Apex jobs: batches, queueables, future calls');
      await h.click('Apex jobs');
      await h.settle();
      await h.pause(1600);
      // Salesforce's own jobs: what the API can read, and Setup for the rest
      await h.say('Background jobs: Salesforce’s own, from the last days');
      await h.click('Background jobs');
      await h.settle();
      await h.select(h.page.locator('.pane-body select:visible').first(), '30');
      await h.settle();
      await h.pause(2000);
    },
  },
  {
    name: 'automation',
    intro: 'Develop › Save order: everything that runs when a record is saved, in order',
    hash: 'automation',
    run: async (h) => {
      // From the empty page: choose an object, then read what runs when one is saved
      await h.pause(1500);
      await h.say('Choose an object');
      await h.type(h.page.locator('input[placeholder="Object, e.g. Case"]'), 'Opportunity');
      await h.page.keyboard.press('Enter');
      await h.until('OpportunityTrigger', 60000);
      await h.until('Amount_Required_When_Won');
      await h.settle();
      await h.pause(2000);
      // What the trigger runs, as a tree under its moment of the save
      await h.say('Click a trigger: what it runs, as a tree');
      await h.press(h.page.locator('.save-card.opens', { hasText: 'OpportunityTrigger' }).first());
      await h.waiting(() => h.page.locator('.auto-node-children .auto-node').first().waitFor({ timeout: 90000 }));
      await h.pause(2500);
      await h.say('The same as a table');
      await h.click(/^Table/);
      await h.pause(1800);
      await h.say('Order of a save: every step, filtered by name');
      await h.click(/^Order of a save/);
      await h.type(h.page.locator('input[placeholder="Name contains…"]'), 'Amount');
      await h.pause(1800);
    },
  },
  {
    name: 'events',
    intro: 'Develop › Events: listen to platform events and change events as they arrive',
    hash: 'events',
    run: async (h) => {
      await h.say('Listen to the change events');
      await h.click('Listen');
      await h.until('Listening on');
      await h.pause(1500);
      // Someone changes an account: its change event arrives
      await h.say('Someone changes an account…');
      const hooli = await idOf('acme-uat', "SELECT Id FROM Account WHERE Name = 'Hooli' LIMIT 1");
      await update('acme-uat', 'Account', hooli, { Phone: `+61 2 5550 ${Math.floor(1000 + Math.random() * 8999)}` });
      const row = h.page.locator('tr', { hasText: '/data/ChangeEvents' }).first();
      await h.waiting(() => row.waitFor({ timeout: 60000 }));
      await h.pause(1000);
      await h.say('…its event arrives: click it to read it');
      await h.press(row);
      await h.until('ChangeEventHeader');
      await h.pause(2200);
    },
  },
  {
    name: 'rest',
    intro: 'Develop › REST Explorer: any REST call, with the answer as a tree',
    hash: 'rest',
    run: async (h) => {
      const path = h.page.locator('.pane-body input:not([type=checkbox]):not([type=file])').first();
      await h.say('Type a path (vXX.X is the org’s API version)');
      await h.press(path);
      await path.fill('');
      await path.pressSequentially('/services/data/vXX.X/sobjects/Account/describe', { delay: 35 });
      await h.say('Send: the answer as a tree');
      await h.click('Send');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'metadata',
    intro: 'Org › Metadata: every component of the org — pick some, package them, deploy',
    hash: 'metadata',
    run: async (h) => {
      await h.say('Choose a type: its components are listed');
      await h.select(h.page.locator('.pane-body select').first(), 'ApexClass');
      await h.until('InvoiceController', 90000);
      await h.pause(800);
      // A long list: find the ones you want by name
      await h.say('Find the ones you want by name, tick them');
      await h.type(h.page.locator('input[placeholder^="Find "]'), 'account*');
      await h.pause(1000);
      for (const name of ['AccountService', 'AccountServiceTest'])
        await h.press(h.row(name).locator('input[type=checkbox]'));
      await h.say('Add them to a package, and look at what goes in');
      await h.click(/^Add \d+ to package/);
      await h.pause(1500);
      await h.press(h.page.locator('.package-contents button', { hasText: 'AccountService' }).first());
      await h.settle();
      await h.pause(1800);
      // Into the other org: validate, then quick deploy the validation (no second test run)
      await h.say('Validate first, with the test class that covers them');
      await h.select(h.page.locator('.release-panel select').first(), 'acme-uat');
      await h.select(h.page.locator('.release-panel select').nth(1), 'RunSpecifiedTests');
      await h.type(h.page.locator('.release-panel textarea'), 'AccountServiceTest');
      await validate(h, 'acme-uat');
      await h.pause(1200);
      await h.say('Then quick deploy the validation — no second test run');
      await h.click('Quick deploy (no second test run)');
      await h.confirm('acme-uat');
      await h.until(/Deploy (Succeeded|Failed)/, 300000);
      await h.until('✓ Deploy Succeeded', 5000);
      await h.settle();
      await h.pause(2000);
    },
  },
  {
    name: 'deployments',
    intro: 'Org › Deployments: what was deployed, when, by whom — and quick deploy',
    hash: 'deployments',
    run: async (h) => {
      await h.say('Every deployment: status, components, tests');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'access',
    intro: 'Access › Users: one user and everything they have',
    hash: 'access',
    run: async (h) => {
      await h.say('Find a user by name, username or e-mail');
      await h.type(h.page.locator('input[placeholder="Name, username, email or user Id"]'), 'Ann');
      await h.click('Find');
      await h.until('Sales Manager');
      await h.pause(1200);
      await h.say('Their permission sets and groups');
      await h.click('Permission sets & groups');
      await h.pause(2000);
      await h.say('Their system permissions, and where each comes from');
      await h.click('System permissions');
      await h.pause(2000);
      await h.say('Everything in one Excel workbook');
      await h.click('Everything (workbook)');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'groups',
    intro: 'Access › Groups & queues: who is in each group, opened level by level',
    hash: 'groups',
    run: async (h) => {
      await h.until('Tier 1 Support', 60000);
      await h.pause(800);
      await h.say('Click a group: its members');
      await h.press(h.row('Tier 1 Support'));
      await h.settle();
      await h.pause(1600);
      // A group with a group and a role inside: open them to see who is in each, one level per click
      await h.say('A group with a group and a role inside');
      await h.press(h.row('Support Team'));
      await h.settle();
      await h.pause(1200);
      await h.say('Who is in it: one level per click');
      await h.press(
        h.page
          .locator('.card.section button', { hasText: 'Who is in it' })
          .and(h.page.locator('tr', { hasText: 'Support Manager' }).locator('button'))
          .first()
      );
      await h.waiting(() =>
        h.page.locator('.member-tree .auto-node-children .auto-node').first().waitFor({ timeout: 60000 })
      );
      await h.pause(1800);
      await h.press(
        h.page
          .locator('.card.section button', { hasText: 'Who is in it' })
          .and(h.page.locator('tr', { hasText: 'Sales Leads' }).locator('button'))
          .first()
      );
      await h.waiting(() =>
        h.page.locator('.member-tree .auto-node-children .auto-node').first().waitFor({ timeout: 60000 })
      );
      await h.pause(2000);
    },
  },
  {
    name: 'objectaccess',
    intro: 'Access › Object access: who can read or edit an object or a field',
    hash: 'objectaccess',
    run: async (h) => {
      await h.pause(1500);
      await h.say('Choose an object and a field');
      await h.select(h.page.locator('.pane-body select').nth(0), 'Contact');
      await h.pause(1500);
      await h.select(h.page.locator('.pane-body select').nth(1), 'Salary__c');
      await h.say('Show who: users, profiles, permission sets and groups');
      await h.click('Show who');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'compare',
    intro: 'Access › Compare: two users side by side — access and every field',
    hash: 'compare',
    run: async (h) => {
      const users = h.page.locator('input[placeholder="Name, username or email"]');
      // One match is one button
      await h.say('Two users: type a name — one match is one button');
      await h.type(users.first(), 'Ann');
      await h.pause(1500);
      await h.click(/^Use Ann Lee/);
      await h.type(users.last(), 'Bob');
      await h.pause(1500);
      await h.click(/^Use Bob Ray/);
      await h.say('Compare: what each has and the other does not');
      await h.click('Compare');
      await h.settle();
      await h.pause(1600);
      // Every field of both, in boxes
      await h.say('Every field of both, side by side');
      await h.press(h.page.locator('.dt-group-toggle', { hasText: 'Other fields' }).first());
      await h.pause(2500);
    },
  },
  {
    name: 'myaccess',
    intro: 'Settings › Your access: what your own user may do in this org',
    hash: 'myaccess',
    run: async (h) => {
      await h.say('Read only, limited or full: and which permission is missing');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'company',
    intro: 'Org › Company: the org’s Id, edition, locale and fiscal year',
    hash: 'company',
    run: async (h) => {
      await h.say('Everything about the org, in one place');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'health',
    intro: 'Security › Org health: Salesforce’s Health Check and what is not used',
    hash: 'health',
    run: async (h) => {
      await h.settle();
      await h.pause(1600);
      await h.say('Each tab carries its count');
      await h.click('Licenses');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'limits',
    intro: 'Org › Limits: every org limit and the storage, with how much is used',
    hash: 'limits',
    run: async (h) => {
      await h.pause(2000);
      await h.say('Storage: data and files, per object');
      await h.click('Storage');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'apps',
    intro: 'Org › Connected apps: the apps connected to the org and how they are used',
    hash: 'apps',
    run: async (h) => {
      await h.say('Each app: its policies and who uses it');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'audit',
    intro: 'Security › Logins & audit: login history and the setup audit trail',
    hash: 'audit',
    run: async (h) => {
      await h.say('Login history: who logged in, from where, how');
      await h.click('Load');
      await h.settle();
      await h.pause(1600);
      await h.say('Setup audit trail: every change made in Setup');
      await h.click('Setup audit trail');
      await h.pause(1000);
      await h.click('Load');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'activity',
    intro: 'Settings › Activity: everything you changed or exported with NomadSF',
    hash: 'record',
    run: async (h) => {
      // Two changes first (a record, a test run), then where they are listed
      await h.say('Change a record and run a test with NomadSF…');
      const globex = await idOf('acme-uat', "SELECT Id FROM Account WHERE Name = 'Globex' LIMIT 1");
      await h.type(h.page.locator('input[placeholder^="Record Id"]'), globex);
      await h.click('Show all data');
      await h.until('Open in Salesforce');
      await h.type(h.page.locator('input[placeholder="Filter fields and values"]'), 'rating');
      await h.click('Edit');
      // A real change: whichever rating it does not have now
      const rating = h.page.locator('table.record select').first();
      await h.select(rating, (await rating.inputValue()) === 'Hot' ? 'Warm' : 'Hot');
      await h.click(/^Save/);
      await h.confirm('acme-uat');
      await h.settle();
      await h.pause(1000);
      await h.tab('Develop', 'Apex tests');
      await h.press(h.page.locator('tr', { hasText: 'InvoiceServiceTest' }).locator('input[type=checkbox]'));
      await h.click('Run selected');
      await h.confirm('acme-uat').catch(() => {});
      await h.until('Passed', 180000);
      await h.settle();
      await h.pause(1000);
      await h.say('…both are listed in Activity, in every org');
      await h.tab('Settings', 'Activity');
      await h.until('record update');
      await h.settle();
      await h.pause(2200);
    },
  },
  {
    name: 'backup',
    intro: 'Data › Backup: back up objects to a folder, on demand or on a schedule',
    hash: 'backup',
    folder: true,
    run: async (h) => {
      // A new backup is already open as a draft: name, objects, a folder, then a real backup into it
      await h.say('A new backup: a name and the objects');
      await h.type(
        h.page.locator('.pane-body input:not([type=checkbox]):not([type=file])').first(),
        'Customers nightly'
      );
      await h.pause(800);
      for (const name of ['Account', 'Contact', 'Invoice']) await h.pickObject(name);
      await h.say('Count the records first');
      await h.click('Count records');
      await h.until('records in 3 objects', 120000);
      await h.settle();
      await h.pause(1400);
      await h.say('Settings: the folder it is written to, and a schedule');
      await h.click('Settings');
      await h.pause(1000);
      await h.click('Choose folder…');
      await h.pause(1200);
      await h.say('Back up now');
      await h.click('Back up now');
      await h.until('last: ✓', 300000);
      await h.settle();
      await h.pause(1200);
      await h.say('Backups & restore: every backup, ready to restore');
      await h.click('Backups & restore');
      await h.settle();
      await h.pause(2200);
    },
  },
  {
    name: 'lifecycle',
    intro: 'Data › Lifecycle: archive, anonymize and delete records in steps',
    hash: 'lifecycle',
    run: async (h) => {
      // A job from a template: its steps in order, then when it runs — shown, not run
      await h.settle();
      await h.pause(1000);
      await h.say('A new job from a template');
      await h.click('+ New');
      await h.pause(700);
      await h.press(h.page.locator('.menu [role=menuitem]', { hasText: 'Sandbox refresh' }).first());
      await h.settle();
      await h.pause(2200);
      await h.say('When it runs — shown, not run');
      await h.press(h.page.locator('button.tab', { hasText: /^Settings$/ }).first());
      await h.pause(1800);
      await h.say('Its steps, in order');
      await h.press(h.page.locator('button.tab', { hasText: /^Steps/ }).first());
      await h.pause(1500);
    },
  },
  {
    name: 'migrate',
    intro: 'Compare & Deploy › Copy records: records from one org to another, every link kept',
    hash: 'migrate',
    run: async (h) => {
      await h.say('Choose the other org (B)');
      await h.select(
        h.page
          .locator('.pane-body select')
          .filter({ has: h.page.locator('option', { hasText: 'Choose the other org' }) })
          .first(),
        'acme-dev'
      );
      await h.settle();
      await h.pause(1600);
      await h.say('Choose the object to copy');
      await h.pickObject('Account');
      await h.pause(1500);
      await h.say('Add its children: contacts come along');
      await h.click('+ Children…');
      await h.settle();
      await h.pause(1600);
      const child = h.page.locator('label.child-row', { has: h.page.locator('.mono', { hasText: /^Contact$/ }) });
      await child.scrollIntoViewIfNeeded();
      await h.press(child.locator('input[type=checkbox]'));
      await h.click(/^Add \d+ as Related only/);
      await h.pause(1500);
      await h.say('Check plan: what will be created, every link kept');
      await h.click('Check plan');
      await h.until('ready to copy', 120000);
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'orgdiff',
    intro: 'Compare & Deploy › Compare metadata: two orgs, type by type, down to the files',
    hash: 'orgdiff',
    run: async (h) => {
      await h.say('Choose the other org (B)');
      await h.select(
        h.page
          .locator('.pane-body select')
          .filter({ has: h.page.locator('option', { hasText: 'Choose the other org' }) })
          .first(),
        'acme-dev'
      );
      await h.settle();
      await h.pause(1000);
      // A few types, found by typing, compared down to their files
      await h.say('Find the types by typing, tick them');
      await h.click('None');
      await h.type(h.page.locator('input.type-find'), 'apexclass, aura*, permissionset');
      await h.click(/^Tick shown/);
      const wanted = ['ApexClass', 'AuraDefinitionBundle', 'PermissionSet', 'PermissionSetGroup'];
      for (const chip of await h.page.locator('.type-chips .chip').allInnerTexts()) {
        const type = chip.replace(/\s*×\s*$/, '').trim();
        if (!wanted.includes(type))
          await h.press(h.page.locator('.type-chips .chip', { hasText: new RegExp(`^${type} ×$`) }).first());
      }
      await h.page.locator('input.type-find').fill('');
      await h.pause(800);
      await h.say('Compare: same, different, only in A, only in B');
      await h.click(/^Compare \d+ type/);
      await h.settle(300000);
      await h.pause(1000);
      await h.say('Compare content: down to the files');
      await h.click(/^Compare content of \d+ in both/);
      await h.until('Content compared', 300000);
      await h.settle(300000);
      await h.pause(1500);
      // A box per type; a choice per row, or for the whole type
      await h.say('A box per type; a choice per row, or for the whole type');
      await h.press(h.page.locator('.group-toggle', { hasText: 'PermissionSet' }).first());
      await h.pause(1500);
      await h.press(h.page.locator('.group-toggle', { hasText: 'ApexClass' }).first());
      await h.pause(1200);
      const row = (name) =>
        h.page.locator('tr', { has: h.page.locator('td', { hasText: new RegExp(`^${name}$`) }) }).first();
      await h.select(row('AccountService').locator('select.row-action'), 'deploy');
      await h.select(row('Report_Builder').locator('select.row-action'), 'deploy');
      await h.select(row('Finance_Read').locator('select.row-action'), 'deploy');
      await h.press(
        h.page
          .locator('.group-head', { has: h.page.locator('.group-toggle b', { hasText: /^AuraDefinitionBundle$/ }) })
          .locator('button', { hasText: '+ All to package' })
      );
      await h.pause(1500);
      // What goes in, file by file, then the same validate and deploy as everywhere
      await h.say('What goes in, file by file');
      await h.press(h.page.locator('.package-contents button', { hasText: 'AccountService' }).first());
      await h.settle();
      await h.pause(2200);
      await h.say('Find the tests that reach it, then validate in B');
      await h.click('Find dependent tests');
      await h.until('test class(es) found');
      await validate(h, 'acme-dev');
      await h.pause(2000);
    },
  },
  {
    name: 'orgaccess',
    intro: 'Compare & Deploy › Compare access: users and permissions in two orgs',
    hash: 'orgaccess',
    run: async (h) => {
      await h.say('Choose the other org');
      await h.select(h.page.locator('.pane-body select').nth(1), 'acme-dev');
      await h.pause(2000);
      await h.say('The same user in both orgs: what differs');
      await h.click('Find a user');
      await h.pause(1200);
      await h.type(h.page.locator('.pane-body input[type=text], .pane-body input:not([type])').first(), 'Ann');
      await h.page.keyboard.press('Enter');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'orgapps',
    intro: 'Compare & Deploy › Compare apps: the connected apps of two orgs',
    hash: 'orgapps',
    run: async (h) => {
      await h.say('Choose the other org: the apps of both, side by side');
      await h.select(
        h.page
          .locator('.pane-body select')
          .filter({ has: h.page.locator('option', { hasText: 'Choose the other org' }) })
          .first(),
        'acme-dev'
      );
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'settings',
    intro: 'Settings › Orgs: the orgs you are logged in to',
    hash: 'settings',
    run: async (h) => {
      await h.say('Each org: its type, your user, and a button to open it');
      await h.settle();
      await h.pause(2400);
    },
  },
  {
    name: 'settingsai',
    hash: 'settingsai',
    init: () => {
      window.__nomadsfDemoAiForm = true;
    },
    intro: 'Settings › AI: connect your own AI for the ✦ buttons (optional)',
    run: async (h) => {
      await h.until('Provider');
      await h.say('The key stays in the extension, and goes only to the provider you choose');
      const provider = h.page.locator('.pane-body label', { hasText: 'Provider' }).locator('select').first();
      const shown = [
        ['Anthropic', 'Anthropic Claude: a model and your API key'],
        ['OpenAI', 'OpenAI'],
        ['Gemini', 'Google Gemini'],
        ['Mistral', 'Mistral'],
        ['Groq', 'Groq'],
        ['OpenRouter', 'OpenRouter: a key, or sign in with OpenRouter'],
        ['GitHub', 'GitHub Models: a GitHub token with “Models: read”'],
        ['Ollama', 'Ollama: a model on your own computer — no key'],
        ['Custom', 'Any OpenAI-format endpoint: its address, and a key if it needs one'],
      ];
      for (const [name, text] of shown) {
        const label = await provider
          .locator('option', { hasText: name })
          .first()
          .textContent()
          .catch(() => null);
        if (!label) continue;
        await h.say(text, 600);
        await h.select(provider, label);
        await h.pause(1600);
      }
      await h.say('Connect and test: one small call checks it works, then every ✦ button can use it');
    },
  },
  {
    name: 'settingsproject',
    hash: 'settingsproject',
    folder: true,
    intro: 'Settings › Project: the Salesforce project every page uses',
    run: async (h) => {
      await h.say('Choose the project folder (the repository with sfdx-project.json)');
      await h.click('Choose project folder…');
      await h.settle();
      await h.pause(1200);
      await h.say('Its components, counted by type — read only, nothing is written');
      await h.pause(1600);
      await h.say('In VS Code, the open workspace is the project: nothing to choose');
      await h.pause(1200);
    },
  },
  {
    name: 'messages',
    intro: 'Messages: what went wrong says why, next to what started it — and in the Log',
    problems: /Salry__c|No such column/i,
    hash: 'query',
    run: async (h) => {
      await h.say('A typo in a field name…');
      await h.code('SELECT Name, Salry__c FROM Contact');
      await h.page.keyboard.press('Escape');
      await h.click('Run');
      await h.settle();
      await h.pause(1600);
      await h.say('…the message says which field; fixed, it runs');
      await h.code('SELECT Name, Salary__c FROM Contact ORDER BY Salary__c DESC');
      await h.page.keyboard.press('Escape');
      await h.click('Run');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'eventlogs',
    intro: 'Security › Event logs: the org’s event log files, or CSV files, as tables',
    hash: 'eventlogs',
    run: async (h) => {
      // The demo org has no event log files (scratch orgs never do): the page says so; then CSV files of the same
      // kind, made up for the demo (tools/demo/event-logs), as they come from an org with Event Monitoring
      await h.say('A scratch org keeps no event log files — the page says so');
      await h.settle();
      await h.pause(2200);
      await h.say('Open CSV files from an org with Event Monitoring');
      await h.press(h.page.locator('button.tab', { hasText: 'Open CSV files' }));
      await h.pause(800);
      const files = (name) => fileURLToPath(new URL(`./event-logs/${name}`, import.meta.url));
      await h.press(h.page.locator('label.file-button', { hasText: 'Choose CSV files' }));
      await h.page.keyboard.press('Escape');
      await h.page.locator('input[type=file]').setInputFiles(files('Login-2026-11-09_10.csv'));
      await h.settle();
      await h.pause(2200);
      await h.say('Summaries: by user, by IP, by what was used');
      await h.press(h.page.locator('.table-tabs button, [role=tab]', { hasText: /^By user/ }).first());
      await h.pause(1800);
      await h.page.locator('input[type=file]').setInputFiles(files('ApexExecution-2026-11-10.csv'));
      await h.settle();
      await h.press(h.page.locator('.table-tabs button, [role=tab]', { hasText: /^By what was used/ }).first());
      await h.pause(2200);
      await h.press(h.page.locator('.table-tabs button, [role=tab]', { hasText: /^Every event/ }).first());
      await h.pause(1800);
    },
  },
  {
    name: 'search',
    intro: 'Search (⌘K): say what you want to do — NomadSF opens the place',
    hash: 'query',
    run: async (h) => {
      // Say what you want to do: the place, on the right tab
      await h.pause(1000);
      await h.say('Kill a running batch? Type it');
      await h.press(h.page.locator('.header-search'));
      await h.type(h.page.locator('.quick-jump input'), 'kill the running batch');
      await h.pause(1600);
      await h.press(h.page.locator('.quick-jump li button').first());
      await h.settle();
      await h.pause(1800);
      await h.press(h.page.locator('.header-search'));
      await h.type(h.page.locator('.quick-jump input'), 'compare two profiles');
      await h.pause(1600);
      await h.press(h.page.locator('.quick-jump li button').first());
      await h.settle();
      await h.pause(1800);
      await h.press(h.page.locator('.header-search'));
      await h.type(h.page.locator('.quick-jump input'), 'why cant ann edit cases');
      await h.pause(2000);
      await h.page.keyboard.press('Enter');
      await h.settle();
      await h.pause(1800);
    },
  },
  {
    name: 'retrieve',
    intro: 'Retrieve into the project: the org’s version of some components into your folder',
    hash: 'settingsproject',
    folder: true,
    run: async (h) => {
      // The project folder, then the org's version of a few classes into it: shown file by file first
      await h.say('Choose the project folder');
      await h.click('Choose project folder…');
      await h.settle();
      await h.pause(1200);
      await h.say('Pick some classes in Metadata');
      await h.tab('Org', 'Metadata');
      await h.select(h.page.locator('.pane-body select:visible').first(), 'ApexClass');
      await h.until('InvoiceController', 90000);
      await h.pause(800);
      for (const name of ['AccountService', 'InvoiceService'])
        await h.press(h.row(name).locator('input[type=checkbox]'));
      await h.click(/^Add \d+ to package/);
      await h.pause(1200);
      await h.say('Retrieve into the project: shown file by file first');
      await h.click(/^Retrieve into project/);
      await h.click('Read from the org');
      await h.settle(120000);
      await h.pause(1500);
      await h.press(h.page.locator('.retrieve-into button.link').first());
      await h.pause(2500);
    },
  },
  {
    name: 'project',
    intro: 'Compare & Deploy › Project: your project folder against the org',
    hash: 'project',
    run: async (h) => {
      await h.settle();
      await h.pause(1600);
      await h.say('Compare with the org: choose the types');
      await h.click(/^Compare with/);
      await h.pause(1200);
      for (const type of ['ApexTrigger', 'PermissionSet', 'PermissionSetGroup'])
        await h.press(
          h.page
            .locator('label', { hasText: new RegExp(`^\\s*${type}\\b`) })
            .locator('input[type=checkbox]')
            .first()
        );
      await h.say('Same, different, only in the project, only in the org');
      await h.click(/^Compare \d+ types/);
      await h.settle(120000);
      await h.pause(1500);
      await h.say('Compare content: down to the files');
      await h.click(/^Compare content/);
      await h.settle(120000);
      await h.pause(1500);
      // The project's permission sets into the org, through the same panel as everywhere
      await h.say('Put the project’s permission sets in a package, and validate');
      await h.press(
        h.page
          .locator('.group-head', { has: h.page.locator('.group-toggle b', { hasText: /^PermissionSet$/ }) })
          .locator('button', { hasText: '+ All to package' })
      );
      await h.pause(1500);
      await validate(h);
      await h.pause(2000);
    },
  },
  {
    name: 'branchorg',
    intro: 'Compare & Deploy › Branch ↔ Org: a branch of the project against an org',
    hash: 'branchorg',
    folder: true,
    run: async (h) => {
      // A branch that is not checked out, against the org at the top
      await h.say('Open the project folder');
      await h.click('Open the project folder…');
      await h.until('Read the branch');
      await h.say('Any branch — not only the one checked out');
      await h.choose(h.page.locator('.compare-go select').first(), /feature\/vip-discount/);
      await h.click('Read the branch');
      await h.settle(120000);
      await h.pause(1200);
      await h.say('Choose the types, compare with the org');
      await h.pause(1200);
      await h.press(
        h.page
          .locator('label', { hasText: /^\s*ApexClass\b/ })
          .locator('input[type=checkbox]')
          .first()
      );
      await h.click(/^Compare (\d+ )?types?$/);
      await h.settle(120000);
      await h.pause(1500);
      await h.say('Down to the files — then deploy what differs');
      await h.click(/^Compare content/);
      await h.settle(120000);
      await h.pause(2500);
    },
  },
  {
    name: 'manifest',
    intro: 'Compare & Deploy › Check a manifest: a package.xml against an org',
    hash: 'manifest',
    folder: true,
    run: async (h) => {
      // A package.xml, its files from a branch, each checked against acme-uat
      await h.say('Open the project folder');
      await h.click('Open the project folder…');
      await h.until('The files come from');
      await h.say('Choose the package.xml');
      await h.page
        .locator('.compare-manifest input[type=file]')
        .first()
        .setInputFiles(fileURLToPath(new URL('./manifest/package.xml', import.meta.url)));
      await h.pause(800);
      await h.say('The branch its files come from, and the org to check against');
      await h.choose(h.page.locator('.compare-manifest select').first(), /feature\/vip-discount/);
      await h.say('Each component: same, different or missing in the org');
      await h.click('Read the manifest');
      await h.until(/component\(s\) from package\.xml/, 120000);
      await h.settle(120000);
      await h.pause(2500);
      await h.page.mouse.wheel(0, 500);
      await h.pause(2500);
    },
  },
  {
    name: 'package',
    intro: 'Compare & Deploy › Branch ↔ Branch: what a branch brings into another, as a package',
    hash: 'package',
    folder: true,
    run: async (h) => {
      await h.say('Open the project folder (read from git, nothing written)');
      await h.click('Open the project folder…');
      await h.until('Source — the branch with the changes');
      await h.say('Source: the branch with the changes; Target: where they go');
      await h.choose(h.page.locator('.compare-refs select').first(), /feature\/vip-discount/);
      await h.choose(h.page.locator('.compare-refs select').nth(1), /^main$/);
      await h.say('Like a pull request: added, changed, deleted');
      await h.click('Compare');
      await h.until('In the manifest:');
      await h.until('1 to delete');
      await h.settle();
      await h.pause(1200);
      await h.press(h.page.locator('.group-toggle', { hasText: 'ApexClass' }));
      await h.pause(1200);
      await h.say('Click a file: its difference — ✦ explained by AI if you like');
      await h.press(h.page.locator('button', { hasText: 'classes/AccountService.cls' }).first());
      await h.until('Explain the difference');
      await h.pause(1800);
      await h.say('Find the tests that reach it, then validate');
      await h.click('Find dependent tests');
      await h.until('test class(es) found');
      await h.pause(1000);
      await validate(h);
      await h.pause(1500);
    },
  },
  {
    name: 'aireview',
    intro: '✦ Review: the AI reads a class and says what could go wrong',
    hash: 'code',
    ai: { any: REVIEW },
    run: async (h) => {
      await h.type(h.page.locator('input[placeholder^="Filter"]').first(), 'Invoice');
      await h.press(h.page.locator('.pane-body li button', { hasText: /^InvoiceService/ }).first());
      await h.until('owedByAccount');
      await h.pause(800);
      await h.say('✦ Review: what could go wrong, and how to fix it');
      await h.click('Review');
      // The answer, formatted (a thinking model takes a while)
      await h.waiting(() => h.page.locator('.ai-reply .md').first().waitFor({ timeout: 300000 }));
      await h.pause(2500);
    },
  },
  {
    name: 'aiwrite',
    intro: '✦ Write: describe a new component, the AI writes it, you deploy it',
    hash: 'code',
    ai: { any: '```json\n' + JSON.stringify(TRIGGER, null, 2) + '\n```' },
    run: async (h) => {
      await h.click('Other metadata');
      await h.pause(800);
      await h.type(h.page.locator('.pane-body .combo input').first(), 'ApexTrigger');
      await h.page.keyboard.press('Enter');
      await h.settle();
      await h.pause(800);
      await h.say('Describe the trigger you need');
      await h.type(
        h.page.locator('input[placeholder^="✦ Describe a new"]'),
        'A trigger on Invoice__c that marks sent invoices past their due date as Overdue'
      );
      await h.click(/^✦ Write the ApexTrigger/);
      await h.until('Written by AI', 300000);
      await h.pause(1500);
      await h.say('Read what it wrote, then validate it with its tests');
      await h.click('Create / deploy…');
      await h.click('Find dependent tests');
      await h.until('test class(es) found');
      await validate(h);
      await h.pause(1500);
    },
  },
  {
    name: 'othermeta',
    intro: 'Develop › Code › Other metadata: any type, edited and deployed',
    hash: 'code',
    run: async (h) => {
      await h.click('Other metadata');
      await h.pause(800);
      await h.say('Choose any metadata type');
      await h.type(h.page.locator('.pane-body .combo input').first(), 'PermissionSet');
      await h.page.keyboard.press('Enter');
      await h.page.keyboard.press('Escape');
      await h.settle();
      await h.type(h.page.locator('input[placeholder^="Filter"]').last(), 'Invoice');
      await h.press(h.page.locator('.code-list li button', { hasText: /^Invoice_Viewer/ }).first());
      await h.until('Reads invoices.');
      await h.settle();
      await h.pause(1000);
      // A change in the editor: saved only by deploying it
      await h.say('Change it in the editor — saved only by deploying it');
      await h.press(h.page.locator('.monaco-editor .view-line', { hasText: 'Reads invoices.' }).first());
      await h.page.keyboard.press('End');
      for (let i = 0; i < '</description>'.length; i++) await h.page.keyboard.press('ArrowLeft');
      await h.page.keyboard.type(' Shown on the account page.', { delay: 40 });
      await h.until('edited here only');
      await h.pause(1200);
      await h.click(/^Save 1 edited file/);
      await validate(h);
      await h.until('Validated on acme-uat');
      await h.pause(1500);
    },
  },
  // ---------- new tools ----------
  {
    name: 'codechecks',
    hash: 'codechecks',
    intro: 'Develop › Code checks: well-known mistakes in the code, each with why and how to fix it',
    run: async (h) => {
      await h.say('The org’s Apex, triggers, Visualforce, LWC and Aura — or the project’s');
      await h.click('Check');
      await h.until(/file\(s\) checked/, 180000);
      await h.settle();
      await h.say('High, Medium, Low: injection, XSS, secrets, sharing, access checks, loops');
      await h.pause(800);
      await h.press(h.page.locator('table tbody tr').first());
      await h.say('Click one: the line, why it matters, and the fix');
      await h.look(h.page.locator('.check-detail'));
      await h.pause(1600);
    },
  },
  {
    name: 'customsettings',
    hash: 'customsettings',
    intro: 'Data › Custom settings: their values — edit, add, delete — and new custom settings',
    run: async (h) => {
      const pick = h.page.locator('.pane-body label', { hasText: 'Custom setting' }).locator('select');
      await pick.waitFor({ timeout: 60000 });
      await h.say('Choose a custom setting: a hierarchy one has a value per level');
      await h.choose(pick, /Integration_Settings__c/);
      await h.until('Organization');
      await h.settle();
      await h.pause(1000);
      await h.say('Add a level for one profile, with its own value');
      await h.click('+ Add a level');
      await h.press(h.page.locator('.setting-edit .segmented button', { hasText: 'A profile' }));
      await h.pause(1500);
      await h.choose(h.page.locator('.setting-edit select').first(), /^Standard User$/);
      await h.type(
        h.page.locator('.setting-edit input:not([type=checkbox])').last(),
        'https://billing-test.example.com'
      );
      await h.click('Save…');
      await h.confirm('acme-uat');
      await h.until('Profile: Standard User');
      await h.settle();
      await h.pause(1400);
      await h.say('Delete it again — every change asks for the org’s name');
      await h.press(
        h.page.locator('tr', { hasText: 'Profile: Standard User' }).locator('button', { hasText: 'Delete' })
      );
      await h.confirm('acme-uat');
      await h.until('Deleted');
      await h.settle();
      await h.say('+ New custom setting: its label, kind and fields, deployed in one go');
      await h.click('+ New custom setting');
      await h.type(h.page.locator('input[placeholder="e.g. Billing Settings"]'), 'Shipping Settings');
      await h.type(h.page.locator('input[placeholder="Label, e.g. Endpoint"]').first(), 'Carrier endpoint');
      await h.pause(1600);
    },
  },
  {
    name: 'bulkaccess',
    hash: 'bulkaccess',
    intro: 'Access › Assign in bulk: permission sets, groups and queues — to or from many users at once',
    run: async (h) => {
      await h.say('The users: by name, username, profile, role, a query or a file');
      await h.press(h.page.locator('.segmented button', { hasText: 'By a query' }));
      await h.type(h.page.locator('input.mono'), "Name IN ('Bob Ray')");
      await h.click('Find');
      await h.until('active user(s) found');
      await h.say('What to give: any number of permission sets, groups and queues');
      await h.type(h.page.locator('input[placeholder^="Find permission sets"]'), 'Report Builder');
      await h.press(h.page.locator('.bulk-pick .chip', { hasText: /^\+ Report Builder$/ }).first());
      await h.press(h.page.locator('.segmented button', { hasText: /^Public groups/ }));
      await h.type(h.page.locator('input[placeholder^="Find public groups"]'), 'Sales Leads');
      await h.press(h.page.locator('.bulk-pick .chip', { hasText: /Sales Leads/ }).first());
      await h.say('Add them — one confirmation, then a line per user and item');
      await h.click(/^Add 2 to 1/);
      await h.confirm('acme-uat');
      await h.until(/added,/, 120000);
      await h.settle();
      await h.look(h.page.locator('table').last());
      await h.pause(1400);
      await h.say('Remove takes them back the same way');
      await h.click(/^Remove 2 from 1/);
      await h.confirm('acme-uat');
      await h.until(/removed,/, 120000);
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'integration',
    hash: 'integration',
    intro: 'Security › Integration check: why an integration fails — and what to do',
    run: async (h) => {
      await h.say('Choose the integration user, and its connected app');
      await h.type(h.page.locator('input[placeholder^="Integration user"]'), 'Integration User');
      await h.pause(1500);
      await h.choose(h.page.locator('.who-pick select, .who-pick .search-select-native').first(), /^Integration User/);
      await h.choose(
        h.page.locator('.pane-body label', { hasText: 'Connected app' }).locator('select'),
        /CPQ Integration/
      );
      await h.click('Check');
      await h.until(/problem|Nothing/, 60000);
      await h.settle();
      await h.say('The user, its API permission, its logins, the app, certificates and endpoints');
      await h.pause(1200);
      await h.say('Each problem says what to do: here, the user is not approved for the app');
      await h.look(h.page.locator('.finding.bad').first());
      await h.pause(1800);
    },
  },
  {
    name: 'flows',
    intro: 'Develop › Flows: old versions, old API versions, waiting and failed interviews',
    hash: 'flows',
    run: async (h) => {
      // An obsolete version of Invoice reminder (the active one and the newest draft are kept)
      await h.say('Old versions: the active one and the newest draft are kept');
      await h.until('Invoice_Reminder', 60000);
      await h.settle();
      await h.pause(1800);
      await h.say('Active flows on an old API version');
      await h.press(h.page.locator('button.tab', { hasText: /^Old API versions/ }));
      await h.until('Invoice_Reminder');
      await h.pause(1800);
      await h.say('Paused interviews, and failed runs');
      await h.press(h.page.locator('button.tab', { hasText: /^Waiting interviews/ }));
      await h.pause(1200);
      await h.press(h.page.locator('button.tab', { hasText: /^Failed runs/ }));
      await h.pause(1500);
      await h.press(h.page.locator('button.tab', { hasText: /^Old versions/ }));
      await h.pause(1200);
    },
  },
  {
    name: 'licenses',
    intro: 'Org › Licenses: how many are used, and who holds one without using it',
    hash: 'licenses',
    run: async (h) => {
      await h.until('rows', 60000);
      await h.settle();
      await h.pause(1200);
      await h.say('Click a license: its users');
      await h.press(h.row('Salesforce Platform'));
      await h.until(/users assigned this license|active users whose profile/);
      await h.pause(1600);
      await h.say('No login for 90 days: freeze or deactivate them');
      await h.press(h.page.locator('button.tab', { hasText: /^No login for/ }));
      await h.pause(1200);
      await h.press(h.row('Dina Patel'));
      await h.pause(1800);
      await h.say('Frozen but still holding a license');
      await h.press(h.page.locator('button.tab', { hasText: /^Frozen but active/ }));
      await h.pause(1000);
      await h.press(h.page.locator('button.tab', { hasText: /^Usage/ }));
      await h.pause(1000);
    },
  },
  {
    name: 'accesssets',
    intro: 'Access › Access sets: profiles, permission sets, groups and custom permissions',
    hash: 'permissions',
    run: async (h) => {
      // Everything listed; a permission set: what it allows, who has it, assigning it
      await h.say('Everything, as a table: click one to open it');
      await h.until('click one to open it', 60000);
      await h.pause(1400);
      await h.say('A permission set: what it allows');
      await h.press(h.page.locator('.segmented button', { hasText: /^Permission sets/ }));
      await h.pause(600);
      await h.choose(h.page.locator('.pane-body select.search-select-native').first(), /^Finance Read$/);
      await h.settle();
      await h.pause(1500);
      await h.press(h.page.locator('button.tab', { hasText: /^Field access/ }));
      await h.settle();
      await h.pause(1500);
      await h.say('Who has it — and assign it to more users');
      await h.press(h.page.locator('button.tab', { hasText: /^Assigned users/ }));
      await h.until('users with permission set');
      await h.pause(1500);
      await h.press(h.page.locator('button.tab', { hasText: /^Assign to users/ }));
      await h.pause(1400);
      // Custom permissions: who gives one, and who has it
      await h.say('Custom permissions: who gives one, and who has it');
      await h.press(h.page.locator('.segmented button', { hasText: /^Custom permissions/ }));
      await h.until('click one to open it');
      await h.pause(1000);
      await h.press(h.row('Approve Discounts'));
      await h.until('Given by');
      await h.pause(1500);
      await h.press(h.page.locator('button.tab', { hasText: /^Users/ }));
      await h.pause(1800);
    },
  },
  {
    name: 'secdash',
    intro: 'Security › Dashboard: the org’s security at a glance',
    hash: 'secdash',
    run: async (h) => {
      await h.say('Each tile is one small check');
      await h.until('Health Check', 60000);
      await h.settle();
      await h.pause(2200);
      await h.say('Click a tile: it opens the tool it comes from');
      await h.press(h.page.locator('.sec-tile', { hasText: 'Setup changes' }).first());
      await h.settle();
      await h.pause(2200);
    },
  },
  {
    name: 'timeline',
    intro: 'Security › Timeline: everything that happened, in one list',
    hash: 'timeline',
    run: async (h) => {
      await h.say('Setup changes, logins, components and NomadSF — one list');
      await h.click('Show');
      await h.until('rows', 120000);
      await h.settle();
      await h.pause(2200);
      await h.page.mouse.wheel(0, 500);
      await h.pause(1800);
    },
  },
  {
    name: 'whocansee',
    intro: 'Security › Who can see: what a user can do with a record, an object, a field or a class — and why',
    hash: 'whocansee',
    run: async (h) => {
      await h.say('Choose the user');
      await h.type(h.page.locator('input[placeholder^="User"]'), 'Dina Patel');
      await h.pause(1500);
      const pick = h.page.locator('.who-pick select, .who-pick .search-select-native').first();
      await h.choose(pick, /Dina Patel/);
      // A record found by its name in an object
      await h.say('A record: choose its object, type part of its name');
      await h.click('A record');
      const object = h.page.locator('input[placeholder^="Object"]').first();
      await h.type(object, 'Invoice__c');
      await h.page.keyboard.press('Escape');
      await h.type(h.page.locator('input[placeholder*="a name, an Id"]'), 'INV-000');
      await h.pause(2500);
      const records = h.page.locator('.pane-body .form').nth(2).locator('select').first();
      await h.choose(records, /INV-0002/);
      await h.click('Check');
      await h.until(/Why/, 60000);
      await h.settle();
      await h.pause(2500);
      // Without a record: the object, then a class
      await h.say('An object: create, read, edit, delete — and from where');
      await h.click('An object');
      await h.click('Check');
      await h.until(/Modify all/, 60000);
      await h.settle();
      await h.pause(2200);
      await h.say('A class, page or custom permission: who gives it');
      await h.click('A class, page or permission');
      await h.type(h.page.locator('input[placeholder="Name"]'), 'InvoiceService');
      await h.page.keyboard.press('Escape');
      await h.click('Check');
      await h.until(/Can run/, 60000);
      await h.settle();
      await h.pause(2200);
    },
  },
  {
    name: 'sharing',
    intro: 'Security › Sharing: how an object’s records are shared, as a tree',
    hash: 'sharing',
    run: async (h) => {
      await h.type(h.page.locator('input[placeholder^="Object"]'), 'Invoice__c');
      await h.say('Defaults, the role hierarchy, then each sharing rule');
      await h.click('Show');
      await h.until('Private', 120000);
      await h.settle();
      await h.pause(2200);
      await h.say('The same as a table');
      await h.press(h.page.locator('button.tab', { hasText: /^Table/ }).first());
      await h.pause(2000);
    },
  },
  {
    name: 'restore',
    intro: 'Data › Backup › Restore: what changed since a backup, put back',
    hash: 'backup',
    folder: true,
    run: async (h) => {
      // A backup, then someone changes an account: Restore finds it and puts it back
      await h.say('Back up the accounts…');
      await h.type(h.page.locator('.pane-body input:not([type=checkbox]):not([type=file])').first(), 'Accounts');
      await h.pickObject('Account');
      await h.click('Settings');
      await h.click('Choose folder…');
      await h.click('Back up now');
      await h.until('last: ✓', 300000);
      await h.settle();
      await h.say('…then someone changes one');
      const acct = (await soql('acme-uat', "SELECT Id, Phone FROM Account WHERE Name = 'Globex' LIMIT 1"))[0];
      await update('acme-uat', 'Account', acct.Id, { Phone: '+61 2 9000 0000' });
      await h.click('Backups & restore');
      await h.settle();
      await h.pause(1400);
      await h.say('Compare the backup with the org: what changed');
      await h.click('Compare with the org');
      await h.until('changed since the backup', 180000);
      await h.settle();
      await h.pause(1500);
      await h.press(h.page.locator('table tbody input[type=checkbox]').first());
      await h.say('Tick it and put it back');
      await h.click('Put back 1 value…');
      await h.confirm('acme-uat');
      await h.until('Put back 1', 120000).catch(() => {});
      await h.settle();
      await h.pause(1800);
    },
  },
  {
    name: 'files',
    intro: 'Compare & Deploy › Open a file: a snapshot, workbook, CSV or package.xml next to the org',
    hash: 'access',
    run: async (h) => {
      // A user's snapshot from acme-uat, opened next to acme-dev: what differs there
      await h.say('Save a user’s snapshot in one org…');
      await h.type(h.page.locator('input[placeholder^="Name, username"]'), 'Dina');
      await h.page.keyboard.press('Enter');
      await h.until('Dina Patel');
      await h.press(h.page.locator('.pane-body li, .pane-body tr', { hasText: 'Dina Patel' }).first());
      await h.settle();
      const [download] = await Promise.all([h.page.waitForEvent('download'), h.click('Snapshot (CSV)')]);
      const snapshot = join(files, 'dina-snapshot.csv');
      await download.saveAs(snapshot);
      await h.pause(800);
      await h.say('…open it next to another org: NomadSF says what it is');
      await h.tab('Compare & Deploy', 'Open a file');
      await h.select(
        h.page.locator('header select').first(),
        await h.page.locator('header select option', { hasText: 'acme-dev' }).first().getAttribute('value')
      );
      await h.settle();
      await h.page.locator('label.file-button input').setInputFiles(snapshot);
      await h.until('A user snapshot');
      await h.settle();
      await h.pause(2500);
    },
  },
  {
    name: 'sandbox',
    intro: 'Compare & Deploy › Sandbox refresh: save what a refresh wipes, then put it back',
    hash: 'sandbox',
    run: async (h) => {
      // Before: the users to keep (a query) and everything else, in one workbook
      await h.say('Before the refresh: the users to keep, by a query');
      await h.press(h.page.locator('.segmented button', { hasText: 'By a query' }));
      await h.type(h.page.locator('input.mono').first(), "Name IN ('Dina Patel', 'Bob Ray')");
      await h.click('Add them all');
      await h.pause(1200);
      await h.say('Save the workbook: settings, jobs, sharing and users');
      const [download] = await Promise.all([
        h.page.waitForEvent('download', { timeout: 300000 }),
        h.click('Save the workbook'),
      ]);
      const workbook = join(files, 'before-refresh.xlsx');
      await download.saveAs(workbook);
      await h.until('Saved:');
      await h.pause(1800);
      // After, in another sandbox: what differs, what to put back (shown, not put back), its users
      await h.say('After the refresh, in the sandbox: open the workbook');
      await h.select(
        h.page.locator('header select').first(),
        await h.page.locator('header select option', { hasText: 'acme-dev' }).first().getAttribute('value')
      );
      await h.settle();
      await h.press(h.page.locator('button.tab', { hasText: /After the refresh/ }));
      await h.page.locator('label.file-button input').first().setInputFiles(workbook);
      await h.until(/to put back|Nothing left/, 240000);
      await h.settle();
      await h.pause(2200);
      await h.say('What differs — tick what to put back, change a value first');
      await h.page.mouse.wheel(0, 700);
      await h.pause(2000);
      await h.page.mouse.wheel(0, 900);
      await h.pause(2200);
      await h.say('And a checklist for what only Setup can do');
      await h.press(h.page.locator('button.tab', { hasText: /Setup checklist/ }));
      await h.pause(1800);
    },
  },
];
