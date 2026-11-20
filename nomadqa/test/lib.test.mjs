import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFaker, fillPattern, seeded } from '../extension/core/fake.js';
import { defaultRules, generate, counts, orderNodes, checkSoql } from '../extension/core/plan.js';
import { checkScripts, readCheck, apexLiteral, factoryClass } from '../extension/core/apex.js';
import { createRecords, csvFiles, deleteBatch } from '../extension/core/create.js';
import { apiHostFor, Salesforce } from '../extension/core/salesforce.js';

const field = (name, type, extra = {}) => ({
  name,
  type,
  createable: true,
  nillable: true,
  defaultedOnCreate: false,
  length: 255,
  ...extra,
});
const describes = {
  Account: {
    name: 'Account',
    label: 'Account',
    fields: [
      field('Name', 'string', { nillable: false, nameField: true }),
      field('Industry', 'picklist', {
        picklistValues: [
          { value: 'Retail', active: true },
          { value: 'Energy', active: true },
          { value: 'Old', active: false },
        ],
      }),
      field('Website', 'url'),
      field('AnnualRevenue', 'currency', { precision: 18, scale: 0 }),
      field('OwnerId', 'reference', { nillable: false, defaultedOnCreate: true }),
      field('CreatedDate', 'datetime', { createable: false }),
      field('BillingAddress', 'address'),
    ],
  },
  Contact: {
    name: 'Contact',
    label: 'Contact',
    fields: [
      field('FirstName', 'string'),
      field('LastName', 'string', { nillable: false }),
      field('Email', 'email'),
      field('AccountId', 'reference'),
      field('Title', 'string', { length: 8 }),
    ],
  },
};
const types = Object.fromEntries(
  Object.entries(describes).map(([o, d]) => [o, Object.fromEntries(d.fields.map((f) => [f.name, f.type]))])
);

const plan = {
  nodes: [
    {
      id: 'c',
      object: 'Contact',
      count: 2,
      parentId: 'a',
      parentField: 'AccountId',
      rules: defaultRules(describes.Contact, { parentField: 'AccountId' }),
    },
    {
      id: 'a',
      object: 'Account',
      count: 3,
      rules: { ...defaultRules(describes.Account), AnnualRevenue: { kind: 'range', from: 100, to: 200 } },
    },
  ],
};

test('the same seed gives the same values; e-mails and companies do not repeat', () => {
  const a = seeded(7);
  const b = seeded(7);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const f = makeFaker(3);
  const companies = Array.from({ length: 200 }, () => f.company());
  assert.equal(new Set(companies).size, 200);
  const emails = Array.from({ length: 50 }, () => f.email('Ann', 'Lee'));
  assert.equal(new Set(emails).size, 50);
  assert.ok(emails.every((e) => e.endsWith('example.com')));
  assert.equal(f.weighted('Gold 100%, Silver 0%'), 'Gold');
  assert.equal(fillPattern('INV-{0000} for {parent.Name}', 7, { Name: 'Acme' }), 'INV-0007 for Acme');
});

test('default rules: required and usual fields, never system, compound or the parent link', () => {
  assert.deepEqual(Object.keys(defaultRules(describes.Account)).sort(), [
    'AnnualRevenue',
    'Industry',
    'Name',
    'Website',
  ]);
  assert.deepEqual(Object.keys(defaultRules(describes.Contact, { parentField: 'AccountId' })).sort(), [
    'Email',
    'FirstName',
    'LastName',
    'Title',
  ]);
});

test('generate: parents first, children per parent, linked by key; values fit their fields', () => {
  assert.deepEqual(
    orderNodes(plan.nodes).map((n) => n.id),
    ['a', 'c']
  );
  assert.deepEqual(counts(plan), { a: 3, c: 6 });
  const recs = generate(plan, describes, makeFaker(1, new Date('2026-01-01')));
  assert.equal(recs.length, 9);
  assert.deepEqual(
    recs.slice(0, 3).map((r) => r.object),
    ['Account', 'Account', 'Account']
  );
  const acc = recs[0];
  assert.ok(['Retail', 'Energy'].includes(acc.values.Industry));
  assert.ok(acc.values.AnnualRevenue >= 100 && acc.values.AnnualRevenue <= 200);
  assert.match(acc.values.Website, /^https:\/\/[a-z0-9]+\.example\.com$/);
  const kids = recs.filter((r) => r.parentKey === acc.key);
  assert.equal(kids.length, 2);
  assert.deepEqual(kids[0].values.AccountId, { $ref: acc.key });
  assert.ok(kids[0].values.Email.toLowerCase().includes(kids[0].values.FirstName.toLowerCase().slice(0, 3)));
  assert.ok(kids.every((k) => !k.values.Title || k.values.Title.length <= 8));
  // Same seed, same records
  assert.deepEqual(generate(plan, describes, makeFaker(1, new Date('2026-01-01'))), recs);
});

test('apex: literals by type; the check script links children and rolls back; its result is read', () => {
  assert.equal(apexLiteral("O'Brien", 'string'), "'O\\'Brien'");
  assert.equal(apexLiteral(5, 'currency'), '5.0');
  assert.equal(apexLiteral('2026-02-01', 'date'), "Date.valueOf('2026-02-01')");
  const recs = generate(plan, describes, makeFaker(1));
  const [script] = checkScripts(recs);
  assert.match(script, /^String DATA = '\[/);
  assert.match(script, /extends Exception/);
  assert.match(script, /throw new NomadQACheckDoneException/);
  const data = JSON.parse(
    script
      .slice('String DATA = '.length, script.indexOf(';\n'))
      .slice(1, -1)
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\')
  );
  assert.equal(data.length, 9);
  assert.deepEqual(data.find((d) => d.k === 'c-1').v.AccountId, { $ref: 'a-1' });
  // Too big for one script: split by families, a parent always with its children
  const parts = checkScripts(recs, 2600 + 1200);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    const d = JSON.parse(
      part.slice('String DATA = '.length, part.indexOf(';\n')).slice(1, -1).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
    );
    const keys = new Set(d.map((x) => x.k));
    assert.ok(d.every((x) => !x.p || keys.has(x.p)));
  }
  const r = readCheck(
    {
      compiled: true,
      success: false,
      exceptionMessage: 'NomadQACheckDoneException: NOMADQA["a-2\\tGold needs a website (Website)"]',
    },
    9
  );
  assert.deepEqual(r, { ok: 8, failed: [{ key: 'a-2', message: 'Gold needs a website (Website)' }] });
  assert.throws(
    () => readCheck({ compiled: false, compileProblem: 'Unexpected token', line: 3 }, 1),
    /did not compile/
  );
  const cls = factoryClass(recs, types);
  assert.match(cls, /@IsTest/);
  assert.match(cls, /'AccountId' => byKey\.get\('a-1'\)\.Id/);
});

test('create: parents first, children get the new Ids, a failed parent skips its children; delete in reverse', async () => {
  const recs = generate(plan, describes, makeFaker(1));
  const inserted = [];
  let id = 0;
  const sf = {
    async insert(object, rows) {
      inserted.push({ object, rows });
      return rows.map((r, i) =>
        object === 'Account' && i === 1 ? { error: 'Gold needs a website' } : { id: `${object}${++id}` }
      );
    },
  };
  const r = await createRecords(sf, recs);
  assert.equal(r.created, 2 + 4);
  assert.equal(r.failed.length, 1 + 2);
  assert.equal(inserted[1].rows[0].AccountId, 'Account1');
  const removed = [];
  await deleteBatch(
    {
      async remove(ids) {
        removed.push(ids[0]);
        return { deleted: ids.length, problems: [] };
      },
    },
    { order: ['Account', 'Contact'], ids: r.ids }
  );
  assert.deepEqual(
    removed.map((x) => x.replace(/\d+/, '')),
    ['Contact', 'Account']
  );
  const csv = csvFiles(recs);
  assert.ok(csv['Contact.csv'].startsWith('NomadQA key,Parent key,'));
  assert.match(csv['Contact.csv'], /\nc-1,a-1,/);
});

test('hosts and the API client', async () => {
  assert.equal(apiHostFor('acme--uat.sandbox.lightning.force.com'), 'acme--uat.sandbox.my.salesforce.com');
  assert.equal(apiHostFor('example.com'), undefined);
  const calls = [];
  const sf = new Salesforce('x.my.salesforce.com', 'SID', {
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            { success: true, id: '001A' },
            { success: false, errors: [{ message: 'bad' }] },
          ]),
      };
    },
  });
  const res = await sf.insert('Account', [{ Name: 'a' }, { Name: 'b' }], { allowDuplicates: true });
  assert.deepEqual(res, [{ id: '001A' }, { error: 'bad' }]);
  assert.equal(calls[0].init.headers['Sforce-Duplicate-Rule-Header'], 'allowSave=true');
  assert.equal(JSON.parse(calls[0].init.body).records[0].attributes.type, 'Account');
  assert.throws(() => checkSoql('DELETE FROM Account'), /SELECT Id FROM/);
});
