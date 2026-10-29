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
const csv = (name, rows) => {
  const path = join(files, name);
  writeFileSync(path, rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'));
  return path;
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
      await h.code('SELECT Name, Industry, Customer_Tier__c, AnnualRevenue FROM Account ORDER BY AnnualRevenue DESC');
      await h.page.keyboard.press('Escape');
      await h.click('Run');
      await h.until('rows');
      await h.pause(1200);
      await h.type(h.page.locator('.dt-filter').first(), 'Tech');
      await h.pause(1500);
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
      await h.click('Me');
      await h.until('Log in as this user');
      await h.pause(1500);
    },
  },
  {
    name: 'history',
    hash: 'record',
    run: async (h) => {
      const acme = await idOf('acme-uat', "SELECT Id FROM Account WHERE Name = 'Globex' LIMIT 1");
      await h.type(h.page.locator('input[placeholder^="Record Id"]'), acme);
      await h.click('Show all data');
      await h.until('Open in Salesforce');
      await h.click('History');
      await h.settle();
      await h.pause(1600);
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
      await h.type(h.page.locator('input[placeholder="Object, e.g. Case"]'), 'Case');
      await h.page.keyboard.press('Enter');
      await h.until('CaseTrigger', 60000);
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'events',
    hash: 'events',
    run: async (h) => {
      await h.click('Listen');
      await h.settle();
      await h.pause(1600);
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
      await h.until('AccountService', 90000);
      await h.pause(800);
      for (const name of ['AccountService', 'CaseHandler']) await h.press(h.row(name).locator('input[type=checkbox]'));
      await h.click(/^Add \d+ to package/);
      await h.pause(1500);
      await h.press(h.page.locator('tr', { hasText: 'CaseHandler' }).last());
      await h.settle();
      await h.pause(1600);
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
    hash: 'activity',
    run: async (h) => {
      await h.settle();
      await h.pause(1600);
    },
  },
  {
    name: 'backup',
    hash: 'backup',
    run: async (h) => {
      // A new backup is already open as a draft
      await h.type(
        h.page.locator('.pane-body input:not([type=checkbox]):not([type=file])').first(),
        'Customers nightly'
      );
      await h.pause(800);
      for (const name of ['Account', 'Contact', 'Case']) await h.pickObject(name);
      await h.click('Count records');
      await h.settle();
      await h.pause(1600);
      await h.click('Settings');
      await h.settle();
      await h.pause(1600);
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
      await h.pause(1600);
      await h.click(/^Compare \d+ type/);
      await h.settle();
      await h.pause(1600);
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
    },
  },
  {
    name: 'messages',
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
      await h.pause(2500);
    },
  },
];
