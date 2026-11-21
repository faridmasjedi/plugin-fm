// NomadQA on a Salesforce page (isolated world, after core/engine.js): the Inspector and the Recorder.
// Its own panel lives in a shadow root of its own, so the page's styles never reach it.
(() => {
  if (globalThis.__nomadqaPage) return;
  const Q = globalThis.__nomadqa;
  const state = {
    mode: 'off',
    pinned: null,
    checking: false,
    steps: [],
    lastClickAt: 0,
    path: location.pathname + location.search,
  };

  // ---------- panel ----------
  const host = document.createElement('div');
  host.id = 'nomadqa-host';
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>
    :host{all:initial}
    *{box-sizing:border-box;font:13px/1.4 Inter,system-ui,-apple-system,sans-serif}
    .box{position:fixed;border:2px solid #5b3fd1;background:rgba(91,63,209,.08);border-radius:4px;pointer-events:none;display:none}
    .tip{position:fixed;max-width:420px;background:#1d2433;color:#fff;border-radius:10px;padding:10px 12px;box-shadow:0 8px 30px rgba(0,0,0,.3);pointer-events:auto;display:none}
    .tip .row{display:flex;gap:8px;margin:2px 0}.tip .k{color:#a6adbe;min-width:76px}.tip .v{word-break:break-all}
    .tip code{font:12px ui-monospace,Menlo,monospace;color:#c4b8ff}
    .tip button{margin-top:6px;margin-right:6px}.tip .group{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 6px;margin-top:6px}.tip .group .k{min-width:96px}.tip button.step{border-color:#5b3fd1;color:#432bb0}
    .bar{position:fixed;right:18px;bottom:18px;background:#fff;color:#1d2433;border:1px solid #e3e6ee;border-radius:12px;box-shadow:0 8px 30px rgba(20,24,40,.18);padding:10px 12px;display:none;gap:10px;align-items:center;pointer-events:auto}
    .dot{width:10px;height:10px;border-radius:50%;background:#d12b2b;box-shadow:0 0 0 0 rgba(209,43,43,.5);animation:p 1.4s infinite}
    @keyframes p{70%{box-shadow:0 0 0 8px rgba(209,43,43,0)}}
    button{font:inherit;font-size:12.5px;padding:5px 10px;border-radius:7px;border:1px solid #d5d9e4;background:#fff;color:#1d2433;cursor:pointer}
    button.on{background:#5b3fd1;border-color:#5b3fd1;color:#fff}
    .last{color:#5b6475;max-width:260px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .brand{font-weight:700;color:#5b3fd1}
  </style>
  <div class="box"></div><div class="tip"></div>
  <div class="bar"><span class="dot"></span><span class="brand">NomadQA</span><span class="count">0 steps</span><span class="last"></span>
  <button class="check" title="Then click what to check on the page">+ Check</button><button class="stop">Stop</button></div>`;
  const box = root.querySelector('.box');
  const tip = root.querySelector('.tip');
  const bar = root.querySelector('.bar');
  const ours = (el) => el === host || host.contains(el) || el?.getRootNode?.() === root;
  const mount = () => document.documentElement.appendChild(host);

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function outline(el) {
    if (!el) return (box.style.display = 'none');
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block',
      left: `${r.x - 2}px`,
      top: `${r.y - 2}px`,
      width: `${r.width + 4}px`,
      height: `${r.height + 4}px`,
    });
  }

  // ---------- inspector ----------
  const apiNames = {};
  async function apiName(object, label) {
    if (!object || !label) return '';
    if (!apiNames[object])
      apiNames[object] = chrome.runtime.sendMessage({ type: 'nomadqa:fields', object }).catch(() => ({}));
    const fields = await apiNames[object];
    if (!Array.isArray(fields)) return '';
    const want = label.toLowerCase();
    // The page may show a shorter label than the field's own ("Type" for "Account Type")
    const hit =
      fields.find((f) => f.label.toLowerCase() === want) ??
      fields.find((f) => f.name.toLowerCase() === want.replace(/\s+/g, '')) ??
      fields.find((f) => f.label.toLowerCase().endsWith(` ${want}`));
    return hit?.name ?? '';
  }
  const short = (t) => (t.length > 34 ? `${t.slice(0, 32)}…` : t);

  // Test steps for what is pinned, by what a person sees (as the Recorder writes them)
  const CLICKS = 'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="link"], [role="option"]';
  function stepsFor(el, d) {
    const out = [];
    const line = (t) =>
      String(t ?? '')
        .split('\n')
        .map((x) => x.trim())
        .find(Boolean) ?? '';
    if (d.field) {
      const input = [...Q.ancestors(el)].find((a) => a.matches?.('input, textarea'));
      if (input && !input.readOnly && !input.disabled)
        out.push({
          button: 'Type into it',
          step: { action: 'fill', field: d.field, value: input.value ?? '' },
          text: `Type “${input.value ?? ''}” in ${d.field}`,
        });
      const value = Q.fieldValue(d.field);
      if (value !== null && value !== undefined)
        out.push({
          button: 'Check its value',
          step: { action: 'expect', kind: 'field', field: d.field, value },
          text: `Check ${d.field} is “${value}”`,
        });
    }
    const click = [...Q.ancestors(el)].find((a) => a.matches?.(CLICKS));
    const name = click ? line(click.getAttribute('aria-label') || click.getAttribute('title') || click.innerText) : '';
    if (name && name.length <= 60)
      out.push({ button: `Click “${short(name)}”`, step: { action: 'click', label: name }, text: `Click “${name}”` });
    const text = line(el.innerText);
    if (!d.field && text && text.length <= 120 && text !== name)
      out.push({
        button: 'Check this text shows',
        step: { action: 'expect', kind: 'text', value: text },
        text: `Check the page shows “${text}”`,
      });
    out.push({
      button: 'Start on this page',
      step: { action: 'open', path: location.pathname + location.search },
      text: `Open ${location.pathname}`,
    });
    return out;
  }
  function showInfo(el, x, y) {
    const d = Q.describe(el);
    if (!d.fieldApi && d.field && d.record)
      void apiName(d.record.object, d.field).then((api) => {
        if (api && (state.pinned === el || state.hover === el)) {
          const row = tip.querySelector('[data-field]');
          if (row) row.innerHTML = `<code>${esc(d.record.object)}.${esc(api)}</code> · ${esc(d.field)}`;
          // Found by the label: copy it like a named one
          d.fieldApi = `${d.record.object}.${api}`;
          const copy = tip.querySelector('[data-copy="tag"]');
          if (copy && !tip.querySelector('[data-copy="field"]'))
            copy.insertAdjacentHTML('beforebegin', '<button data-copy="field">Copy field</button>'), wire();
        }
      });
    const suggested = state.pinned ? stepsFor(el, d) : [];
    const rows = [];
    if (d.custom) rows.push(['Yours', `<code>${esc(d.custom.tag)}</code><br><code>${esc(d.custom.path)}</code>`]);
    if (d.packaged) rows.push(['Package', `<code>${esc(d.packaged)}</code>`]);
    if (d.fieldApi) rows.push(['Field', `<code>${esc(d.fieldApi)}</code>`]);
    else if (d.field) rows.push(['Field', `<span data-field>${esc(d.field)}</span>`]);
    if (d.name) rows.push(['Says', esc(d.name)]);
    if (d.aura) rows.push(['Aura', `<code>${esc(d.aura)}</code>`]);
    rows.push(['Built from', `<code>${esc(d.components.slice(0, 4).map(short).join(' › ') || d.tag)}</code>`]);
    if (d.record) rows.push(['Record', `${esc(d.record.object)} <code>${esc(d.record.id)}</code>`]);
    tip.innerHTML =
      rows.map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`).join('') +
      (state.pinned
        ? `<div class="group"><span class="k">Copy</span>${
            d.custom ? '<button data-copy="path">Copy path</button>' : ''
          }${
            d.fieldApi ? '<button data-copy="field">Copy field</button>' : ''
          }<button data-copy="tag" title="The component's tag, e.g. c-invoice-list">Copy tag</button></div>${
            suggested.length
              ? `<div class="group"><span class="k">Add to a test</span>${suggested
                  .map(
                    (x, i) => `<button class="step" data-step="${i}" title="${esc(x.text)}">${esc(x.button)}</button>`
                  )
                  .join('')}</div>`
              : ''
          }<div><button data-close>Close</button></div>`
        : '<div class="k" style="margin-top:4px">Click to pin · Esc to stop</div>');
    function wire() {
      tip.querySelectorAll('[data-copy]').forEach((b) => {
        b.onclick = () => {
          const what = b.getAttribute('data-copy');
          navigator.clipboard.writeText(
            what === 'path' ? d.custom.path : what === 'field' ? d.fieldApi : d.components[0] ?? d.tag
          );
          b.textContent = 'Copied';
        };
      });
      tip.querySelectorAll('[data-step]').forEach((b) => {
        b.onclick = async () => {
          const x = suggested[Number(b.getAttribute('data-step'))];
          const { 'nomadqa.picked': list = [] } = await chrome.storage.local.get('nomadqa.picked');
          list.push({ step: x.step, text: x.text, page: location.pathname, at: Date.now() });
          await chrome.storage.local.set({ 'nomadqa.picked': list });
          b.textContent = `Added ✓ (${list.length} waiting in Tests)`;
        };
      });
    }
    wire();
    tip.querySelector('[data-close]')?.addEventListener('click', () => {
      state.pinned = null;
      tip.style.display = 'none';
    });
    tip.style.display = 'block';
    const w = Math.min(420, innerWidth - 20);
    tip.style.left = `${Math.min(x + 14, innerWidth - w - 10)}px`;
    tip.style.top = `${Math.min(y + 16, innerHeight - tip.offsetHeight - 10)}px`;
  }
  const onMove = (e) => {
    if (state.pinned || state.mode !== 'inspect') return;
    const el = e.composedPath?.()[0] ?? e.target;
    if (!el?.tagName || ours(el)) return;
    state.hover = el;
    outline(el);
    showInfo(el, e.clientX, e.clientY);
  };

  // ---------- recorder ----------
  const OPTION = '[role="option"], lightning-base-combobox-item';
  const FIELD_BOX =
    'lightning-input, lightning-textarea, lightning-combobox, lightning-grouped-combobox, lightning-input-field, lightning-lookup, .slds-form-element';
  const closest = (el, sel) => [...Q.ancestors(el)].find((a) => a.matches?.(sel)) ?? null;
  const firstLine = (s) =>
    String(s ?? '')
      .split('\n')
      .map((x) => x.trim())
      .find(Boolean) ?? '';

  async function save() {
    bar.querySelector('.count').textContent = `${state.steps.length} step${state.steps.length === 1 ? '' : 's'}`;
    const last = state.steps[state.steps.length - 1];
    bar.querySelector('.last').textContent = last ? text(last) : '';
    try {
      await chrome.storage.local.set({
        'nomadqa.recording': { host: location.host, at: Date.now(), steps: state.steps },
      });
    } catch {
      /* the extension was reloaded: nothing to keep */
    }
  }
  const text = (s) =>
    s.action === 'click'
      ? `Click “${s.label}”`
      : s.action === 'open'
      ? `Open ${s.path}`
      : s.action === 'expect'
      ? `Check ${s.kind} ${s.field ? `${s.field} = ` : ''}“${s.value}”`
      : `${s.action} ${s.field} = “${s.value}”`;
  function add(step) {
    const last = state.steps[state.steps.length - 1];
    // Typing in the same field again replaces it; a lookup replaces the search text typed into it
    if (
      last &&
      (last.action === 'fill' || last.action === 'lookup') &&
      step.field &&
      last.field === step.field &&
      step.action !== 'expect'
    )
      state.steps.pop();
    state.steps.push(step);
    void save();
  }

  function expectFor(el) {
    const toast = closest(el, '.toastMessage, .forceToastMessage, [role="alert"], .slds-notify');
    if (toast) return { action: 'expect', kind: 'toast', value: firstLine(toast.innerText).slice(0, 80) };
    const item = closest(el, 'records-highlights-details-item, records-record-layout-item, force-record-layout-item');
    if (item) {
      const leaves = [...item.querySelectorAll('*')].filter((x) => x.children.length === 0 && x.textContent.trim());
      const label = leaves[0]?.textContent.trim();
      const value = label ? Q.fieldValue(label) : '';
      if (label && value) return { action: 'expect', kind: 'field', field: label, value: value.slice(0, 80) };
    }
    const t = firstLine(el.innerText ?? el.textContent).slice(0, 80);
    return t ? { action: 'expect', kind: 'text', value: t } : null;
  }

  function onClick(e) {
    if (state.mode !== 'record' && state.mode !== 'inspect') return;
    const el = e.composedPath?.()[0] ?? e.target;
    if (!el?.tagName || ours(el) || e.composedPath?.().includes(host)) return;
    if (state.mode === 'inspect') {
      e.preventDefault();
      e.stopPropagation();
      state.pinned = el;
      outline(el);
      showInfo(el, e.clientX, e.clientY);
      return;
    }
    if (state.checking) {
      e.preventDefault();
      e.stopPropagation();
      state.checking = false;
      bar.querySelector('.check').classList.remove('on');
      outline(null);
      const step = expectFor(el);
      if (step) add(step);
      return;
    }
    state.lastClickAt = Date.now();
    const option = closest(el, OPTION);
    if (option) {
      const fbox = closest(option, FIELD_BOX);
      const label = fbox ? Q.fieldLabelOf(option) || Q.fieldLabelOf(fbox) : '';
      const value = firstLine(option.getAttribute('title') || option.innerText);
      if (label && value) {
        const lookup = closest(option, 'lightning-grouped-combobox, lightning-lookup');
        add({ action: lookup ? 'lookup' : 'pick', field: label, value });
        return;
      }
    }
    if (closest(el, 'input, textarea, [role="combobox"]')) return;
    const target = closest(
      el,
      'button, a, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="link"], input[type="submit"], input[type="button"]'
    );
    if (!target) return;
    const label = firstLine(
      target.getAttribute('aria-label') || target.getAttribute('title') || target.innerText || target.value
    );
    if (!label || label.length > 80) return;
    add({ action: 'click', label });
  }

  function onChange(e) {
    if (state.mode !== 'record') return;
    const el = e.composedPath?.()[0] ?? e.target;
    if (!el?.tagName || ours(el) || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
    if (el.getAttribute('role') === 'combobox') return; // lookups and pick lists come from the option chosen
    const field = Q.fieldLabelOf(el) || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
    if (!field) return;
    if (el.type === 'checkbox') return add({ action: 'check', field, value: el.checked });
    if (el.type === 'password')
      return add({ action: 'fill', field, value: '', note: 'a password is never recorded: type it in the test' });
    add({ action: 'fill', field, value: el.value });
  }

  setInterval(() => {
    if (state.mode !== 'record') return;
    const now = location.pathname + location.search;
    if (now === state.path) return;
    state.path = now;
    // A page opened by a click is the click's doing; otherwise it is a step of its own
    if (Date.now() - state.lastClickAt > 6000) add({ action: 'open', path: location.pathname });
  }, 400);

  bar.querySelector('.check').addEventListener('click', () => {
    state.checking = !state.checking;
    bar.querySelector('.check').classList.toggle('on', state.checking);
  });
  bar.querySelector('.stop').addEventListener('click', () => setMode('off'));
  document.addEventListener(
    'mousemove',
    (e) => {
      if (state.mode === 'inspect') return onMove(e);
      if (state.checking) {
        const el = e.composedPath?.()[0] ?? e.target;
        if (el?.tagName && !ours(el)) outline(el);
      }
    },
    true
  );
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || state.mode !== 'inspect') return;
      if (state.pinned) {
        state.pinned = null;
        tip.style.display = 'none';
      } else setMode('off');
    },
    true
  );

  function setMode(mode, opts = {}) {
    state.mode = mode;
    state.pinned = null;
    state.checking = false;
    outline(null);
    tip.style.display = 'none';
    bar.style.display = mode === 'record' ? 'flex' : 'none';
    if (mode !== 'off') mount();
    if (mode === 'record') {
      state.steps = opts.keep ? state.steps : [{ action: 'open', path: location.pathname }];
      state.path = location.pathname + location.search;
      void save();
    }
    if (mode === 'off') {
      host.remove();
      void chrome.storage.local
        .get('nomadqa.recording')
        .then((r) => {
          const rec = r['nomadqa.recording'];
          if (rec) return chrome.storage.local.set({ 'nomadqa.recording': { ...rec, done: true } });
        })
        .catch(() => {});
    }
    return { mode, steps: state.steps.length };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== 'nomadqa:mode') return;
    reply(setMode(msg.mode === 'toggle-inspect' ? (state.mode === 'inspect' ? 'off' : 'inspect') : msg.mode, msg));
  });
  globalThis.__nomadqaPage = { setMode, state };
})();
