// NomadQA › Test data: plan the records, preview and check them, create them, and clean them up again.
import { h, select, askTyped, toast, download } from './core/ui.js';
import { browserOrgs, sessionFor, Salesforce } from './core/salesforce.js';
import { makeFaker } from './core/fake.js';
import {
  defaultRules,
  writableFields,
  isRequired,
  generate,
  counts,
  orderNodes,
  querySoqls,
  checkSoql,
} from './core/plan.js';
import { checkScripts, readCheck, factoryClass } from './core/apex.js';
import { createRecords, deleteBatch, stillThere, csvFiles } from './core/create.js';

const CHECK_MAX = 500;
const SHOW_MAX = 200;

const store = {
  async get(key, fallback) {
    try {
      const r = await chrome.storage.local.get(key);
      return r[key] ?? fallback;
    } catch {
      return fallback;
    }
  },
  async set(key, value) {
    try {
      await chrome.storage.local.set({ [key]: value });
    } catch {
      /* not kept */
    }
  },
};

const S = {
  orgs: [],
  host: '',
  sf: null,
  facts: null,
  orgError: '',
  view: 'plan',
  objects: null,
  describes: {},
  plan: { name: '', seed: 1, nodes: [] },
  selected: null,
  adding: null,
  fieldFilter: '',
  onlyRules: true,
  lookups: {},
  picklists: {},
  preview: null,
  allowDuplicates: false,
  batches: [],
  recipes: [],
  counts: {},
  busy: '',
  progress: null,
  notice: null,
};

const label = () => S.orgs.find((o) => o.host === S.host)?.label ?? S.host;
const objectLabel = (name) => S.objects?.find((o) => o.name === name)?.label ?? S.describes[name]?.label ?? name;
let nextId = 1;
const newId = () => `n${Date.now().toString(36)}${nextId++}`;
const savePlan = () => store.set('nomadqa.plan', S.plan);

function setNotice(kind, text) {
  S.notice = text ? { kind, text } : null;
}

async function run(what, fn) {
  S.busy = what;
  render();
  try {
    await fn();
  } catch (e) {
    setNotice('bad', e.message);
  } finally {
    S.busy = '';
    S.progress = null;
    render();
  }
}

// ---------- org ----------

async function chooseOrg(host) {
  S.host = host;
  S.sf = null;
  S.facts = null;
  S.objects = null;
  S.describes = {};
  S.lookups = {};
  S.picklists = {};
  S.preview = null;
  S.orgError = '';
  await store.set('nomadqa.host', host);
  if (!host) return render();
  await run('Connecting…', async () => {
    try {
      S.sf = new Salesforce(host, await sessionFor(host));
      S.facts = await S.sf.facts();
      S.objects = await S.sf.objects();
      for (const n of S.plan.nodes) await ensure(n.object);
    } catch (e) {
      S.orgError = e.message;
      throw e;
    }
  });
}

async function ensure(object) {
  if (!S.describes[object]) S.describes[object] = await S.sf.describe(object);
  return S.describes[object];
}

// ---------- plan editing ----------

async function addObject(object, parentId) {
  const name = String(object).trim();
  const known = S.objects?.find(
    (o) => o.name.toLowerCase() === name.toLowerCase() || o.label.toLowerCase() === name.toLowerCase()
  );
  if (!known) return setNotice('bad', `No object “${name}” that can be created in ${label()}.`);
  await run(`Reading ${known.label}…`, async () => {
    const d = await ensure(known.name);
    let parentField;
    if (parentId) {
      const parent = S.plan.nodes.find((n) => n.id === parentId);
      parentField = S.adding?.field;
      if (!parentField) {
        const f = d.fields.find(
          (x) => x.type === 'reference' && x.createable && x.referenceTo?.includes(parent.object)
        );
        parentField = f?.name;
      }
    }
    const node = {
      id: newId(),
      object: known.name,
      count: parentId ? 2 : 10,
      parentId,
      parentField,
      rules: defaultRules(d, { parentField }),
    };
    S.plan.nodes.push(node);
    S.selected = node.id;
    S.adding = null;
    setNotice();
    savePlan();
  });
}

function removeNode(id) {
  const gone = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of S.plan.nodes)
      if (n.parentId && gone.has(n.parentId) && !gone.has(n.id)) {
        gone.add(n.id);
        grew = true;
      }
  }
  S.plan.nodes = S.plan.nodes.filter((n) => !gone.has(n.id));
  if (gone.has(S.selected)) S.selected = S.plan.nodes[0]?.id ?? null;
  savePlan();
  render();
}

function childChoices(object) {
  const d = S.describes[object];
  if (!d || !S.objects) return [];
  const creatable = new Map(S.objects.map((o) => [o.name, o.label]));
  return (d.childRelationships ?? [])
    .filter((c) => c.field && c.relationshipName && creatable.has(c.childSObject) && !c.deprecatedAndHidden)
    .map((c) => ({ object: c.childSObject, field: c.field, text: `${creatable.get(c.childSObject)} · ${c.field}` }))
    .sort((a, b) => a.text.localeCompare(b.text));
}

// ---------- preview ----------

async function preparePreview() {
  await run('Making the records…', async () => {
    for (const n of S.plan.nodes) await ensure(n.object);
    for (const soql of querySoqls(S.plan)) {
      if (S.lookups[soql]) continue;
      checkSoql(soql);
      S.lookups[soql] = (await S.sf.query(soql, { max: 2000 })).map((r) => r.Id);
      if (!S.lookups[soql].length) throw new Error(`The query found nothing: ${soql}`);
    }
    // A record type's own picklist values
    for (const n of S.plan.nodes) {
      const rt = recordTypeOf(n);
      n.recordTypeId = rt?.recordTypeId;
      if (!rt) continue;
      S.picklists[n.id] = {};
      for (const name of Object.keys(n.rules)) {
        const f = S.describes[n.object].fields.find((x) => x.name === name);
        if (f && /picklist/.test(f.type) && n.rules[name].kind === 'auto')
          S.picklists[n.id][name] = await S.sf.picklistFor(n.object, rt.recordTypeId, name).catch(() => undefined);
      }
    }
    const records = generate(S.plan, S.describes, makeFaker(S.plan.seed), {
      lookups: S.lookups,
      picklists: S.picklists,
    });
    S.preview = { records, excluded: new Set(), tab: orderNodes(S.plan.nodes)[0]?.id, check: null };
    S.view = 'preview';
    setNotice();
  });
}

function recordTypeOf(node) {
  if (!node.recordType) return undefined;
  return S.describes[node.object]?.recordTypeInfos?.find((r) => r.developerName === node.recordType && r.available);
}

const included = () => S.preview.records.filter((r) => !S.preview.excluded.has(r.key));

const typesOf = () =>
  Object.fromEntries(
    Object.entries(S.describes).map(([o, d]) => [o, Object.fromEntries(d.fields.map((f) => [f.name, f.type]))])
  );

async function checkWithoutSaving() {
  const records = included().slice(0, CHECK_MAX);
  await run(`Checking ${records.length} records in ${label()} (nothing is saved)…`, async () => {
    const scripts = checkScripts(records);
    const failed = [];
    for (let i = 0; i < scripts.length; i++) {
      if (scripts.length > 1) S.busy = `Checking part ${i + 1} of ${scripts.length} in ${label()} (nothing is saved)…`;
      render();
      const r = await S.sf.executeAnonymous(scripts[i]);
      failed.push(...readCheck(r, 0).failed);
    }
    S.preview.check = {
      ok: records.length - failed.length,
      failed,
      total: records.length,
      failedKeys: new Set(failed.map((f) => f.key)),
    };
  });
}

/** The failed records and everything under them. */
function leaveFailedOut() {
  const out = new Set([...S.preview.excluded, ...S.preview.check.failedKeys]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of S.preview.records)
      if (r.parentKey && out.has(r.parentKey) && !out.has(r.key)) {
        out.add(r.key);
        grew = true;
      }
  }
  S.preview.excluded = out;
  render();
}

async function createInOrg() {
  const records = included();
  const production = S.facts && !S.facts.isSandbox;
  const ok = await askTyped(
    `Create ${records.length} records in ${label()}? They are kept as a batch you can delete later.`,
    label(),
    {
      ok: `Create ${records.length}`,
      extra: production
        ? `${label()} is a PRODUCTION org. Test data there is seen by real users and reports.`
        : undefined,
    }
  );
  if (!ok) return;
  await run('Creating…', async () => {
    S.progress = { done: 0, total: records.length };
    const started = Date.now();
    const result = await createRecords(S.sf, records, {
      allowDuplicates: S.allowDuplicates,
      progress: (done, total) => {
        S.progress = { done, total };
        render();
      },
    });
    const order = [];
    for (const n of orderNodes(S.plan.nodes)) if (!order.includes(n.object)) order.push(n.object);
    const batch = {
      id: newId(),
      at: new Date().toISOString(),
      host: S.host,
      org: label(),
      recipe: S.plan.name || summary(S.plan),
      order,
      ids: result.ids,
      created: result.created,
      failed: result.failed.length,
    };
    if (result.created) {
      S.batches = [batch, ...S.batches];
      await store.set('nomadqa.batches', S.batches);
    }
    const secs = Math.round((Date.now() - started) / 1000);
    setNotice(
      result.failed.length ? 'warn' : 'good',
      `Created ${result.created} of ${records.length} records in ${label()} in ${secs} s` +
        (result.failed.length
          ? ` — ${result.failed.length} failed: ${[...new Set(result.failed.map((f) => f.message))]
              .slice(0, 3)
              .join(' · ')}`
          : '.')
    );
    S.view = 'batches';
  });
}

const summary = (plan) =>
  orderNodes(plan.nodes)
    .map((n) => `${objectLabel(n.object)} ${n.count}`)
    .join(' › ') || 'empty';

// ---------- recipes ----------

const READY = [
  {
    name: 'Sales: accounts, contacts and deals',
    nodes: [
      { id: 'a', object: 'Account', count: 10 },
      { id: 'c', object: 'Contact', count: 3, parentId: 'a', parentField: 'AccountId' },
      { id: 'o', object: 'Opportunity', count: 2, parentId: 'a', parentField: 'AccountId' },
    ],
  },
  {
    name: 'Service: accounts and cases',
    nodes: [
      { id: 'a', object: 'Account', count: 5 },
      { id: 'c', object: 'Contact', count: 2, parentId: 'a', parentField: 'AccountId' },
      { id: 'k', object: 'Case', count: 4, parentId: 'a', parentField: 'AccountId' },
    ],
  },
  { name: 'Leads', nodes: [{ id: 'l', object: 'Lead', count: 50 }] },
];

async function openRecipe(recipe) {
  await run('Opening the recipe…', async () => {
    const ids = new Map(recipe.nodes.map((n) => [n.id, newId()]));
    const nodes = [];
    for (const n of recipe.nodes) {
      const d = await ensure(n.object);
      nodes.push({
        ...n,
        id: ids.get(n.id),
        parentId: n.parentId ? ids.get(n.parentId) : undefined,
        rules: n.rules ?? defaultRules(d, { parentField: n.parentField }),
      });
    }
    S.plan = { name: recipe.name ?? '', seed: recipe.seed ?? 1, nodes };
    S.selected = nodes[0]?.id ?? null;
    S.preview = null;
    S.view = 'plan';
    savePlan();
    setNotice('good', `Opened “${S.plan.name || summary(S.plan)}”.`);
  });
}

function askText(message, value = '') {
  return new Promise((resolve) => {
    const input = h('input', { value, autocomplete: 'off' });
    const close = (v) => {
      backdrop.remove();
      resolve(v);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) close(input.value.trim());
      if (e.key === 'Escape') close(null);
    });
    const backdrop = h(
      'div',
      { class: 'backdrop' },
      h(
        'div',
        { class: 'dialog' },
        h('p', {}, message),
        input,
        h(
          'div',
          { class: 'actions' },
          h('button', { onclick: () => close(null) }, 'Cancel'),
          h('button', { class: 'primary', onclick: () => input.value.trim() && close(input.value.trim()) }, 'Save')
        )
      )
    );
    document.body.append(backdrop);
    input.focus();
    input.select();
  });
}

async function saveRecipe() {
  const name = await askText('A name for this recipe', S.plan.name || summary(S.plan));
  if (!name) return;
  S.plan.name = name;
  const recipe = {
    nomadqa: 'recipe',
    version: 1,
    name,
    seed: S.plan.seed,
    nodes: S.plan.nodes.map(({ recordTypeId, ...n }) => n),
  };
  S.recipes = [recipe, ...S.recipes.filter((r) => r.name !== name)];
  await store.set('nomadqa.recipes', S.recipes);
  savePlan();
  toast(`Saved “${name}”.`);
  render();
}

// ---------- screens ----------

function top() {
  const orgOptions = S.orgs.map((o) => [o.host, o.label]);
  return h(
    'header',
    { class: 'top' },
    h('div', { class: 'brand' }, h('img', { src: 'icons/48.png', alt: '' }), 'NomadQA'),
    S.orgs.length
      ? h(
          'label',
          { class: 'org-pick' },
          'Org',
          select(S.host, orgOptions, (v) => void chooseOrg(v), { 'aria-label': 'Org' })
        )
      : h('span', { class: 'muted' }, 'Log in to a Salesforce org in this browser, then reload'),
    S.facts
      ? h('span', { class: `pill ${S.facts.isSandbox ? 'good' : 'bad'}` }, S.facts.isSandbox ? 'Sandbox' : 'Production')
      : null,
    S.facts?.user ? h('span', { class: 'muted small' }, `${S.facts.user} · ${S.facts.name}`) : null,
    h('span', { class: 'grow' }),
    S.busy ? h('span', { class: 'pill accent', role: 'status' }, S.busy) : null
  );
}

function side() {
  const item = (view, text) =>
    h(
      'button',
      {
        class: S.view === view || (view === 'plan' && S.view === 'preview') ? 'on' : '',
        onclick: () => ((S.view = view === 'plan' && S.preview && S.view === 'preview' ? 'preview' : view), render()),
      },
      text
    );
  const later = (text) => h('button', { disabled: true }, text, h('span', { class: 'later' }, 'later'));
  return h(
    'nav',
    { class: 'side', 'aria-label': 'NomadQA' },
    item('plan', 'Test data'),
    item(
      'batches',
      h('span', {}, 'Batches ', S.batches.length ? h('span', { class: 'pill' }, S.batches.length) : null)
    ),
    item('recipes', 'Recipes'),
    h('hr'),
    later('Inspector'),
    later('Recorder'),
    later('Tests & runs'),
    later('Agent')
  );
}

function noticeEl() {
  if (!S.notice) return null;
  return h(
    'div',
    { class: `notice ${S.notice.kind}`, role: 'status' },
    S.notice.text,
    ' ',
    h('button', { class: 'link', onclick: () => (setNotice(), render()) }, 'Dismiss')
  );
}

function planView() {
  const total = counts(S.plan);
  const all = Object.values(total).reduce((a, b) => a + b, 0);
  return [
    h(
      'div',
      { class: 'head' },
      h('h1', {}, 'Test data'),
      h('span', { class: 'muted' }, 'Records that look real, with their links — for tests and demos'),
      h('span', { class: 'grow' }),
      S.plan.nodes.length
        ? h(
            'button',
            { onclick: () => ((S.plan = { name: '', seed: 1, nodes: [] }), (S.selected = null), savePlan(), render()) },
            'Start again'
          )
        : null,
      S.plan.nodes.length ? h('button', { onclick: () => void saveRecipe() }, 'Save as recipe') : null
    ),
    noticeEl(),
    !S.sf
      ? h('div', { class: 'card empty' }, S.orgError ? h('p', { class: 'bad' }, S.orgError) : 'Choose an org above.')
      : h('div', { class: 'grid' }, makeCard(total, all), rulesCard()),
    S.sf && S.plan.nodes.length
      ? h(
          'div',
          { class: 'row', style: 'justify-content: flex-end' },
          h(
            'button',
            { title: 'Same plan, other values', onclick: () => ((S.plan.seed += 1), savePlan(), render()) },
            'Other values'
          ),
          h(
            'button',
            { class: 'primary', disabled: !all || Boolean(S.busy), onclick: () => void preparePreview() },
            `Preview ${all.toLocaleString()} records →`
          )
        )
      : null,
  ];
}

function makeCard(total, all) {
  const rows = [];
  const walk = (parentId, depth) => {
    for (const n of S.plan.nodes.filter((x) => (x.parentId ?? null) === parentId)) {
      rows.push(nodeRow(n, depth));
      walk(n.id, depth + 1);
    }
  };
  walk(null, 0);
  const sel = S.plan.nodes.find((n) => n.id === S.selected);
  return h(
    'section',
    { class: 'card' },
    h('h2', {}, '1 · What to make'),
    rows.length
      ? h('div', { class: 'tree' }, rows)
      : h('p', { class: 'muted' }, 'Add an object to start, or open a recipe.'),
    adder(),
    h(
      'div',
      { class: 'row' },
      h('button', { onclick: () => ((S.adding = { type: 'object', value: '' }), render()) }, '+ Object'),
      sel
        ? h(
            'button',
            { onclick: () => ((S.adding = { type: 'child', parentId: sel.id }), render()) },
            `+ Records under ${objectLabel(sel.object)}`
          )
        : null
    ),
    all
      ? h(
          'p',
          { class: 'muted small' },
          'Total: ',
          h('b', {}, `${all.toLocaleString()} records`),
          ' — ',
          orderNodes(S.plan.nodes)
            .map((n) => `${total[n.id]} ${objectLabel(n.object)}`)
            .join(', '),
          '. Parents are made first and every link is filled in.'
        )
      : null
  );
}

function nodeRow(n, depth) {
  return h(
    'div',
    {
      class: `node${n.id === S.selected ? ' on' : ''}`,
      style: `margin-left: ${depth * 22}px`,
      onclick: () => ((S.selected = n.id), render()),
    },
    depth ? h('span', { class: 'arrow', 'aria-hidden': 'true' }, '↳') : null,
    h('span', { class: 'name' }, objectLabel(n.object)),
    objectLabel(n.object) !== n.object ? h('span', { class: 'api' }, n.object) : null,
    h('span', { class: 'grow' }),
    h('input', {
      class: 'num',
      type: 'number',
      min: '0',
      max: '5000',
      value: String(n.count),
      'aria-label': `How many ${n.object}`,
      onclick: (e) => e.stopPropagation(),
      onchange: (e) => ((n.count = Math.max(0, Math.min(5000, Number(e.target.value) || 0))), savePlan(), render()),
    }),
    h('span', { class: 'muted small' }, n.parentId ? 'each' : 'records'),
    h(
      'button',
      {
        class: 'icon',
        'aria-label': `Remove ${n.object}`,
        title: 'Remove (and what is under it)',
        onclick: (e) => (e.stopPropagation(), removeNode(n.id)),
      },
      '✕'
    )
  );
}

function adder() {
  if (!S.adding) return null;
  const cancel = h('button', { onclick: () => ((S.adding = null), render()) }, 'Cancel');
  if (S.adding.type === 'object') {
    const input = h('input', {
      list: 'nomadqa-objects',
      placeholder: 'Object, e.g. Account or Invoice__c',
      value: S.adding.value,
    });
    const add = () => void addObject(input.value);
    input.addEventListener('keydown', (e) => e.key === 'Enter' && add());
    setTimeout(() => input.focus(), 0);
    return h(
      'div',
      { class: 'adder' },
      input,
      h(
        'datalist',
        { id: 'nomadqa-objects' },
        (S.objects ?? []).map((o) => h('option', { value: o.name }, o.label))
      ),
      h('button', { class: 'primary', onclick: add }, 'Add'),
      cancel
    );
  }
  const parent = S.plan.nodes.find((n) => n.id === S.adding.parentId);
  const choices = childChoices(parent.object);
  let chosen = choices[0];
  return h(
    'div',
    { class: 'adder' },
    choices.length
      ? select(
          `${chosen.object}|${chosen.field}`,
          choices.map((c) => [`${c.object}|${c.field}`, c.text]),
          (v) => (chosen = choices.find((c) => `${c.object}|${c.field}` === v)),
          { 'aria-label': 'Records under it' }
        )
      : h('span', { class: 'muted' }, `Nothing can be created under ${objectLabel(parent.object)}.`),
    choices.length
      ? h(
          'button',
          {
            class: 'primary',
            onclick: () => ((S.adding.field = chosen.field), void addObject(chosen.object, parent.id)),
          },
          'Add'
        )
      : null,
    cancel
  );
}

const RULES = {
  base: [
    ['', '— not set'],
    ['auto', 'Auto'],
    ['empty', 'Leave empty'],
    ['fixed', 'Fixed value'],
    ['list', 'One of a list'],
    ['weighted', 'Weighted list'],
  ],
};

function ruleOptions(f) {
  if (f.type === 'reference')
    return [
      ['', '— not set'],
      ['query', 'Records from a query'],
      ['fixed', 'Fixed Id'],
      ['empty', 'Leave empty'],
    ];
  const out = [...RULES.base];
  if (/string|textarea|combobox|email|url|phone/.test(f.type)) out.push(['pattern', 'Pattern']);
  if (/int|double|currency|percent/.test(f.type)) out.push(['range', 'Range']);
  if (/^date/.test(f.type)) out.push(['dates', 'Days from today']);
  return out;
}

const AUTO_HINT = {
  picklist: 'any active value',
  multipicklist: 'one or two values',
  email: 'from the name, at example.com',
  url: 'from the company, .example.com',
  phone: '+61 2 5550 ####',
  boolean: 'true now and then',
  date: 'a date near today',
  datetime: 'a time near now',
  reference: '',
};

function setting(node, f, rule) {
  const set = (patch) => ((node.rules[f.name] = { ...rule, ...patch }), savePlan(), render());
  const input = (key, props = {}) =>
    h('input', { value: rule[key] ?? '', onchange: (e) => set({ [key]: e.target.value }), ...props });
  switch (rule.kind) {
    case 'fixed':
      return h('div', { class: 'setting' }, input('value', { 'aria-label': 'Value' }));
    case 'list':
      return h('div', { class: 'setting' }, input('value', { placeholder: 'a, b, c', 'aria-label': 'Values' }));
    case 'weighted':
      return h(
        'div',
        { class: 'setting' },
        input('value', { placeholder: 'Gold 20%, Silver 50%, Bronze 30%', 'aria-label': 'Weighted values' })
      );
    case 'pattern':
      return h(
        'div',
        { class: 'setting' },
        input('value', { placeholder: 'INV-{0000} · {parent.Name}', 'aria-label': 'Pattern' })
      );
    case 'range':
      return h(
        'div',
        { class: 'setting' },
        input('from', { class: 'short', type: 'number', 'aria-label': 'From' }),
        'to',
        input('to', { class: 'short', type: 'number', 'aria-label': 'To' })
      );
    case 'dates':
      return h(
        'div',
        { class: 'setting' },
        input('from', { class: 'short', type: 'number', 'aria-label': 'From day' }),
        'to',
        input('to', { class: 'short', type: 'number', 'aria-label': 'To day' }),
        h('span', { class: 'muted small' }, 'days')
      );
    case 'query':
      return h('div', { class: 'setting' }, input('soql', { class: 'mono', 'aria-label': 'Query' }));
    case 'auto':
      return h(
        'span',
        { class: 'muted small' },
        AUTO_HINT[f.type] ?? (f.type === 'string' || f.type === 'textarea' ? 'from the field’s name' : '')
      );
    default:
      return null;
  }
}

function rulesCard() {
  const node = S.plan.nodes.find((n) => n.id === S.selected);
  if (!node) return h('section', { class: 'card empty' }, 'Pick an object on the left to set its fields.');
  const d = S.describes[node.object];
  if (!d) return h('section', { class: 'card empty' }, 'Reading…');
  let sample = {};
  try {
    const recs = generate(
      { ...S.plan, nodes: S.plan.nodes.map((n) => (n.id === node.id ? n : { ...n, count: n.parentId ? 1 : 1 })) },
      S.describes,
      makeFaker(S.plan.seed),
      {
        lookups: S.lookups,
        picklists: S.picklists,
      }
    );
    sample = recs.find((r) => r.nodeId === node.id)?.values ?? {};
  } catch {
    sample = {};
  }
  const filter = S.fieldFilter.toLowerCase();
  const fields = writableFields(d)
    .filter((f) => f.name !== node.parentField)
    .filter((f) => !S.onlyRules || node.rules[f.name])
    .filter((f) => !filter || f.name.toLowerCase().includes(filter) || f.label.toLowerCase().includes(filter))
    .sort((a, b) => Number(isRequired(b)) - Number(isRequired(a)) || a.label.localeCompare(b.label));
  const types = (d.recordTypeInfos ?? []).filter((r) => r.available && !r.master);
  const show = (v, f) =>
    v === undefined
      ? h(
          'span',
          { class: 'muted' },
          f.type === 'reference' && node.rules[f.name]?.kind === 'query' ? 'found when previewing' : '—'
        )
      : typeof v === 'object'
      ? 'its parent'
      : String(v);
  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'row' },
      h('h2', {}, `2 · Field rules — ${objectLabel(node.object)}`),
      types.length
        ? select(
            node.recordType ?? '',
            [['', 'Default record type'], ...types.map((r) => [r.developerName, `Record type: ${r.name}`])],
            (v) => ((node.recordType = v || undefined), savePlan(), render()),
            { 'aria-label': 'Record type' }
          )
        : null,
      node.parentField ? h('span', { class: 'pill' }, `linked by ${node.parentField}`) : null
    ),
    h(
      'div',
      { class: 'row' },
      h('input', {
        class: 'grow',
        placeholder: 'Find a field',
        value: S.fieldFilter,
        oninput: (e) => {
          S.fieldFilter = e.target.value;
          clearTimeout(rulesCard.t);
          rulesCard.t = setTimeout(() => {
            render();
            const el = document.querySelector('input[placeholder="Find a field"]');
            el?.focus();
            el?.setSelectionRange(el.value.length, el.value.length);
          }, 250);
        },
      }),
      h(
        'label',
        { class: 'check' },
        h('input', {
          type: 'checkbox',
          checked: S.onlyRules,
          onchange: (e) => ((S.onlyRules = e.target.checked), render()),
        }),
        'Only fields with a rule'
      )
    ),
    h(
      'div',
      { class: 'table-box' },
      h(
        'table',
        {},
        h(
          'thead',
          {},
          h('tr', {}, h('th', {}, 'Field'), h('th', {}, 'Rule'), h('th', {}, 'Setting'), h('th', {}, 'Example'))
        ),
        h(
          'tbody',
          {},
          fields.map((f) => {
            const rule = node.rules[f.name];
            return h(
              'tr',
              {},
              h(
                'td',
                {},
                h('b', {}, f.label),
                ' ',
                isRequired(f) ? h('span', { class: 'pill bad' }, 'required') : null,
                h(
                  'span',
                  { class: 'sub mono' },
                  `${f.name} · ${f.type === 'reference' ? `Lookup(${(f.referenceTo ?? []).join(', ')})` : f.type}`
                )
              ),
              h(
                'td',
                {},
                select(
                  rule?.kind ?? '',
                  ruleOptions(f),
                  (v) => {
                    if (!v) delete node.rules[f.name];
                    else
                      node.rules[f.name] = {
                        kind: v,
                        ...(v === 'query'
                          ? { soql: `SELECT Id FROM ${(f.referenceTo ?? ['User'])[0]} LIMIT 200` }
                          : {}),
                        ...(v === 'range' ? { from: 1, to: 100 } : {}),
                        ...(v === 'dates' ? { from: -30, to: 30 } : {}),
                      };
                    savePlan();
                    render();
                  },
                  { 'aria-label': `Rule for ${f.name}` }
                )
              ),
              h('td', {}, rule ? setting(node, f, rule) : null),
              h(
                'td',
                { class: 'example', title: sample[f.name] !== undefined ? String(sample[f.name]) : '' },
                rule ? show(sample[f.name], f) : ''
              )
            );
          })
        )
      )
    ),
    fields.length === 0
      ? h(
          'p',
          { class: 'muted' },
          S.onlyRules
            ? 'No fields with a rule yet — untick “Only fields with a rule” to add some.'
            : 'No field matches.'
        )
      : null,
    h(
      'p',
      { class: 'muted small' },
      'Auto picks a value from the field’s type and name. Patterns: ',
      h('code', {}, '{0000}'),
      ' the record’s number, ',
      h('code', {}, '{parent.Name}'),
      ' its parent’s value. E-mails and websites always use example.com.'
    )
  );
}

function previewView() {
  const p = S.preview;
  const nodes = orderNodes(S.plan.nodes);
  const node = nodes.find((n) => n.id === p.tab) ?? nodes[0];
  const recs = p.records.filter((r) => r.nodeId === node.id);
  const keys = new Map(p.records.map((r) => [r.key, r]));
  const fields = [...new Set(recs.flatMap((r) => Object.keys(r.values)))].filter(
    (f) => f !== node.parentField && f !== 'RecordTypeId'
  );
  const types = typesOf()[node.object] ?? {};
  const failedBy = new Map((p.check?.failed ?? []).map((f) => [f.key, f.message]));
  const n = included().length;
  const parentName = (key) => {
    const parent = keys.get(key);
    return parent ? parent.values.Name ?? parent.values.LastName ?? parent.key : key;
  };
  const editCell = (r, f) =>
    h(
      'td',
      { class: 'cell' },
      h('input', {
        value: r.values[f] ?? '',
        'aria-label': `${f} of ${r.key}`,
        onchange: (e) => {
          const v = e.target.value;
          if (v === '') delete r.values[f];
          else
            r.values[f] = /int|double|currency|percent/.test(types[f])
              ? Number(v)
              : types[f] === 'boolean'
              ? v === 'true'
              : v;
        },
      })
    );
  const grouped = new Map();
  for (const f of p.check?.failed ?? []) grouped.set(f.message, [...(grouped.get(f.message) ?? []), f.key]);
  const nameOf = (key) => {
    const r = keys.get(key);
    return r ? `${objectLabel(r.object)} ${r.n}` : key;
  };
  return [
    h(
      'div',
      { class: 'head' },
      h('button', { class: 'link', onclick: () => ((S.view = 'plan'), render()) }, '← Plan'),
      h('h1', {}, `Preview · ${n.toLocaleString()} records`),
      h('span', { class: 'muted' }, 'Nothing is in the org yet'),
      p.excluded.size ? h('span', { class: 'pill warn' }, `${p.excluded.size} left out`) : null
    ),
    noticeEl(),
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        h('h2', {}, 'Check without saving'),
        h(
          'span',
          { class: 'muted small grow' },
          `Tries the records in ${label()} and rolls everything back: validation rules, required fields, triggers and flows run, nothing stays.`
        ),
        h(
          'button',
          { class: p.check ? '' : 'primary', disabled: Boolean(S.busy), onclick: () => void checkWithoutSaving() },
          p.check ? 'Check again' : 'Check'
        )
      ),
      n > CHECK_MAX ? h('p', { class: 'muted small' }, `Checks the first ${CHECK_MAX} records.`) : null,
      p.check
        ? h(
            'div',
            { class: 'row' },
            h('span', { class: 'pill good' }, `${p.check.ok} would save`),
            p.check.failed.length ? h('span', { class: 'pill bad' }, `${p.check.failed.length} would fail`) : null
          )
        : null,
      grouped.size
        ? h(
            'div',
            { class: 'notice bad' },
            h(
              'ul',
              { class: 'problems' },
              [...grouped]
                .slice(0, 8)
                .map(([msg, ks]) =>
                  h(
                    'li',
                    {},
                    h(
                      'b',
                      {},
                      ks.slice(0, 4).map(nameOf).join(', ') + (ks.length > 4 ? ` and ${ks.length - 4} more` : '')
                    ),
                    ' — ',
                    msg
                  )
                )
            ),
            h(
              'div',
              { class: 'row', style: 'margin-top: 8px' },
              h(
                'button',
                { onclick: leaveFailedOut },
                `Leave the ${p.check.failed.length} failing out (and what is under them)`
              ),
              h('button', { onclick: () => ((S.view = 'plan'), render()) }, 'Change the rules')
            )
          )
        : null
    ),
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'tabs', role: 'tablist' },
        nodes.map((x) =>
          h(
            'button',
            { role: 'tab', class: x.id === node.id ? 'on' : '', onclick: () => ((p.tab = x.id), render()) },
            objectLabel(x.object),
            h('span', { class: 'count' }, p.records.filter((r) => r.nodeId === x.id).length)
          )
        )
      ),
      h(
        'div',
        { class: 'table-box' },
        h(
          'table',
          { class: 'records' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              h('th', {}, '#'),
              node.parentId ? h('th', {}, `Under (${node.parentField})`) : null,
              fields.map((f) => h('th', {}, f)),
              h('th', {}, 'Check')
            )
          ),
          h(
            'tbody',
            {},
            recs.slice(0, SHOW_MAX).map((r) =>
              h(
                'tr',
                { class: failedBy.has(r.key) || p.excluded.has(r.key) ? 'bad' : '' },
                h('td', { class: 'muted' }, r.n),
                node.parentId ? h('td', {}, parentName(r.parentKey)) : null,
                fields.map((f) => editCell(r, f)),
                h(
                  'td',
                  {},
                  p.excluded.has(r.key)
                    ? h('span', { class: 'muted' }, 'left out')
                    : failedBy.has(r.key)
                    ? h('span', { class: 'bad', style: 'color: var(--bad)' }, '✕')
                    : p.check
                    ? h('span', { style: 'color: var(--good)' }, '✓')
                    : ''
                )
              )
            )
          )
        )
      ),
      recs.length > SHOW_MAX ? h('p', { class: 'muted small' }, `Showing ${SHOW_MAX} of ${recs.length}.`) : null
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Use it'),
      S.progress
        ? h(
            'div',
            {},
            h(
              'div',
              { class: 'bar' },
              h('div', { style: `width: ${Math.round((100 * S.progress.done) / S.progress.total)}%` })
            ),
            h('p', { class: 'muted small' }, `${S.progress.done} of ${S.progress.total}`)
          )
        : null,
      h(
        'div',
        { class: 'uses' },
        h(
          'div',
          { class: 'use main' },
          h('b', {}, `Create in ${label()}`),
          h(
            'p',
            {},
            `${n} records, parents first. Asks you to type the org’s name; kept as a batch you can delete in one click.`
          ),
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: S.allowDuplicates,
              onchange: (e) => (S.allowDuplicates = e.target.checked),
            }),
            'Save even when a duplicate rule matches'
          ),
          h(
            'button',
            { class: 'primary', disabled: !n || Boolean(S.busy), onclick: () => void createInOrg() },
            `Create ${n} records…`
          )
        ),
        h(
          'div',
          { class: 'use' },
          h('b', {}, 'CSV files'),
          h('p', {}, 'One per object, with a key per record and its parent’s key — for Data Loader or a spreadsheet.'),
          h(
            'button',
            {
              onclick: () =>
                Object.entries(csvFiles(included())).forEach(([name, text]) => download(name, `﻿${text}`, 'text/csv')),
            },
            'Download'
          )
        ),
        h(
          'div',
          { class: 'use' },
          h('b', {}, 'Apex test data factory'),
          h('p', {}, 'An @IsTest class that builds the same records inside your Apex tests.'),
          h(
            'button',
            { onclick: () => download('NomadQATestData.cls', factoryClass(included(), typesOf())) },
            'Get the class'
          )
        ),
        h(
          'div',
          { class: 'use' },
          h('b', {}, 'Recipe'),
          h('p', {}, 'Keep the plan to make the same kind of data again, here or in another org.'),
          h('button', { onclick: () => void saveRecipe() }, 'Save recipe')
        )
      )
    ),
  ];
}

function batchesView() {
  const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const total = (b) => Object.values(b.ids).reduce((a, l) => a + l.length, 0);
  const del = async (b) => {
    if (b.host !== S.host) return setNotice('warn', `That batch is in ${b.org}: choose it above first.`), render();
    const ok = await askTyped(
      `Delete the ${total(b)} records of this batch from ${b.org}? Children go first, then parents.`,
      b.org,
      { ok: 'Delete', danger: true }
    );
    if (!ok) return;
    await run('Deleting…', async () => {
      const r = await deleteBatch(S.sf, b);
      S.counts[b.id] = 0;
      setNotice(
        r.problems.length ? 'warn' : 'good',
        `Deleted ${r.deleted} records from ${b.org}.${
          r.problems.length ? ` ${r.problems.length} could not be deleted: ${r.problems.slice(0, 2).join(' · ')}` : ''
        }`
      );
      b.deletedAt = new Date().toISOString();
      await store.set('nomadqa.batches', S.batches);
    });
  };
  const count = (b) =>
    run('Counting…', async () => {
      if (b.host !== S.host) throw new Error(`That batch is in ${b.org}: choose it above first.`);
      S.counts[b.id] = await stillThere(S.sf, b);
    });
  const forget = async (b) => {
    S.batches = S.batches.filter((x) => x.id !== b.id);
    await store.set('nomadqa.batches', S.batches);
    render();
  };
  return [
    h(
      'div',
      { class: 'head' },
      h('h1', {}, 'Batches'),
      h('span', { class: 'muted' }, 'Every record NomadQA created, by run — so test data never gets lost in an org')
    ),
    noticeEl(),
    h(
      'section',
      { class: 'card' },
      S.batches.length
        ? h(
            'div',
            { class: 'table-box' },
            h(
              'table',
              {},
              h(
                'thead',
                {},
                h(
                  'tr',
                  {},
                  h('th', {}, 'When'),
                  h('th', {}, 'Org'),
                  h('th', {}, 'Recipe'),
                  h('th', {}, 'Records'),
                  h('th', {}, 'Still there'),
                  h('th', {}, '')
                )
              ),
              h(
                'tbody',
                {},
                S.batches.map((b) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, when(b.at)),
                    h('td', {}, b.org),
                    h('td', {}, b.recipe),
                    h(
                      'td',
                      {},
                      total(b),
                      h('span', { class: 'sub' }, b.order.map((o) => `${(b.ids[o] ?? []).length} ${o}`).join(' · '))
                    ),
                    h(
                      'td',
                      {},
                      S.counts[b.id] !== undefined
                        ? String(S.counts[b.id])
                        : h('button', { class: 'link', onclick: () => void count(b) }, 'Count')
                    ),
                    h(
                      'td',
                      { style: 'text-align: right' },
                      h(
                        'div',
                        { class: 'row', style: 'justify-content: flex-end; flex-wrap: nowrap' },
                        h(
                          'button',
                          {
                            onclick: () => (
                              navigator.clipboard.writeText(Object.values(b.ids).flat().join('\n')), toast('Ids copied')
                            ),
                          },
                          'Copy Ids'
                        ),
                        b.deletedAt || S.counts[b.id] === 0
                          ? h('button', { onclick: () => void forget(b) }, 'Remove from the list')
                          : h('button', { class: 'danger', onclick: () => void del(b) }, 'Delete the batch…')
                      )
                    )
                  )
                )
              )
            )
          )
        : h('p', { class: 'empty' }, 'No batches yet: records you create from Test data show here.'),
      h(
        'p',
        { class: 'muted small' },
        'Batches are kept in this browser, by record Id. Delete asks for the org’s name and removes children before parents.'
      )
    ),
  ];
}

function recipesView() {
  const upload = h('input', {
    type: 'file',
    accept: '.json,application/json',
    onchange: async (e) => {
      try {
        const r = JSON.parse(await e.target.files[0].text());
        if (r.nomadqa !== 'recipe' || !Array.isArray(r.nodes)) throw new Error('Not a NomadQA recipe file.');
        S.recipes = [r, ...S.recipes.filter((x) => x.name !== r.name)];
        await store.set('nomadqa.recipes', S.recipes);
        toast(`Added “${r.name}”.`);
      } catch (err) {
        setNotice('bad', err.message);
      }
      render();
    },
  });
  const card = (r, ready = false) =>
    h(
      'div',
      { class: `recipe${ready ? ' ready' : ''}` },
      h('b', {}, r.name),
      h('span', { class: 'muted small' }, r.nodes.map((n) => `${n.object} ${n.count}`).join(' › ')),
      h(
        'div',
        { class: 'row', style: 'margin-top: 6px' },
        h('button', { class: 'primary', disabled: !S.sf, onclick: () => void openRecipe(r) }, 'Open'),
        ready
          ? null
          : h(
              'button',
              {
                onclick: () =>
                  download(
                    `${r.name.replace(/[^\w-]+/g, '-')}.nomadqa.json`,
                    JSON.stringify(r, null, 2),
                    'application/json'
                  ),
              },
              'Download'
            ),
        ready
          ? null
          : h(
              'button',
              {
                class: 'icon',
                'aria-label': `Delete ${r.name}`,
                onclick: async () => (
                  (S.recipes = S.recipes.filter((x) => x !== r)),
                  await store.set('nomadqa.recipes', S.recipes),
                  render()
                ),
              },
              '✕'
            )
      )
    );
  return [
    h(
      'div',
      { class: 'head' },
      h('h1', {}, 'Recipes'),
      h(
        'span',
        { class: 'muted' },
        'Plans you keep, to make the same kind of data again — in any org with these objects'
      )
    ),
    noticeEl(),
    h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        h('h2', { class: 'grow' }, 'Yours'),
        h('label', { class: 'btn' }, 'Upload a recipe…', h('span', { style: 'display: none' }, upload))
      ),
      S.recipes.length
        ? h(
            'div',
            { class: 'recipes' },
            S.recipes.map((r) => card(r))
          )
        : h('p', { class: 'muted' }, 'None yet: “Save as recipe” on Test data keeps one here.')
    ),
    h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Ready-made'),
      h(
        'div',
        { class: 'recipes' },
        READY.map((r) => card(r, true))
      )
    ),
  ];
}

function render() {
  const root = document.getElementById('app');
  const y = window.scrollY;
  const view =
    S.view === 'preview' && S.preview
      ? previewView()
      : S.view === 'batches'
      ? batchesView()
      : S.view === 'recipes'
      ? recipesView()
      : planView();
  root.replaceChildren(top(), h('div', { class: 'layout' }, side(), h('main', {}, view)));
  window.scrollTo(0, y);
}

async function start() {
  S.batches = await store.get('nomadqa.batches', []);
  S.recipes = await store.get('nomadqa.recipes', []);
  S.plan = await store.get('nomadqa.plan', S.plan);
  S.selected = S.plan.nodes[0]?.id ?? null;
  S.orgs = await browserOrgs();
  const wanted = new URLSearchParams(location.search).get('host') || (await store.get('nomadqa.host', ''));
  const host = S.orgs.find((o) => o.host === wanted)?.host ?? S.orgs[0]?.host ?? '';
  render();
  if (host) await chooseOrg(host);
}

void start();
