// NomadQA pages for tests: Inspector, Recorder, Tests (edit and run), Runs, Agent, Settings (AI).
import { h, select, askTyped, toast, download } from '../core/ui.js';
import {
  ACTIONS,
  KINDS,
  OPS,
  COUNT_WHAT,
  stepText,
  problem,
  runTest,
  stepper,
  junit,
  groupJunit,
  testsFromFile,
} from '../core/steps.js';
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

/** The cookies of an org's own domains (My Domain, Lightning, Setup, Visualforce), to put back after a test logs in. */
async function orgCookies(host) {
  const stem = host.replace(/\.my\.salesforce\.com$/, '');
  return (await chrome.cookies.getAll({})).filter((c) => {
    const d = c.domain.replace(/^\./, '');
    return d.startsWith(`${stem}.`) || d.startsWith(`${stem}--`);
  });
}

/** Drives a tab of the org: a new one, `tabId` (a tab already there), or one in a window of its own (`window`:
 * where it goes on the screen — tests of a group running side by side). */
async function tabDriver(host, { tabId, window: place } = {}) {
  const home = `https://${host}/lightning/page/home`;
  const win = place
    ? await chrome.windows
        .create({ url: home, focused: true, ...place })
        .catch(() => chrome.windows.create({ url: home, focused: true }))
    : null;
  const tab = win
    ? win.tabs[0]
    : tabId
    ? await chrome.tabs.get(tabId)
    : await chrome.tabs.create({ url: home, active: true });
  await waitTab(tab.id);
  await inTab(tab.id, () => globalThis.__nomadqa.ready(90000));
  let kept = null;
  return {
    tabId: tab.id,
    async open(url) {
      await chrome.tabs.update(tab.id, { url });
      await waitTab(tab.id);
      await inTab(tab.id, () => globalThis.__nomadqa.ready(90000));
    },
    // A page that is not Lightning (the login page): loaded, nothing more
    async load(url) {
      await chrome.tabs.update(tab.id, { url });
      await waitTab(tab.id);
    },
    // After the login form is sent: the redirects end on Lightning (or stay on a login or verification page)
    async settle(timeout = 90000) {
      const end = Date.now() + timeout;
      let still = 0;
      while (Date.now() < end) {
        await sleep(500);
        const t = await chrome.tabs.get(tab.id);
        if (t.status !== 'complete') {
          still = 0;
          continue;
        }
        if (/\/lightning\//.test(t.url ?? ''))
          return void (await inTab(tab.id, () => globalThis.__nomadqa.ready(60000)));
        if (++still > 16) return;
      }
    },
    url: async () => (await chrome.tabs.get(tab.id)).url ?? '',
    // The login form makes the page go away: run once, never again on the next page
    step: (s) =>
      s.action === 'login-form'
        ? chrome.scripting
            .executeScript({ target: { tabId: tab.id }, files: ['core/engine.js'] })
            .then(() =>
              chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: (st) => globalThis.__nomadqa.run(st),
                args: [s],
              })
            )
            .then(([r]) => r?.result)
            .catch(() => undefined)
        : inTab(tab.id, (st) => globalThis.__nomadqa.run(st), [s]),
    // Logging in as someone else replaces your session in this browser: it is kept first, and put back after
    async keepSession() {
      if (!kept) kept = await orgCookies(host);
    },
    forgetSession() {
      kept = null;
    },
    async restoreSession() {
      if (!kept) return;
      for (const c of kept) {
        const domain = c.domain.replace(/^\./, '');
        await chrome.cookies
          .set({
            url: `https://${domain}${c.path}`,
            name: c.name,
            value: c.value,
            path: c.path,
            secure: c.secure,
            httpOnly: c.httpOnly,
            sameSite: c.sameSite,
            ...(c.hostOnly ? {} : { domain: c.domain }),
            ...(c.session ? {} : { expirationDate: c.expirationDate }),
          })
          .catch(() => {});
      }
      kept = null;
      await this.open(`https://${host}/lightning/page/home`).catch(() => {});
    },
    async close() {
      if (win) await chrome.windows.remove(win.id).catch(() => {});
    },
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
    logins: [],
    debug: null, // the test gone through step by step on a Salesforce page: { testId, tabId, st, driver }
    groupResult: null,
    groupTabs: {}, // a group's tests at the same time: { name: n }
  });
  const loginsMap = () =>
    Object.fromEntries(
      T.logins.filter((l) => l.name).map((l) => [l.name, { url: l.url, username: l.username, password: l.password }])
    );

  async function load() {
    T.groupTabs = await store.get('nomadqa.groupTabs', {});
    T.tests = await store.get('nomadqa.tests', []);
    T.runs = await store.get('nomadqa.runs', []);
    T.ai = { ...T.ai, ...(await store.get('nomadqa.ai', {})) };
    T.recording = await store.get('nomadqa.recording', null);
    T.picked = await store.get('nomadqa.picked', []);
    T.logins = await store.get('nomadqa.logins', []);
    // A test gone through on the page from an earlier visit cannot go on (its steps' state was here): it is closed
    await store.set('nomadqa.debug', null);
    chrome.runtime.onMessage.addListener((msg, sender, reply) => {
      if (msg?.type !== 'nomadqa:debug' || !T.debug || sender.tab?.id !== T.debug.tabId) return;
      void debugCommand(msg).then(
        () => reply({ ok: true }),
        (e) => reply({ ok: false, message: e.message })
      );
      return true;
    });
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
      // The page changed a step's value: its sentence is written again here (the page has only a short one)
      const d = changes['nomadqa.debug']?.newValue;
      if (d?.items?.some((x) => x.text !== stepText(x.step))) {
        for (const x of d.items) x.text = stepText(x.step);
        void store.set('nomadqa.debug', d);
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
      lastPageCard(),
      h(
        'details',
        { class: 'card more-tabs', open: T.tabsOpen || undefined, ontoggle: (e) => (T.tabsOpen = e.target.open) },
        h('summary', {}, h('b', {}, 'Other tabs and orgs')),
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
  // The Salesforce page you were on last (where NomadQA was opened from, most of the time)
  function lastPageCard() {
    const last = [...T.tabs].sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
    return h(
      'section',
      { class: 'card' },
      h('h2', {}, 'Your last Salesforce page'),
      last
        ? h(
            'div',
            { class: 'org-tab last-page' },
            h(
              'span',
              { class: 'grow' },
              h('b', {}, last.title || 'Salesforce'),
              h(
                'span',
                { class: 'sub' },
                `${
                  apiHostFor(new URL(last.url).host)?.replace(/\.my\.salesforce\.com$/, '') ?? new URL(last.url).host
                } · ${new URL(last.url).pathname}`
              )
            ),
            h('button', { class: 'primary', onclick: () => void inspect(last) }, 'Inspect it')
          )
        : h('p', { class: 'muted' }, 'No Salesforce page is open. Open one, or pick an org below.'),
      h(
        'p',
        { class: 'muted small' },
        'Or on any Salesforce page press ',
        h('b', {}, 'Alt + Shift + I'),
        '. Hover to see, click to pin and copy; ',
        h('b', {}, 'Just click'),
        ' in the list at the bottom left lets the page work as usual; Esc stops.'
      )
    );
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
    count: 'How many (buttons, tabs, fields…)',
    place: 'Where a field is (section, row, column)',
    recordtype: 'The record type',
    layout: 'The page layout (of who is logged in)',
  };
  const FIELD_HINT = 'label or API name: Industry, Account.Industry';
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
      ['field', 'Field', 'Last Name or LastName'],
      ['value', 'Value', 'Smith or {{found.Name}}'],
    ],
    pick: [
      ['field', 'Field', 'Stage or StageName'],
      ['value', 'Value', 'Closed Won'],
    ],
    lookup: [
      ['field', 'Field', 'Account Name or AccountId'],
      ['value', 'Record name', 'Acme'],
    ],
    search: [
      ['text', 'Type', 'Mia Brown'],
      ['box', 'In (optional)', 'empty: Salesforce’s search · a field · Search this list…'],
      ['choose', 'Then choose (optional)', 'empty: press Enter'],
    ],
    check: [
      ['field', 'Field', 'Active or Active__c'],
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
      ['field', 'Field', FIELD_HINT, { when: (s) => s.kind === 'field' || s.kind === 'place' }],
      [
        'what',
        'Count',
        '',
        { options: COUNT_WHAT.map((w) => [w, w[0].toUpperCase() + w.slice(1)]), when: (s) => s.kind === 'count' },
      ],
      [
        'within',
        'In (optional)',
        'a section, card or related list title',
        { when: (s) => ['count', 'button', 'no-button'].includes(s.kind) },
      ],
      ['section', 'Section', 'its title, or 1, 2…', { when: (s) => s.kind === 'place' }],
      ['row', 'Row', '1', { when: (s) => s.kind === 'place' }],
      ['col', 'Column', '1 = left, 2 = right', { when: (s) => s.kind === 'place' }],
      [
        'op',
        'How',
        '',
        {
          options: (s) =>
            s.kind === 'count'
              ? [
                  ['is', 'is exactly'],
                  ['more', 'is more than'],
                  ['less', 'is less than'],
                  ['not', 'is not'],
                ]
              : Object.entries(OPS),
          when: (s) => ['field', 'toast', 'title', 'url', 'count', 'recordtype', 'layout'].includes(s.kind),
        },
      ],
      [
        'value',
        'Value',
        'Technology',
        {
          when: (s) => s.op !== 'empty' && s.op !== 'filled' && s.kind !== 'place',
          placeholder: (s) =>
            s.kind === 'count'
              ? '2'
              : s.kind === 'recordtype'
              ? 'Partner'
              : s.kind === 'layout'
              ? 'Contact Layout'
              : 'Technology',
        },
      ],
    ],
    login: [
      [
        'login',
        'Login (Settings › Logins)',
        '',
        {
          options: () => [
            ['', T.logins.length ? 'Choose a login…' : 'None yet: add one in Settings'],
            ...T.logins.filter((l) => l.name).map((l) => [l.name, `${l.name} · ${l.username}`]),
          ],
        },
      ],
    ],
    loginas: [['user', 'User (username or name)', 'ann.lee@acme.com or Ann Lee', { wide: true }]],
    remember: [
      ['field', 'Field on the page', 'Account Number or AccountNumber'],
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
      accept: '.json,.xml,application/json,application/xml,text/xml',
      onchange: async (e) => {
        try {
          // A test, a group of tests, or a JUnit report NomadQA wrote (it carries its tests)
          const found = testsFromFile(await e.target.files[0].text());
          const copies = found.map((t) => ({ ...t, id: newId() }));
          T.tests = [...copies, ...T.tests];
          await saveTests();
          T.selected = copies[0].id;
          T.results = null;
          setNotice('good', `Added ${copies.length === 1 ? `“${copies[0].name}”` : `${copies.length} tests`}.`);
        } catch (err) {
          setNotice('bad', err.message);
        }
        e.target.value = '';
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
      groupResultEl(),
      pickedCard(test),
      h(
        'div',
        { class: 'grid' },
        h(
          'section',
          { class: 'card' },
          h('h2', {}, 'Your tests'),
          T.tests.length
            ? testList(lastRun)
            : h('p', { class: 'muted' }, 'None yet: record one, ask the Agent, or start a new one.')
        ),
        test ? editor(test) : h('section', { class: 'card empty' }, 'Pick a test on the left.')
      ),
    ];
  }

  /** The tests by group: each group can be run at once, and downloaded as one file. */
  function testList(lastRun) {
    const groups = new Map();
    for (const t of T.tests) {
      const g = t.group ?? '';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    const names = [...groups.keys()].sort((a, b) => (!a ? 1 : !b ? -1 : a.localeCompare(b)));
    const row = (t) => {
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
    };
    return h(
      'div',
      { class: 'tree' },
      names.map((g) =>
        g || names.length > 1
          ? h(
              'div',
              { class: 'test-group' },
              h(
                'div',
                { class: 'row group-head' },
                h('b', { class: 'grow' }, g || 'No group'),
                g
                  ? [
                      h(
                        'button',
                        {
                          class: 'primary',
                          disabled: !S.sf || Boolean(S.busy),
                          title:
                            (T.groupTabs[g] ?? 1) > 1
                              ? `Runs the tests ${T.groupTabs[g]} at a time, each in a window of its own`
                              : `Runs the ${groups.get(g).length} tests one after the other`,
                          onclick: () => void runGroup(g),
                        },
                        `Run all ${groups.get(g).length}`
                      ),
                      select(
                        String(T.groupTabs[g] ?? 1),
                        [1, 2, 3, 4, 6, 8].map((k) => [String(k), k === 1 ? 'one at a time' : `${k} at a time`]),
                        (v) => {
                          T.groupTabs = { ...T.groupTabs, [g]: Number(v) };
                          void store.set('nomadqa.groupTabs', T.groupTabs);
                          render();
                        },
                        {
                          class: 'tabs-at-once',
                          title:
                            'How many tests run at the same time, each in a window of its own. Tests that log in as someone else still run alone.',
                        }
                      ),
                      h(
                        'button',
                        {
                          title: 'One file with every test of the group (the headless runner takes it too)',
                          onclick: () =>
                            download(
                              `${g.replace(/[^\w-]+/g, '-').toLowerCase()}.nomadqa-group.json`,
                              JSON.stringify(
                                { nomadqa: 'group', name: g, tests: groups.get(g).map(({ id, host, ...t }) => t) },
                                null,
                                2
                              ),
                              'application/json'
                            ),
                        },
                        'Download'
                      ),
                    ]
                  : null
              ),
              groups.get(g).map(row)
            )
          : groups.get(g).map(row)
      )
    );
  }

  function groupResultEl() {
    const g = T.groupResult;
    if (!g) return null;
    return h(
      'div',
      { class: `notice ${g.passed === g.total ? 'good' : 'bad'}`, role: 'status' },
      `Group “${g.name}”: ${g.passed} of ${g.total} passed${g.tabs > 1 ? ` (${g.tabs} at a time)` : ''}.`,
      g.failed.length ? ` Failed: ${g.failed.join(', ')}.` : '',
      ' ',
      h(
        'button',
        {
          class: 'link',
          onclick: () =>
            download(`${g.name.replace(/[^\w-]+/g, '-').toLowerCase()}.junit.xml`, g.junit, 'application/xml'),
        },
        'JUnit for the group'
      ),
      ' ',
      h('button', { class: 'link', onclick: () => ((T.groupResult = null), render()) }, 'Dismiss')
    );
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
                  .map(([k, lab, ph0, o]) => {
                    const opts = typeof o?.options === 'function' ? o.options(s) : o?.options;
                    const ph = typeof o?.placeholder === 'function' ? o.placeholder(s) : ph0;
                    return h(
                      'label',
                      { class: `step-field${o?.wide ? ' wide' : ''}` },
                      h('span', {}, lab),
                      opts
                        ? h(
                            'select',
                            { onchange: (e) => (set(k, e.target.value), render()) },
                            opts.map(([v, l]) =>
                              h('option', { value: v, selected: String(s[k] ?? opts[0][0]) === String(v) }, l)
                            )
                          )
                        : h('input', {
                            value: s[k] === undefined ? '' : String(s[k]),
                            placeholder: ph,
                            title: s[k] === undefined ? ph : String(s[k]),
                            onchange: (e) => (set(k, e.target.value), render()),
                          })
                    );
                  }),
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
            disabled: !S.sf || Boolean(S.busy) || !test.steps.length,
            title: 'The steps show on the Salesforce page: run them one at a time, change, add or remove them',
            onclick: () => void startDebug(test),
          },
          'Step by step on the page'
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
      h(
        'div',
        { class: 'row' },
        h('span', { class: 'muted small' }, 'Group'),
        h('input', {
          value: test.group ?? '',
          list: 'nomadqa-groups',
          placeholder: 'e.g. Smoke — tests of a group run together',
          style: 'width: 280px',
          'aria-label': 'Group',
          onchange: (e) => {
            const g = e.target.value.trim();
            if (g) test.group = g;
            else delete test.group;
            changed();
            render();
          },
        }),
        h(
          'datalist',
          { id: 'nomadqa-groups' },
          [...new Set(T.tests.map((t) => t.group).filter(Boolean))].map((g) => h('option', { value: g }))
        )
      ),
      T.debug?.testId === test.id
        ? h(
            'div',
            { class: 'notice' },
            'Going through it on the Salesforce page: its steps are in the list there (bottom left). ',
            h(
              'button',
              {
                class: 'link',
                onclick: async () => {
                  const t = await chrome.tabs.get(T.debug.tabId).catch(() => null);
                  if (t)
                    await chrome.tabs.update(t.id, { active: true }),
                      await chrome.windows.update(t.windowId, { focused: true });
                },
              },
              'Show me'
            ),
            ' · ',
            h('button', { class: 'link', onclick: () => void closeDebug() }, 'Close it')
          )
        : null,
      res?.ms !== undefined
        ? (() => {
            const at = res.results.findIndex((r) => r.ok === false && !r.optional);
            return h(
              'div',
              { class: `notice ${res.ok ? 'good' : 'bad'}` },
              res.ok ? `Passed in ${(res.ms / 1000).toFixed(1)} s.` : `Failed at step ${at + 1}.`,
              res.cleaned ? ` ${res.cleaned} test record(s) deleted.` : '',
              res.ok
                ? null
                : [
                    ' ',
                    h(
                      'button',
                      {
                        class: 'primary',
                        disabled: Boolean(S.busy),
                        title: `Runs steps 1 to ${at} on a Salesforce page, then stops at step ${
                          at + 1
                        }: change it, add a step, or remove it`,
                        onclick: () => void startDebug(test, at),
                      },
                      'Fix it on the page'
                    ),
                  ]
            );
          })()
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

  /** Asks before a test that changes data runs in production; true to go on. */
  async function okToRun(tests, what) {
    // Screenshots of a tab need Chrome's "all sites" permission: asked only for a test that takes them (while the
    // click still counts as the person's), and only once
    if (tests.some((t) => t.steps.some((x) => x.action === 'shot')))
      await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
    const changes = tests.some((t) =>
      t.steps.some((s) => ['click', 'fill', 'pick', 'lookup', 'check', 'data'].includes(s.action))
    );
    if (changes && S.facts && !S.facts.isSandbox)
      return askTyped(`${label()} is a PRODUCTION org. Run ${what} there anyway? It may change data.`, label(), {
        ok: 'Run',
        danger: true,
      });
    return true;
  }

  /** Keeps a run in Runs (with the test itself, so it can be downloaded again). */
  async function saveRun(test, out, extra = {}) {
    const { id, host, ...file } = test;
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
      test: file,
      junit: junit(test, out),
      ...extra,
    };
    T.runs = [entry, ...T.runs].slice(0, 100);
    await store.set('nomadqa.runs', T.runs);
  }
  const backHere = async () => {
    const me = await chrome.tabs.getCurrent().catch(() => null);
    if (me) await chrome.tabs.update(me.id, { active: true }).catch(() => {});
  };

  async function runHere(test) {
    if (!(await okToRun([test], `“${test.name}”`))) return;
    T.results = { testId: test.id, results: [] };
    await run(`Running “${test.name}”…`, async () => {
      const driver = await tabDriver(S.host);
      const out = await runTest(test, {
        driver,
        sf: S.sf,
        describes: S.describes,
        logins: loginsMap(),
        onStep: (i, r) => {
          T.results.results[i] = r;
          S.busy = `Running “${test.name}”: step ${i + 2} of ${test.steps.length}…`;
          render();
        },
      });
      T.results = { testId: test.id, ...out };
      await saveRun(test, out);
      // Back to NomadQA to see the result
      await backHere();
    });
  }

  /** Tests that log in as someone else change who is logged in for the whole browser: they run alone. */
  const logsIn = (t) => t.steps.some((x) => x.action === 'login' || x.action === 'loginas');

  /** Windows for tests side by side: each nearly the whole screen (pages look as usual), a little apart, so each
   * one shows a part of itself (a window fully hidden would be slowed down by the browser). */
  function windowPlaces(n) {
    const gap = 36;
    const W = screen.availWidth;
    const H = screen.availHeight;
    // Never bigger than the screen (Chrome refuses a window mostly off it)
    const width = Math.min(W, Math.max(Math.min(900, W), W - gap * (n - 1)));
    const height = Math.min(H, Math.max(Math.min(600, H), H - gap * (n - 1)));
    return Array.from({ length: n }, (_, k) => ({
      left: Math.round((screen.availLeft ?? 0) + Math.min(k * gap, Math.max(0, W - width))),
      top: Math.round((screen.availTop ?? 0) + Math.min(k * gap, Math.max(0, H - height))),
      width,
      height,
    }));
  }

  /** Runs every test of a group: one after the other in one tab, or `n` at a time, each in a window of its own (a
   * test that logs in as someone else runs alone, after the others). One JUnit report for all of them. */
  async function runGroup(name) {
    const tests = T.tests.filter((t) => (t.group ?? '') === name);
    if (!tests.length || !(await okToRun(tests, `the ${tests.length} tests of “${name}”`))) return;
    const n = Math.max(1, Math.min(Number(T.groupTabs[name] ?? 1), tests.length));
    const suite = newId();
    const done = new Array(tests.length);
    let finished = 0;
    const status = () => {
      S.busy = `Group “${name}”: ${finished} of ${tests.length} done${n > 1 ? `, ${n} at a time` : ''}…`;
      render();
    };
    const runOne = async (driver, k) => {
      const test = tests[k];
      if (n === 1) {
        S.busy = `Group “${name}”: test ${k + 1} of ${tests.length}, “${test.name}”…`;
        render();
      }
      const out = await runTest(test, { driver, sf: S.sf, describes: S.describes, logins: loginsMap() }).catch((e) => ({
        ok: false,
        ms: 0,
        results: [{ ok: false, message: e.message, ms: 0 }],
      }));
      done[k] = { test, run: out };
      finished++;
      await saveRun(test, out, { group: name, suite });
      if (n > 1) status();
    };
    await run(`Running the group “${name}”…`, async () => {
      if (n === 1) {
        const driver = await tabDriver(S.host);
        for (const k of tests.keys()) await runOne(driver, k);
      } else {
        status();
        const together = [...tests.keys()].filter((k) => !logsIn(tests[k]));
        const alone = [...tests.keys()].filter((k) => logsIn(tests[k]));
        const places = windowPlaces(Math.min(n, Math.max(1, together.length)));
        const drivers = [];
        try {
          let next = 0;
          await Promise.all(
            places.map(async (place) => {
              if (next >= together.length) return;
              const driver = await tabDriver(S.host, { window: place });
              drivers.push(driver);
              while (next < together.length) await runOne(driver, together[next++]);
            })
          );
          // Then, alone, the ones that log in as someone else
          if (alone.length) {
            const driver = drivers[0] ?? (await tabDriver(S.host, { window: places[0] }));
            if (!drivers.includes(driver)) drivers.push(driver);
            for (const d of drivers.slice(1)) await d.close();
            for (const k of alone) await runOne(driver, k);
          }
        } finally {
          for (const d of drivers) await d.close();
        }
      }
      await backHere();
    });
    const list = done.filter(Boolean);
    if (list.length)
      T.groupResult = {
        name,
        passed: list.filter((x) => x.run.ok).length,
        total: tests.length,
        failed: list.filter((x) => !x.run.ok).map((x) => x.test.name),
        junit: groupJunit(name, list),
        tabs: n,
      };
    render();
  }

  // ---------- going through a test on the page, step by step ----------
  // The steps show in the list on the Salesforce page (content/page.js) from storage (nomadqa.debug); the page asks
  // this tab to run them (nomadqa:debug), since the test's state ({{found}}, records made, who is logged in) is here.
  const readDebug = () => store.get('nomadqa.debug', null);
  async function writeDebug(fn) {
    const d = await readDebug();
    if (!d) return null;
    fn(d);
    await store.set('nomadqa.debug', d);
    return d;
  }

  /** Opens the test on a Salesforce page; with upTo, runs the steps before that one first (to a failed step). */
  async function startDebug(test, upTo = 0) {
    if (T.debug) await closeDebug();
    if (!(await okToRun([test], `“${test.name}”`))) return;
    await run(`Opening “${test.name}” on the page…`, async () => {
      const driver = await tabDriver(S.host);
      const st = stepper(test, { driver, sf: S.sf, describes: S.describes, logins: loginsMap() });
      T.debug = { testId: test.id, tabId: driver.tabId, st, driver };
      await store.set('nomadqa.debug', {
        testId: test.id,
        name: test.name,
        tabId: driver.tabId,
        items: test.steps.map((step) => ({ step: structuredClone(step), text: stepText(step), result: null })),
        at: 0,
        running: '',
        msg: upTo ? `Running the ${upTo} step(s) before step ${upTo + 1}…` : '',
        dirty: false,
      });
      await pageMode(driver.tabId, 'debug');
    });
    if (upTo > 0 && T.debug) await debugRun(upTo);
  }

  /** Runs `n` steps from the current one; stops at a step that fails (an optional one goes on). */
  async function debugRun(n) {
    const D = T.debug;
    let d = await writeDebug((x) => {
      x.running = 'yes';
      x.bad = false;
    });
    try {
      for (let k = 0; d && k < n && d.at < d.items.length; k++) {
        const i = d.at;
        const { shot, ...r } = await D.st.run(d.items[i].step);
        d = await writeDebug((x) => {
          if (x.items[i]) x.items[i].result = r;
          if (r.ok || r.optional) x.at = i + 1;
          x.msg = r.ok
            ? `Step ${i + 1} passed.`
            : `Step ${i + 1} failed: change it, add a step before it, or remove it.`;
          x.bad = !r.ok;
        });
        // A step that opened another page: the list is put back on it
        await pageMode(D.tabId, 'debug').catch(() => {});
        if (!r.ok && !r.optional) break;
      }
    } finally {
      d = await writeDebug((x) => {
        x.running = '';
        if (x.at >= x.items.length && !x.bad) x.msg = 'The end: every step ran. Save to keep your changes.';
      });
    }
  }

  async function debugCommand(msg) {
    if (msg.cmd === 'step') return debugRun(Number(msg.n) || 1);
    if (msg.cmd === 'all') return debugRun(Infinity);
    if (msg.cmd === 'close') return closeDebug();
    if (msg.cmd === 'save') {
      const d = await readDebug();
      const test = T.tests.find((t) => t.id === d?.testId);
      if (!test) throw new Error('The test is not in NomadQA any more.');
      test.steps = d.items.map((x) => x.step);
      await saveTests();
      T.results = null;
      await writeDebug((x) => {
        x.dirty = false;
        x.bad = false;
        x.msg = `Saved to “${test.name}”.`;
      });
      render();
    }
  }

  async function closeDebug() {
    const D = T.debug;
    T.debug = null;
    // The page turns its list off when this goes
    await store.set('nomadqa.debug', null);
    if (D) {
      const cleaned = await D.st.finish().catch(() => 0);
      if (cleaned) toast(`${cleaned} test record(s) deleted.`);
    }
    render();
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
                      h(
                        'td',
                        {},
                        r.testName,
                        r.group ? h('span', { class: 'pill', style: 'margin-left: 6px' }, r.group) : null
                      ),
                      h('td', {}, r.org),
                      h(
                        'td',
                        {},
                        h(
                          'span',
                          { class: `pill ${r.ok ? 'good' : 'bad'}` },
                          r.ok ? 'passed' : `failed at ${r.results.findIndex((x) => x.ok === false && !x.optional) + 1}`
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
                            title: 'The test as it ran (upload it in Tests to run it again)',
                            disabled: !r.test,
                            onclick: () =>
                              download(
                                `${r.testName.replace(/[^\w-]+/g, '-').toLowerCase()}.nomadqa.json`,
                                JSON.stringify(r.test, null, 2),
                                'application/json'
                              ),
                          },
                          'Test'
                        ),
                        ' ',
                        h(
                          'button',
                          {
                            title: 'The results for CI; Tests can upload it again (it carries the steps)',
                            onclick: () =>
                              download(
                                `${r.testName.replace(/[^\w-]+/g, '-').toLowerCase()}.junit.xml`,
                                r.test
                                  ? junit({ ...r.test, name: r.testName }, { results: r.results, ms: r.ms })
                                  : r.junit,
                                'application/xml'
                              ),
                          },
                          'JUnit'
                        ),
                        r.suite
                          ? [
                              ' ',
                              h(
                                'button',
                                {
                                  title: `One report for every test of this run of “${r.group}”`,
                                  onclick: () => {
                                    const all = T.runs.filter((x) => x.suite === r.suite && x.test).reverse();
                                    download(
                                      `${r.group.replace(/[^\w-]+/g, '-').toLowerCase()}.junit.xml`,
                                      groupJunit(
                                        r.group,
                                        all.map((x) => ({
                                          test: { ...x.test, name: x.testName },
                                          run: { results: x.results, ms: x.ms },
                                        }))
                                      ),
                                      'application/xml'
                                    );
                                  },
                                },
                                'Group JUnit'
                              ),
                            ]
                          : null
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
      h(
        'div',
        { class: 'head' },
        h('h1', {}, 'Settings'),
        h('span', { class: 'muted' }, 'Your AI for the Agent, and the logins tests use')
      ),
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
      loginsCard(),
    ];
  }

  // Logins for "Log in" steps: kept in this browser only; a test names the login, it never holds the password
  function loginsCard() {
    const pages = [
      ['https://login.salesforce.com', 'login.salesforce.com (production, Developer Edition)'],
      ['https://test.salesforce.com', 'test.salesforce.com (sandbox, scratch org)'],
      ...(S.host ? [[`https://${S.host}`, `${label()} (its My Domain)`]] : []),
    ];
    const save = async () => {
      await store.set('nomadqa.logins', T.logins);
      toast('Saved.');
    };
    const field = (l, k, props = {}) =>
      h('input', { value: l[k] ?? '', autocomplete: 'off', onchange: (e) => (l[k] = e.target.value.trim()), ...props });
    return h(
      'section',
      { class: 'card', style: 'max-width: 900px' },
      h(
        'div',
        { class: 'row' },
        h('h2', { class: 'grow' }, 'Logins'),
        h(
          'button',
          {
            onclick: () => (
              T.logins.push({
                name: `user${T.logins.length + 1}`,
                url: S.facts?.isSandbox ? 'https://test.salesforce.com' : 'https://login.salesforce.com',
                username: '',
                password: '',
              }),
              render()
            ),
          },
          '+ Add a login'
        )
      ),
      h(
        'p',
        { class: 'muted small' },
        'For ',
        h('b', {}, 'Log in'),
        ' steps: the test starts on the login page and types these. They stay in this browser; a test only names the login, so a downloaded test never holds a password. To test as another user without a password, use ',
        h('b', {}, 'Log in as a user'),
        ' (Login-As) instead.'
      ),
      T.logins.length
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
                  h('th', {}, 'Name in tests'),
                  h('th', {}, 'Login page'),
                  h('th', {}, 'Username'),
                  h('th', {}, 'Password'),
                  h('th', {}, '')
                )
              ),
              h(
                'tbody',
                {},
                T.logins.map((l, i) =>
                  h(
                    'tr',
                    {},
                    h('td', {}, field(l, 'name', { style: 'width: 120px', 'aria-label': 'Name' })),
                    h(
                      'td',
                      {},
                      select(
                        l.url,
                        pages.some(([v]) => v === l.url) ? pages : [[l.url, l.url], ...pages],
                        (v) => ((l.url = v), render()),
                        { 'aria-label': 'Login page' }
                      )
                    ),
                    h('td', {}, field(l, 'username', { placeholder: 'name@company.com', 'aria-label': 'Username' })),
                    h(
                      'td',
                      {},
                      field(l, 'password', {
                        type: 'password',
                        placeholder: 'kept in this browser',
                        'aria-label': 'Password',
                      })
                    ),
                    h(
                      'td',
                      {},
                      h(
                        'button',
                        {
                          class: 'icon',
                          'aria-label': `Remove ${l.name}`,
                          onclick: () => (T.logins.splice(i, 1), void save(), render()),
                        },
                        '✕'
                      )
                    )
                  )
                )
              )
            )
          )
        : h('p', { class: 'muted' }, 'None yet.'),
      T.logins.length
        ? h(
            'div',
            { class: 'row' },
            h('button', { class: 'primary', onclick: () => void save() }, 'Save the logins'),
            h(
              'span',
              { class: 'muted small' },
              'Headless runner: ',
              h('code', {}, '--logins logins.json'),
              ' (the same names, with url, username and password)'
            )
          )
        : null
    );
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

  /** Reads again what is kept in this browser (another NomadQA tab, or a page, may have changed it). */
  async function reload() {
    T.tests = await store.get('nomadqa.tests', []);
    T.runs = await store.get('nomadqa.runs', []);
    T.recording = await store.get('nomadqa.recording', null);
    T.picked = await store.get('nomadqa.picked', []);
    T.logins = await store.get('nomadqa.logins', []);
    if (S.view === 'inspector') await salesforceTabs();
  }

  return {
    load,
    reload,
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
