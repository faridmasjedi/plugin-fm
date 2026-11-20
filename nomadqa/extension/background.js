// The toolbar button opens NomadQA in a tab (for the org of the page you are on); Alt+Shift+I turns the Inspector
// on or off on the Salesforce page in front.
import { apiHostFor } from './core/salesforce.js';

/** Opens NomadQA next to `tab`, for the org of its page. */
async function openFor(tab) {
  let host = '';
  try {
    host = apiHostFor(new URL(tab?.url ?? '').host) ?? '';
  } catch {
    host = '';
  }
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`app.html${host ? `?host=${encodeURIComponent(host)}` : ''}`),
    index: (tab?.index ?? 0) + 1,
  });
}

// The tab on Salesforce pages (content/tab.js)
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'nomadqa:open') void openFor(sender.tab);
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
