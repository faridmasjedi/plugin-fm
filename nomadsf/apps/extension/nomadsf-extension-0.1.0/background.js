import { a as r } from './assets/hosts-XUdLUg5A.js';
chrome.runtime.onMessage.addListener((t, o) => {
  var a;
  if (t.type !== 'nomadsf:open-studio' || !((a = o.tab) != null && a.url)) return;
  const e = r(new URL(o.tab.url).host);
  if (!e) return;
  const n = t.page && /^[a-z]+$/.test(t.page) ? `#${t.page}` : '';
  chrome.tabs.create({
    url: chrome.runtime.getURL(`app/index.html?host=${encodeURIComponent(e)}${n}`),
    index: o.tab.index + 1,
  });
});
