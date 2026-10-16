import { a as l } from './hosts-XUdLUg5A.js';
(function () {
  const o = document.createElement('link').relList;
  if (o && o.supports && o.supports('modulepreload')) return;
  for (const e of document.querySelectorAll('link[rel="modulepreload"]')) i(e);
  new MutationObserver((e) => {
    for (const t of e)
      if (t.type === 'childList')
        for (const r of t.addedNodes) r.tagName === 'LINK' && r.rel === 'modulepreload' && i(r);
  }).observe(document, { childList: !0, subtree: !0 });
  function c(e) {
    const t = {};
    return (
      e.integrity && (t.integrity = e.integrity),
      e.referrerPolicy && (t.referrerPolicy = e.referrerPolicy),
      e.crossOrigin === 'use-credentials'
        ? (t.credentials = 'include')
        : e.crossOrigin === 'anonymous'
        ? (t.credentials = 'omit')
        : (t.credentials = 'same-origin'),
      t
    );
  }
  function i(e) {
    if (e.ep) return;
    e.ep = !0;
    const t = c(e);
    fetch(e.href, t);
  }
})();
const s = document.getElementById('main');
function m(n, o) {
  return chrome.runtime.getURL(`app/index.html?host=${encodeURIComponent(n)}${o ? `#${o}` : ''}`);
}
async function p() {
  const [n] = await chrome.tabs.query({ active: !0, currentWindow: !0 }),
    o = n != null && n.url ? new URL(n.url).host : '',
    c = l(o);
  if (!c) {
    s.innerHTML = '<p class="muted">Open a Salesforce page (Lightning, Setup or Classic) and click NomadSF again.</p>';
    return;
  }
  const i = await chrome.cookies.get({ url: `https://${c}`, name: 'sid' });
  s.innerHTML = '';
  const e = document.createElement('div');
  if (((e.className = 'org'), (e.textContent = c), s.append(e), !(i != null && i.value))) {
    const r = document.createElement('p');
    (r.className = 'muted'),
      (r.textContent = 'Not logged in to this org in this browser. Log in, then try again.'),
      s.append(r);
    return;
  }
  const t = (r, u, d = !1) => {
    const a = document.createElement('button');
    (a.textContent = r),
      d && (a.className = 'primary'),
      (a.onclick = () => {
        chrome.tabs.create({ url: m(c, u), index: ((n == null ? void 0 : n.index) ?? 0) + 1 }), window.close();
      }),
      s.append(a);
  };
  t('Open NomadSF Studio', void 0, !0),
    t('▶  Execute Apex', 'apex'),
    t('☰  Debug logs', 'logs'),
    t('⌕  Query', 'query');
}
p().catch((n) => {
  s.innerHTML = '';
  const o = document.createElement('p');
  (o.className = 'muted'), (o.textContent = n.message), s.append(o);
});
