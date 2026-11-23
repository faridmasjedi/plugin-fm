import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  problem,
  withValues,
  stepText,
  runTest,
  junit,
  groupJunit,
  testsFromFile,
  stepper,
  pageRecord,
} from '../extension/core/steps.js';
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
    'Check Industry contains “Energy”'
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

test('marker at the start of names or every text field', async () => {
  const { markValues } = await import('../extension/core/plan.js');
  const fields = new Map(
    [
      { name: 'Name', type: 'string', nameField: true, length: 10 },
      { name: 'Description', type: 'textarea', length: 100 },
      { name: 'Email', type: 'email', length: 80 },
      { name: 'Code__c', type: 'string', unique: true, length: 20 },
    ].map((f) => [f.name, f])
  );
  const v = () => ({ Name: 'Acme Corporation', Description: 'Big', Email: 'a@b.c', Code__c: 'X1' });
  assert.deepEqual(markValues(v(), fields, { text: 'Nomad ', where: 'names' }), {
    Name: 'Nomad Acme',
    Description: 'Big',
    Email: 'a@b.c',
    Code__c: 'X1',
  });
  const all = markValues(v(), fields, { text: 'Nomad ', where: 'text' });
  assert.equal(all.Description, 'Nomad Big');
  assert.equal(all.Email, 'a@b.c');
  assert.equal(all.Code__c, 'X1');
  // Only the pattern: the made-up value is replaced; no double pattern when it is already there
  assert.deepEqual(markValues(v(), fields, { text: 'Nomad', where: 'text', mode: 'only' }), {
    Name: 'Nomad',
    Description: 'Nomad',
    Email: 'a@b.c',
    Code__c: 'X1',
  });
  assert.equal(markValues({ Name: 'Nomad X' }, fields, { text: 'Nomad', where: 'names' }).Name, 'Nomad X');
});

test('clone: search, copies with children, another org', async () => {
  const { whereOf, buildClones, fitClones } = await import('../extension/core/clone.js');
  assert.equal(whereOf('acme', 'Name'), "Name LIKE '%acme%'");
  assert.equal(whereOf("Industry = 'Energy'"), "Industry = 'Energy'");
  assert.throws(() => whereOf('x = 1; DELETE'), /;/);
  const f = (name, type = 'string', extra = {}) => ({
    name,
    type,
    createable: true,
    nillable: true,
    length: 80,
    ...extra,
  });
  const acc = {
    fields: [
      f('Name', 'string', { nameField: true }),
      f('Ext__c', 'string', { externalId: true }),
      f('OwnerId', 'reference'),
    ],
  };
  const con = { fields: [f('LastName'), f('AccountId', 'reference')] };
  const { nodes, records } = buildClones({
    parent: { object: 'Account', describe: acc, rows: [{ Id: 'A1', Name: 'Acme', Ext__c: 'E', OwnerId: '005' }] },
    children: [
      { object: 'Contact', field: 'AccountId', describe: con, rows: [{ Id: 'C1', LastName: 'Lee', AccountId: 'A1' }] },
    ],
    copies: 2,
    marker: { text: 'Nomad ', where: 'names' },
  });
  assert.equal(nodes.length, 2);
  assert.deepEqual(
    records.map((r) => [r.key, r.parentKey, r.values]),
    [
      ['p-1', undefined, { Name: 'Nomad Acme', OwnerId: '005' }],
      ['c0-1', 'p-1', { LastName: 'Nomad Lee', AccountId: { $ref: 'p-1' } }],
      ['p-2', undefined, { Name: 'Nomad Acme', OwnerId: '005' }],
      ['c0-2', 'p-2', { LastName: 'Nomad Lee', AccountId: { $ref: 'p-2' } }],
    ]
  );
  const fit = fitClones({ nodes, records }, { Account: acc });
  assert.equal(fit.nodes.length, 1);
  assert.deepEqual(fit.records[0].values, { Name: 'Nomad Acme' });
  assert.equal(fit.changes.length, 2);
});

test('pattern rule: alone, or with a made-up value added', async () => {
  const { valueOf } = await import('../extension/core/plan.js');
  const { makeFaker } = await import('../extension/core/fake.js');
  const ctx = { faker: makeFaker(1), values: {}, object: 'Account', label: 'Account', n: 7 };
  const name = { name: 'Name', type: 'string', nameField: true, length: 255 };
  assert.equal(valueOf({ kind: 'pattern', value: 'Nomad' }, name, ctx), 'Nomad');
  assert.equal(valueOf({ kind: 'pattern', value: 'INV-{000}' }, name, ctx), 'INV-007');
  assert.match(valueOf({ kind: 'pattern', value: 'Nomad', random: true }, name, ctx), /^Nomad \S+/);
  const mail = valueOf(
    { kind: 'pattern', value: 'Nomad QA', random: true },
    { name: 'Email', type: 'email', length: 80 },
    { ...ctx, values: { FirstName: 'Leila', LastName: 'Patel' } }
  );
  assert.match(mail, /^nomad\.qa\.[a-z.]+@example\.com$/);
});

test('runTest: find a record and use it, remember a value, optional steps, screenshots', async () => {
  const opened = [];
  const sf = {
    host: 'x.my.salesforce.com',
    rest: async (m, path) => {
      assert.match(decodeURIComponent(path), /SELECT Id, Name FROM Account/);
      return { totalSize: 1, records: [{ attributes: {}, Id: '001F', Name: 'Found Co' }] };
    },
  };
  const driver = {
    open: async (url) => opened.push(url),
    step: async (s) =>
      s.action === 'remember'
        ? { ok: true, value: 'AC-7' }
        : s.label === 'Maybe'
        ? { ok: false, message: 'not there' }
        : s.action === 'fill'
        ? { ok: true, message: s.value }
        : { ok: true },
    shot: async () => 'data:image/png;base64,BBB',
  };
  const r = await runTest(
    {
      name: 'T',
      steps: [
        { action: 'query', soql: "SELECT Id, Name FROM Account WHERE Name LIKE 'Found%'", save: 'found' },
        { action: 'open', record: '{{found}}' },
        { action: 'remember', field: 'Account Number', as: 'num' },
        { action: 'click', label: 'Maybe', optional: true },
        { action: 'fill', field: 'Description', value: '{{found.Name}} / {{num}}' },
        { action: 'shot' },
      ],
    },
    { driver, sf }
  );
  assert.equal(opened[0], 'https://x.my.salesforce.com/lightning/r/001F/view');
  assert.equal(r.ok, true);
  assert.equal(r.results[3].optional, true);
  assert.equal(r.results[4].message, 'Found Co / AC-7');
  assert.equal(r.results[5].shot, 'data:image/png;base64,BBB');
  assert.equal(
    stepText({ action: 'expect', kind: 'field', field: 'Stage', op: 'not', value: 'Lost' }),
    'Check Stage is not “Lost”'
  );
  assert.equal(
    stepText({ action: 'expect', kind: 'no-button', value: 'Delete' }),
    'Check there is no button or link “Delete”'
  );
  assert.equal(problem({ action: 'expect', kind: 'field', field: 'Phone', op: 'filled' }), '');
  assert.match(problem({ action: 'query', soql: 'DELETE FROM Account' }), /SELECT/);
});

test('JUnit carries the test: uploaded again, it gives the same steps; a group gives every test', () => {
  const t = {
    id: 'x',
    host: 'h',
    nomadqa: 'test',
    version: 1,
    name: 'A & “B”',
    steps: [{ action: 'click', label: 'Save <now>' }],
  };
  const run = { results: [{ ok: false, message: 'No “Save” & no luck', ms: 10 }], ms: 10 };
  const xml = junit(t, run);
  assert.match(xml, /<failure message="No “Save” &amp; no luck"\/>/);
  const back = testsFromFile(xml);
  assert.equal(back.length, 1);
  assert.equal(back[0].name, 'A & “B”');
  assert.deepEqual(back[0].steps, t.steps);
  assert.equal(back[0].id, undefined);
  const group = groupJunit('Smoke', [
    { test: t, run },
    { test: { ...t, name: 'Two' }, run: { results: [{ ok: true, ms: 1 }], ms: 1 } },
  ]);
  assert.deepEqual(
    testsFromFile(group).map((x) => x.name),
    ['A & “B”', 'Two']
  );
  assert.equal(testsFromFile(JSON.stringify({ nomadqa: 'group', name: 'G', tests: [t, t] })).length, 2);
  assert.throws(() => testsFromFile('<testsuites><testsuite name="x"/></testsuites>'), /not written by NomadQA/);
});

test('fields by API name, new checks, logins', async () => {
  assert.deepEqual(pageRecord('https://x.lightning.force.com/lightning/r/Contact/003AA0000012345AAA/view'), {
    object: 'Contact',
    id: '003AA0000012345AAA',
  });
  assert.deepEqual(pageRecord('https://x/lightning/o/Contact/list'), { object: 'Contact', id: '' });
  const sent = [];
  const opened = [];
  const sf = {
    host: 'x.my.salesforce.com',
    describe: async () => ({
      fields: [
        { name: 'Title', label: 'Title' },
        { name: 'Name', label: 'Full Name' },
        { name: 'Level__c', label: 'Level' },
        { name: 'RecordTypeId', label: 'Record Type ID' },
      ],
    }),
    query: async (q) =>
      /FROM User/.test(q)
        ? [{ Id: '005A', Name: 'Ann Lee', Username: 'ann@x.com', ProfileId: '00eP' }]
        : /FROM Organization/.test(q)
        ? [{ Id: '00DO' }]
        : /RecordType\.Name/.test(q)
        ? [{ RecordType: { Name: 'Partner' } }]
        : [],
    facts: async () => ({ userId: '005ME' }),
    rest: async () => ({ records: [] }),
  };
  let url = 'https://x.lightning.force.com/lightning/r/Contact/003AA0000012345AAA/view';
  const driver = {
    open: async (u) => opened.push(u),
    load: async (u) => opened.push(u),
    settle: async () => (url = 'https://x.lightning.force.com/lightning/page/home'),
    url: async () => url,
    step: async (s) => (sent.push(s), { ok: true }),
    keepSession: async () => sent.push('kept'),
    restoreSession: async () => sent.push('restored'),
  };
  const st = stepper(
    { steps: [] },
    { driver, sf, logins: { sales: { url: 'https://test.salesforce.com', username: 'ann@x.com', password: 'pw' } } }
  );
  // API names: Level__c is shown as Level; "Name" is tried as typed, then as its label
  await st.run({ action: 'expect', kind: 'field', field: 'Level__c', value: 'Gold' });
  assert.equal(sent.at(-1).fieldAlt, 'Level');
  await st.run({ action: 'expect', kind: 'field', field: 'Contact.Name', value: 'Mia' });
  assert.equal(sent.at(-1).field, 'Full Name');
  assert.equal((await st.run({ action: 'expect', kind: 'recordtype', op: 'is', value: 'Partner' })).ok, true);
  assert.match((await st.run({ action: 'expect', kind: 'recordtype', op: 'is', value: 'Other' })).message, /“Partner”/);
  // Login-As: the su link, and back to you at the end
  const r = await st.run({ action: 'loginas', user: 'Ann Lee' });
  assert.equal(r.ok, true);
  assert.match(opened.at(-2), /servlet\.su\?oid=00DO&suorgadminid=005A/);
  // Log in with a saved login: the session is kept, the form gets the username and password
  const l = await st.run({ action: 'login', login: 'sales' });
  assert.equal(l.ok, true, l.message);
  assert.match(opened.join(' '), /secur\/logout\.jsp.*test\.salesforce\.com/);
  assert.deepEqual(
    sent.filter((x) => x === 'kept' || x?.action === 'login-form').map((x) => x.username ?? x),
    ['kept', 'kept', 'ann@x.com']
  );
  await st.finish();
  assert.equal(sent.at(-1), 'restored');
  assert.match((await st.run({ action: 'login', login: 'nobody' })).message, /Settings › Logins/);
  assert.equal(
    stepText({ action: 'expect', kind: 'count', what: 'buttons', within: 'Cases', op: 'is', value: '2' }),
    'Check the number of buttons in “Cases” is 2'
  );
  assert.equal(
    stepText({ action: 'expect', kind: 'place', field: 'Phone', section: '1', row: 1, col: 2 }),
    'Check Phone is in section 1, row 1, column 2'
  );
  assert.equal(
    stepText({ action: 'fill', field: 'Title', api: 'Contact.Title', value: 'CEO' }),
    'Type “CEO” in Title (Contact.Title)'
  );
  assert.match(problem({ action: 'expect', kind: 'count', value: 'two' }), /number/);
  assert.match(problem({ action: 'expect', kind: 'place', field: 'Phone' }), /section, a row or a column/);
  assert.match(problem({ action: 'loginas' }), /user/);
});

test('search and choose: sentences and checks', () => {
  assert.equal(
    stepText({ action: 'search', text: 'Mia', choose: 'Mia Brown' }),
    'Search “Mia” in Salesforce search (at the top), choose “Mia Brown”'
  );
  assert.equal(
    stepText({ action: 'search', box: 'Search this list...', text: 'Acme' }),
    'Search “Acme” in “Search this list...”, press Enter'
  );
  assert.equal(problem({ action: 'search', text: 'Mia' }), '');
  assert.equal(problem({ action: 'search', choose: 'Mia Brown' }), 'needs text');
});

test('a click that opens a list: type, then choose', () => {
  assert.equal(
    stepText({ action: 'click', label: 'App Launcher', type: 'Sales', choose: 'Sales' }),
    'Click “App Launcher”, type “Sales”, choose “Sales”'
  );
  assert.equal(problem({ action: 'click', label: 'Select a List View', choose: 'All Open Cases' }), '');
});

test('a group of steps: runs as one step, the first failure stops it, its reason and picture go up', async () => {
  const { htmlReport, markdownSummary, failureLine } = await import('../extension/core/report.js');
  const sf = { host: 'x.my.salesforce.com' };
  const ran = [];
  const driver = {
    open: async () => {},
    url: async () => 'https://x.lightning.force.com/lightning/r/Account/001/view',
    step: async (s) => {
      ran.push(s.label ?? s.value);
      return s.value === 'Energy'
        ? { ok: false, message: 'Not found', expected: 'Industry contains “Energy”', got: '“Media”', toasts: ['Oops'] }
        : { ok: true };
    },
    shot: async () => 'data:image/jpeg;base64,CCC',
  };
  const group = {
    action: 'group',
    name: 'Open the Sales app',
    steps: [
      { action: 'click', label: 'App Launcher', type: 'Sales', choose: 'Sales' },
      { action: 'expect', kind: 'field', field: 'Industry', value: 'Energy' },
      { action: 'click', label: 'Never' },
    ],
  };
  assert.equal(problem(group), '');
  assert.match(problem({ action: 'group', steps: [] }), /no steps/);
  assert.match(problem({ action: 'group', steps: [group] }), /another group/);
  assert.match(problem({ action: 'group', steps: [{ action: 'click' }] }), /step 1 of the group: needs label/);
  assert.equal(stepText(group), 'Open the Sales app (3 steps)');
  const test = { name: 'G', steps: [group, { action: 'click', label: 'After' }] };
  const run = await runTest(test, { driver, sf });
  assert.equal(run.ok, false);
  assert.deepEqual(ran, ['App Launcher', 'Energy']);
  const g = run.results[0];
  assert.equal(g.ok, false);
  assert.equal(g.at, 1);
  assert.equal(g.children.length, 3);
  assert.equal(g.children[2].ok, null);
  assert.equal(g.shot, 'data:image/jpeg;base64,CCC');
  assert.equal(g.children[1].shot, undefined);
  assert.equal(g.expected, 'Industry contains “Energy”');
  assert.equal(g.got, '“Media”');
  assert.match(g.message, /^Step 2 of the group, “Check Industry contains “Energy””: Not found/);
  assert.equal(run.results[1].ok, null);
  assert.match(failureLine(test, run), /^Step 1, Open the Sales app \(3 steps\): Step 2 of the group/);
  const html = htmlReport({ title: 'G', org: 'acme', items: [{ test, run }] });
  assert.match(html, /Why it failed/);
  assert.match(html, /<div class="k">Expected<\/div><div class="v">Industry contains “Energy”/);
  assert.match(html, /<div class="k">Got<\/div><div class="v">“Media”/);
  assert.match(html, /data:image\/jpeg;base64,CCC/);
  assert.match(html, /<td class="n">1\.2<\/td>/);
  const md = markdownSummary({ title: 'G', items: [{ test, run }] });
  assert.match(md, /0 of 1 passed/);
  assert.match(md, /\*\*Expected:\*\* Industry contains “Energy”/);
  assert.doesNotMatch(md, /\n\n\n/);
});

test('a query that finds the wrong number says what was wanted and what it got', async () => {
  const sf = { host: 'x', rest: async () => ({ totalSize: 0, records: [] }) };
  const run = await runTest(
    { name: 'Q', steps: [{ action: 'query', soql: 'SELECT Id FROM Account', count: 2 }] },
    { driver: { step: async () => ({ ok: true }) }, sf }
  );
  assert.equal(run.results[0].expected, '2 row(s)');
  assert.equal(run.results[0].got, '0 row(s)');
});

test('an element by its exact path: click, type, check', () => {
  const js = 'document.querySelector("one-app-nav-bar").shadowRoot.querySelector("a[title=\\"Accounts\\"]")';
  assert.equal(problem({ action: 'click', css: js }), '');
  assert.equal(problem({ action: 'fill', css: '//input[@name="Name"]', value: 'Acme' }), '');
  assert.equal(problem({ action: 'expect', kind: 'element', css: 'h1.title' }), '');
  assert.match(problem({ action: 'expect', kind: 'element' }), /path/);
  assert.match(problem({ action: 'click' }), /label/);
  assert.equal(stepText({ action: 'click', css: 'button.save' }), 'Click the element button.save');
  assert.equal(
    stepText({ action: 'expect', kind: 'element', css: 'h1', value: 'Acme', op: 'is' }),
    'Check the element h1 is “Acme”'
  );
  assert.equal(stepText({ action: 'expect', kind: 'element', css: 'h1' }), 'Check the element h1 is shown');
});
