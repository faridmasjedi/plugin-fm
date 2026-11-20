import { test } from 'node:test';
import assert from 'node:assert/strict';
import { problem, withValues, stepText, runTest, junit } from '../extension/core/steps.js';
import { firstJson, stepsFromWords } from '../extension/core/ai.js';
import { turnOn, turnOff } from '../extension/core/bypass.js';

test('steps: problems, values from a data step, text', () => {
  assert.equal(problem({ action: 'click', label: 'Save' }), '');
  assert.equal(problem({ action: 'open', record: '{{a-1}}' }), '');
  assert.match(problem({ action: 'open' }), /path/);
  assert.match(problem({ action: 'fly' }), /unknown/);
  assert.match(problem({ action: 'expect', kind: 'field', value: 'x' }), /field/);
  assert.match(problem({ action: 'query', soql: 'DELETE x' }), /SELECT/);
  assert.equal(problem({ action: 'query', soql: "SELECT Id FROM Contact WHERE LastName = 'x'", count: 1 }), '');
  const vars = { 'a-1': { id: '001X', values: { Name: 'Acme' } } };
  assert.deepEqual(withValues({ action: 'open', record: '{{a-1}}', label: '{{a-1.Name}} / {{nope}}' }, vars), {
    action: 'open',
    record: '001X',
    label: 'Acme / {{nope}}',
  });
  assert.equal(
    stepText({ action: 'expect', kind: 'field', field: 'Industry', value: 'Energy' }),
    'Check Industry is “Energy”'
  );
});

test('runTest: data, open by record, page steps, a failure stops the rest, cleanup, JUnit', async () => {
  const opened = [];
  const sf = {
    host: 'x.my.salesforce.com',
    describe: async () => ({
      name: 'Account',
      label: 'Account',
      fields: [{ name: 'Name', type: 'string', createable: true, nillable: false, nameField: true, length: 80 }],
    }),
    query: async () => [],
    insert: async (object, rows) => rows.map((_, i) => ({ id: `001A${i}` })),
    remove: async (ids) => ({ deleted: ids.length, problems: [] }),
    rest: async () => ({ totalSize: 2 }),
  };
  const driver = {
    open: async (url) => opened.push(url),
    step: async (s) => (s.label === 'Broken' ? { ok: false, message: 'Not found: Broken' } : { ok: true }),
    shot: async () => 'data:image/png;base64,AAA',
  };
  const t = {
    name: 'T',
    steps: [
      {
        action: 'data',
        recipe: {
          nodes: [{ id: 'a', object: 'Account', count: 1, rules: { Name: { kind: 'fixed', value: 'Acme' } } }],
        },
      },
      { action: 'open', record: '{{a-1}}' },
      { action: 'query', soql: 'SELECT Id FROM Account', count: 2 },
      { action: 'click', label: 'Broken' },
      { action: 'click', label: 'Save' },
    ],
  };
  const r = await runTest(t, { driver, sf });
  assert.equal(opened[0], 'https://x.my.salesforce.com/lightning/r/001A0/view');
  assert.deepEqual(
    r.results.map((x) => x.ok),
    [true, true, true, false, null]
  );
  assert.equal(r.results[3].shot, 'data:image/png;base64,AAA');
  assert.equal(r.cleaned, 1);
  assert.equal(r.ok, false);
  const xml = junit(t, r);
  assert.match(xml, /tests="5" failures="1"/);
  assert.match(xml, /<failure message="Not found: Broken"\/>/);
  assert.match(xml, /<skipped\/>/);
});

test('agent: reads JSON out of an answer, checks every step', async () => {
  assert.deepEqual(firstJson('Sure! ```json\n{"a": {"b": "}"}}\n``` done'), { a: { b: '}' } });
  assert.equal(firstJson('no json here'), null);
  const answer = {
    name: 'Contact on account',
    steps: [
      { action: 'open', path: '/lightning/o/Contact/new' },
      { action: 'fill', field: 'Last Name' },
    ],
  };
  const fetchImpl = async (url, init) => {
    assert.equal(init.headers['x-api-key'], 'k');
    assert.equal(init.headers['anthropic-dangerous-direct-browser-access'], 'true');
    assert.match(JSON.parse(init.body).system, /Objects in this org/);
    return { ok: true, json: async () => ({ content: [{ text: `Here:\n${JSON.stringify(answer)}` }] }) };
  };
  const r = await stepsFromWords({ provider: 'anthropic', key: 'k' }, 'make a contact', {
    objects: [{ name: 'Contact', label: 'Contact' }],
    fetchImpl,
  });
  assert.equal(r.test.steps.length, 2);
  assert.deepEqual(r.problems, [{ i: 1, problem: 'needs value' }]);
  await assert.rejects(() => stepsFromWords({ provider: 'openai', key: '' }, 'x', { fetchImpl }), /key/);
});

test('bypass: a custom setting at the user level is put back exactly', async () => {
  const calls = [];
  const sf = {
    query: async () => [],
    rest: async (method, path, body) => {
      calls.push([method, path, body]);
      return { id: 'a0X1' };
    },
  };
  const undo = await turnOn(sf, { kind: 'setting', object: 'Bypass__c', field: 'Validation__c' }, '005U');
  assert.deepEqual(calls[0], ['POST', '/sobjects/Bypass__c', { SetupOwnerId: '005U', Validation__c: true }]);
  await turnOff(sf, undo);
  assert.deepEqual(calls[1], ['DELETE', '/sobjects/Bypass__c/a0X1', undefined]);
  // Already on: nothing to do, nothing to undo
  const on = await turnOn(
    { query: async () => [{ Id: 'a0X2', Validation__c: true }], rest: async () => assert.fail('no change') },
    { kind: 'setting', object: 'Bypass__c', field: 'Validation__c' },
    '005U'
  );
  assert.equal(on, null);
  // Off before: patched on, then patched back off
  const patches = [];
  const u2 = await turnOn(
    { query: async () => [{ Id: 'a0X3', Validation__c: false }], rest: async (m, p, b) => patches.push([m, p, b]) },
    { kind: 'setting', object: 'Bypass__c', field: 'Validation__c' },
    '005U'
  );
  await turnOff({ rest: async (m, p, b) => patches.push([m, p, b]) }, u2);
  assert.deepEqual(patches, [
    ['PATCH', '/sobjects/Bypass__c/a0X3', { Validation__c: true }],
    ['PATCH', '/sobjects/Bypass__c/a0X3', { Validation__c: false }],
  ]);
});

test('a recipe from another org is fitted: missing objects, fields, links and record types', async () => {
  const { fitRecipe } = await import('../extension/core/plan.js');
  const f = (name, type, extra = {}) => ({ name, label: name, type, createable: true, nillable: true, ...extra });
  const describes = {
    Account: { name: 'Account', fields: [f('Name', 'string', { nillable: false })], recordTypeInfos: [] },
    Contact: {
      name: 'Contact',
      fields: [f('LastName', 'string'), f('Company__c', 'reference', { referenceTo: ['Account'] })],
    },
  };
  const recipe = {
    nodes: [
      {
        id: 'a',
        object: 'Account',
        count: 2,
        recordType: 'Customer',
        rules: { Name: { kind: 'auto' }, Tier__c: { kind: 'auto' } },
      },
      {
        id: 'c',
        object: 'Contact',
        count: 1,
        parentId: 'a',
        parentField: 'AccountId',
        rules: { LastName: { kind: 'auto' } },
      },
      { id: 'i', object: 'Invoice__c', count: 1, parentId: 'a', parentField: 'Account__c', rules: {} },
      { id: 'l', object: 'Line__c', count: 1, parentId: 'i', parentField: 'Invoice__c', rules: {} },
    ],
  };
  const { nodes, changes } = fitRecipe(recipe, describes);
  assert.deepEqual(
    nodes.map((n) => n.id),
    ['a', 'c']
  );
  assert.equal(nodes[0].recordType, undefined);
  assert.deepEqual(Object.keys(nodes[0].rules), ['Name']);
  assert.equal(nodes[1].parentField, 'Company__c');
  assert.equal(changes.length, 4);
  assert.match(changes.join(' '), /Invoice__c is not in this org: left out, with what was under it/);
  assert.match(changes.join(' '), /linked to Account by Company__c/);
});
