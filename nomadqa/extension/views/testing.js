// NomadQA pages for tests: Inspector, Recorder, Tests (edit and run), Runs, Agent, Settings (AI).
import { h, select, askTyped, toast, download } from '../core/ui.js';
import { ACTIONS, stepText, problem, runTest, junit } from '../core/steps.js';
import { PROVIDERS, stepsFromWords } from '../core/ai.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SF_TABS = ['https://*.salesforce.com/*', 'https://*.force.com/*'];

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
    agent: { words: '', result: null },
  });

  async function load() {
    T.tests = await store.get('nomadqa.tests', []);
    T.runs = await store.get('nomadqa.runs', []);
    T.ai = { ...T.ai, ...(await store.get('nomadqa.ai', {})) };
    T.recording = await store.get('nomadqa.recording', null);
    chrome.storage.onChanged.addListener((changes) => {
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
        T.tabs.length
          ? h(
              'div',
              { class: 'table-box' },
              h(
                'table',
                {},
                h(
                  'tbody',
                  {},
                  T.tabs.map((t) =>
                    h(
                      'tr',
                      {},
                      h(
                        'td',
                        {},
                        h('b', {}, t.title || 'Salesforce'),
                        h('span', { class: 'sub' }, new URL(t.url).host)
                      ),
                      h(
                        'td',
                        { style: 'text-align: right' },
                        h('button', { class: 'primary', onclick: () => void inspect(t) }, 'Inspect this tab')
                      )
                    )
                  )
                )
              )
            )
          : h('p', { class: 'muted' }, 'No Salesforce tab is open in this browser.'),
        h('button', { onclick: () => void salesforceTabs().then(render) }, 'Look again')
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
  const FIELDS = {
    open: [
      ['path', 'Path (/lightning/o/Account/list)'],
      ['record', 'or a record ({{a-1}} or an Id)'],
      ['object', 'or an object'],
      ['name', '… and a name'],
    ],
    click: [
      ['label', 'What it says'],
      ['within', 'In (a section title, optional)'],
    ],
    fill: [
      ['field', 'Field label'],
      ['value', 'Value'],
    ],
    pick: [
      ['field', 'Field label'],
      ['value', 'Value'],
    ],
    lookup: [
      ['field', 'Field label'],
      ['value', 'Record name'],
    ],
    check: [
      ['field', 'Field label'],
      ['value', 'true or false'],
    ],
    wait: [
      ['text', 'Until this text shows'],
      ['ms', 'or milliseconds'],
    ],
    press: [['key', 'Key (Enter, Escape…)']],
    expect: [
      ['kind', 'text · toast · field · title · url · no-text'],
      ['field', 'Field (for kind field)'],
      ['value', 'Value'],
    ],
    query: [
      ['soql', 'SELECT Id FROM …'],
      ['count', 'Rows (empty = at least one)'],
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
                { class: 'setting', style: 'flex-wrap: wrap' },
                fields.map(([k, ph]) =>
                  h('input', {
                    value: s[k] === undefined ? '' : String(s[k]),
                    placeholder: ph,
                    'aria-label': ph,
                    title: ph,
                    style: 'flex: 1 1 150px',
                    onchange: (e) => (set(k, e.target.value), render()),
                  })
                )
              ),
          bad ? h('span', { class: 'sub', style: 'color: var(--bad)' }, bad) : null,
          r?.ok === false ? h('span', { class: 'sub', style: 'color: var(--bad)' }, r.message) : null
        ),
        h(
          'td',
          {},
          r
            ? h(
                'span',
                { class: `pill ${r.ok ? 'good' : r.ok === null ? '' : 'bad'}` },
                r.ok ? `✓ ${(r.ms / 1000).toFixed(1)} s` : r.ok === null ? 'not run' : '✕'
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
              : `Failed at step ${res.results.findIndex((r) => r.ok === false) + 1}.`,
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
