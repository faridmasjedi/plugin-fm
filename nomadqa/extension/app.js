// NomadQA › Test data: plan the records, preview and check them, create them, and clean them up again.
import { h, select, searchSelect, askTyped, toast, download } from './core/ui.js';
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
  fitRecipe,
} from './core/plan.js';
import { checkScripts, readCheck, factoryClass } from './core/apex.js';
import { createRecords, deleteBatch, stillThere, csvFiles, failureSummary } from './core/create.js';
import { dataTable } from './core/table.js';
import { whereOf, readWide, childIds, buildClones, fitClones, copyable } from './core/clone.js';
import { log, mountLog } from './core/log.js';
import { findSwitches, coverage, turnOn, turnOff } from './core/bypass.js';
import { testingViews } from './views/testing.js';

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
  shown: {},
  job: null,
  clone: { object: '', where: '', rows: null, picked: new Set(), children: [], copies: 1, marker: null },
  busy: '',
  progress: null,
  notice: null,
  bypass: { switches: null, all: false, coverage: {}, use: new Set() },
};

const label = () => S.orgs.find((o) => o.host === S.host)?.label ?? S.host;
const objectLabel = (name) => S.objects?.find((o) => o.name === name)?.label ?? S.describes[name]?.label ?? name;
let nextId = 1;
const newId = () => `n${Date.now().toString(36)}${nextId++}`;
const savePlan = () => store.set('nomadqa.plan', S.plan);

function setNotice(kind, text) {
  S.notice = text ? { kind, text } : null;
}

const AREA = {
  plan: 'Test data',
  preview: 'Test data',
  clone: 'Clone',
  batches: 'Batches',
  recipes: 'Recipes',
  inspector: 'Inspector',
  recorder: 'Recorder',
  tests: 'Tests',
  runs: 'Runs',
  agent: 'Agent',
  settings: 'Settings',
};

async function run(what, fn) {
  S.busy = what;
  const quiet = what === 'Creating…';
  const entry = quiet ? null : log(AREA[S.view] ?? 'NomadQA', what, { status: 'working' });
  render();
  try {
    await fn();
    entry?.done(`${what.replace(/…$/, '')} — done`);
  } catch (e) {
    entry?.problem(e.message);
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

const switchKey = (x) => (x.kind === 'setting' ? `${x.object}.${x.field}` : `perm:${x.name}`);

/** The org's own automation switches: looked for on request (reads only), used only when ticked. */
function automationCard() {
  const B = S.bypass;
  const objects = [...new Set(S.plan.nodes.map((x) => x.object))];
  const look = (all) =>
    run('Looking for automation switches (reading only)…', async () => {
      B.all = all;
      B.switches = await findSwitches(S.sf, { all });
      B.coverage = {};
      // What checks each one (a few: the ones named like a switch; on request when every one is listed)
      if (!all) for (const sw of B.switches) B.coverage[switchKey(sw)] = await coverage(S.sf, sw, objects);
    });
  const seeCoverage = (sw) =>
    run('Reading what checks it…', async () => {
      B.coverage[switchKey(sw)] = await coverage(S.sf, sw, objects);
    });
  const n = (list) => `${list.filter((x) => x.checks).length} of ${list.length}`;
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'row' }, h('h2', {}, 'Automation while creating'), h('span', { class: 'pill' }, 'optional')),
    h(
      'p',
      { class: 'muted small' },
      'Some orgs have their own switch to turn validation rules, triggers or flows off for one user: a hierarchy custom setting checkbox, or a custom permission. NomadQA looks for ones named like ',
      h('i', {}, 'bypass, skip, disable, override'),
      ', then reads which active validation rules and triggers on ',
      objects.join(', ') || 'these objects',
      ' mention them. Looking changes nothing; a ticked switch is turned on for you only while creating, then put back exactly as it was.'
    ),
    B.switches === null
      ? h(
          'div',
          { class: 'row' },
          h('button', { disabled: Boolean(S.busy), onclick: () => void look(false) }, 'Look for switches')
        )
      : [
          B.switches.length
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
                      h('th', {}, 'Switch'),
                      h('th', {}, 'Kind'),
                      h('th', {}, 'What checks it'),
                      h('th', {}, 'Use while creating')
                    )
                  ),
                  h(
                    'tbody',
                    {},
                    B.switches.map((sw) => {
                      const key = switchKey(sw);
                      const cov = B.coverage[key];
                      const missing = cov ? [...cov.rules, ...cov.triggers].filter((x) => !x.checks) : [];
                      return h(
                        'tr',
                        {},
                        h(
                          'td',
                          {},
                          h('b', {}, sw.label),
                          h('span', { class: 'sub mono' }, sw.kind === 'setting' ? `${sw.object}.${sw.field}` : sw.name)
                        ),
                        h(
                          'td',
                          { class: 'muted' },
                          sw.kind === 'setting'
                            ? 'Custom setting (your user level)'
                            : 'Custom permission (a permission set)'
                        ),
                        h(
                          'td',
                          {},
                          cov
                            ? [
                                h('span', {}, `${n(cov.rules)} validation rules · ${n(cov.triggers)} triggers`),
                                missing.length
                                  ? h(
                                      'span',
                                      { class: 'sub' },
                                      `Still run: ${missing
                                        .map((x) => `${x.object}.${x.name}`)
                                        .slice(0, 5)
                                        .join(', ')}${missing.length > 5 ? '…' : ''}`
                                    )
                                  : null,
                              ]
                            : h('button', { class: 'link', onclick: () => void seeCoverage(sw) }, 'See what checks it')
                        ),
                        h(
                          'td',
                          {},
                          h(
                            'label',
                            { class: 'check' },
                            h('input', {
                              type: 'checkbox',
                              checked: B.use.has(key),
                              onchange: (e) => (e.target.checked ? B.use.add(key) : B.use.delete(key), render()),
                            }),
                            'Use'
                          )
                        )
                      );
                    })
                  )
                )
              )
            : h(
                'p',
                { class: 'muted' },
                B.all
                  ? 'This org has no hierarchy custom setting checkbox or custom permission.'
                  : 'Nothing named like a switch here: validation rules, triggers and flows run as usual.'
              ),
          h(
            'div',
            { class: 'row' },
            h(
              'label',
              { class: 'check' },
              h('input', { type: 'checkbox', checked: B.all, onchange: (e) => void look(e.target.checked) }),
              'List every custom setting checkbox and custom permission'
            ),
            h('span', { class: 'muted small' }, 'Flows are not read: check them by hand.')
          ),
        ]
  );
}

/** The objects of what is being previewed (a plan, or records found to clone). */
const previewNodes = () => S.preview?.nodes ?? S.plan.nodes;
const previewName = () => S.preview?.name ?? (S.plan.name || summary(S.plan));

async function createInOrg() {
  const records = included();
  const production = S.facts && !S.facts.isSandbox;
  const calls = Math.ceil(records.length / 200);
  const ok = await askTyped(
    `Create ${records.length.toLocaleString()} records in ${label()}? About ${calls.toLocaleString()} calls to Salesforce${
      calls > 50 ? ' (they count towards the org’s daily API limit; this takes a few minutes)' : ''
    }. They are kept as a batch you can delete later.`,
    label(),
    {
      ok: `Create ${records.length.toLocaleString()}`,
      extra: production
        ? `${label()} is a PRODUCTION org. Test data there is seen by real users and reports.`
        : undefined,
    }
  );
  if (!ok) return;
  const order = [];
  for (const n of orderNodes(previewNodes())) if (!order.includes(n.object)) order.push(n.object);
  // The batch exists from the start and grows as records are made: leaving the page or stopping keeps it
  const batch = {
    id: newId(),
    at: new Date().toISOString(),
    host: S.host,
    org: label(),
    recipe: previewName(),
    order,
    ids: {},
    status: 'running',
    total: records.length,
  };
  S.batches = [batch, ...S.batches];
  S.job = { batchId: batch.id, done: 0, total: records.length, stop: false };
  let lastSave = 0;
  const keep = async (force = false) => {
    if (!force && Date.now() - lastSave < 1500) return;
    lastSave = Date.now();
    await store.set('nomadqa.batches', S.batches);
  };
  await keep(true);
  const entry = log('Test data', `Creating ${records.length.toLocaleString()} records in ${label()}…`, {
    status: 'working',
  });
  await run('Creating…', async () => {
    S.progress = { done: 0, total: records.length };
    const started = Date.now();
    // The org's own automation switches: on for this user only while creating, then exactly as before
    const used = (S.bypass.switches ?? []).filter((x) => S.bypass.use.has(switchKey(x)));
    const undo = [];
    for (const sw of used) {
      undo.push(await turnOn(S.sf, sw, S.facts.userId));
      log('Test data', `Automation switch ${sw.label} on for you`);
    }
    let result;
    try {
      result = await createRecords(S.sf, records, {
        allowDuplicates: S.allowDuplicates,
        stop: () => S.job?.stop,
        saved: (object, made) => {
          (batch.ids[object] ??= []).push(...made);
          void keep();
        },
        progress: (done, total) => {
          S.progress = { done, total };
          if (S.job) S.job.done = done;
          entry.update(`Creating in ${label()}: ${done.toLocaleString()} of ${total.toLocaleString()}…`);
          render();
        },
      });
    } finally {
      for (const u of undo.reverse()) await turnOff(S.sf, u);
      if (used.length) log('Test data', `Automation switch${used.length > 1 ? 'es' : ''} put back as before`);
    }
    batch.status = result.stopped ? 'stopped' : 'done';
    batch.created = result.created;
    batch.failed = result.failed.length;
    if (!result.created) S.batches = S.batches.filter((b) => b !== batch);
    S.job = null;
    await keep(true);
    const secs = Math.round((Date.now() - started) / 1000);
    // What each object gave, and why records failed (Salesforce's own words)
    const fails = failureSummary(result.failed);
    for (const object of order) {
      const made = (result.ids[object] ?? []).length;
      const want = records.filter((r) => r.object === object).length;
      const why = fails.filter((f) => f.object === object);
      log('Test data', `${object}: ${made.toLocaleString()} of ${want.toLocaleString()} made`, {
        status: made < want ? 'problem' : 'done',
        detail: why.length ? why.map((f) => `${f.count} × ${f.message}`).join('\n') : undefined,
      });
    }
    const text =
      `${
        result.stopped ? 'Stopped: made' : 'Made'
      } ${result.created.toLocaleString()} of ${records.length.toLocaleString()} records in ${label()} in ${secs} s` +
      (fails.length
        ? ` — ${result.failed.length.toLocaleString()} not made: ${fails
            .slice(0, 3)
            .map((f) => `${f.object}: ${f.message}`)
            .join(' · ')}. The Log has every reason.`
        : '.');
    if (fails.length || result.stopped) entry.problem(text);
    else entry.done(text);
    setNotice(fails.length || result.stopped ? 'warn' : 'good', text);
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
    // The objects this org has (a recipe may come from another org)
    const describes = {};
    for (const n of recipe.nodes) {
      if (describes[n.object] !== undefined) continue;
      const known = S.objects?.some((o) => o.name === n.object);
      describes[n.object] = known ? await ensure(n.object).catch(() => undefined) : undefined;
    }
    for (const k of Object.keys(describes)) if (!describes[k]) delete describes[k];
    const { nodes: fitted, changes } = fitRecipe(recipe, describes);
    const ids = new Map(fitted.map((n) => [n.id, newId()]));
    const nodes = fitted.map((n) => ({
      ...n,
      id: ids.get(n.id),
      parentId: n.parentId ? ids.get(n.parentId) : undefined,
    }));
    S.plan = { name: recipe.name ?? '', seed: recipe.seed ?? 1, nodes };
    S.selected = nodes[0]?.id ?? null;
    S.preview = null;
    S.view = 'plan';
    savePlan();
    setNotice(
      changes.length ? 'warn' : 'good',
      changes.length
        ? `Opened “${S.plan.name || summary(S.plan)}”, fitted to ${label()}: ${changes.join(' ')}`
        : `Opened “${S.plan.name || summary(S.plan)}”: everything it needs is in ${label()}.`
    );
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
    // Creating goes on on any page: its progress stays here, and opens its batch
    S.job
      ? h(
          'button',
          { class: 'job', title: 'Open its batch', onclick: () => ((S.view = 'batches'), render()) },
          h(
            'span',
            { class: 'job-bar' },
            h('span', { style: `width: ${Math.round((100 * S.job.done) / Math.max(1, S.job.total))}%` })
          ),
          `Creating ${S.job.done.toLocaleString()} of ${S.job.total.toLocaleString()}`
        )
      : S.busy
      ? h('span', { class: 'pill accent', role: 'status' }, S.busy)
      : null
  );
}

function side() {
  const item = (view, text) =>
    h(
      'button',
      {
        class: S.view === view || (S.view === 'preview' && (S.preview?.back ?? 'plan') === view) ? 'on' : '',
        onclick: () => (
          (S.view = S.view === 'preview' && (S.preview?.back ?? 'plan') === view ? 'preview' : view), render()
        ),
      },
      text
    );
  return h(
    'nav',
    { class: 'side', 'aria-label': 'NomadQA' },
    item('plan', 'Test data'),
    item('clone', 'Find & clone'),
    item(
      'batches',
      h('span', {}, 'Batches ', S.batches.length ? h('span', { class: 'pill' }, S.batches.length) : null)
    ),
    item('recipes', 'Recipes'),
    h('hr'),
    item('inspector', 'Inspector'),
    item('recorder', 'Recorder'),
    item('tests', 'Tests'),
    item('runs', 'Runs'),
    item('agent', 'Agent'),
    h('hr'),
    item('settings', 'Settings')
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

/** Clone screen: a pattern for the names of the copies, alone or with the copied value after it. */
function markerParts(m, set) {
  return [
    h('b', {}, 'Pattern in names'),
    h('input', {
      value: m.text,
      placeholder: 'e.g. Nomad',
      style: 'width: 120px',
      'aria-label': 'Pattern',
      onchange: (e) => set({ text: e.target.value }),
    }),
    h(
      'label',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        checked: (m.mode ?? 'then') === 'then',
        onchange: (e) => set({ mode: e.target.checked ? 'then' : 'only' }),
      }),
      'with the copied value added'
    ),
  ];
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
        : null,
      // Only an object at the top can get a parent: one parent per object in a plan
      sel && !sel.parentId
        ? h(
            'button',
            { onclick: () => ((S.adding = { type: 'parent', nodeId: sel.id }), render()) },
            `+ Records above ${objectLabel(sel.object)}`
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

// The objects a record can sit under: its lookups to objects that can be created (not users, owners, record types)
const NOT_PARENTS = new Set(['User', 'Group', 'RecordType', 'Profile', 'UserRole', 'Organization', 'BusinessHours']);
const NOT_PARENT_FIELDS = new Set(['OwnerId', 'CreatedById', 'LastModifiedById', 'RecordTypeId', 'MasterRecordId']);

function parentChoices(object) {
  const d = S.describes[object];
  if (!d || !S.objects) return [];
  const creatable = new Set(S.objects.map((o) => o.name));
  const out = [];
  for (const f of d.fields) {
    if (f.type !== 'reference' || !f.createable || NOT_PARENT_FIELDS.has(f.name)) continue;
    const targets = (f.referenceTo ?? []).filter((t) => creatable.has(t) && !NOT_PARENTS.has(t));
    for (const t of targets)
      out.push({
        object: t,
        field: f.name,
        required: !f.nillable && !f.defaultedOnCreate,
        many: targets.length > 1,
        fieldLabel: f.label,
      });
  }
  return out.sort(
    (a, b) => b.required - a.required || a.many - b.many || objectLabel(a.object).localeCompare(objectLabel(b.object))
  );
}

async function addParent(node, object, field) {
  await run(`Reading ${objectLabel(object)}…`, async () => {
    const d = await ensure(object);
    const parent = { id: newId(), object, count: 1, rules: defaultRules(d) };
    node.parentId = parent.id;
    node.parentField = field;
    delete node.rules[field]; // the link is filled in from the new parent
    S.plan.nodes.splice(S.plan.nodes.indexOf(node), 0, parent);
    S.selected = parent.id;
    S.adding = null;
    savePlan();
    setNotice(
      'good',
      `${objectLabel(node.object)} now goes under ${objectLabel(object)} (by ${field}): 1 ${objectLabel(object)} with ${
        node.count
      } ${objectLabel(node.object)} each. Change the numbers as you like.`
    );
  });
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
    // A short list you can type in (all the org's objects), as in NomadSF
    return h(
      'div',
      { class: 'adder' },
      searchSelect(
        '',
        (S.objects ?? []).map((o) => [o.name, o.label, o.name]),
        (v) => void addObject(v),
        { placeholder: 'Choose an object…', open: true, 'aria-label': 'Object' }
      ),
      cancel
    );
  }
  if (S.adding.type === 'parent') {
    // The objects it can go under: its lookups, required ones first
    const node = S.plan.nodes.find((n) => n.id === S.adding.nodeId);
    const ups = parentChoices(node.object);
    const key = (p) => `${p.object}|${p.field}`;
    let up = ups[0];
    return h(
      'div',
      { class: 'adder' },
      ups.length
        ? select(
            key(up),
            ups.map((p) => [
              key(p),
              `${objectLabel(p.object)} · ${p.field}${p.required ? ' (required)' : ''}`,
              p.fieldLabel,
            ]),
            (v) => (up = ups.find((p) => key(p) === v)),
            { 'aria-label': 'Records above it' }
          )
        : h('span', { class: 'muted' }, `${objectLabel(node.object)} has no lookup to an object that can be created.`),
      ups.length
        ? h('button', { class: 'primary', onclick: () => void addParent(node, up.object, up.field) }, 'Add')
        : null,
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
        input('value', { placeholder: 'Nomad · INV-{0000} · {parent.Name}', 'aria-label': 'Pattern' }),
        /url|phone/.test(f.type)
          ? null
          : h(
              'label',
              { class: 'check', title: 'The pattern, then a value NomadQA makes up: “Nomad Oakline Logistics”' },
              h('input', {
                type: 'checkbox',
                checked: Boolean(rule.random),
                onchange: (e) => set({ random: e.target.checked }),
              }),
              'with random added'
            )
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
  const nodes = orderNodes(previewNodes());
  const node = nodes.find((n) => n.id === p.tab) ?? nodes[0];
  const recs = p.records.filter((r) => r.nodeId === node.id);
  const keys = new Map(p.records.map((r) => [r.key, r]));
  const fields = [...new Set(recs.flatMap((r) => Object.keys(r.values)))].filter(
    (f) => f !== node.parentField && f !== 'RecordTypeId'
  );
  const types = typesOf()[node.object] ?? {};
  const failedBy = new Map((p.check?.failed ?? []).map((f) => [f.key, f.message]));
  const n = included().length;
  // Which parent record a child goes under: any record of the parent object in this preview
  const parents = node.parentId ? p.records.filter((x) => x.nodeId === node.parentId) : [];
  const parentPick = (r) =>
    select(
      r.parentKey,
      parents.map((x) => [
        x.key,
        `${x.values.Name ?? x.values.LastName ?? x.values.Subject ?? x.key}`,
        `${objectLabel(x.object)} ${x.n}`,
      ]),
      (v) => {
        r.parentKey = v;
        r.values[node.parentField] = { $ref: v };
        if (S.preview.check) S.preview.check = null;
        render();
      },
      { 'aria-label': `Parent of ${r.key}` }
    );
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
      h(
        'button',
        { class: 'link', onclick: () => ((S.view = p.back ?? 'plan'), render()) },
        p.back === 'clone' ? '← Find & clone' : '← Plan'
      ),
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
              p.back === 'clone'
                ? null
                : h('button', { onclick: () => ((S.view = 'plan'), render()) }, 'Change the rules')
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
      dataTable({
        name: `preview-${node.object}`,
        columns: [
          ['#', '#'],
          ...(node.parentId ? [['__parent', `Under (${node.parentField})`]] : []),
          ...fields.map((f) => [f, f]),
          ['__check', 'Check'],
        ],
        rows: recs,
        maxShown: SHOW_MAX,
        note: 'Type in a cell to change a value.',
        value: (k, r) =>
          k === '#'
            ? r.n
            : k === '__parent'
            ? parentName(r.parentKey)
            : k === '__check'
            ? p.excluded.has(r.key)
              ? 'left out'
              : failedBy.has(r.key)
              ? `✕ ${failedBy.get(r.key)}`
              : p.check
              ? '✓'
              : ''
            : r.values[k],
        cell: (k, r) =>
          k === '__parent' ? parentPick(r) : k === '#' || k === '__check' ? null : editCell(r, k).firstChild,
      })
    ),
    automationCard(),
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
          h('b', {}, 'Create in an org'),
          S.orgs.length > 1
            ? select(
                S.host,
                S.orgs.map((o) => [o.host, o.label]),
                (v) => void createElsewhere(v),
                { 'aria-label': 'Org to create in' }
              )
            : h('span', { class: 'mono small' }, label()),
          h(
            'p',
            {},
            `${n} records, parents first. You type the org’s name to confirm; they are kept as a batch you can delete in one click.`
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
          S.bypass.use.size
            ? h('span', { class: 'pill accent' }, `${S.bypass.use.size} automation switch(es) on while creating`)
            : null,
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
                Object.entries(csvFiles(included())).forEach(([name, text]) =>
                  download(name, `\uFEFF${text}`, 'text/csv')
                ),
            },
            'Download'
          )
        ),
        h(
          'div',
          { class: 'use' },
          h('b', {}, 'Apex test data factory'),
          h(
            'p',
            {},
            'An @IsTest class with these records. Add it to your project, then call ',
            h('code', {}, 'NomadQATestData.make()'),
            ' in a test method: the records exist only while that test runs.'
          ),
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
          h(
            'p',
            {},
            'The plan, not the records: open it again here or in another org, and it is checked against that org’s objects and fields.'
          ),
          h('button', { onclick: () => void saveRecipe() }, 'Save recipe')
        )
      )
    ),
  ];
}

/** Creating in another org: the same plan, made again from that org's fields (and checked there). */
async function createElsewhere(host) {
  if (host === S.host) return;
  const to = S.orgs.find((o) => o.host === host)?.label ?? host;
  const ok = await askTyped(
    S.preview?.back === 'clone'
      ? `Make these clones in ${to}? Fields ${to} lacks, links to other records and record types are left out.`
      : `Make the preview again in ${to}? The plan stays; values come from ${to}’s fields, and records found by a query are looked up there.`,
    to,
    { ok: 'Switch' }
  );
  if (!ok) return render();
  const clones = S.preview?.back === 'clone' ? S.preview : null;
  await chooseOrg(host);
  if (!S.sf) return;
  if (!clones) return void (await preparePreview());
  await run('Fitting the clones to this org…', async () => {
    for (const n of clones.nodes) await ensure(n.object).catch(() => null);
    const fit = fitClones(clones, S.describes);
    S.preview = { ...clones, ...fit, excluded: new Set(), check: null, tab: fit.nodes[0]?.id };
    S.view = 'preview';
    if (fit.changes.length) setNotice('warn', fit.changes.join(' '));
  });
}

// ---------- find & clone ----------

const nameFieldOf = (d) => d.fields.find((f) => f.nameField)?.name ?? 'Id';

async function findToClone() {
  const c = S.clone;
  await run(`Finding ${objectLabel(c.object)} records…`, async () => {
    const d = await ensure(c.object);
    const name = nameFieldOf(d);
    const where = whereOf(c.where, name);
    const soql = `SELECT Id${name !== 'Id' ? `, ${name}` : ''}, CreatedDate, LastModifiedDate FROM ${c.object}${
      where ? ` WHERE ${where}` : ''
    } ORDER BY LastModifiedDate DESC LIMIT 200`;
    c.rows = (await S.sf.query(soql, { max: 200 })).map((r) => ({ ...r, Name: r[name] ?? r.Id }));
    c.picked = new Set();
    log('Find & clone', `Found ${c.rows.length} ${objectLabel(c.object)}`, { detail: soql });
  });
}

async function previewClones() {
  const c = S.clone;
  const ids = c.rows.filter((r) => c.picked.has(r.Id)).map((r) => r.Id);
  await run(`Reading ${ids.length} records and what is under them…`, async () => {
    const pd = await ensure(c.object);
    const parent = {
      object: c.object,
      describe: pd,
      rows: await readWide(
        S.sf,
        c.object,
        copyable(pd).map((f) => f.name),
        ids
      ),
    };
    const children = [];
    for (const ch of c.children) {
      const d = await ensure(ch.object);
      const kidIds = await childIds(S.sf, ch.object, ch.field, ids);
      const names = [...new Set([ch.field, ...copyable(d).map((f) => f.name)])];
      children.push({ ...ch, describe: d, rows: kidIds.length ? await readWide(S.sf, ch.object, names, kidIds) : [] });
    }
    const { nodes, records } = buildClones({ parent, children, copies: c.copies, marker: c.marker });
    S.preview = {
      records,
      nodes,
      excluded: new Set(),
      tab: 'p',
      check: null,
      back: 'clone',
      name: `Clones of ${ids.length} ${objectLabel(c.object)}${c.copies > 1 ? ` ×${c.copies}` : ''}`,
    };
    S.view = 'preview';
    setNotice();
    log('Find & clone', `Previewing ${records.length} clones`, {
      detail: nodes.map((n) => `${n.object}: ${records.filter((r) => r.nodeId === n.id).length}`).join('\n'),
    });
  });
}

function cloneView() {
  const c = S.clone;
  const marker = c.marker ?? { text: '', where: 'names', mode: 'then' };
  const picked = c.rows?.filter((r) => c.picked.has(r.Id)).length ?? 0;
  const kids = c.object && S.describes[c.object] ? childChoices(c.object) : [];
  const total = picked * Math.max(1, c.copies);
  return [
    h(
      'div',
      { class: 'head' },
      h('h1', {}, 'Find & clone'),
      h(
        'span',
        { class: 'muted' },
        'Copy real records (and what is under them) as test data — nothing changes until you create'
      )
    ),
    noticeEl(),
    !S.sf
      ? h('div', { class: 'card empty' }, 'Choose an org above.')
      : h(
          'section',
          { class: 'card' },
          h('h2', {}, '1 · Find'),
          h(
            'div',
            { class: 'row' },
            searchSelect(
              c.object,
              (S.objects ?? []).map((o) => [o.name, o.label, o.name]),
              (v) => {
                Object.assign(c, { object: v, rows: null, picked: new Set(), children: [] });
                void run('Reading the object…', () => ensure(v));
              },
              { placeholder: 'Choose an object…', 'aria-label': 'Object' }
            ),
            h('input', {
              class: 'grow',
              value: c.where,
              placeholder: "Words in the name — or a condition, e.g. Industry = 'Energy' AND CreatedDate = THIS_YEAR",
              'aria-label': 'What to find',
              oninput: (e) => (c.where = e.target.value),
              onkeydown: (e) => e.key === 'Enter' && c.object && void findToClone(),
            }),
            h(
              'button',
              { class: 'primary', disabled: !c.object || Boolean(S.busy), onclick: () => void findToClone() },
              'Find'
            )
          ),
          h('p', { class: 'muted small' }, 'Shows the 200 changed last. Only reads.')
        ),
    c.rows
      ? h(
          'section',
          { class: 'card' },
          h(
            'div',
            { class: 'row' },
            h('h2', { class: 'grow' }, '2 · Pick'),
            h('span', { class: 'pill' }, `${picked} picked`),
            h('button', { onclick: () => ((c.picked = new Set(c.rows.map((r) => r.Id))), render()) }, 'Pick all'),
            h('button', { onclick: () => ((c.picked = new Set()), render()) }, 'None')
          ),
          c.rows.length
            ? dataTable({
                name: `clone-${c.object}`,
                columns: [
                  ['__pick', '✓'],
                  ['Name', 'Name'],
                  ['Id', 'Id'],
                  ['LastModifiedDate', 'Last changed'],
                ],
                rows: c.rows,
                value: (k, r) => (k === '__pick' ? (c.picked.has(r.Id) ? 'yes' : '') : r[k]),
                cell: (k, r) =>
                  k === '__pick'
                    ? h('input', {
                        type: 'checkbox',
                        checked: c.picked.has(r.Id),
                        'aria-label': `Pick ${r.Name}`,
                        onchange: (e) => (e.target.checked ? c.picked.add(r.Id) : c.picked.delete(r.Id), render()),
                      })
                    : k === 'Name'
                    ? h('a', { href: `https://${S.host}/${r.Id}`, target: '_blank' }, r.Name)
                    : null,
              })
            : h('p', { class: 'muted' }, 'Nothing found.')
        )
      : null,
    picked
      ? h(
          'section',
          { class: 'card' },
          h('h2', {}, '3 · Clone'),
          h(
            'div',
            { class: 'row' },
            h('b', {}, 'With the records under them'),
            kids.length
              ? searchSelect(
                  '',
                  kids
                    .filter((k) => !c.children.some((x) => x.field === k.field && x.object === k.object))
                    .map((k) => [`${k.object}.${k.field}`, k.text]),
                  (v) => {
                    const k = kids.find((x) => `${x.object}.${x.field}` === v);
                    if (k) c.children.push({ object: k.object, field: k.field, text: k.text });
                    render();
                  },
                  { placeholder: 'Add an object under them…', 'aria-label': 'Records under them' }
                )
              : h('span', { class: 'muted small' }, 'None'),
            c.children.map((k, i) =>
              h(
                'span',
                { class: 'pill accent' },
                k.text,
                ' ',
                h(
                  'button',
                  {
                    class: 'link',
                    'aria-label': `Remove ${k.text}`,
                    onclick: () => (c.children.splice(i, 1), render()),
                  },
                  '✕'
                )
              )
            )
          ),
          h(
            'div',
            { class: 'row' },
            h('b', {}, 'Copies of each'),
            h('input', {
              type: 'number',
              min: 1,
              max: 50,
              value: c.copies,
              style: 'width: 80px',
              'aria-label': 'Copies of each',
              onchange: (e) => ((c.copies = Math.min(50, Math.max(1, Number(e.target.value) || 1))), render()),
            }),
            markerParts(marker, (patch) => ((c.marker = { ...marker, ...patch }), render()))
          ),
          h(
            'p',
            { class: 'muted small' },
            'Every writable field is copied, except ones that must be unique. Records under them are copied one level down and linked to the new copy. You see them all in the preview, can check them without saving, and create them as a batch — in this org or another.'
          ),
          h(
            'div',
            { class: 'row', style: 'justify-content: flex-end' },
            h(
              'button',
              { class: 'primary', disabled: Boolean(S.busy), onclick: () => void previewClones() },
              `Preview ${total} clone${total === 1 ? '' : 's'}${c.children.length ? ' and what is under them' : ''} →`
            )
          )
        )
      : null,
  ];
}

function batchesView() {
  const when = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const total = (b) => Object.values(b.ids).reduce((a, l) => a + l.length, 0);
  const del = async (b) => {
    if (b.host !== S.host) return setNotice('warn', `That batch is in ${b.org}: choose it above first.`), render();
    const ok = await askTyped(
      `Delete the ${total(b).toLocaleString()} records of this batch from ${b.org}? Children go first, then parents.`,
      b.org,
      { ok: 'Delete', danger: true }
    );
    if (!ok) return;
    await run('Deleting…', async () => {
      const r = await deleteBatch(S.sf, b);
      S.counts[b.id] = 0;
      delete S.shown[b.id];
      setNotice(
        r.problems.length ? 'warn' : 'good',
        `Deleted ${r.deleted.toLocaleString()} records from ${b.org}.${
          r.problems.length ? ` ${r.problems.length} could not be deleted: ${r.problems.slice(0, 2).join(' · ')}` : ''
        }`
      );
      if (r.problems.length)
        log('Batches', `${r.problems.length} record(s) not deleted`, {
          status: 'problem',
          detail: r.problems.join('\n'),
        });
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
  // The batch's records by name, a box per object (opened like a dropdown), each opening in Salesforce
  const showRecords = (b) => {
    if (S.shown[b.id]) {
      delete S.shown[b.id];
      return render();
    }
    if (b.host !== S.host) return setNotice('warn', `That batch is in ${b.org}: choose it above first.`), render();
    void run('Reading the records…', async () => {
      const rows = [];
      for (const object of b.order) {
        const ids = b.ids[object] ?? [];
        if (!ids.length) continue;
        const d = await ensure(object);
        const nameField = d.fields.find((f) => f.nameField)?.name ?? 'Id';
        const names = new Map();
        for (let i = 0; i < ids.length && i < 2000; i += 300) {
          const chunk = ids.slice(i, i + 300);
          for (const r of await S.sf.query(
            `SELECT Id, ${nameField} FROM ${object} WHERE Id IN (${chunk.map((x) => `'${x}'`).join(',')})`
          ))
            names.set(r.Id, r[nameField]);
        }
        ids.slice(0, 2000).forEach((id) =>
          rows.push({
            Object: objectLabel(object),
            Name: names.get(id) ?? '',
            Id: id,
            State: names.has(id) ? 'in the org' : 'deleted',
            api: object,
          })
        );
      }
      S.shown[b.id] = rows;
    });
  };
  const recordsOf = (b) =>
    dataTable({
      name: `batch-${b.id}`,
      columns: ['Object', 'Name', 'Id', 'State'],
      rows: S.shown[b.id],
      groupBy: 'Object',
      note: '· up to 2,000 per object · click a name to open it',
      cell: (k, r) =>
        k === 'Name' && r.State !== 'deleted'
          ? h(
              'a',
              { href: `https://${b.host}/lightning/r/${r.api}/${r.Id}/view`, target: '_blank', rel: 'noreferrer' },
              r.Name || r.Id
            )
          : undefined,
    });
  return [
    h(
      'div',
      { class: 'head' },
      h('h1', {}, 'Batches'),
      h('span', { class: 'muted' }, 'Every record NomadQA created, by run — so test data never gets lost in an org')
    ),
    noticeEl(),
    S.batches.length
      ? S.batches.map((b) => {
          const running = S.job?.batchId === b.id;
          const made = total(b);
          return h(
            'section',
            { class: 'card batch' },
            h(
              'div',
              { class: 'row' },
              h(
                'div',
                { class: 'grow' },
                h('b', {}, b.recipe),
                h('span', { class: 'sub' }, `${when(b.at)} · ${b.org}`)
              ),
              running
                ? h('span', { class: 'pill accent' }, 'creating…')
                : b.status === 'stopped'
                ? h('span', { class: 'pill warn' }, 'stopped')
                : b.status === 'running'
                ? h('span', { class: 'pill warn' }, 'interrupted')
                : null,
              b.failed
                ? h(
                    'span',
                    { class: 'pill bad', title: 'The Log has the reasons' },
                    `${b.failed.toLocaleString()} not made`
                  )
                : null
            ),
            running
              ? h(
                  'div',
                  {},
                  h(
                    'div',
                    { class: 'bar' },
                    h('div', { style: `width: ${Math.round((100 * S.job.done) / S.job.total)}%` })
                  ),
                  h(
                    'p',
                    { class: 'muted small' },
                    `${S.job.done.toLocaleString()} of ${S.job.total.toLocaleString()} done · ${made.toLocaleString()} made so far`
                  )
                )
              : null,
            h(
              'p',
              { class: 'small' },
              h('b', {}, `${made.toLocaleString()} records`),
              ' — ',
              b.order.map((o) => `${(b.ids[o] ?? []).length.toLocaleString()} ${objectLabel(o)}`).join(' · ')
            ),
            h(
              'div',
              { class: 'row' },
              running
                ? h(
                    'button',
                    {
                      class: 'danger',
                      onclick: () => ((S.job.stop = true), toast('Stopping after the calls on their way…'), render()),
                    },
                    'Stop'
                  )
                : [
                    h(
                      'button',
                      { disabled: !made, onclick: () => void showRecords(b) },
                      S.shown[b.id] ? 'Hide records' : 'Show records'
                    ),
                    S.counts[b.id] !== undefined
                      ? h('span', { class: 'muted small' }, `${S.counts[b.id].toLocaleString()} still in the org`)
                      : h('button', { disabled: !made, onclick: () => void count(b) }, 'Count what is still there'),
                    h('span', { class: 'grow' }),
                    b.deletedAt || S.counts[b.id] === 0 || !made
                      ? h('button', { onclick: () => void forget(b) }, 'Remove from the list')
                      : h('button', { class: 'danger', onclick: () => void del(b) }, 'Delete the batch…'),
                  ]
            ),
            S.shown[b.id] && !running ? recordsOf(b) : null
          );
        })
      : h(
          'section',
          { class: 'card' },
          h('p', { class: 'empty' }, 'No batches yet: records you create from Test data show here.')
        ),
    h(
      'p',
      { class: 'muted small' },
      'Batches are kept in this browser, by record Id. A batch is saved while it is being made, so stopping or closing the page keeps what was made. Delete asks for the org’s name and removes children before parents.'
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
      : S.view === 'clone'
      ? cloneView()
      : TESTING.views[S.view]
      ? TESTING.views[S.view]()
      : planView();
  root.replaceChildren(top(), h('div', { class: 'layout' }, side(), h('main', {}, view)));
  window.scrollTo(0, y);
}

const TESTING = testingViews({ S, render, run, setNotice, label, store, noticeEl });

async function start() {
  mountLog();
  await TESTING.load();
  const view = new URLSearchParams(location.search).get('view');
  if (view) S.view = view;
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
