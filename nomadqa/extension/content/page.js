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
    .tray{position:fixed;left:18px;bottom:18px;width:400px;max-height:58vh;display:none;flex-direction:column;background:#fff;color:#1d2433;border:1px solid #e3e6ee;border-radius:14px;box-shadow:0 10px 36px rgba(20,24,40,.2);pointer-events:auto;overflow:hidden}
    .tray header{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eef0f5;cursor:move;user-select:none}
    .tray header b{flex:1}.tray .n{background:#efebff;color:#432bb0;border-radius:999px;padding:0 8px;font-size:12px;font-weight:600}
    .tray ol{margin:0;padding:6px 8px 6px 30px;overflow:auto;flex:1}
    .tray li{padding:6px 4px;border-bottom:1px solid #f1f2f6}
    .tray li .line{display:flex;gap:6px;align-items:flex-start}.tray li .txt{flex:1;word-break:break-word}
    .tray li .acts{display:flex;gap:2px;flex:none}
    .tray .ib{border:0;background:none;padding:2px 5px;color:#5b6475;font-size:13px}.tray .ib:hover{background:#f0f1f7;color:#1d2433}
    .tray .ib:disabled{opacity:.35;cursor:default}
    .tray .edit{display:flex;gap:6px;margin-top:6px}.tray .edit input{flex:1}
    .tray input{font:inherit;font-size:12.5px;padding:5px 8px;border:1px solid #d5d9e4;border-radius:7px;min-width:0}
    .tray .empty{padding:12px;color:#5b6475}
    .tray footer{display:flex;flex-wrap:wrap;gap:6px;padding:10px 12px;border-top:1px solid #eef0f5;background:#fafbfd}
    .tray .find{display:grid;gap:6px;padding:10px 12px;border-top:1px solid #eef0f5}
    .tray .find .r{display:flex;flex-wrap:wrap;gap:6px}.tray .msg{font-size:12px;color:#5b6475}.tray .msg.bad{color:#a3272b}
    .tray.small ol,.tray.small footer,.tray.small .find,.tray.small .empty{display:none}
    button.primary{background:#5b3fd1;border-color:#5b3fd1;color:#fff}
    button:disabled{opacity:.45;cursor:default}
    .tray header button.on{background:#5b3fd1;border-color:#5b3fd1;color:#fff}
    .tray .note{padding:8px 12px;background:#fff8e6;color:#7a5200;font-size:12px;border-bottom:1px solid #f3e3b8}
    .tray li.cur{background:#f4f1ff;border-radius:6px}
    .tray li .txt[data-a]{cursor:pointer}.tray li .txt[data-a]:hover{text-decoration:underline}
    .tray .mk{flex:none;width:14px;text-align:center;color:#8a93a6}.tray .mk.cur{color:#5b3fd1}.tray .mk.ok{color:#1f7a4d}.tray .mk.bad{color:#c23934}.tray .mk.warn{color:#a86b00}
    .tray .why{margin:4px 0 0 20px;font-size:12px;color:#a3272b;word-break:break-word}
    .tray .muted{color:#8a93a6}
    .tip button.step.primary{color:#fff}
    .tip .form{display:grid;gap:6px;margin-top:8px;padding-top:8px;border-top:1px solid #39415a}
    .tip .form input{font:inherit;font-size:12.5px;padding:5px 8px;border:1px solid #4a5370;border-radius:7px;background:#11161f;color:#fff}
  </style>
  <div class="box"></div><div class="tray"></div><div class="tip"></div>
  <div class="bar"><span class="dot"></span><span class="brand">NomadQA</span><span class="count">0 steps</span><span class="last"></span>
  <button class="check" title="Then click what to check on the page">+ Check</button><button class="stop">Stop</button></div>`;
  const box = root.querySelector('.box');
  const tip = root.querySelector('.tip');
  const bar = root.querySelector('.bar');
  const tray = root.querySelector('.tray');
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

  // ---------- the test being picked (shown while the Inspector is on) ----------
  // Steps added from the pinned panel wait in storage (nomadqa.picked) until Tests takes them: here they can be
  // read, changed, moved and removed, and a record can be found by a query.
  const MAIN = {
    click: 'label',
    fill: 'value',
    pick: 'value',
    lookup: 'value',
    search: 'text',
    check: 'value',
    expect: 'value',
    open: 'path',
    query: 'soql',
    remember: 'as',
    wait: 'text',
    press: 'key',
  };
  const trayState = {
    list: [],
    debug: null,
    editing: -1,
    finding: false,
    small: false,
    pass: false,
    side: 'left',
    at: null,
    msg: '',
    msgBad: false,
  };
  const readPicked = async () => (await chrome.storage.local.get('nomadqa.picked'))['nomadqa.picked'] ?? [];
  const writePicked = (list) => chrome.storage.local.set({ 'nomadqa.picked': list });
  const readDebug = async () => (await chrome.storage.local.get('nomadqa.debug'))['nomadqa.debug'] ?? null;
  // One change at a time: two quick clicks must not both read the old list and lose a step
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));
  /** Changes the test being gone through (debug mode): fn(d) changes d in place. */
  const changeDebug = (fn) =>
    serial(async () => {
      const d = await readDebug();
      if (!d) return;
      fn(d);
      await chrome.storage.local.set({ 'nomadqa.debug': d });
    });
  const debugging = () => state.mode === 'debug';
  // Steps added from the pinned panel: to the list being picked, or (going through a test) before the current step.
  // done: the step was already done by hand (Add and click it), so the test goes on after it.
  const addPicked = (items, { done = false } = {}) =>
    debugging()
      ? changeDebug((d) => {
          d.items.splice(
            d.at,
            0,
            ...items.map((x) => ({
              step: x.step,
              text: x.text,
              result: done ? { ok: true, message: 'done by hand' } : null,
            }))
          );
          if (done) d.at += items.length;
          d.dirty = true;
        }).then(() => trayState.debug?.items.length ?? 0)
      : serial(async () => {
          const list = await readPicked();
          list.push(...items.map((x) => ({ step: x.step, text: x.text, page: location.pathname, at: Date.now() })));
          await writePicked(list);
          return list.length;
        });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch['nomadqa.picked']) {
      trayState.list = ch['nomadqa.picked'].newValue ?? [];
      paintTray();
    }
    if (ch['nomadqa.debug'] && debugging()) {
      trayState.debug = ch['nomadqa.debug'].newValue ?? null;
      if (!trayState.debug) return void setMode('off');
      paintTray();
    }
  });
  const items = () => (debugging() ? trayState.debug?.items ?? [] : trayState.list);
  /** Picking is paused while "Just click" is on, and while a step of the test runs. */
  const picking = () =>
    (state.mode === 'inspect' || debugging()) && !trayState.pass && !Q.pressing && !trayState.debug?.running;
  const mainOf = (step) => MAIN[step.action] ?? (step.record ? 'record' : 'path');
  const send = (cmd, extra = {}) =>
    chrome.runtime.sendMessage({ type: 'nomadqa:debug', cmd, ...extra }).then(
      (r) => r,
      () => null
    );
  async function command(cmd, extra) {
    const r = await send(cmd, extra);
    if (!r) {
      trayState.msg = 'NomadQA is not open: open it again from the tab you started in.';
      trayState.msgBad = true;
      paintTray();
    }
  }
  function paintTray() {
    if (state.mode !== 'inspect' && !debugging()) return (tray.style.display = 'none');
    const t = trayState;
    const d = debugging() ? t.debug : null;
    if (debugging() && !d) return (tray.style.display = 'none');
    const list = items();
    const busy = Boolean(d?.running);
    tray.style.display = 'flex';
    tray.classList.toggle('small', t.small);
    placeTray();
    const mark = (p, i) =>
      !d
        ? ''
        : `<span class="mk ${
            i === d.at
              ? 'cur'
              : p.result?.ok
              ? 'ok'
              : p.result?.ok === false
              ? p.result.optional
                ? 'warn'
                : 'bad'
              : ''
          }">${i === d.at ? '▶' : p.result?.ok ? '✓' : p.result?.ok === false ? '✕' : '·'}</span>`;
    const item = (p, i) =>
      `<li class="${d && i === d.at ? 'cur' : ''}"><div class="line">${mark(p, i)}<span class="txt"${
        d ? ` data-a="goto" data-i="${i}" title="Go to this step"` : ''
      }>${esc(p.text)}</span><span class="acts">` +
      `<button class="ib" data-a="edit" data-i="${i}" title="Change" ${busy ? 'disabled' : ''}>✎</button>` +
      `<button class="ib" data-a="up" data-i="${i}" title="Up" ${i && !busy ? '' : 'disabled'}>↑</button>` +
      `<button class="ib" data-a="down" data-i="${i}" title="Down" ${
        i < list.length - 1 && !busy ? '' : 'disabled'
      }>↓</button>` +
      `<button class="ib" data-a="del" data-i="${i}" title="Remove" ${busy ? 'disabled' : ''}>✕</button></span></div>` +
      (d && p.result?.ok === false ? `<div class="why">${esc(p.result.message)}</div>` : '') +
      (t.editing === i
        ? `<div class="edit"><input data-edit value="${esc(
            p.step[mainOf(p.step)] ?? ''
          )}"><button class="primary" data-a="save" data-i="${i}">Save</button></div>`
        : '') +
      '</li>';
    const atEnd = d && d.at >= list.length;
    tray.innerHTML =
      `<header><span class="brand">NomadQA</span><b title="${esc(d?.name ?? '')}">${
        d ? esc(d.name.length > 26 ? `${d.name.slice(0, 25)}…` : d.name) : 'Test steps'
      }</b><span class="n">${list.length}</span>` +
      `<button class="${
        t.pass ? 'on' : ''
      }" data-a="pass" title="The page works as usual: nothing is pinned or added">Just click</button>` +
      `<button class="ib" data-a="side" title="Move the list to the other side (or drag it by its title)">⇆</button>` +
      `<button class="ib" data-a="small" title="${t.small ? 'Show' : 'Hide'} the list">${
        t.small ? '▴' : '▾'
      }</button></header>` +
      (t.pass
        ? '<div class="note">Just click: the page works as usual. Switch it off to point and pick again.</div>'
        : '') +
      (list.length
        ? `<ol>${list.map(item).join('')}${
            d
              ? `<li class="${atEnd ? 'cur' : ''} end"><div class="line">${
                  atEnd ? '<span class="mk cur">▶</span>' : ''
                }<span class="txt muted">The end</span></div></li>`
              : ''
          }</ol>`
        : `<div class="empty">${
            d
              ? 'No steps: pin something on the page and add it.'
              : 'Click anything on the page to pin it, then <b>Add to a test</b>. The steps show here.'
          }</div>`) +
      (t.finding
        ? `<div class="find"><b>Find a record</b><div class="r"><input data-f="object" placeholder="Object, e.g. Account" style="width:130px">` +
          `<input data-f="where" placeholder="Name words, or Industry = 'Energy'" style="flex:1"></div>` +
          `<div class="r"><button class="primary" data-a="find-go">Find, add, and open it</button><button data-a="find-add">Only add the steps</button><button data-a="find-x">Cancel</button></div>` +
          `<div class="msg${t.msgBad ? ' bad' : ''}">${esc(
            t.msg || 'Adds “find the record” and “open it” to the test.'
          )}</div></div>`
        : '') +
      (d
        ? `<footer><button class="primary" data-a="run1" ${busy || atEnd ? 'disabled' : ''}>▶ This step</button>` +
          `<button data-a="runall" ${busy || atEnd ? 'disabled' : ''}>▶▶ To the end</button>` +
          `<button data-a="find" ${busy ? 'disabled' : ''}>+ Find a record</button>` +
          `<button data-a="keep" ${busy ? 'disabled' : ''}>${d.dirty ? 'Save to the test' : 'Saved'}</button>` +
          `<button data-a="close" ${busy ? 'disabled' : ''}>Close</button>` +
          `<div class="msg${t.msgBad || d.bad ? ' bad' : ''}" style="flex-basis:100%">${esc(
            busy ? 'Running…' : t.msg || d.msg || 'New steps from the page go in before ▶. Click a step to go to it.'
          )}</div></footer>`
        : `<footer><button data-a="find">+ Find a record</button><button data-a="tests" class="primary">Open in Tests</button>` +
          `<button data-a="clear">Clear</button><button data-a="off" title="Turn the Inspector off (Esc)">Stop</button></footer>`);
    tray.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = () => void trayAction(b.dataset.a, Number(b.dataset.i));
    });
    const input = tray.querySelector('[data-edit]');
    if (input) {
      input.focus();
      input.onkeydown = (e) => e.key === 'Enter' && void trayAction('save', t.editing);
    }
  }
  /** The list sits in a bottom corner, or where it was dragged to (out of the way of what is under it). */
  function placeTray() {
    const t = trayState;
    if (t.at) {
      const x = Math.max(0, Math.min(t.at.left, innerWidth - 120));
      const y = Math.max(0, Math.min(t.at.top, innerHeight - 48));
      Object.assign(tray.style, { left: `${x}px`, top: `${y}px`, right: 'auto', bottom: 'auto' });
    } else
      Object.assign(
        tray.style,
        t.side === 'right'
          ? { left: 'auto', right: '18px', top: 'auto', bottom: '18px' }
          : { left: '18px', right: 'auto', top: 'auto', bottom: '18px' }
      );
  }
  void chrome.storage.local
    .get('nomadqa.trayAt')
    .then((r) => {
      const v = r['nomadqa.trayAt'];
      if (v) Object.assign(trayState, { side: v.side ?? 'left', at: v.at ?? null });
      placeTray();
    })
    .catch(() => {});
  // Drag the list by its title
  tray.addEventListener('pointerdown', (e) => {
    const head = e.composedPath().find((x) => x.tagName === 'HEADER');
    if (!head || e.composedPath().some((x) => x.tagName === 'BUTTON')) return;
    e.preventDefault();
    const r = tray.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev) => {
      trayState.at = { left: ev.clientX - dx, top: ev.clientY - dy };
      placeTray();
    };
    const up = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      void chrome.storage.local.set({ 'nomadqa.trayAt': { side: trayState.side, at: trayState.at } }).catch(() => {});
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  });
  const soqlFor = (object, where) => {
    const w = String(where ?? '').trim();
    const cond = !w
      ? ''
      : /[=<>]|\b(LIKE|IN|AND|OR|NOT)\b/i.test(w)
      ? w
      : `Name LIKE '%${w.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}%'`;
    return `SELECT Id, Name FROM ${object}${cond ? ` WHERE ${cond}` : ''} ORDER BY LastModifiedDate DESC LIMIT 1`;
  };
  const sentence = (step) => {
    const k = mainOf(step);
    return `${step.action === 'expect' ? 'Check' : step.action[0].toUpperCase() + step.action.slice(1)}: ${
      step[k] ?? ''
    }`;
  };
  /** Writes the list: the picked steps, or the test being gone through (the current step follows its step). */
  function writeList(list, at) {
    if (!debugging()) return writePicked(list);
    return changeDebug((d) => {
      d.items = list;
      if (at !== undefined) d.at = Math.max(0, Math.min(at, list.length));
      d.dirty = true;
    });
  }
  async function trayAction(a, i) {
    const t = trayState;
    const list = [...items()];
    const at = t.debug?.at ?? 0;
    t.msg = a === 'find' || a === 'find-go' || a === 'find-add' ? t.msg : '';
    t.msgBad = false;
    if (a === 'small') t.small = !t.small;
    else if (a === 'side') {
      t.side = t.at ? t.side : t.side === 'left' ? 'right' : 'left';
      t.at = null;
      void chrome.storage.local.set({ 'nomadqa.trayAt': { side: t.side, at: null } }).catch(() => {});
    } else if (a === 'pass') {
      t.pass = !t.pass;
      state.pinned = null;
      tip.style.display = 'none';
      outline(null);
    } else if (a === 'edit') t.editing = t.editing === i ? -1 : i;
    else if (a === 'save') {
      const v = tray.querySelector('[data-edit]')?.value ?? '';
      const step = { ...list[i].step, [mainOf(list[i].step)]: v };
      // The text follows the change: the old value in it is replaced by the new one
      const old = String(list[i].step[mainOf(list[i].step)] ?? '');
      const text = old && list[i].text.includes(old) ? list[i].text.replace(old, v) : sentence(step);
      list[i] = { ...list[i], step, text, result: null };
      t.editing = -1;
      return writeList(list);
    } else if (a === 'up' || a === 'down') {
      const j = a === 'up' ? i - 1 : i + 1;
      [list[i], list[j]] = [list[j], list[i]];
      return writeList(list, at === i ? j : at === j ? i : at);
    } else if (a === 'del') {
      list.splice(i, 1);
      t.editing = -1;
      return writeList(list, i < at ? at - 1 : at);
    } else if (a === 'goto') return writeList(list, i);
    else if (a === 'clear') return writePicked([]);
    else if (a === 'tests') void chrome.runtime.sendMessage({ type: 'nomadqa:open', view: 'tests' });
    else if (a === 'off') return void setMode('off');
    else if (a === 'run1') return void command('step');
    else if (a === 'runall') return void command('all');
    else if (a === 'keep') return void command('save');
    else if (a === 'close') {
      if (t.debug?.dirty && !confirm('Close without saving your changes to the test?')) return;
      return void command('close');
    } else if (a === 'find') (t.finding = !t.finding), (t.msg = ''), (t.msgBad = false);
    else if (a === 'find-x') t.finding = false;
    else if (a === 'find-go' || a === 'find-add') {
      const object = tray.querySelector('[data-f="object"]').value.trim();
      const where = tray.querySelector('[data-f="where"]').value;
      if (!/^\w+$/.test(object)) {
        t.msg = 'Give the object’s API name, e.g. Account.';
        t.msgBad = true;
        return paintTray();
      }
      const soql = soqlFor(object, where);
      const r = await chrome.runtime.sendMessage({ type: 'nomadqa:find', soql });
      if (r?.error || !r?.rows?.length) {
        t.msg = r?.error ?? `Nothing found: ${soql}`;
        t.msgBad = true;
        return paintTray();
      }
      const saved = list.filter((p) => p.step.action === 'query' && p.step.save).length;
      const name = `found${saved ? saved + 1 : ''}`;
      const found = r.rows[0].Name ?? r.rows[0].Id;
      await addPicked([
        {
          step: { action: 'query', soql, save: name },
          text: `Find ${/^[aeiou]/i.test(object) ? 'an' : 'a'} ${object}: ${where || 'the latest'} → {{${name}}}`,
        },
        { step: { action: 'open', record: `{{${name}}}` }, text: `Open the ${object} found (now: ${found})` },
      ]);
      t.finding = false;
      // Going through a test, the test runs them (it keeps {{found}} for later steps)
      if (a === 'find-go') {
        if (debugging()) return void command('step', { n: 2 });
        location.assign(`/lightning/r/${object}/${r.rows[0].Id}/view`);
      }
      return;
    }
    paintTray();
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
          step: {
            action: 'fill',
            field: d.field,
            ...(d.fieldApi ? { api: d.fieldApi } : {}),
            value: input.value ?? '',
          },
          text: `Type “${input.value ?? ''}” in ${d.field}`,
        });
      const value = Q.fieldValue(d.field);
      if (value !== null && value !== undefined)
        out.push({
          button: 'Check its value',
          step: {
            action: 'expect',
            kind: 'field',
            field: d.field,
            ...(d.fieldApi ? { api: d.fieldApi } : {}),
            op: 'is',
            value,
          },
          text: `Check ${d.field} is “${value}”`,
        });
    }
    const click = [...Q.ancestors(el)].find((a) => a.matches?.(CLICKS));
    const name = click ? line(click.getAttribute('aria-label') || click.getAttribute('title') || click.innerText) : '';
    // A box to type in (a search bar, a list's search, a lookup) or Salesforce's search button: type, then choose
    const typable = [...Q.ancestors(el)].find((a) => a.matches?.('input, textarea'));
    const boxLabel = typable
      ? d.field || typable.getAttribute('placeholder') || typable.getAttribute('aria-label') || ''
      : '';
    if ((typable && !typable.readOnly && !typable.disabled && boxLabel) || /^search\b/i.test(name))
      out.push({
        button: 'Search and choose…',
        form: true,
        box: typable && !/^search(\.\.\.|…)?$/i.test(boxLabel.trim()) ? boxLabel.trim() : '',
        value: typable?.value ?? '',
      });
    if (name && name.length <= 60)
      out.push({
        button: `Click “${short(name)}”`,
        go: 'Add and click it',
        target: click,
        step: { action: 'click', label: name },
        text: `Click “${name}”`,
      });
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
      text: `Open “${document.title.replace(/\s*\|\s*Salesforce\s*$/, '')}”`,
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
          // Found by the label: copy it like a named one; steps added from here know it too
          const full = `${d.record.object}.${api}`;
          for (const x of suggested) if (x.step.field === d.field) x.step.api = full;
          const copy = tip.querySelector('[data-copy="tag"]');
          // Only this button: the panel may have been drawn again since (pinned), with its own buttons
          if (copy && !tip.querySelector('[data-copy="field"]')) {
            const b = document.createElement('button');
            b.textContent = 'Copy field';
            b.setAttribute('data-copy', 'field');
            b.onclick = () => {
              navigator.clipboard.writeText(full);
              b.textContent = 'Copied';
            };
            copy.before(b);
          }
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
                    (x, i) =>
                      `<button class="step" data-${x.form ? 'form' : 'step'}="${i}" title="${esc(
                        x.text ?? 'Type in it, then choose what it suggests (or press Enter)'
                      )}">${esc(x.button)}</button>${
                        x.go
                          ? `<button class="step primary" data-go="${i}" title="Adds the step, then really clicks it">${esc(
                              x.go
                            )}</button>`
                          : ''
                      }`
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
          const n = await addPicked([x]);
          b.textContent = `Added ✓ (${n} steps)`;
        };
      });
      // Search and choose: what to type and what to choose, then add it (and do it, like a person would)
      tip.querySelectorAll('[data-form]').forEach((b) => {
        b.onclick = () => {
          const x = suggested[Number(b.getAttribute('data-form'))];
          const form = document.createElement('div');
          form.className = 'form';
          form.innerHTML =
            `<div class="k">Search and choose${x.box ? ` in “${esc(x.box)}”` : ' (Salesforce’s search)'}</div>` +
            `<input data-s="text" placeholder="Type, e.g. Mia Brown" value="${esc(x.value)}">` +
            `<input data-s="choose" placeholder="Then choose (empty: press Enter)">` +
            `<div><button class="step" data-s="add">Add</button><button class="step primary" data-s="go" title="Adds the step, then does it on this page">Add and do it</button></div>` +
            '<div class="k" data-s="msg"></div>';
          b.closest('.group').after(form);
          form.querySelector('[data-s="text"]').focus();
          const stepOf = () => {
            const text = form.querySelector('[data-s="text"]').value.trim();
            const choose = form.querySelector('[data-s="choose"]').value.trim();
            const step = { action: 'search', text, ...(x.box ? { box: x.box } : {}), ...(choose ? { choose } : {}) };
            const where = x.box ? `“${x.box}”` : 'Search';
            return {
              step,
              text: choose
                ? `Search “${text}” in ${where}, choose “${choose}”`
                : `Search “${text}” in ${where}, press Enter`,
            };
          };
          const msg = (t) => (form.querySelector('[data-s="msg"]').textContent = t);
          form.querySelector('[data-s="add"]').onclick = async () => {
            const it = stepOf();
            if (!it.step.text) return msg('Type what to search first.');
            const n = await addPicked([it]);
            msg(`Added ✓ (${n} steps)`);
          };
          form.querySelector('[data-s="go"]').onclick = async () => {
            const it = stepOf();
            if (!it.step.text) return msg('Type what to search first.');
            msg('Searching…');
            await addPicked([it], { done: true });
            state.pinned = null;
            tip.style.display = 'none';
            outline(null);
            const r = await Q.run(it.step);
            if (!r.ok) alert(`NomadQA: the step was added, but on this page it did not work: ${r.message}`);
          };
        };
      });
      // Add the click and really do it: the page moves on (a related record, a tab…) and picking goes on there
      tip.querySelectorAll('[data-go]').forEach((b) => {
        b.onclick = async () => {
          const x = suggested[Number(b.getAttribute('data-go'))];
          await addPicked([x], { done: true });
          state.pinned = null;
          tip.style.display = 'none';
          outline(null);
          state.passNext = true;
          x.target.click();
        };
      });
    }
    wire();
    tip.querySelector('[data-close]')?.addEventListener('click', () => {
      state.pinned = null;
      tip.style.display = 'none';
    });
    tip.style.display = 'block';
    placeTip(el, x, y);
  }
  /** The panel goes next to what is pointed at (below, above, or beside it), never over it. */
  function placeTip(el, x, y) {
    const m = 10;
    const w = tip.offsetWidth;
    const ht = tip.offsetHeight;
    const r = el.getBoundingClientRect();
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
    let left = clamp(x + 14, m, innerWidth - w - m);
    let top;
    if (r.bottom + 8 + ht <= innerHeight - m) top = r.bottom + 8;
    else if (r.top - 8 - ht >= m) top = r.top - 8 - ht;
    else {
      top = clamp(y - ht / 2, m, innerHeight - ht - m);
      left =
        r.right + 8 + w <= innerWidth - m
          ? r.right + 8
          : r.left - 8 - w >= m
          ? r.left - 8 - w
          : x > innerWidth / 2
          ? m
          : innerWidth - w - m;
    }
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  const onMove = (e) => {
    if (state.pinned || !picking()) return;
    const el = e.composedPath?.()[0] ?? e.target;
    if (!el?.tagName) return;
    // On NomadQA's own list: the panel of what was under the pointer goes away, so it covers nothing
    if (ours(el) || e.composedPath?.().includes(host)) {
      state.hover = null;
      tip.style.display = 'none';
      outline(null);
      return;
    }
    state.hover = el;
    outline(el);
    showInfo(el, e.clientX, e.clientY);
  };

  // ---------- recorder ----------
  const OPTION = '[role="option"], lightning-base-combobox-item, search_dialog-instant-result-item';
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
      : s.action === 'search'
      ? `Search “${s.text}”${s.choose ? `, choose “${s.choose}”` : ''}`
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
    if (state.passNext) return void (state.passNext = false);
    if (state.mode !== 'record' && state.mode !== 'inspect' && !debugging()) return;
    const el = e.composedPath?.()[0] ?? e.target;
    if (!el?.tagName || ours(el) || e.composedPath?.().includes(host)) return;
    if (state.mode === 'inspect' || debugging()) {
      if (!picking()) return; // Just click, or a step of the test is clicking
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
      // A suggestion of a box that is not a field (Salesforce's search, a search bar): search and choose
      const typed = state.typing;
      if (value && typed?.text && Date.now() - typed.at < 60000) {
        addSearch({ action: 'search', text: typed.text, ...(typed.box ? { box: typed.box } : {}), choose: value });
        state.typing = null;
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

  // What is typed in a box that is not a field's (a search bar): kept until a suggestion is chosen or Enter pressed
  // (a lookup field's box says "Search Accounts…" too: it is recorded from the record chosen, as before)
  const searchBoxOf = (el) => {
    if (!el?.tagName || ours(el) || el.tagName !== 'INPUT') return null;
    if (closest(el, 'lightning-grouped-combobox, lightning-lookup, records-record-layout-item')) return null;
    const name = (el.getAttribute('placeholder') || el.getAttribute('aria-label') || Q.fieldLabelOf(el) || '').trim();
    if (el.type !== 'search' && !/^search\b/i.test(name)) return null;
    return /^search(\.\.\.|…)?$/i.test(name) ? '' : name;
  };
  /** A search step; the click that only opened Salesforce's search box before it is not needed. */
  const addSearch = (step) => {
    const last = state.steps[state.steps.length - 1];
    if (last?.action === 'click' && /^search$/i.test(last.label ?? '')) state.steps.pop();
    add(step);
  };
  function onInput(e) {
    if (state.mode !== 'record') return;
    const el = e.composedPath?.()[0] ?? e.target;
    const box = searchBoxOf(el);
    if (box !== null) state.typing = { box, text: el.value, at: Date.now() };
  }
  function onKey(e) {
    if (state.mode !== 'record' || e.key !== 'Enter') return;
    const el = e.composedPath?.()[0] ?? e.target;
    const box = searchBoxOf(el);
    if (box === null || !el.value) return;
    addSearch({ action: 'search', text: el.value, ...(box ? { box } : {}) });
    state.typing = null;
  }

  function onChange(e) {
    if (state.mode !== 'record') return;
    const el = e.composedPath?.()[0] ?? e.target;
    if (!el?.tagName || ours(el) || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
    if (el.getAttribute('role') === 'combobox') return; // lookups and pick lists come from the option chosen
    if (searchBoxOf(el) !== null) return; // a search: recorded when a suggestion is chosen or Enter pressed
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
      if (state.mode === 'inspect' || debugging()) return onMove(e);
      if (state.checking) {
        const el = e.composedPath?.()[0] ?? e.target;
        if (el?.tagName && !ours(el)) outline(el);
      }
    },
    true
  );
  document.addEventListener('click', onClick, true);
  document.addEventListener('change', onChange, true);
  document.addEventListener('input', onInput, true);
  document.addEventListener('keydown', onKey, true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || (state.mode !== 'inspect' && !debugging())) return;
      if (state.pinned) {
        state.pinned = null;
        tip.style.display = 'none';
      } else if (!debugging()) setMode('off');
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
    if (mode === 'inspect') void readPicked().then((l) => ((trayState.list = l), paintTray()));
    else if (mode === 'debug') void readDebug().then((d) => ((trayState.debug = d), paintTray()));
    else tray.style.display = 'none';
    // The background turns it on again after a full page load (a record opened, a step that opens a page)
    chrome.runtime
      .sendMessage({ type: 'nomadqa:inspecting', on: mode === 'inspect' || mode === 'debug', mode })
      .catch(() => {});
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
