// NomadQA pages for tests: Inspector, Recorder, Tests (edit and run), Runs, Agent, Settings (AI).
import { h, select, askTyped, askYes, toast, download } from '../core/ui.js';
import { htmlReport, failureOf } from '../core/report.js';
import {
  ACTIONS,
  FIELDS,
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
  // The tab the test is in: a click that opens a new tab (Setup from the gear) moves the test there
  const cur = { id: tab.id };
  let opened = null;
  const onCreated = (t) => {
    if (t.openerTabId === cur.id) opened = t.id;
  };
  chrome.tabs.onCreated.addListener(onCreated);
  await waitTab(cur.id);
  await inTab(cur.id, () => globalThis.__nomadqa.ready(90000));
  let kept = null;
  /** Runs one step once (never again: a click must not happen twice). */
  async function once(s) {
    await inTab(cur.id, () => true);
    const [r] = await chrome.scripting.executeScript({
      target: { tabId: cur.id },
      func: (st) => globalThis.__nomadqa.run(st),
      args: [s],
    });
    return r?.result;
  }
  return {
    get tabId() {
      return cur.id;
    },
    async open(url) {
      await chrome.tabs.update(cur.id, { url });
      await waitTab(cur.id);
      await inTab(cur.id, () => globalThis.__nomadqa.ready(90000));
    },
    // A page that is not Lightning (the login page): loaded, nothing more
    async load(url) {
      await chrome.tabs.update(cur.id, { url });
      await waitTab(cur.id);
    },
    // After the login form is sent: the redirects end on Lightning (or stay on a login or verification page)
    async settle(timeout = 90000) {
      const end = Date.now() + timeout;
      let still = 0;
      while (Date.now() < end) {
        await sleep(500);
        const t = await chrome.tabs.get(cur.id);
        if (t.status !== 'complete') {
          still = 0;
          continue;
        }
        if (/\/lightning\//.test(t.url ?? ''))
          return void (await inTab(cur.id, () => globalThis.__nomadqa.ready(60000)));
        if (++still > 16) return;
      }
    },
    url: async () => (await chrome.tabs.get(cur.id)).url ?? '',
    // The login form makes the page go away: run once, never again on the next page
    async step(s) {
      if (s.action === 'login-form') return once(s).catch(() => undefined);
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const before = (await chrome.tabs.get(cur.id)).url;
      opened = null;
      let r = await once({ ...s, __id: id }).catch(() => undefined);
      if (r === undefined) {
        // The page went away while the step ran (choosing another app reloads the whole page): when the step had
        // pressed (its mark is on the new page) or the page is another one, it was done
        await waitTab(cur.id).catch(() => {});
        await inTab(cur.id, () => globalThis.__nomadqa.ready(60000)).catch(() => {});
        const marked = await inTab(cur.id, (k) => sessionStorage.getItem('nomadqa.pressed') === k, [id]).catch(
          () => false
        );
        const now = (await chrome.tabs.get(cur.id)).url;
        r =
          marked || now !== before
            ? { ok: true, message: 'Done; the page loaded again after it.' }
            : { ok: false, message: 'No answer from the page (it reloaded before the step finished).' };
      }
      // A new tab from this one: the test goes on there
      if (opened) {
        cur.id = opened;
        opened = null;
        await chrome.tabs.update(cur.id, { active: true }).catch(() => {});
        await waitTab(cur.id);
        await inTab(cur.id, () => globalThis.__nomadqa.ready(90000)).catch(() => {});
        r = { ...r, message: [r.message, 'Went on in the new tab it opened.'].filter(Boolean).join(' ') };
      }
      return r;
    },
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
    /** Ends the driver: its window goes; with { tab: true } also the tab(s) it opened (never a tab it was given). */
    async close({ tab: closeTab = false } = {}) {
      chrome.tabs.onCreated.removeListener(onCreated);
      if (win) return void (await chrome.windows.remove(win.id).catch(() => {}));
      if (!closeTab) return;
      const ids = [...new Set([tabId ? null : tab.id, cur.id === tabId ? null : cur.id])].filter(Boolean);
      if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
    },
    // What the tab shows (the test's tab is in front while it runs): a small JPEG
    async shot() {
      if (!(await chrome.permissions.contains({ origins: ['<all_urls>'] }))) return undefined;
      const t = await chrome.tabs.get(cur.id);
      return smaller(await chrome.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 80 }));
    },
  };
}

/** A screenshot made small: at most 1280 pixels wide, JPEG at 60% (about 100 KB instead of a few MB). */
async function smaller(dataUrl, width = 1280) {
  try {
    const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const k = Math.min(1, width / img.width);
    const c = new OffscreenCanvas(Math.round(img.width * k), Math.round(img.height * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
    return await new Promise((ok) => {
      const r = new FileReader();
      r.onload = () => ok(r.result);
      r.readAsDataURL(blob);
    });
  } catch {
    return dataUrl;
  }
}

/** Every step of a test, the steps of its groups too. */
const allSteps = (t) => t.steps.flatMap((s) => (s.action === 'group' ? s.steps ?? [] : [s]));

/** Puts the engine and the page script in a tab, then sets its mode (inspect, record, off). */
async function pageMode(tabId, mode, extra = {}) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['core/engine.js', 'core/words.js', 'content/page.js'],
  });
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
    closed: {}, // groups folded in the list: { name: true }
    focusStep: -1, // a step just added: the editor scrolls to it
    clip: [], // steps copied, to paste in any test
    shots: {}, // pictures of failed steps by run: { runId: { stepIndex: dataUrl } }
    shotsOk: false, // Chrome lets NomadQA take pictures of a tab
    sel: null, // steps ticked in the editor: { testId, set }
    closeTab: true, // the tab a test ran in is closed when it ends
  });
  const loginsMap = () =>
    Object.fromEntries(
      T.logins.filter((l) => l.name).map((l) => [l.name, { url: l.url, username: l.username, password: l.password }])
    );

  async function load() {
    T.groupTabs = await store.get('nomadqa.groupTabs', {});
    T.closed = await store.get('nomadqa.closedGroups', {});
    T.tests = await store.get('nomadqa.tests', []);
    T.runs = await store.get('nomadqa.runs', []);
    T.ai = { ...T.ai, ...(await store.get('nomadqa.ai', {})) };
    T.recording = await store.get('nomadqa.recording', null);
    T.picked = await store.get('nomadqa.picked', []);
    T.logins = await store.get('nomadqa.logins', []);
    T.clip = await store.get('nomadqa.clip', []);
    T.shots = await store.get('nomadqa.shots', {});
    T.closeTab = await store.get('nomadqa.closeTab', true);
    T.shotsOk = await chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
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
    // The old tab of a test that went on in a new one: "Go to that tab"
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== 'nomadqa:front' || !T.debug) return;
      void chrome.tabs
        .update(T.debug.tabId, { active: true })
        .then((t) => chrome.windows.update(t.windowId, { focused: true }))
        .catch(() => {});
    });
    // A step clicked (↗) in the list on the Salesforce page: its test opens here, at that step
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type !== 'nomadqa:show' || !T.tests.some((t) => t.id === msg.testId)) return;
      void showStep(msg.testId, String(msg.step ?? ''));
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

  /** Opens a test at one of its steps ("3", or "3.2": the 2nd step of the group at 3), brought to the front. */
  async function showStep(testId, key) {
    T.selected = testId;
    S.view = 'tests';
    T.results = null;
    const g = Number(key.split('.')[0]);
    if (key.includes('.')) T.folded = { ...T.folded, [`${testId}:${g}`]: false };
    T.focusStep = key;
    render();
    const me = await chrome.tabs.getCurrent().catch(() => null);
    if (me) {
      await chrome.tabs.update(me.id, { active: true }).catch(() => {});
      await chrome.windows.update(me.windowId, { focused: true }).catch(() => {});
    }
    requestAnimationFrame(() => {
      document.querySelector(`tr[data-step="${key}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => {
        if (T.focusStep === key) (T.focusStep = -1), render();
      }, 2500);
    });
  }

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
  // What each step asks for (FIELDS, core/words.js): the same boxes here and in the list on the Salesforce page

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

  /** The tests by group: a group opens and closes, runs at once (n at a time), and downloads as one file. */
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
          class: `test-row${t.id === T.selected ? ' on' : ''}`,
          role: 'button',
          tabindex: '0',
          onclick: () => ((T.selected = t.id), (T.results = null), render()),
          onkeydown: (e) => e.key === 'Enter' && ((T.selected = t.id), (T.results = null), render()),
        },
        h('span', {
          class: `dot ${r ? (r.ok ? 'good' : 'bad') : ''}`,
          title: r ? (r.ok ? 'Passed last time' : 'Failed last time') : 'Not run yet',
        }),
        h('span', { class: 'name', title: t.name }, t.name),
        h('span', { class: 'meta' }, `${t.steps.length} step${t.steps.length === 1 ? '' : 's'}`),
        h(
          'button',
          {
            class: 'icon row-del',
            'aria-label': `Delete the test ${t.name}`,
            title: 'Delete this test',
            onclick: (e) => {
              e.stopPropagation();
              void deleteTest(t);
            },
            onkeydown: (e) => e.stopPropagation(),
          },
          '✕'
        )
      );
    };
    const toggle = (g) => {
      T.closed = { ...T.closed, [g]: !T.closed[g] };
      void store.set('nomadqa.closedGroups', T.closed);
      render();
    };
    const groupEl = (g) => {
      const list = groups.get(g);
      const open = !T.closed[g];
      const failed = list.filter((t) => lastRun(t)?.ok === false).length;
      const passed = list.filter((t) => lastRun(t)?.ok).length;
      return h(
        'div',
        { class: `test-group${open ? ' open' : ''}` },
        h(
          'div',
          {
            class: 'group-head',
            role: 'button',
            tabindex: '0',
            'aria-expanded': String(open),
            onclick: () => toggle(g),
            onkeydown: (e) => e.key === 'Enter' && toggle(g),
          },
          h('span', { class: 'caret' }, '▸'),
          h('b', { class: 'name' }, g || 'No group'),
          h('span', { class: 'count' }, String(list.length)),
          passed ? h('span', { class: 'pill good' }, `${passed} ✓`) : null,
          failed ? h('span', { class: 'pill bad' }, `${failed} ✕`) : null
        ),
        open && g
          ? h(
              'div',
              { class: 'group-tools' },
              h(
                'button',
                {
                  class: 'primary small',
                  disabled: !S.sf || Boolean(S.busy),
                  title:
                    (T.groupTabs[g] ?? 1) > 1
                      ? `Runs the tests ${T.groupTabs[g]} at a time, each in a window of its own`
                      : `Runs the ${list.length} tests one after the other`,
                  onclick: () => void runGroup(g),
                },
                `▶ Run all ${list.length}`
              ),
              select(
                String(T.groupTabs[g] ?? 1),
                [1, 2, 3, 4, 6, 8].map((k) => [String(k), k === 1 ? 'One at a time' : `${k} at a time`]),
                (v) => {
                  T.groupTabs = { ...T.groupTabs, [g]: Number(v) };
                  void store.set('nomadqa.groupTabs', T.groupTabs);
                  render();
                },
                {
                  class: 'small',
                  'aria-label': 'How many at a time',
                  title:
                    'How many tests run at the same time, each in a window of its own. Tests that log in as someone else still run alone.',
                }
              ),
              h('span', { class: 'grow' }),
              h(
                'button',
                {
                  class: 'small',
                  title: 'One file with every test of the group (the headless runner takes it too)',
                  onclick: () =>
                    download(
                      `${g.replace(/[^\w-]+/g, '-').toLowerCase()}.nomadqa-group.json`,
                      JSON.stringify(
                        { nomadqa: 'group', name: g, tests: list.map(({ id, host, ...t }) => t) },
                        null,
                        2
                      ),
                      'application/json'
                    ),
                },
                'Download'
              )
            )
          : null,
        open ? h('div', { class: 'group-rows' }, list.map(row)) : null
      );
    };
    // No groups at all: just the tests
    if (names.length === 1 && !names[0]) return h('div', { class: 'test-list' }, groups.get('').map(row));
    return h('div', { class: 'test-list' }, names.map(groupEl));
  }

  /** After a group ran: how many passed, and for each test that failed, its step and why (click: see it). */
  function groupResultEl() {
    const g = T.groupResult;
    if (!g) return null;
    const failedItems = g.items.filter((x) => !x.run.ok);
    return h(
      'section',
      { class: `run-result group-result ${failedItems.length ? 'bad' : 'good'}`, role: 'status' },
      h(
        'div',
        { class: 'row' },
        h(
          'b',
          { class: 'grow' },
          `Group “${g.name}”: ${g.passed} of ${g.total} passed${g.tabs > 1 ? ` (${g.tabs} at a time)` : ''}.`
        ),
        h(
          'button',
          {
            class: 'small primary',
            title: 'A page for people: every test and step, why each failure failed, with pictures',
            onclick: () => downloadReport(`Group ${g.name}`, g.items, g.at),
          },
          'Report'
        ),
        h(
          'button',
          {
            class: 'small',
            onclick: () =>
              download(`${g.name.replace(/[^\w-]+/g, '-').toLowerCase()}.junit.xml`, g.junit, 'application/xml'),
          },
          'JUnit'
        ),
        h('button', { class: 'small', onclick: () => ((T.groupResult = null), render()) }, 'Dismiss')
      ),
      failedItems.length
        ? h(
            'ul',
            { class: 'failed-tests' },
            failedItems.map(({ test, run: out }) => {
              const f = failureOf(test, out);
              return h(
                'li',
                {},
                h(
                  'button',
                  {
                    class: 'link',
                    title: 'Open the test with this run’s results',
                    onclick: () => {
                      T.selected = test.id;
                      T.results = { testId: test.id, ...out };
                      render();
                    },
                  },
                  test.name
                ),
                f
                  ? h(
                      'span',
                      { class: 'muted' },
                      ` — step ${f.i + 1}, ${stepText(f.step)}: `,
                      h('span', { class: 'why-text' }, f.result.message ?? 'failed')
                    )
                  : null
              );
            })
          )
        : null
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

  /** Steps copied (⧉, or the ones ticked): pasted into any test, or into a group. Also on the clipboard, as JSON. */
  async function copySteps(steps) {
    T.clip = structuredClone(steps);
    await store.set('nomadqa.clip', T.clip);
    await navigator.clipboard.writeText(JSON.stringify(steps.length === 1 ? steps[0] : steps, null, 2)).catch(() => {});
    toast(
      steps.length === 1
        ? `Copied “${stepText(steps[0])}”: paste it in any test.`
        : `Copied ${steps.length} steps: paste them in any test.`
    );
    render();
  }
  const clipText = () => {
    if (T.clip?.length !== 1) return `${T.clip?.length ?? 0} steps`;
    const c = T.clip[0];
    const name = c.action === 'group' ? c.name || 'the group' : stepText(c);
    return `“${name.length > 32 ? `${name.slice(0, 31)}…` : name}”`;
  };

  /** What the page had when the test failed: the step, the reason, what was wanted and what was there, a picture. */
  function failureBox(test, run, { fix } = {}) {
    const f = failureOf(test, run);
    if (!f) return null;
    const r = f.result;
    const row = (k, v) => (v ? [h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)] : null);
    const openShot = async () => {
      const blob = await (await fetch(r.shot)).blob();
      await chrome.tabs.create({ url: URL.createObjectURL(blob) });
    };
    return h(
      'div',
      { class: 'failure' },
      h(
        'div',
        { class: 'failure-head' },
        h('b', {}, `Failed at step ${f.i + 1}`),
        h('span', { class: 'muted' }, ` · ${stepText(f.step)}`),
        h('span', { class: 'grow' }),
        fix
          ? h(
              'button',
              {
                class: 'primary small',
                disabled: Boolean(S.busy),
                title: `Runs steps 1 to ${f.i} on a Salesforce page, then stops at step ${
                  f.i + 1
                }: change it, add a step, or remove it`,
                onclick: fix,
              },
              'Fix it on the page'
            )
          : null
      ),
      h(
        'div',
        { class: 'failure-body' },
        h(
          'div',
          { class: 'failure-grid' },
          f.inner ? row('In the group', `${r.at + 1}. ${stepText(f.inner)}`) : null,
          row('Why', r.message),
          row('Expected', r.expected),
          row('Got', r.got),
          row('Salesforce said', r.toasts?.length ? r.toasts.join(' · ') : ''),
          row('Page', r.url ? h('a', { href: r.url, target: '_blank', class: 'link' }, r.url) : '')
        ),
        r.shot
          ? h(
              'button',
              { class: 'shot', title: 'The page when it failed: open it big', onclick: () => void openShot() },
              h('img', { src: r.shot, alt: `The page when step ${f.i + 1} failed` })
            )
          : !T.shotsOk
          ? h(
              'div',
              { class: 'shot none' },
              h('span', { class: 'muted small' }, 'No picture of the page: Chrome asks once for it.'),
              h(
                'button',
                {
                  class: 'small',
                  onclick: async () => {
                    T.shotsOk = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
                    if (T.shotsOk) toast('Failed steps get a small picture from the next run.');
                    render();
                  },
                },
                'Allow pictures of failed steps'
              )
            )
          : null
      )
    );
  }

  /** A report for people: an HTML page with every step, why it failed, and the picture. */
  function downloadReport(title, items, at = new Date().toISOString()) {
    download(
      `${
        title
          .replace(/[^\w-]+/g, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase() || 'nomadqa'
      }.report.html`,
      htmlReport({ title, org: label(), at, items }),
      'text/html'
    );
  }

  /** The group box of a test: a list of the groups there are, or a new one. */
  function groupPicker(test, changed) {
    const groups = [...new Set(T.tests.map((t) => t.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    if (T.newGroupFor === test.id) {
      const input = h('input', {
        placeholder: 'Name of the new group, e.g. Smoke',
        style: 'width: 240px',
        'aria-label': 'New group',
        onkeydown: (e) => {
          if (e.key === 'Enter') add();
          if (e.key === 'Escape') (T.newGroupFor = null), render();
        },
      });
      const add = () => {
        const g = input.value.trim();
        if (!g) return input.focus();
        test.group = g;
        T.newGroupFor = null;
        changed();
        render();
      };
      requestAnimationFrame(() => input.focus());
      return [
        input,
        h('button', { class: 'primary small', onclick: add }, 'Add'),
        h('button', { class: 'small', onclick: () => ((T.newGroupFor = null), render()) }, 'Cancel'),
      ];
    }
    return [
      select(
        test.group ?? '',
        [['', 'No group'], ...groups.map((g) => [g, g]), ['\u0000new', '+ New group…']],
        (v) => {
          if (v === '\u0000new') T.newGroupFor = test.id;
          else {
            if (v) test.group = v;
            else delete test.group;
            changed();
          }
          render();
        },
        { 'aria-label': 'Group', style: 'width: 220px' }
      ),
      h(
        'button',
        { class: 'small', title: 'A new group for this test', onclick: () => ((T.newGroupFor = test.id), render()) },
        '+ New group'
      ),
    ];
  }

  function editor(test) {
    const changed = () => void saveTests();
    const res = T.results?.testId === test.id ? T.results : null;
    const sel = T.sel?.testId === test.id ? T.sel.set : new Set();
    const tick = (i, on) => {
      const set = new Set(sel);
      if (on) set.add(i);
      else set.delete(i);
      T.sel = { testId: test.id, set };
      render();
    };
    const foldKey = (i) => `${test.id}:${i}`;
    T.folded ??= {};

    /** A step's row: of the test (g undefined) or of the group at test.steps[g]; r is its result. */
    const stepRow = (s, list, i, r, g) => {
      const inGroup = g !== undefined;
      const key = inGroup ? `${g}.${i}` : String(i);
      const isGroup = s.action === 'group';
      const bad = problem(s);
      const set = (k, v) => {
        if (v === '' || v === undefined) delete s[k];
        else s[k] = k === 'ms' || k === 'count' ? Number(v) : k === 'value' && s.action === 'check' ? v === 'true' : v;
        changed();
      };
      const fields = isGroup ? [] : FIELDS[s.action] ?? [];
      const open = isGroup && !T.folded[foldKey(i)];
      const actions = Object.entries(ACTIONS).filter(([k]) => !inGroup || k !== 'group');
      return h(
        'tr',
        {
          class: [
            r?.ok === false && !r.optional ? 'bad' : '',
            T.focusStep === key ? 'new' : '',
            s.action === 'data' || (!isGroup && !fields.length) ? 'no-fields' : '',
            isGroup ? 'group-row' : '',
            inGroup ? 'child' : '',
            !inGroup && sel.has(i) ? 'picked' : '',
          ]
            .filter(Boolean)
            .join(' '),
          'data-step': key,
        },
        h(
          'td',
          { class: 'c-n' },
          inGroup
            ? h('span', { class: 'sub-n' }, `${g + 1}.${i + 1}`)
            : h(
                'label',
                { class: 'pick-n', title: 'Tick to group, copy or remove several steps' },
                h('input', {
                  type: 'checkbox',
                  checked: sel.has(i),
                  'aria-label': `Select step ${i + 1}`,
                  onchange: (e) => tick(i, e.target.checked),
                }),
                h('span', {}, String(i + 1))
              )
        ),
        h(
          'td',
          { class: 'c-step' },
          select(
            s.action,
            actions.map(([k, a]) => [k, a.say]),
            (v) => {
              // A step made a group keeps itself as the group's first step
              list[i] = v === 'group' ? { action: 'group', name: '', steps: [s] } : { action: v };
              changed();
              render();
            },
            { 'aria-label': `Step ${key} action` }
          )
        ),
        h(
          'td',
          {},
          isGroup
            ? h(
                'div',
                { class: 'group-line' },
                h(
                  'button',
                  {
                    class: 'icon caret-btn',
                    'aria-expanded': String(open),
                    title: open ? 'Fold the group' : 'Show its steps',
                    onclick: () => ((T.folded = { ...T.folded, [foldKey(i)]: open }), render()),
                  },
                  open ? '▾' : '▸'
                ),
                h('input', {
                  class: 'grow',
                  value: s.name ?? '',
                  placeholder: 'Name of the group, e.g. Open the Sales app',
                  'aria-label': 'Name of the group',
                  onchange: (e) => (set('name', e.target.value.trim()), render()),
                }),
                h('span', { class: 'pill' }, `${s.steps?.length ?? 0} step${(s.steps?.length ?? 0) === 1 ? '' : 's'}`)
              )
            : s.action === 'data'
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
                    const opts = typeof o?.options === 'function' ? o.options(s, { logins: T.logins }) : o?.options;
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
                  })
              ),
          isGroup ? null : h('span', { class: 'sub says' }, stepText(s)),
          bad ? h('span', { class: 'sub', style: 'color: var(--bad)' }, bad) : null,
          r?.ok === false ? h('span', { class: 'sub', style: 'color: var(--bad)' }, r.message) : null
        ),
        h(
          'td',
          { class: 'c-side' },
          h(
            'div',
            { class: 'side-in' },
            h(
              'div',
              { class: 'c-opt' },
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
            h(
              'div',
              { class: 'c-res' },
              r
                ? h(
                    'span',
                    { class: `pill ${r.ok ? 'good' : r.ok === null ? '' : r.optional ? 'warn' : 'bad'}` },
                    r.ok
                      ? `✓ ${(r.ms / 1000).toFixed(1)} s`
                      : r.ok === null
                      ? 'not run'
                      : r.optional
                      ? '✕ optional'
                      : '✕'
                  )
                : null,
              r?.ok && r.message && !isGroup ? h('span', { class: 'sub' }, r.message) : null
            ),
            h(
              'div',
              { class: 'c-acts' },
              h(
                'button',
                {
                  class: 'icon',
                  'aria-label': 'Add a step below',
                  title: inGroup ? 'Add a step below this one, in the group' : 'Add a step below this one',
                  onclick: () => addStepAt(list, i + 1, inGroup ? `${g}.${i + 1}` : String(i + 1)),
                },
                '+'
              ),
              h(
                'button',
                {
                  class: 'icon',
                  'aria-label': 'Up',
                  disabled: i === 0,
                  onclick: () => (
                    ([list[i - 1], list[i]] = [list[i], list[i - 1]]), (T.sel = null), changed(), render()
                  ),
                },
                '↑'
              ),
              h(
                'button',
                {
                  class: 'icon',
                  'aria-label': 'Down',
                  disabled: i === list.length - 1,
                  onclick: () => (
                    ([list[i + 1], list[i]] = [list[i], list[i + 1]]), (T.sel = null), changed(), render()
                  ),
                },
                '↓'
              ),
              h(
                'button',
                {
                  class: 'icon',
                  'aria-label': isGroup ? 'Copy the group' : 'Copy the step',
                  title: isGroup ? 'Copy the group (paste it in any test)' : 'Copy the step (paste it in any test)',
                  onclick: () => void copySteps([s]),
                },
                '⧉'
              ),
              h(
                'button',
                {
                  class: 'icon',
                  'aria-label': isGroup ? 'Remove the group' : 'Remove step',
                  title: isGroup ? 'Remove the group and its steps' : 'Remove the step',
                  onclick: () => (list.splice(i, 1), (T.sel = null), changed(), render()),
                },
                '✕'
              )
            )
          )
        )
      );
    };
    /** Under a group's steps: add one, paste, or take them out of the group. */
    const groupFoot = (s, i) =>
      h(
        'tr',
        { class: 'group-foot' },
        h('td', {}),
        h(
          'td',
          { colspan: 3 },
          h(
            'div',
            { class: 'row' },
            h(
              'button',
              { class: 'small', onclick: () => addStepAt(s.steps, s.steps.length, `${i}.${s.steps.length}`) },
              '+ Step in the group'
            ),
            T.clip?.length
              ? h(
                  'button',
                  {
                    class: 'small',
                    title: 'Paste what you copied at the end of this group',
                    onclick: () => {
                      // A group holds steps only: a copied group gives its steps
                      s.steps.push(...structuredClone(T.clip).flatMap((x) => (x.action === 'group' ? x.steps : [x])));
                      changed();
                      render();
                    },
                  },
                  `Paste ${clipText()} here`
                )
              : null,
            h('span', { class: 'grow' }),
            h(
              'button',
              {
                class: 'small',
                title: 'Its steps become steps of the test again, in its place',
                onclick: () => (test.steps.splice(i, 1, ...s.steps), (T.sel = null), changed(), render()),
              },
              'Ungroup'
            )
          )
        )
      );
    const rows = [];
    test.steps.forEach((s, i) => {
      const r = res?.results?.[i];
      rows.push(stepRow(s, test.steps, i, r));
      if (s.action === 'group' && !T.folded[foldKey(i)]) {
        (s.steps ?? []).forEach((c, j) => rows.push(stepRow(c, s.steps, j, r?.children?.[j], i)));
        rows.push(groupFoot(s, i));
      }
    });
    const file = () => {
      const { id, host, ...rest } = test;
      return JSON.stringify(rest, null, 2);
    };
    const fname = `${test.name.replace(/[^\w-]+/g, '-').toLowerCase()}.nomadqa.json`;
    /** A new step at `at` of `list` (the test's steps, or a group's); the editor scrolls to it, ready to type. */
    const addStepAt = (list, at, key) => {
      list.splice(at, 0, { action: 'click', label: '' });
      T.focusStep = key;
      T.sel = null;
      changed();
      render();
      requestAnimationFrame(() => {
        const tr = document.querySelector(`tr[data-step="${key}"]`);
        tr?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        tr?.querySelector('.step-fields input')?.focus({ preventScroll: true });
        T.focusStep = -1;
      });
    };
    const picked = [...sel].sort((a, b) => a - b).filter((i) => i < test.steps.length);
    /** The ticked steps as one group, where the first of them was (groups among them give their steps). */
    const groupPicked = () => {
      const steps = picked.map((i) => test.steps[i]).flatMap((x) => (x.action === 'group' ? x.steps : [x]));
      const first = picked[0];
      for (const i of [...picked].reverse()) test.steps.splice(i, 1);
      test.steps.splice(first, 0, { action: 'group', name: '', steps });
      T.sel = null;
      T.focusStep = String(first);
      changed();
      render();
      requestAnimationFrame(() => document.querySelector(`tr[data-step="${first}"] .group-line input`)?.focus());
    };
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
          'label',
          { class: 'check', title: 'For every test: the tab a test runs in is closed when the test ends' },
          h('input', {
            type: 'checkbox',
            checked: T.closeTab,
            onchange: (e) => ((T.closeTab = e.target.checked), void store.set('nomadqa.closeTab', T.closeTab)),
          }),
          'Close its tab after'
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
      h('div', { class: 'row' }, h('span', { class: 'muted small' }, 'Group'), ...groupPicker(test, changed)),
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
        ? h(
            'div',
            { class: `run-result ${res.ok ? 'good' : 'bad'}` },
            h(
              'div',
              { class: 'row' },
              h(
                'b',
                { class: 'grow' },
                res.ok ? `Passed in ${(res.ms / 1000).toFixed(1)} s.` : `Failed after ${(res.ms / 1000).toFixed(1)} s.`,
                res.cleaned ? h('span', { class: 'muted' }, ` ${res.cleaned} test record(s) deleted.`) : null
              ),
              h(
                'button',
                {
                  class: 'small',
                  title: 'A page for people: every step, and why it failed (with the picture)',
                  onclick: () => downloadReport(test.name, [{ test, run: res }]),
                },
                'Report'
              )
            ),
            res.ok ? null : failureBox(test, res, { fix: () => void startDebug(test, failureOf(test, res).i) })
          )
        : null,
      picked.length
        ? h(
            'div',
            { class: 'pick-bar' },
            h('b', {}, `${picked.length} ticked`),
            h(
              'button',
              {
                class: 'primary small',
                title: 'They become one step, a group: copy it, run it, fold it',
                onclick: groupPicked,
              },
              'Group them'
            ),
            h('button', { class: 'small', onclick: () => void copySteps(picked.map((i) => test.steps[i])) }, 'Copy'),
            h(
              'button',
              {
                class: 'small danger',
                onclick: () => {
                  for (const i of [...picked].reverse()) test.steps.splice(i, 1);
                  T.sel = null;
                  changed();
                  render();
                },
              },
              'Remove'
            ),
            h('span', { class: 'grow' }),
            h('button', { class: 'link', onclick: () => ((T.sel = null), render()) }, 'Untick all')
          )
        : null,
      // The steps grow with the page (no box of their own to scroll): a change never sends the list to its top
      h(
        'div',
        { class: 'table-box steps-box' },
        h(
          'table',
          { class: 'steps' },
          h(
            'colgroup',
            {},
            h('col', { class: 'c-n' }),
            h('col', { class: 'c-step' }),
            h('col', {}),
            h('col', { class: 'c-side' })
          ),
          h(
            'thead',
            {},
            h('tr', {}, h('th', {}, '#'), h('th', {}, 'Step'), h('th', {}, 'Details'), h('th', {}, 'Result'))
          ),
          h(
            'tbody',
            {},
            rows.length
              ? rows
              : h('tr', {}, h('td', { colspan: 4, class: 'muted empty-row' }, 'No steps yet: add one below.'))
          )
        )
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { onclick: () => addStepAt(test.steps, test.steps.length, String(test.steps.length)) }, '+ Step'),
        T.clip?.length
          ? h(
              'button',
              {
                title: 'Paste what you copied (⧉) at the end of this test',
                onclick: () => {
                  test.steps.push(...structuredClone(T.clip));
                  changed();
                  render();
                },
              },
              `Paste ${clipText()}`
            )
          : null,
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
            onclick: () => void deleteTest(test),
          },
          'Delete test'
        )
      ),
      h(
        'p',
        { class: 'muted small' },
        'Headless (CI): ',
        h('code', {}, `node nomadqa/runner/run.mjs ${fname} --org <alias>`),
        ' — or a folder of tests; Chrome and Node 22, nothing to install; an HTML report, JUnit and a picture of a failed step. GitHub Actions: nomadqa/examples/github-workflow.yml.'
      )
    );
  }

  async function deleteTest(test) {
    if (!(await askYes(`Delete the test “${test.name}”? Its runs stay in Runs.`, { ok: 'Delete', danger: true })))
      return;
    T.tests = T.tests.filter((t) => t !== test);
    if (T.selected === test.id) T.selected = null;
    await saveTests();
    toast(`Deleted “${test.name}”.`);
    render();
  }

  /** Asks before a test that changes data runs in production; true to go on. */
  async function okToRun(tests, what) {
    // Screenshots of a tab need Chrome's "all sites" permission: asked only for a test that takes them (while the
    // click still counts as the person's), and only once
    if (tests.some((t) => allSteps(t).some((x) => x.action === 'shot')))
      T.shotsOk = await chrome.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
    const changes = tests.some((t) =>
      allSteps(t).some((s) => ['click', 'fill', 'pick', 'lookup', 'check', 'data'].includes(s.action))
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
    const strip = ({ shot, children, ...r }) => (children ? { ...r, children: children.map(strip) } : r);
    const entry = {
      id: newId(),
      testId: test.id,
      testName: test.name,
      at: new Date().toISOString(),
      org: label(),
      ok: out.ok,
      ms: out.ms,
      results: out.results.map(strip),
      steps: test.steps.map(stepText),
      test: file,
      junit: junit(test, out),
      ...extra,
    };
    T.runs = [entry, ...T.runs].slice(0, 100);
    await store.set('nomadqa.runs', T.runs);
    // The pictures of failed steps are kept apart, for the newest 20 runs that have one (about 100 KB each)
    const shots = Object.fromEntries(out.results.map((r, i) => [i, r.shot]).filter(([, v]) => v));
    if (Object.keys(shots).length) {
      const all = { ...T.shots, [entry.id]: shots };
      const keep = T.runs
        .map((r) => r.id)
        .filter((k) => all[k])
        .slice(0, 20);
      T.shots = Object.fromEntries(keep.map((k) => [k, all[k]]));
      await store.set('nomadqa.shots', T.shots);
    }
    return entry;
  }
  /** A kept run's results with their pictures again. */
  const withShots = (r) => r.results.map((x, i) => (T.shots[r.id]?.[i] ? { ...x, shot: T.shots[r.id][i] } : x));
  /** A kept run as the report wants it. */
  const runItem = (r) => ({
    test: { ...(r.test ?? { steps: [] }), name: r.testName, group: r.group },
    run: { ok: r.ok, ms: r.ms, results: withShots(r) },
  });
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
      if (T.closeTab) await driver.close({ tab: true });
      // Back to NomadQA to see the result
      await backHere();
    });
  }

  /** Tests that log in as someone else change who is logged in for the whole browser: they run alone. */
  const logsIn = (t) => allSteps(t).some((x) => x.action === 'login' || x.action === 'loginas');

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
        if (T.closeTab) await driver.close({ tab: true });
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
        at: new Date().toISOString(),
        passed: list.filter((x) => x.run.ok).length,
        total: tests.length,
        items: list,
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
        // A step that opened a new tab: the test (and its list) goes on there; the old tab's list says so
        if (D.driver.tabId !== D.tabId) {
          const old = D.tabId;
          D.tabId = D.driver.tabId;
          const to = await chrome.tabs
            .get(D.tabId)
            .then((t) => (/\.salesforce-setup\.com|\/lightning\/setup\//.test(t.url ?? '') ? 'Setup' : t.title ?? ''))
            .catch(() => '');
          d = await writeDebug((x) => {
            x.tabId = D.tabId;
            if (x.items[i]?.result) x.items[i].result.newTab = true;
            x.msg = `Step ${i + 1} opened a new tab${to ? ` (${to})` : ''}: the test goes on here.`;
          });
          await pageMode(old, 'moved', { to }).catch(() => {});
        }
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
                        ' ',
                        h(
                          'button',
                          {
                            title: 'A page for people: every step, why it failed, with the picture',
                            disabled: !r.test,
                            onclick: () => downloadReport(r.testName, [runItem(r)], r.at),
                          },
                          'Report'
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
                              ' ',
                              h(
                                'button',
                                {
                                  title: `A page for people with every test of this run of “${r.group}”`,
                                  onclick: () =>
                                    downloadReport(
                                      `Group ${r.group}`,
                                      T.runs
                                        .filter((x) => x.suite === r.suite && x.test)
                                        .reverse()
                                        .map(runItem),
                                      r.at
                                    ),
                                },
                                'Group report'
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
            h(
              'div',
              { class: 'row' },
              h('h2', { class: 'grow' }, open.testName),
              h(
                'button',
                {
                  class: 'small',
                  disabled: !open.test,
                  onclick: () => downloadReport(open.testName, [runItem(open)], open.at),
                },
                'Report'
              )
            ),
            open.test && !open.ok ? failureBox(runItem(open).test, runItem(open).run) : null,
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
