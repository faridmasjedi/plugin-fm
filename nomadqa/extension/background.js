// The toolbar button opens NomadQA in a tab (for the org of the page you are on); Alt+Shift+I turns the Inspector
// on or off on the Salesforce page in front.
import { apiHostFor } from './core/salesforce.js';

/** Opens NomadQA next to `tab`, for the org of its page. */
async function openFor(tab, view = '') {
  let host = '';
  try {
    host = apiHostFor(new URL(tab?.url ?? '').host) ?? '';
  } catch {
    host = '';
  }
  await chrome.tabs.create({
    url: chrome.runtime.getURL(
      `app.html?${new URLSearchParams({ ...(host ? { host } : {}), ...(view ? { view } : {}) })}`
    ),
    index: (tab?.index ?? 0) + 1,
  });
}

// The tab on Salesforce pages (content/tab.js)
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'nomadqa:open') void openFor(sender.tab, msg.view);
});

chrome.action.onClicked.addListener((tab) => void openFor(tab));

/** Puts the engine and NomadQA's page script in a tab (once; they stay until the page reloads). */
export async function prepare(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ['core/engine.js', 'content/page.js'] });
}

// The Inspector asks for an object's field API names by label (the page itself does not carry them)
const described = new Map();
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'nomadqa:fields') return;
  (async () => {
    const host = apiHostFor(new URL(sender.tab?.url ?? '').host);
    if (!host || !/^\w+$/.test(msg.object ?? '')) return {};
    const key = `${host}|${msg.object}`;
    if (!described.has(key)) {
      const sid = (await chrome.cookies.get({ url: `https://${host}`, name: 'sid' }))?.value;
      const res = await fetch(`https://${host}/services/data/v62.0/sobjects/${msg.object}/describe`, {
        headers: { Authorization: `Bearer ${sid}` },
      });
      const d = await res.json();
      described.set(
        key,
        (d.fields ?? []).map((f) => ({ label: f.label, name: f.name }))
      );
    }
    return described.get(key);
  })()
    .then(reply)
    .catch(() => reply({}));
  return true;
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-inspector' || !tab?.id) return;
  try {
    if (!apiHostFor(new URL(tab.url ?? '').host)) return;
    await prepare(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'nomadqa:mode', mode: 'toggle-inspect' });
  } catch {
    /* not a page NomadQA may run on */
  }
});

// The Inspector's "Find a record": runs a read-only query in the page's org, so the record can be opened right away
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'nomadqa:find') return;
  (async () => {
    const host = apiHostFor(new URL(sender.tab?.url ?? '').host);
    if (!host) throw new Error('Not a Salesforce page.');
    if (!/^\s*SELECT\s[\s\S]+?\sFROM\s+\w+/i.test(String(msg.soql ?? '')) || /;/.test(msg.soql))
      throw new Error('A query that reads: SELECT … FROM …');
    const sid = (await chrome.cookies.get({ url: `https://${host}`, name: 'sid' }))?.value;
    const res = await fetch(`https://${host}/services/data/v62.0/query?q=${encodeURIComponent(msg.soql)}`, {
      headers: { Authorization: `Bearer ${sid}` },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.[0]?.message ?? `Salesforce answered ${res.status}.`);
    return { total: data.totalSize ?? 0, rows: (data.records ?? []).slice(0, 5).map(({ attributes, ...r }) => r) };
  })()
    .then(reply)
    .catch((e) => reply({ error: e.message }));
  return true;
});

// Tabs where the Inspector is on (or a test is gone through step by step): after a full page load it is turned on
// again there, in the same mode
const modes = async () => (await chrome.storage.session.get('modes')).modes ?? {};
const setModes = (m) => chrome.storage.session.set({ modes: m });
chrome.runtime.onMessage.addListener((msg, sender) => {
  const id = sender.tab?.id;
  if (!id) return;
  if (msg?.type === 'nomadqa:inspecting')
    void modes().then((m) => {
      if (msg.on) m[id] = msg.mode ?? 'inspect';
      else delete m[id];
      return setModes(m);
    });
  if (msg?.type === 'nomadqa:loaded')
    void modes().then(async (m) => {
      if (!m[id]) return;
      try {
        await prepare(id);
        await chrome.tabs.sendMessage(id, { type: 'nomadqa:mode', mode: m[id], resume: true });
      } catch {
        /* the page went elsewhere */
      }
    });
});
// A tab opened from a tab being recorded or inspected (Setup from the gear opens one): it goes on there
chrome.tabs.onCreated.addListener(
  (t) =>
    void modes().then((m) => {
      const mode = t.openerTabId ? m[t.openerTabId] : null;
      if (!t.id || (mode !== 'record' && mode !== 'inspect')) return;
      m[t.id] = mode;
      return setModes(m);
    })
);
chrome.tabs.onRemoved.addListener(
  (id) =>
    void modes().then((m) => {
      if (!m[id]) return;
      delete m[id];
      return setModes(m);
    })
);
