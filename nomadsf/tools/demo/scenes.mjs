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

export const scenes = [
  {
    name: 'hubs',
    hash: 'code',
    run: async (h) => {
      await h.tab('Data', 'Query');
      await h.tab('Access', 'Users');
      await h.tab('Org', 'Org health');
      await h.tab('Org to org', 'Migrate');
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
    hash: 'query',
    run: async (h) => {
      await h.code('SELECT Name, Title, AccountId FROM Contact ORDER BY Name');
      await h.page.keyboard.press('Escape');
      await h.click('Run');
      await h.until('rows');
      await h.pause(1200);
      // Fields of the Account each AccountId points to, as new columns (once the Id columns are known)
      await h.page.getByText('Looking up names…').waitFor({ state: 'detached', timeout: 60000 });
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
      await h.click('Add to the query instead');
      await h.until('rows');
      await h.settle();
      await h.pause(1800);
    },
  },
  {
    name: 'code',
    hash: 'code',
    run: async (h) => {
      await h.type(h.page.locator('input[placeholder^="Filter"]').first(), 'CaseH');
      await h.press(h.page.locator('.pane-body li button', { hasText: /^CaseHandler/ }).first());
      await h.until('beforeInsert');
      await h.pause(1200);
      await h.click('Dependencies');
      await h.until('Used by');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'related',
    hash: 'record',
    run: async (h) => {
      const acme = await idOf('acme-uat', "SELECT Id FROM Account WHERE Name = 'Acme Corp' LIMIT 1");
      await h.type(h.page.locator('input[placeholder^="Record Id"]'), acme);
      await h.click('Show all data');
      await h.until('Open in Salesforce');
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
      await h.press(group('Contact').locator(':scope > label input'));
      await h.press(group('Case').locator(':scope > button', { hasText: '▸' }));
      await h.pause(1200);
      await h.press(group('Case').locator('li label input').first());
      await h.pause(600);
      await h.select(tree.locator('.copy-bar select'), 'acme-dev');
      // New names and e-mails: the people are not duplicates of acme-dev's own
      await h.press(tree.locator('.copy-bar label', { hasText: 'Mask personal data' }).locator('input'));
      await h.press(tree.locator('.copy-bar button', { hasText: /^Copy$/ }));
      await h.confirm('acme-dev');
      await h.until('created', 120000);
      await h.pause(1500);
      await h.click('Undo this copy');
      await h.confirm('acme-dev');
      await h.until('deleted', 120000);
    },
  },
  {
    name: 'record',
    hash: 'record',
    run: async (h) => {
      const acme = await idOf('acme-uat', "SELECT Id FROM Account WHERE Name = 'Acme Corp' LIMIT 1");
      await h.type(h.page.locator('input[placeholder^="Record Id"]'), acme);
      await h.click('Show all data');
      await h.until('Open in Salesforce');
      await h.pause(1000);
      await h.type(h.page.locator('input[placeholder="Filter fields and values"]'), 'tier');
      await h.pause(1200);
      await h.click('Edit');
      await h.select(h.page.locator('table.record select').first(), 'Gold');
      await h.pause(800);
      await h.click('Cancel');
      await h.page.locator('input[placeholder="Filter fields and values"]').fill('');
      await h.click('Me');
      await h.until('Log in as this user');
      await h.pause(1500);
    },
  },
  {
    name: 'history',
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
      await h.click('History');
      await h.until('Status');
      await h.settle();
      await h.pause(2200);
    },
  },
  {
    name: 'data-tool',
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
      await h.type(h.page.locator('input[placeholder="Account"], input[list]').first(), 'Account');
      await h.select(
        h.page
          .locator('select')
          .filter({ has: h.page.locator('option[value=update]') })
          .first(),
        'update'
      );
      await h.file(h.page.locator('input[type=file]:visible').first(), file);
      await h.settle();
      await h.pause(1600);
      await h.click('Run on');
      await h.confirm('acme-uat');
      await h.until('Succeeded', 120000);
      await h.pause(2000);
    },
  },
  {
    name: 'csvcompare',
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
      await h.file(h.page.locator('input[type=file]').first(), file);
      await h.pause(1200);
      await h.type(h.page.locator('input[placeholder="e.g. Contact"]'), 'Account');
      await h.page.keyboard.press('Tab');
      await h.settle();
      await h.pause(1600);
      await h.choose(h.page.locator('.pane-body select').first(), /Customer Number|Customer_Number__c/);
      await h.click('Compare');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'lookup',
    hash: 'lookup',
    run: async (h) => {
      const file = csv('order-lines.csv', [
        ['Order', 'Customer'],
        ['SO-1001', 'Globex'],
        ['SO-1002', 'Hooli'],
        ['SO-1003', 'Initech'],
        ['SO-1004', 'Wonka Foods'],
      ]);
      await h.file(h.page.locator('input[type=file]').first(), file);
      await h.pause(1500);
      await h.select(h.page.locator('.pane-body select').first(), 'Customer');
      await h.type(h.page.locator('input[placeholder="e.g. User"]'), 'Account');
      await h.page.keyboard.press('Tab');
      await h.pause(2000);
      await h.choose(h.page.locator('.pane-body select').nth(1), /Account Name|^Name/);
      await h.pause(1200);
      await h.click(/Look up \d+ value/);
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'schema',
    hash: 'schema',
    run: async (h) => {
      await h.type(h.page.locator('input[placeholder="Object, e.g. Account"]'), 'Account');
      await h.page.keyboard.press('Enter');
      await h.until('Fields (');
      await h.pause(1200);
      await h.press(h.page.getByText('Customer_Tier__c', { exact: true }).first());
      await h.pause(1800);
      await h.click('Relationships');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'fields',
    hash: 'fields',
    run: async (h) => {
      await h.type(h.page.locator('input[placeholder="Object, e.g. Account"]'), 'Account');
      await h.page.keyboard.press('Enter');
      await h.settle();
      await h.pause(1600);
      await h.click('Count all');
      await h.settle();
      await h.pause(1600);
      await h.press(h.page.getByText('Customer_Tier__c', { exact: true }).first());
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'apex',
    hash: 'apex',
    run: async (h) => {
      await h.code(
        "Integer gold = [SELECT COUNT() FROM Account WHERE Customer_Tier__c = 'Gold'];\nSystem.debug('Gold customers: ' + gold);"
      );
      await h.page.keyboard.press('Escape');
      await h.click(/^Execute ⌘/);
      await h.confirm('acme-uat');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'apextests',
    hash: 'apextests',
    run: async (h) => {
      for (const name of ['AccountServiceTest', 'CaseHandlerTest'])
        await h.press(h.page.locator('tr', { hasText: name }).locator('input[type=checkbox]'));
      await h.click('Run selected');
      await h.confirm('acme-uat').catch(() => {});
      await h.until('Passed', 180000).catch(() => {});
      await h.settle();
      await h.pause(1600);
      await h.click('Code coverage');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'logs',
    hash: 'logs',
    run: async (h) => {
      await h.click('On 30 min');
      await h.confirm('acme-uat').catch(() => {});
      await h.settle();
      await h.pause(1600);
      await h.click('Refresh');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'jobs',
    hash: 'jobs',
    run: async (h) => {
      await h.pause(1500);
      await h.click('Background Apex');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'automation',
    hash: 'automation',
    run: async (h) => {
      // From the empty page: choose an object, then read what runs when one is saved
      await h.pause(1500);
      await h.type(h.page.locator('input[placeholder="Object, e.g. Case"]'), 'Opportunity');
      await h.page.keyboard.press('Enter');
      await h.until('OpportunityTrigger', 60000);
      await h.until('Amount_Required_When_Won');
      await h.settle();
      await h.pause(2000);
      await h.click(/^Table/);
      await h.pause(1800);
      await h.click(/^Order of a save/);
      await h.type(h.page.locator('input[placeholder="Name contains…"]'), 'Amount');
      await h.pause(1800);
    },
  },
  {
    name: 'events',
    hash: 'events',
    run: async (h) => {
      await h.click('Listen');
      await h.until('Listening on');
      await h.pause(1500);
      // Someone changes an account: its change event arrives
      const hooli = await idOf('acme-uat', "SELECT Id FROM Account WHERE Name = 'Hooli' LIMIT 1");
      await update('acme-uat', 'Account', hooli, { Phone: `+61 2 5550 ${Math.floor(1000 + Math.random() * 8999)}` });
      const row = h.page.locator('tr', { hasText: '/data/ChangeEvents' }).first();
      await h.waiting(() => row.waitFor({ timeout: 60000 }));
      await h.pause(1000);
      await h.press(row);
      await h.until('ChangeEventHeader');
      await h.pause(2200);
    },
  },
  {
    name: 'rest',
    hash: 'rest',
    run: async (h) => {
      const path = h.page.locator('.pane-body input:not([type=checkbox]):not([type=file])').first();
      await h.press(path);
      await path.fill('');
      await path.pressSequentially('/services/data/vXX.X/sobjects/Account/describe', { delay: 35 });
      await h.click('Send');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'metadata',
    hash: 'metadata',
    run: async (h) => {
      await h.select(h.page.locator('.pane-body select').first(), 'ApexClass');
      await h.until('InvoiceController', 90000);
      await h.pause(800);
      for (const name of ['InvoiceController', 'InvoiceService', 'InvoiceServiceTest'])
        await h.press(h.row(name).locator('input[type=checkbox]'));
      await h.click(/^Add \d+ to package/);
      await h.pause(1500);
      await h.press(h.page.locator('.package-contents button', { hasText: 'InvoiceService' }).first());
      await h.settle();
      await h.pause(1800);
      // Into the other org: validate, then quick deploy the validation (no second test run)
      await h.select(h.page.locator('.release-panel select').first(), 'acme-dev');
      await h.select(h.page.locator('.release-panel select').nth(1), 'RunSpecifiedTests');
      await h.type(h.page.locator('.release-panel textarea'), 'InvoiceServiceTest');
      await validate(h, 'acme-dev');
      await h.pause(1200);
      await h.click('Quick deploy (no second test run)');
      await h.confirm('acme-dev');
      await h.until(/Deploy (Succeeded|Failed)/, 300000);
      await h.until('✓ Deploy Succeeded', 5000);
      await h.settle();
      await h.pause(2000);
    },
  },
  {
    name: 'deployments',
    hash: 'deployments',
    run: async (h) => {
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'access',
    hash: 'access',
    run: async (h) => {
      await h.type(h.page.locator('input[placeholder="Name, username, email or user Id"]'), 'Ann');
      await h.click('Find');
      await h.until('Sales Manager');
      await h.pause(1200);
      await h.click('Permission sets & groups');
      await h.pause(2000);
      await h.click('System permissions');
      await h.pause(2000);
      await h.click('Everything (workbook)');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'permsets',
    hash: 'permsets',
    run: async (h) => {
      await h.settle();
      await h.pause(1000);
      // One table, a box per kind: open the groups, then one group's users
      await h.press(h.page.getByText('Permission set group', { exact: true }));
      await h.pause(1000);
      await h.press(h.page.locator('td', { hasText: /^Finance Team$/ }).first());
      await h.until('Dina Patel');
      await h.settle();
      await h.pause(1500);
      await h.click('Assign to users');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'permedit',
    hash: 'permissions',
    run: async (h) => {
      await h.pause(1500);
      await h.choose(
        h.page
          .locator('.pane-body select')
          .filter({ has: h.page.locator('option', { hasText: 'Sales Ops' }) })
          .first(),
        /Sales Ops/
      );
      await h.settle();
      await h.pause(1600);
      await h.click(/^Edit/);
      await h.settle();
      await h.pause(1600);
      await h.click('Cancel');
      await h.pause(1000);
    },
  },
  {
    name: 'groups',
    hash: 'groups',
    run: async (h) => {
      await h.until('Tier 1 Support', 60000);
      await h.pause(800);
      await h.press(h.row('Tier 1 Support'));
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'who',
    hash: 'assigned',
    run: async (h) => {
      await h.pause(1500);
      await h.choose(
        h.page
          .locator('.pane-body select')
          .filter({ has: h.page.locator('option', { hasText: 'Sales Ops' }) })
          .first(),
        /Sales Ops/
      );
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'objectaccess',
    hash: 'objectaccess',
    run: async (h) => {
      await h.pause(1500);
      await h.select(h.page.locator('.pane-body select').nth(0), 'Contact');
      await h.pause(1500);
      await h.select(h.page.locator('.pane-body select').nth(1), 'Salary__c');
      await h.click('Show who');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'accessmap',
    hash: 'accessmap',
    run: async (h) => {
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'compare',
    hash: 'compare',
    run: async (h) => {
      const users = h.page.locator('input[placeholder="Name, username or email"]');
      await h.type(users.first(), 'Ann');
      await h.pause(1500);
      await h.choose(
        h.page
          .locator('.pane-body select')
          .filter({ has: h.page.locator('option', { hasText: 'Ann Lee' }) })
          .first(),
        /Ann Lee/
      );
      await h.type(users.last(), 'Bob');
      await h.pause(1500);
      await h.choose(
        h.page
          .locator('.pane-body select')
          .filter({ has: h.page.locator('option', { hasText: 'Bob Ray' }) })
          .first(),
        /Bob Ray/
      );
      await h.click('Compare');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'myaccess',
    hash: 'myaccess',
    run: async (h) => {
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'company',
    hash: 'company',
    run: async (h) => {
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'health',
    hash: 'health',
    run: async (h) => {
      await h.settle();
      await h.pause(1600);
      await h.click('Licenses');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'limits',
    hash: 'limits',
    run: async (h) => {
      await h.pause(2000);
      await h.click('Storage');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'apps',
    hash: 'apps',
    run: async (h) => {
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'audit',
    hash: 'audit',
    run: async (h) => {
      await h.click('Load');
      await h.settle();
      await h.pause(1600);
      await h.click('Setup audit trail');
      await h.pause(1000);
      await h.click('Load');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'activity',
    hash: 'record',
    run: async (h) => {
      // Two changes first (a record, a test run), then where they are listed
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
      await h.tab('Org', 'Activity');
      await h.until('record update');
      await h.settle();
      await h.pause(2200);
    },
  },
  {
    name: 'backup',
    hash: 'backup',
    folder: true,
    run: async (h) => {
      // A new backup is already open as a draft: name, objects, a folder, then a real backup into it
      await h.type(
        h.page.locator('.pane-body input:not([type=checkbox]):not([type=file])').first(),
        'Customers nightly'
      );
      await h.pause(800);
      for (const name of ['Account', 'Contact', 'Invoice']) await h.pickObject(name);
      await h.click('Count records');
      await h.until('records in 3 objects', 120000);
      await h.settle();
      await h.pause(1400);
      await h.click('Settings');
      await h.pause(1000);
      await h.click('Choose folder…');
      await h.pause(1200);
      await h.click('Back up now');
      await h.until('last: ✓', 300000);
      await h.settle();
      await h.pause(1200);
      await h.click('Backups & restore');
      await h.settle();
      await h.pause(2200);
    },
  },
  {
    name: 'lifecycle',
    hash: 'lifecycle',
    run: async (h) => {
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'migrate',
    hash: 'migrate',
    run: async (h) => {
      await h.select(
        h.page
          .locator('.pane-body select')
          .filter({ has: h.page.locator('option', { hasText: 'Choose the other org' }) })
          .first(),
        'acme-dev'
      );
      await h.settle();
      await h.pause(1600);
      await h.pickObject('Account');
      await h.pause(1500);
      await h.click('+ Children…');
      await h.settle();
      await h.pause(1600);
      const child = h.page.locator('label.child-row', { has: h.page.locator('.mono', { hasText: /^Contact$/ }) });
      await child.scrollIntoViewIfNeeded();
      await h.press(child.locator('input[type=checkbox]'));
      await h.click(/^Add \d+ as Related only/);
      await h.pause(1500);
      await h.click('Check plan');
      await h.until('ready to copy', 120000);
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'orgdiff',
    hash: 'orgdiff',
    run: async (h) => {
      await h.select(
        h.page
          .locator('.pane-body select')
          .filter({ has: h.page.locator('option', { hasText: 'Choose the other org' }) })
          .first(),
        'acme-dev'
      );
      await h.settle();
      await h.pause(1000);
      // A few types, compared down to their files
      await h.click('None');
      for (const type of ['ApexClass', 'AuraDefinitionBundle', 'PermissionSet', 'PermissionSetGroup'])
        await h.press(
          h.page
            .locator('label', { hasText: new RegExp(`^\\s*${type}\\s*$`) })
            .locator('input[type=checkbox]')
            .first()
        );
      await h.click(/^Compare \d+ type/);
      await h.settle(300000);
      await h.pause(1000);
      await h.click(/^Compare content of \d+ in both/);
      await h.until('Content compared', 300000);
      await h.settle(300000);
      await h.pause(1500);
      // A box per type; a choice per row, or for the whole type
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
      await h.press(h.page.locator('.package-contents button', { hasText: 'AccountService' }).first());
      await h.settle();
      await h.pause(2200);
      await h.click('Find dependent tests');
      await h.until('test class(es) found');
      await validate(h, 'acme-dev');
      await h.pause(2000);
    },
  },
  {
    name: 'orgaccess',
    hash: 'orgaccess',
    run: async (h) => {
      await h.select(h.page.locator('.pane-body select').nth(1), 'acme-dev');
      await h.pause(2000);
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
    hash: 'orgapps',
    run: async (h) => {
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
    hash: 'settings',
    run: async (h) => {
      await h.settle();
      await h.pause(1600);
      await h.tab('Settings', 'AI');
      await h.pause(1600);
      await h.tab('Settings', 'Project');
      await h.settle();
      await h.pause(1800);
    },
  },
  {
    name: 'messages',
    problems: /Salry__c|No such column/i,
    hash: 'query',
    run: async (h) => {
      await h.code('SELECT Name, Salry__c FROM Contact');
      await h.page.keyboard.press('Escape');
      await h.click('Run');
      await h.settle();
      await h.pause(1600);
      await h.code('SELECT Name, Salary__c FROM Contact ORDER BY Salary__c DESC');
      await h.page.keyboard.press('Escape');
      await h.click('Run');
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'project',
    hash: 'project',
    run: async (h) => {
      await h.settle();
      await h.pause(1600);
      await h.click(/^Compare with/);
      await h.pause(1200);
      for (const type of ['ApexTrigger', 'PermissionSet', 'PermissionSetGroup'])
        await h.press(
          h.page
            .locator('label', { hasText: new RegExp(`^\\s*${type}\\b`) })
            .locator('input[type=checkbox]')
            .first()
        );
      await h.click(/^Compare \d+ types/);
      await h.settle(120000);
      await h.pause(1500);
      await h.click(/^Compare content/);
      await h.settle(120000);
      await h.pause(1500);
      // The project's permission sets into the org, through the same panel as everywhere
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
    name: 'package',
    hash: 'package',
    folder: true,
    run: async (h) => {
      await h.click('Open the project folder…');
      await h.until('Source — the branch with the changes');
      await h.choose(h.page.locator('.compare-refs select').first(), /feature\/vip-discount/);
      await h.choose(h.page.locator('.compare-refs select').nth(1), /^main$/);
      await h.click('Compare');
      await h.until('2 · Package');
      await h.until('1 to delete');
      await h.settle();
      await h.pause(1200);
      await h.press(h.page.locator('.group-toggle', { hasText: 'ApexClass' }));
      await h.pause(1200);
      await h.press(h.page.locator('button', { hasText: 'classes/AccountService.cls' }).first());
      await h.until('Explain the difference');
      await h.pause(1800);
      await h.click('Find dependent tests');
      await h.until('test class(es) found');
      await h.pause(1000);
      await validate(h);
      await h.pause(1500);
    },
  },
  {
    name: 'aireview',
    hash: 'code',
    ai: { any: REVIEW },
    run: async (h) => {
      await h.type(h.page.locator('input[placeholder^="Filter"]').first(), 'Invoice');
      await h.press(h.page.locator('.pane-body li button', { hasText: /^InvoiceService/ }).first());
      await h.until('owedByAccount');
      await h.pause(800);
      await h.click('Review');
      // The answer, formatted (a thinking model takes a while)
      await h.waiting(() => h.page.locator('.ai-reply .md').first().waitFor({ timeout: 300000 }));
      await h.pause(2500);
    },
  },
  {
    name: 'aiwrite',
    hash: 'code',
    ai: { any: '```json\n' + JSON.stringify(TRIGGER, null, 2) + '\n```' },
    run: async (h) => {
      await h.click('Other metadata');
      await h.pause(800);
      await h.type(h.page.locator('.pane-body input[list]').first(), 'ApexTrigger');
      await h.page.keyboard.press('Enter');
      await h.settle();
      await h.pause(800);
      await h.type(
        h.page.locator('input[placeholder^="✦ Describe a new"]'),
        'A trigger on Invoice__c that marks sent invoices past their due date as Overdue'
      );
      await h.click(/^✦ Write the ApexTrigger/);
      await h.until('Written by AI', 300000);
      await h.pause(1500);
      await h.click('Create / deploy…');
      await h.click('Find dependent tests');
      await h.until('test class(es) found');
      await validate(h);
      await h.pause(1500);
    },
  },
  {
    name: 'othermeta',
    hash: 'code',
    run: async (h) => {
      await h.click('Other metadata');
      await h.pause(800);
      await h.type(h.page.locator('.pane-body input[list]').first(), 'PermissionSet');
      await h.page.keyboard.press('Enter');
      await h.settle();
      await h.type(h.page.locator('input[placeholder^="Filter"]').last(), 'Invoice');
      await h.press(h.page.locator('.code-list li button', { hasText: /^Invoice_Viewer/ }).first());
      await h.until('Reads invoices.');
      await h.settle();
      await h.pause(1000);
      // A change in the editor: saved only by deploying it
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
];
