// The toolbar button opens NomadQA in a tab, for the org of the page you are on (when it is a Salesforce page).
import { apiHostFor } from './core/salesforce.js';

chrome.action.onClicked.addListener(async (tab) => {
  let host = '';
  try {
    host = apiHostFor(new URL(tab.url ?? '').host) ?? '';
  } catch {
    host = '';
  }
  await chrome.tabs.create({
    url: chrome.runtime.getURL(`app.html${host ? `?host=${encodeURIComponent(host)}` : ''}`),
    index: (tab.index ?? 0) + 1,
  });
});
