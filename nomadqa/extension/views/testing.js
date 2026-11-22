// NomadQA pages for tests: Inspector, Recorder, Tests (edit and run), Runs, Agent, Settings (AI).
import { h, select, askTyped, toast, download } from '../core/ui.js';
import { ACTIONS, KINDS, OPS, stepText, problem, runTest, junit } from '../core/steps.js';
import { PROVIDERS, stepsFromWords } from '../core/ai.js';
import { apiHostFor } from '../core/salesforce.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SF_TABS = [
  'https://*.salesforce.com/*',
  'https://*.force.com/*',
  'https://*.salesforce-setup.com/*',
  'https://*.cloudforce.com/*',
];

// ---------- running in a browser tab ----------

async function waitTab(tabId, timeout = 90000) {
  await sleep(300);
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') return t;
    await sleep(250);
  }
  throw new Error('The page did not finish loading.');
}

/** Runs `func` in the tab's isolated world, with the engine there (put back after a reload). */
async function inTab(tabId, func, args = []) {
  for (let i = 0; ; i++) {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['core/engine.js'] });
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
      return r?.result;
    } catch (e) {
      if (i >= 6) throw e;
      await sleep(1000);
    }
  }
}

async function tabDriver(host) {
  const tab = await chrome.tabs.create({ url: `https://${host}/lightning/page/home`, active: true });
  await waitTab(tab.id);
  await inTab(tab.id, () => globalThis.__nomadqa.ready(90000));
  return {
    tabId: tab.id,
    async open(url) {
      await chrome.tabs.update(tab.id, { url });
      await waitTab(tab.id);
      await inTab(tab.id, () => globalThis.__nomadqa.ready(90000));
    },
    step: (s) => inTab(tab.id, (st) => globalThis.__nomadqa.run(st), [s]),
    // What the tab shows (the test's tab is in front while it runs)
    async shot() {
      if (!(await chrome.permissions.contains({ origins: ['<all_urls>'] }))) return undefined;
      const t = await chrome.tabs.get(tab.id);
      return chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' });
    },
  };
}

/** Puts the engine and the page script in a tab, then sets its mode (inspect, record, off). */
async function pageMode(tabId, mode, extra = {}) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['core/engine.js', 'content/page.js'] });
  return chrome.tabs.sendMessage(tabId, { type: 'nomadqa:mode', mode, ...extra });
}

export function testingViews(ctx) {
  const { S, render, run, setNotice, label, store, noticeEl } = ctx;
  const T = (S.testing = {
    tests: [],
    runs: [],
    ai: { provider: 'anthropic', model: '', base: '', key: '' },
    selected: null,
    results: null,
    recording: null,
    tabs: [],
    picked: [],
    agent: { words: '', result: null },
  });

  async function load() {
    T.tests = await store.get('nomadqa.tests', []);
    T.runs = await store.get('nomadqa.runs', []);
    T.ai = { ...T.ai, ...(await store.get('nomadqa.ai', {})) };
    T.recording = await store.get('nomadqa.recording', null);
    T.picked = await store.get('nomadqa.picked', []);
    // The Inspector's list follows the browser: tabs opened, moved to another page, or closed
    let soon;
    const again = () => {
      clearTimeout(soon);
      soon = setTimeout(() => S.view === 'inspector' && void salesforceTabs().then(render), 400);
    };
    chrome.tabs.onCreated.addListener(again);
    chrome.tabs.onRemoved.addListener(again);
    chrome.tabs.onUpdated.addListener((id, change) => (change.url || change.status === 'complete') && again());
    chrome.storage.onChanged.addListener((changes) => {
      if (changes['nomadqa.picked']) {
        T.picked = changes['nomadqa.picked'].newValue ?? [];
        if (S.view === 'tests') render();
      }
      if (changes['nomadqa.recording']) {
        T.recording = changes['nomadqa.recording'].newValue ?? null;
        if (S.view === 'recorder') render();
      }
    });
  }
  const saveTests = () => store.set('nomadqa.tests', T.tests);

  async function salesforceTabs() {
    const tabs = await chrome.tabs.query({ url: SF_TABS });
    T.tabs = tabs.filter((t) => t.url && !/\/secur\//.test(t.url));
  }

  // ---------- Inspector ----------
  function inspectorView() {
    if (!T.tabsRead) {
      T.tabsRead = true;
      void salesforceTabs().then(render);
    }
    return [
      h(
        'div',
        { class: 'head' },
        h('h1', {}, 'Inspector'),
        h('span', { class: 'muted' }, 'Point at anything on a Salesforce page: what it is, and where it comes from')
      ),
      noticeEl(),
      h(
        'section',
        { class: 'card' },
        h('h2', {}, 'Turn it on'),
        h(
          'p',
          { class: 'muted' },
          'On any Salesforce page press ',
          h('b', {}, 'Alt + Shift + I'),
          ' — or pick a tab here. Hover to see, click to pin and copy, Esc to stop.'
        ),
        orgTabs()
      ),
      h(
        'section',
        { class: 'card' },
        h('h2', {}, 'What it tells'),
        h(
          'ul',
          { class: 'problems' },
          h(
            'li',
            {},
            h('b', {}, 'Yours'),
            ' — your own Lightning web component (c-…) and its folder in the project, e.g. force-app/main/default/lwc/invoiceList'
          ),
          h('li', {}, h('b', {}, 'Package'), ' — a component from an installed package (its namespace)'),
          h(
            'li',
            {},
            h('b', {}, 'Field'),
            ' — the field’s API name on record pages (Account.Phone), or its label in forms'
          ),
          h('li', {}, h('b', {}, 'Aura'), ' — the Aura component behind older parts of the page'),
          h(
            'li',
            {},
            h('b', {}, 'Built from'),
            ' — the components around it, nearest first; and the record of the page'
          )
        )
      ),
    ];
  }
  // Every org logged in to in this browser, with its open tabs (any page: an app from the App Launcher, a record,
  // Setup…); an org without a tab can be opened right here. Tabs of orgs without a session come last.
  function orgTabs() {
    const byOrg = new Map((S.orgs ?? []).map((o) => [o.host, { label: o.label, host: o.host, tabs: [] }]));
    const other = [];
    for (const t of T.tabs) {
      const host = apiHostFor(new URL(t.url).host);
      (byOrg.get(host)?.tabs ?? other).push(t);
    }
    const tabRow = (t) =>
      h(
        'div',
        { class: 'org-tab' },
        h('span', { class: 'grow' }, t.title || 'Salesforce', h('span', { class: 'sub' }, new URL(t.url).pathname)),
        h('button', { class: 'primary', onclick: () => void inspect(t) }, 'Inspect this tab')
      );
    const groups = [...byOrg.values()];
    if (!groups.length && !other.length)
      return h(
        'p',
        { class: 'muted' },
        'Not logged in to any org in this browser. Log in to Salesforce, then come back.'
      );
    return h(
      'div',
      { class: 'org-tabs' },
      groups.map((g) =>
        h(
          'div',
          { class: 'org-group' },
          h(
            'div',
            { class: 'row' },
            h('b', { class: 'grow' }, g.label),
            h('span', { class: 'pill' }, `${g.tabs.length} tab${g.tabs.length === 1 ? '' : 's'}`),
            h(
              'button',
              { class: g.tabs.length ? '' : 'primary', onclick: () => void openAndInspect(g.host) },
              g.tabs.length ? 'Open another and inspect' : 'Open and inspect'
            )
          ),
          g.tabs.map(tabRow)
        )
      ),
      other.length ? h('div', { class: 'org-group' }, h('b', {}, 'Other Salesforce tabs'), other.map(tabRow)) : null
    );
  }
  async function openAndInspect(host) {
    try {
      const tab = await chrome.tabs.create({ url: `https://${host}/lightning/page/home`, active: true });
      await waitTab(tab.id);
      await inTab(tab.id, () => globalThis.__nomadqa.ready(90000));
      await pageMode(tab.id, 'inspect');
    } catch (e) {
      setNotice('bad', `Could not start there: ${e.message}`);
      render();
    }
  }
  async function inspect(tab) {
    try {
      await pageMode(tab.id, 'inspect');
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {
      setNotice('bad', `Could not start there: ${e.message}`);
      render();
    }
  }

  // ---------- Recorder ----------
  function recorderView() {
    const rec = T.recording;
    const active = rec && !rec.done;
    return [
      h(
        'div',
        { class: 'head' },
        h('h1', {}, 'Recorder'),
        h('span', { class: 'muted' }, 'Do it once in Salesforce: NomadQA writes the steps, by what you see')
      ),
      noticeEl(),
      h(
        'section',
        { class: 'card' },
        h(
          'div',
          { class: 'row' },
          h('h2', { class: 'grow' }, active ? 'Recording…' : rec ? 'Last recording' : 'Start'),
          active ? h('span', { class: 'pill bad' }, '● recording') : null,
          !active
            ? h(
                'button',
                { class: 'primary', disabled: !S.host, onclick: () => void startRecording() },
                `Record in ${label()}`
              )
            : h('button', { onclick: () => void stopRecording() }, 'Stop')
        ),
        h(
          'p',
          { class: 'muted small' },
          'A new tab opens on the org. Click, type and choose as usual; ',
          h('b', {}, '+ Check'),
          ' on the page’s NomadQA bar, then a value or a message, adds a check. Passwords are never recorded.'
        ),
        rec?.steps?.length
          ? h(
              'ol',
              { class: 'problems' },
              rec.steps.map((s) => h('li', {}, stepText(s)))
            )
          : h('p', { class: 'muted' }, 'No steps yet.'),
        rec?.steps?.length && !active
          ? h(
              'div',
              { class: 'row' },
              h('button', { class: 'primary', onclick: () => void saveRecording() }, 'Save as a test'),
              h(
                'button',
                { onclick: async () => ((T.recording = null), await store.set('nomadqa.recording', null), render()) },
                'Discard'
              )
            )
          : null
      ),
    ];
  }
  async function startRecording() {
    await run('Opening the org…', async () => {
      const tab = await chrome.tabs.create({ url: `https://${S.host}/lightning/page/home`, active: true });
      await waitTab(tab.id);
      await inTab(tab.id, () => globalThis.__nomadqa.ready(90000));
      await pageMode(tab.id, 'record');
      T.recordingTab = tab.id;
    });
  }
  async function stopRecording() {
    try {
      if (T.recordingTab) await chrome.tabs.sendMessage(T.recordingTab, { type: 'nomadqa:mode', mode: 'off' });
    } catch {
      /* the tab was closed */
    }
    if (T.recording) {
      T.recording = { ...T.recording, done: true };
      await store.set('nomadqa.recording', T.recording);
    }
    render();
  }
  async function saveRecording() {
    const test = {
      id: newId(),
      nomadqa: 'test',
      version: 1,
      name: `Recorded ${new Date().toLocaleString()}`,
      cleanup: true,
      steps: T.recording.steps,
      host: S.host,
    };
    T.tests = [test, ...T.tests];
    await saveTests();
    T.recording = null;
    await store.set('nomadqa.recording', null);
    T.selected = test.id;
    S.view = 'tests';
    toast('Saved as a test.');
    render();
  }

  // ---------- Tests ----------
  // What each step asks for: [key, label, placeholder, { options, wide }]
  const KIND_LABELS = {
    text: 'Text on the page',
    toast: 'A message (toast)',
    field: 'A field',
    title: 'The page title',
    url: 'The address',
    'no-text': 'Text is NOT shown',
    button: 'A button or link is shown',
    'no-button': 'A button or link is NOT shown',
  };
  const FIELDS = {
    open: [
      // One way to open: only the one in use shows (all of them on a new step)
      ['path', 'Page', '/lightning/o/Account/list', { wide: true, when: (s) => s.path || !(s.record || s.object) }],
      ['record', 'or a record', '{{found}} or an Id', { when: (s) => s.record || !(s.path || s.object) }],
      ['object', 'or an object', 'Account', { when: (s) => s.object || !(s.path || s.record) }],
      ['name', '… by its name', 'Acme', { when: (s) => s.object || !(s.path || s.record) }],
    ],
    click: [
      ['label', 'What it says', 'Save'],
      ['within', 'In (optional)', 'a section or dialog title'],
    ],
    fill: [
      ['field', 'Field', 'Last Name'],
      ['value', 'Value', 'Smith or {{found.Name}}'],
    ],
    pick: [
      ['field', 'Field', 'Stage'],
      ['value', 'Value', 'Closed Won'],
    ],
    lookup: [
      ['field', 'Field', 'Account Name'],
      ['value', 'Record name', 'Acme'],
    ],
    check: [
      ['field', 'Field', 'Active'],
      [
        'value',
        'Ticked',
        '',
        {
          options: [
            ['true', 'Ticked'],
            ['false', 'Not ticked'],
          ],
        },
      ],
    ],
    wait: [
      ['text', 'Until this text shows', 'Saved'],
      ['ms', 'or milliseconds', '1000'],
    ],
    press: [['key', 'Key', 'Enter, Escape, Tab…']],
    expect: [
      ['kind', 'What to check', '', { options: KINDS.map((k) => [k, KIND_LABELS[k]]) }],
      ['field', 'Field', 'Industry', { when: (s) => s.kind === 'field' }],
      [
        'op',
        'How',
        '',
        {
          options: Object.entries(OPS),
          when: (s) => ['field', 'toast', 'title', 'url'].includes(s.kind),
        },
      ],
      ['value', 'Value', 'Technology', { when: (s) => s.op !== 'empty' && s.op !== 'filled' }],
    ],
    remember: [
      ['field', 'Field on the page', 'Account Number'],
      ['as', 'Remember as', 'number → use {{number}} later'],
    ],
    shot: [],
    query: [
      ['soql', 'Query', "SELECT Id, Name FROM Account WHERE Name LIKE 'Acme%' LIMIT 1", { wide: true }],
      ['count', 'Rows it must find', 'empty = at least one'],
      ['save', 'Save the first row as', 'found → {{found}}, {{found.Name}}'],
    ],
    data: [],
  };

  function testsView() {
    const test = T.tests.find((t) => t.id === T.selected);
    const upload = h('input', {
      type: 'file',
      accept: '.json',
      onchange: async (e) => {
        try {
          const t = JSON.parse(await e.target.files[0].text());
          if (t.nomadqa !== 'test' || !Array.isArray(t.steps)) throw new Error('Not a NomadQA test file.');
          const copy = { ...t, id: newId() };
          T.tests = [copy, ...T.tests];
          await saveTests();
          T.selected = copy.id;
        } catch (err) {
          setNotice('bad', err.message);
        }
        render();
      },
    });
    const lastRun = (t) => T.runs.find((r) => r.testId === t.id);
    return [
      h(
        'div',
        { class: 'head' },
        h('h1', {}, 'Tests'),
        h('span', { class: 'muted' }, 'Steps by what a person sees — run here, or headless in CI'),
        h('span', { class: 'grow' }),
        h('button', { onclick: () => void newTest() }, '+ New test'),
        h('label', { class: 'btn' }, 'Upload…', h('span', { style: 'display: none' }, upload))
      ),
      noticeEl(),
      pickedCard(test),
      h(
        'div',
        { class: 'grid' },
        h(
          'section',
          { class: 'card' },
          h('h2', {}, 'Your tests'),
          T.tests.length
            ? h(
                'div',
                { class: 'tree' },
                T.tests.map((t) => {
                  const r = lastRun(t);
                  return h(
                    'div',
                    {
                      class: `node${t.id === T.selected ? ' on' : ''}`,
                      onclick: () => ((T.selected = t.id), (T.results = null), render()),
                    },
                    h('span', { class: 'name' }, t.name),
                    h('span', { class: 'grow' }),
                    h('span', { class: 'api' }, `${t.steps.length} steps`),
                    r ? h('span', { class: `pill ${r.ok ? 'good' : 'bad'}` }, r.ok ? 'passed' : 'failed') : null
                  );
                })
              )
            : h('p', { class: 'muted' }, 'None yet: record one, ask the Agent, or start a new one.')
        ),
        test ? editor(test) : h('section', { class: 'card empty' }, 'Pick a test on the left.')
      ),
    ];
  }

  // Steps added from the Inspector's pinned panel, waiting to go into a test
  function pickedCard(test) {
    if (!T.picked.length) return null;
    const clear = () => store.set('nomadqa.picked', []);
    const take = async (t) => {
      const n = T.picked.length;
      t.steps.push(...T.picked.map((p) => p.step));
      await saveTests();
      await clear();
      T.selected = t.id;
      T.results = null;
      T.picked = [];
      setNotice('good', `Added ${n} step${n === 1 ? '' : 's'} to “${t.name}”.`);
      render();
    };
    return h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        h('h2', { class: 'grow' }, `From the Inspector · ${T.picked.length} step${T.picked.length === 1 ? '' : 's'}`),
        test ? h('button', { class: 'primary', onclick: () => void take(test) }, `Add to “${test.name}”`) : null,
        h(
          'button',
          {
            class: test ? '' : 'primary',
            onclick: async () => {
              const first = T.picked[0];
              const t = {
                id: newId(),
                nomadqa: 'test',
                version: 1,
                name: 'Test from the Inspector',
                cleanup: true,
                steps: [],
              };
              // Starts where the first step was picked, unless it already opens a page
              if (first.step.action !== 'open') t.steps.push({ action: 'open', path: first.page });
              T.tests = [t, ...T.tests];
              await take(t);
            },
          },
          'New test from them'
        ),
        h('button', { onclick: () => void clear() }, 'Clear')
      ),
      h(
        'ol',
        { class: 'picked' },
        T.picked.map((p, i) =>
          h(
            'li',
            {},
            stepText(p.step),
            h('span', { class: 'muted small' }, ` · ${p.page}`),
            h(
              'button',
              {
                class: 'link',
                'aria-label': `Remove step ${i + 1}`,
                onclick: () =>
                  void store.set(
                    'nomadqa.picked',
                    T.picked.filter((_, j) => j !== i)
                  ),
              },
              '✕'
            )
          )
        )
      )
    );
  }

  async function newTest() {
    const t = {
      id: newId(),
      nomadqa: 'test',
      version: 1,
      name: 'New test',
      cleanup: true,
      steps: [{ action: 'open', path: '/lightning/o/Account/list' }],
    };
    T.tests = [t, ...T.tests];
    await saveTests();
    T.selected = t.id;
    T.results = null;
    render();
  }

  function editor(test) {
    const changed = () => void saveTests();
    const res = T.results?.testId === test.id ? T.results : null;
    const stepRow = (s, i) => {
      const r = res?.results?.[i];
      const bad = problem(s);
      const set = (k, v) => {
        if (v === '' || v === undefined) delete s[k];
        else s[k] = k === 'ms' || k === 'count' ? Number(v) : k === 'value' && s.action === 'check' ? v === 'true' : v;
        changed();
      };
      const fields = FIELDS[s.action] ?? [];
      return h(
        'tr',
        { class: r?.ok === false ? 'bad' : '' },
        h('td', { class: 'muted' }, i + 1),
        h(
          'td',
          {},
          select(
            s.action,
            Object.entries(ACTIONS).map(([k, a]) => [k, a.say]),
            (v) => ((test.steps[i] = { action: v }), changed(), render()),
            { 'aria-label': `Step ${i + 1} action` }
          )
        ),
        h(
          'td',
          {},
          s.action === 'data'
            ? h(
                'div',
                { class: 'setting' },
                select(
                  s.recipe?.name ?? '',
                  [
                    ['', 'Choose a recipe…'],
                    ...(s.recipe?.name && !S.recipes.some((rc) => rc.name === s.recipe.name)
                      ? [[s.recipe.name, `${s.recipe.name} (in this test)`]]
                      : []),
                    ...S.recipes.map((rc) => [rc.name, rc.name]),
                  ],
                  (v) => {
                    const rc = S.recipes.find((x) => x.name === v);
                    if (rc) s.recipe = { name: rc.name, seed: rc.seed, nodes: rc.nodes };
                    changed();
                    render();
                  }
                ),
                s.recipe
                  ? h('span', { class: 'muted small' }, s.recipe.nodes.map((n) => `${n.object} ${n.count}`).join(' › '))
                  : null
              )
            : h(
                'div',
                { class: 'step-fields' },
                fields
                  .filter(([, , , o]) => !o?.when || o.when(s))
                  .map(([k, lab, ph, o]) =>
                    h(
                      'label',
                      { class: `step-field${o?.wide ? ' wide' : ''}` },
                      h('span', {}, lab),
                      o?.options
                        ? h(
                            'select',
                            { onchange: (e) => (set(k, e.target.value), render()) },
                            o.options.map(([v, l]) =>
                              h('option', { value: v, selected: String(s[k] ?? o.options[0][0]) === String(v) }, l)
                            )
                          )
                        : h('input', {
                            value: s[k] === undefined ? '' : String(s[k]),
                            placeholder: ph,
                            title: s[k] === undefined ? ph : String(s[k]),
                            onchange: (e) => (set(k, e.target.value), render()),
                          })
                    )
                  ),
                h(
                  'label',
                  { class: 'check step-optional', title: 'If it fails, the test still goes on' },
                  h('input', {
                    type: 'checkbox',
                    checked: Boolean(s.optional),
                    onchange: (e) => (e.target.checked ? (s.optional = true) : delete s.optional, changed(), render()),
                  }),
                  'Optional'
                )
              ),
          h('span', { class: 'sub' }, stepText(s)),
          bad ? h('span', { class: 'sub', style: 'color: var(--bad)' }, bad) : null,
          r?.ok === false ? h('span', { class: 'sub', style: 'color: var(--bad)' }, r.message) : null
        ),
        h(
          'td',
          {},
          r
            ? h(
                'span',
                { class: `pill ${r.ok ? 'good' : r.ok === null ? '' : r.optional ? 'warn' : 'bad'}` },
                r.ok ? `✓ ${(r.ms / 1000).toFixed(1)} s` : r.ok === null ? 'not run' : r.optional ? '✕ optional' : '✕'
              )
            : null,
          r?.ok && r.message ? h('span', { class: 'sub' }, r.message) : null,
          r?.shot
            ? h(
                'a',
                { class: 'sub', href: r.shot, download: `step-${i + 1}.png`, title: 'Download the screenshot' },
                'Screenshot'
              )
            : null
        ),
        h(
          'td',
          { style: 'white-space: nowrap' },
          h(
            'button',
            {
              class: 'icon',
              'aria-label': 'Up',
              disabled: i === 0,
              onclick: () => (
                ([test.steps[i - 1], test.steps[i]] = [test.steps[i], test.steps[i - 1]]), changed(), render()
              ),
            },
            '↑'
          ),
          h(
            'button',
            {
              class: 'icon',
              'aria-label': 'Down',
              disabled: i === test.steps.length - 1,
              onclick: () => (
                ([test.steps[i + 1], test.steps[i]] = [test.steps[i], test.steps[i + 1]]), changed(), render()
              ),
            },
            '↓'
          ),
          h(
            'button',
            {
              class: 'icon',
              'aria-label': 'Remove step',
              onclick: () => (test.steps.splice(i, 1), changed(), render()),
            },
            '✕'
          )
        )
      );
    };
    const file = () => {
      const { id, host, ...rest } = test;
      return JSON.stringify(rest, null, 2);
    };
    const fname = `${test.name.replace(/[^\w-]+/g, '-').toLowerCase()}.nomadqa.json`;
    return h(
      'section',
      { class: 'card' },
      h(
        'div',
        { class: 'row' },
        h('input', {
          class: 'grow',
          value: test.name,
          'aria-label': 'Test name',
          style: 'font-weight: 600; font-size: 15px',
          onchange: (e) => ((test.name = e.target.value), changed(), render()),
        }),
        h(
          'label',
          { class: 'check' },
          h('input', {
            type: 'checkbox',
            checked: test.cleanup !== false,
            onchange: (e) => ((test.cleanup = e.target.checked), changed()),
          }),
          'Delete its test data after'
        ),
        h(
          'button',
          {
            class: 'primary',
            disabled: !S.sf || Boolean(S.busy) || !test.steps.length,
            onclick: () => void runHere(test),
          },
          `Run in ${label()}`
        )
      ),
      res?.ms !== undefined
        ? h(
            'div',
            { class: `notice ${res.ok ? 'good' : 'bad'}` },
            res.ok
              ? `Passed in ${(res.ms / 1000).toFixed(1)} s.`
              : `Failed at step ${res.results.findIndex((r) => r.ok === false && !r.optional) + 1}.`,
            res.cleaned ? ` ${res.cleaned} test record(s) deleted.` : ''
          )
        : null,
      h(
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
              h('th', {}, '#'),
              h('th', {}, 'Step'),
              h('th', {}, 'Details'),
              h('th', {}, 'Result'),
              h('th', {}, '')
            )
          ),
          h('tbody', {}, test.steps.map(stepRow))
        )
      ),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          { onclick: () => (test.steps.push({ action: 'click', label: '' }), changed(), render()) },
          '+ Step'
        ),
        h('span', { class: 'grow' }),
        h('button', { onclick: () => download(fname, file(), 'application/json') }, 'Download'),
        h(
          'button',
          {
            onclick: () => (
              navigator.clipboard.writeText(`node nomadqa/runner/run.mjs ${fname} --org <alias>`),
              toast('Command copied')
            ),
          },
          'Copy the headless command'
        ),
        h(
          'button',
          {
            class: 'danger',
            onclick: async () => {
              if (!(await askTyped(`Delete the test “${test.name}”?`, 'delete', { ok: 'Delete', danger: true })))
                return;
              T.tests = T.tests.filter((t) => t !== test);
              T.selected = null;
              await saveTests();
              render();
            },
          },
          'Delete test'
        )
      ),
      h(
        'p',
        { class: 'muted small' },
        'Headless (CI): ',
        h('code', {}, `node nomadqa/runner/run.mjs ${fname} --org <alias>`),
        ' — Chrome and Node 22, nothing to install; a JUnit report and a screenshot of a failed step.'
      )
    );
  }

  async function runHere(test) {
    // Screenshots of a tab need Chrome's "all sites" permission: asked only for a test that takes them (while the
    // click still counts as the person's), and only once
    if (test.steps.some((x) => x.action === 'shot'))
      await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
    const changes = test.steps.some((s) => ['click', 'fill', 'pick', 'lookup', 'check', 'data'].includes(s.action));
    if (changes && S.facts && !S.facts.isSandbox) {
      if (
        !(await askTyped(
          `${label()} is a PRODUCTION org. Run “${test.name}” there anyway? It may change data.`,
          label(),
          { ok: 'Run', danger: true }
        ))
      )
        return;
    }
    T.results = { testId: test.id, results: [] };
    await run(`Running “${test.name}”…`, async () => {
      const driver = await tabDriver(S.host);
      const out = await runTest(test, {
        driver,
        sf: S.sf,
        describes: S.describes,
        onStep: (i, r) => {
          T.results.results[i] = r;
          S.busy = `Running “${test.name}”: step ${i + 2} of ${test.steps.length}…`;
          render();
        },
      });
      T.results = { testId: test.id, ...out };
      const entry = {
        id: newId(),
        testId: test.id,
        testName: test.name,
        at: new Date().toISOString(),
        org: label(),
        ok: out.ok,
        ms: out.ms,
        results: out.results.map(({ shot, ...r }) => r),
        steps: test.steps.map(stepText),
        junit: junit(test, out),
      };
      T.runs = [entry, ...T.runs].slice(0, 100);
      await store.set('nomadqa.runs', T.runs);
      // Back to NomadQA to see the result
      const me = await chrome.tabs.getCurrent().catch(() => null);
      if (me) await chrome.tabs.update(me.id, { active: true }).catch(() => {});
    });
  }

  // ---------- Runs ----------
  function runsView() {
    const open = T.runs.find((r) => r.id === T.openRun);
    return [
      h(
        'div',
        { class: 'head' },
        h('h1', {}, 'Runs'),
        h('span', { class: 'muted' }, 'Every test run in this browser, newest first')
      ),
      noticeEl(),
      h(
        'section',
        { class: 'card' },
        T.runs.length
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
                    h('th', {}, 'Test'),
                    h('th', {}, 'Org'),
                    h('th', {}, 'Result'),
                    h('th', {}, 'Time'),
                    h('th', {}, '')
                  )
                ),
                h(
                  'tbody',
                  {},
                  T.runs.map((r) =>
                    h(
                      'tr',
                      { class: r.id === T.openRun ? 'bad' : '' },
                      h(
                        'td',
                        {},
                        new Date(r.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
                      ),
                      h('td', {}, r.testName),
                      h('td', {}, r.org),
                      h(
                        'td',
                        {},
                        h(
                          'span',
                          { class: `pill ${r.ok ? 'good' : 'bad'}` },
                          r.ok ? 'passed' : `failed at ${r.results.findIndex((x) => x.ok === false) + 1}`
                        )
                      ),
                      h('td', {}, `${(r.ms / 1000).toFixed(1)} s`),
                      h(
                        'td',
                        { style: 'text-align: right' },
                        h(
                          'button',
                          { onclick: () => ((T.openRun = T.openRun === r.id ? null : r.id), render()) },
                          T.openRun === r.id ? 'Close' : 'Steps'
                        ),
                        ' ',
                        h(
                          'button',
                          {
                            onclick: () =>
                              download(`${r.testName.replace(/[^\w-]+/g, '-')}.junit.xml`, r.junit, 'application/xml'),
                          },
                          'JUnit'
                        )
                      )
                    )
                  )
                )
              )
            )
          : h('p', { class: 'empty' }, 'No runs yet.'),
        T.runs.length
          ? h(
              'div',
              { class: 'row' },
              h(
                'button',
                { onclick: async () => ((T.runs = []), await store.set('nomadqa.runs', []), render()) },
                'Clear the list'
              )
            )
          : null
      ),
      open
        ? h(
            'section',
            { class: 'card' },
            h('h2', {}, open.testName),
            h(
              'ol',
              { class: 'problems' },
              open.steps.map((s, i) => {
                const r = open.results[i] ?? {};
                return h(
                  'li',
                  {},
                  h(
                    'span',
                    { style: `color: var(--${r.ok ? 'good' : r.ok === null ? 'faint' : 'bad'})` },
                    r.ok ? '✓ ' : r.ok === null ? '· ' : '✕ '
                  ),
                  s,
                  r.ok === false ? h('span', { class: 'sub', style: 'color: var(--bad)' }, r.message) : null
                );
              })
            )
          )
        : null,
    ];
  }

  // ---------- Agent ----------
  function agentView() {
    const res = T.agent.result;
    const words = h(
      'textarea',
      {
        rows: '5',
        style: 'width: 100%; resize: vertical',
        placeholder:
          'e.g. Make an account in Energy, open it, add a contact Robin Tester, and check the contact is linked to the account.',
        oninput: (e) => (T.agent.words = e.target.value),
      },
      T.agent.words
    );
    return [
      h(
        'div',
        { class: 'head' },
        h('h1', {}, 'Agent'),
        h('span', { class: 'muted' }, 'Say what to test: your AI writes the steps, NomadQA checks them, you run them')
      ),
      noticeEl(),
      !T.ai.key && T.ai.provider !== 'custom'
        ? h(
            'div',
            { class: 'notice warn' },
            'Connect your AI first: ',
            h('button', { class: 'link', onclick: () => ((S.view = 'settings'), render()) }, 'Settings'),
            '. Only your sentence and this org’s object names are sent to it.'
          )
        : null,
      h(
        'section',
        { class: 'card' },
        words,
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            { class: 'primary', disabled: Boolean(S.busy), onclick: () => void askAgent() },
            'Write the steps'
          ),
          h(
            'span',
            { class: 'muted small' },
            `${PROVIDERS[T.ai.provider]?.label ?? 'AI'} · ${T.ai.model || PROVIDERS[T.ai.provider]?.model || ''}`
          )
        )
      ),
      res
        ? h(
            'section',
            { class: 'card' },
            h(
              'div',
              { class: 'row' },
              h('h2', { class: 'grow' }, res.test.name),
              res.problems.length
                ? h('span', { class: 'pill bad' }, `${res.problems.length} step(s) to fix`)
                : h('span', { class: 'pill good' }, 'every step is valid')
            ),
            h(
              'ol',
              { class: 'problems' },
              res.test.steps.map((s, i) => {
                const p = res.problems.find((x) => x.i === i);
                return h(
                  'li',
                  {},
                  stepText(s),
                  p ? h('span', { class: 'sub', style: 'color: var(--bad)' }, p.problem) : null
                );
              })
            ),
            h(
              'div',
              { class: 'row' },
              h('button', { class: 'primary', onclick: () => void keepAgentTest(false) }, 'Save as a test'),
              h(
                'button',
                { disabled: res.problems.length > 0 || !S.sf, onclick: () => void keepAgentTest(true) },
                `Save and run in ${label()}`
              )
            )
          )
        : null,
    ];
  }
  async function askAgent() {
    if (!T.agent.words.trim()) return;
    await run('The AI is writing the steps…', async () => {
      T.agent.result = await stepsFromWords(T.ai, T.agent.words, { objects: S.objects ?? [] });
    });
  }
  async function keepAgentTest(andRun) {
    const t = { ...T.agent.result.test, id: newId() };
    T.tests = [t, ...T.tests];
    await saveTests();
    T.selected = t.id;
    S.view = 'tests';
    T.agent.result = null;
    render();
    if (andRun) await runHere(t);
  }

  // ---------- Settings ----------
  function settingsView() {
    const ai = T.ai;
    const p = PROVIDERS[ai.provider] ?? PROVIDERS.custom;
    return [
      h('div', { class: 'head' }, h('h1', {}, 'Settings'), h('span', { class: 'muted' }, 'Your AI for the Agent')),
      noticeEl(),
      h(
        'section',
        { class: 'card', style: 'max-width: 640px' },
        h('label', { class: 'muted small' }, 'Provider'),
        select(
          ai.provider,
          Object.entries(PROVIDERS).map(([k, v]) => [k, v.label]),
          (v) => ((ai.provider = v), render())
        ),
        ai.provider === 'custom'
          ? [
              h('label', { class: 'muted small' }, 'Endpoint (OpenAI-compatible, …/v1)'),
              h('input', { value: ai.base, onchange: (e) => (ai.base = e.target.value.trim()) }),
            ]
          : null,
        h('label', { class: 'muted small' }, 'Model'),
        h('input', {
          value: ai.model,
          placeholder: p.model || 'model name',
          onchange: (e) => (ai.model = e.target.value.trim()),
        }),
        h('label', { class: 'muted small' }, 'Key'),
        h('input', {
          type: 'password',
          value: ai.key,
          autocomplete: 'off',
          placeholder: 'kept in this browser only',
          onchange: (e) => (ai.key = e.target.value.trim()),
        }),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'primary', onclick: () => void saveAi() }, 'Save'),
          ai.key
            ? h(
                'button',
                {
                  onclick: async () => (
                    (ai.key = ''), await store.set('nomadqa.ai', ai), toast('Key removed.'), render()
                  ),
                },
                'Forget the key'
              )
            : null
        ),
        h(
          'p',
          { class: 'muted small' },
          'The key stays in this browser. The Agent sends only your sentence and the names of this org’s objects — never records.'
        )
      ),
    ];
  }
  async function saveAi() {
    const base = (T.ai.base || PROVIDERS[T.ai.provider]?.base || '').replace(/\/$/, '');
    try {
      const origin = new URL(base).origin;
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) throw new Error(`NomadQA needs your permission to talk to ${origin}.`);
      await store.set('nomadqa.ai', T.ai);
      toast('Saved.');
    } catch (e) {
      setNotice('bad', e.message);
    }
    render();
  }

  return {
    load,
    views: {
      inspector: inspectorView,
      recorder: recorderView,
      tests: testsView,
      runs: runsView,
      agent: agentView,
      settings: settingsView,
    },
  };
}
