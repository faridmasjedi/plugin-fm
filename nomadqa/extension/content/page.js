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
    .tip{position:fixed;width:420px;max-width:calc(100vw - 20px);max-height:calc(100vh - 20px);overflow:auto;background:#fff;color:#1d2433;border:1px solid #e3e6ee;border-radius:12px;box-shadow:0 12px 40px rgba(20,24,40,.22);pointer-events:auto;display:none}
    .tip .th{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #eef0f5}
    .tip .th b{flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .tip .chip{flex:none;font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:#432bb0;background:#efebff;border-radius:999px;padding:2px 8px}
    .tip .x{border:0;background:none;color:#5b6475;padding:2px 6px;font-size:13px}.tip .x:hover{background:#f0f1f7;color:#1d2433}
    .tip .info{display:grid;grid-template-columns:86px 1fr;gap:4px 10px;padding:8px 12px;border-bottom:1px solid #eef0f5;font-size:12.5px}
    .tip .info .k{color:#5b6475}.tip .info .v{word-break:break-all}
    .tip code{font:12px ui-monospace,Menlo,monospace;color:#432bb0;background:#f6f4ff;border-radius:4px;padding:0 4px}
    .tip .hint{padding:8px 12px;color:#5b6475;font-size:12px}
    .tip .note{margin:8px 12px 0;padding:7px 10px;background:#fff8e6;color:#7a5200;border-radius:8px;font-size:12px}
    .tip .sec{padding:10px 12px 4px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:#5b6475}
    .tip .acts{padding:0 6px 6px}
    .tip .act{display:flex;align-items:center;gap:10px;padding:7px 6px;border-radius:8px}
    .tip .act:hover{background:#f6f4ff}
    .tip .act .t{flex:1;min-width:0;display:grid;gap:1px}.tip .act .t b{font-weight:600;font-size:12.5px}.tip .act .t span{color:#5b6475;font-size:11.5px}
    .tip .act .b{flex:none;display:flex;gap:6px}
    .tip .act.off .t b{color:#8a93a6}.tip .act.off .t span{color:#a3272b}
    .tip button.step{border-color:#5b3fd1;color:#432bb0;white-space:nowrap}
    .tip button.step.primary{background:#5b3fd1;color:#fff}
    .tip .form{display:grid;gap:8px;margin:0 6px 6px;padding:10px;border:1px solid #e3e6ee;border-radius:8px;background:#fafbfd}
    .tip .form label{display:grid;gap:3px;font-size:11.5px;color:#5b6475}
    .tip .form input{font:inherit;font-size:12.5px;padding:6px 8px;border:1px solid #d5d9e4;border-radius:7px;color:#1d2433;background:#fff}
    .tip .form .b{display:flex;gap:6px}.tip .form .msg{font-size:12px;color:#5b6475}
    .tip .copies{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px 10px;border-top:1px solid #eef0f5}
    .tip .copies .k{color:#5b6475;font-size:12px;margin-right:2px}
    .tip .tabs{display:flex;gap:4px;padding:8px 12px 0;border-bottom:1px solid #eef0f5}
    .tip .tabs button{border:0;border-bottom:2px solid transparent;border-radius:0;background:none;padding:6px 8px;color:#5b6475;font-weight:600}
    .tip .tabs button.on{color:#432bb0;border-bottom-color:#5b3fd1}
    .tip .details{display:grid;grid-template-columns:96px minmax(0,1fr) 22px;gap:5px 8px;padding:10px 12px;font-size:12px;align-items:start}
    .tip .details .k{color:#5b6475}.tip .details .v{word-break:break-all;font:11.5px/1.45 ui-monospace,Menlo,monospace;color:#1d2433}
    .tip .details .cp{border:0;background:none;padding:0 4px;color:#8a93a6;font-size:12px}.tip .details .cp:hover{color:#432bb0}
    .bar{position:fixed;right:18px;bottom:18px;cursor:move;user-select:none;background:#fff;color:#1d2433;border:1px solid #e3e6ee;border-radius:12px;box-shadow:0 8px 30px rgba(20,24,40,.18);padding:10px 12px;display:none;gap:10px;align-items:center;pointer-events:auto}
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
    .tray .edit{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:8px 0 2px;padding:10px;border:1px solid #e3e6ee;border-radius:8px;background:#fafbfd}
    .tray .edit .ef{display:grid;gap:3px;font-size:11.5px;color:#5b6475;min-width:0}.tray .edit .ef.wide{grid-column:1/-1}
    .tray .edit select{font:inherit;font-size:12.5px;padding:5px 6px;border:1px solid #d5d9e4;border-radius:7px;background:#fff;color:#1d2433;min-width:0}
    .tray .edit .chk{display:flex;align-items:center;gap:6px;font-size:12px;color:#5b6475;grid-column:1/-1}
    .tray .edit .b{display:flex;gap:6px;grid-column:1/-1}.tray .edit .says{grid-column:1/-1;font-size:12px;color:#5b6475}
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
    .tray .why .eg{display:block;color:#5b6475}.tray .why .eg b{color:#1d2433;font-weight:600}
    .tray .muted{color:#8a93a6}
    .tray.dock{width:auto;max-height:none;border-radius:12px 12px 0 0;border-bottom:0;box-shadow:0 -6px 28px rgba(20,24,40,.18)}
    .tray.dock header{cursor:ns-resize}
    .tray.dock ol{padding-left:42px}.tray.dock li .txt{font-size:13.5px}
    .tray.dock .why{margin-left:22px}.tray.dock .why .eg{display:inline;margin-left:10px}
    .tray.dock .edit{grid-template-columns:repeat(4,minmax(0,1fr));max-width:1100px}
    .tray.dock footer{flex-wrap:nowrap;align-items:center}.tray.dock footer .msg{flex-basis:auto!important;flex:1;text-align:right}
    .tray.dock.small{height:auto!important}
    .tray .tag{font-size:11px;background:#efebff;color:#432bb0;border-radius:999px;padding:0 7px;white-space:nowrap}
    .tray .caret{padding:0 4px;color:#5b3fd1;font-size:14px;line-height:1.3;flex:none}
    .tray ol.kids{margin:6px 0 0 14px;padding:0 0 0 10px;border-left:2px solid #c9bdf5;overflow:visible}
    .tray li.kid{padding:4px 2px;border-bottom:1px dashed #eef0f5;list-style:none}.tray li.kid:last-child{border-bottom:0}
    .tray li.kid .kn{flex:none;color:#8a93a6;font-size:11.5px;min-width:26px}
  </style>
  <div class="box"></div><div class="tray"></div><div class="tip"></div>
  <div class="bar"><span class="dot"></span><span class="brand">NomadQA</span><span class="count">0 steps</span><span class="last"></span>
  <button class="check" title="Then click what to check on the page">+ Check</button><button class="stop">Stop</button><button class="side" title="Move to the other side (or drag it)">⇆</button></div>`;
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
    const r = Q.screenRect(el);
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
    editing: '', // the step being changed: "3", or "3.2" (the 2nd step of the group at 3)
    open: {}, // groups shown open: { index: true }
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
          trayState.focusAt = d.at + items.length - 1;
          if (done) d.at += items.length;
          d.dirty = true;
        }).then(() => trayState.debug?.items.length ?? 0)
      : serial(async () => {
          const list = await readPicked();
          list.push(...items.map((x) => ({ step: x.step, text: x.text, page: location.pathname, at: Date.now() })));
          trayState.focusAt = list.length - 1;
          await writePicked(list);
          return list.length;
        });
  chrome.storage.onChanged.addListener((ch) => {
    if (ch['nomadqa.picked']) {
      trayState.list = ch['nomadqa.picked'].newValue ?? [];
      paintTray();
    }
    if (ch['nomadqa.debug'] && state.mode === 'moved' && !ch['nomadqa.debug'].newValue) return void setMode('off');
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
  /** Every box of a step (as in Tests): the kind of step, its boxes (some show for one kind of check only), Optional. */
  function editForm(step, key) {
    const W = globalThis.__nomadqaWords;
    // A group is only renamed here (its steps are changed one by one, under it)
    const actions = Object.entries(W.ACTIONS).filter(([k]) =>
      step.action === 'group' ? k === 'group' : k === step.action || (k !== 'data' && k !== 'group')
    );
    const box = ([k, lab, ph0, o]) => {
      const opts = typeof o?.options === 'function' ? o.options(step, { logins: trayState.logins }) : o?.options;
      const ph = typeof o?.placeholder === 'function' ? o.placeholder(step) : ph0;
      const v = step[k] === undefined ? '' : String(step[k]);
      return `<label class="ef${o?.wide ? ' wide' : ''}"><span>${esc(lab)}</span>${
        opts
          ? `<select data-ed="${k}">${opts
              .map(
                ([val, l]) =>
                  `<option value="${esc(val)}"${String(step[k] ?? opts[0][0]) === String(val) ? ' selected' : ''}>${esc(
                    l
                  )}</option>`
              )
              .join('')}</select>`
          : `<input data-ed="${k}" value="${esc(v)}" placeholder="${esc(ph)}">`
      }</label>`;
    };
    return (
      `<div class="edit"><label class="ef wide"><span>Step</span><select data-ed="action">${actions
        .map(([k, a]) => `<option value="${k}"${k === step.action ? ' selected' : ''}>${esc(a.say)}</option>`)
        .join('')}</select></label>` +
      W.fieldsFor(step).map(box).join('') +
      `<label class="chk"><input type="checkbox" data-ed="optional"${
        step.optional ? ' checked' : ''
      }> Optional: if it fails, the test still goes on</label>` +
      `<div class="says">→ ${esc(W.stepText(step))}</div>` +
      `<div class="b"><button class="primary" data-a="save" data-k="${key}">Save</button><button data-a="edit-x" data-k="${key}">Cancel</button></div></div>`
    );
  }
  /** The step being changed, as it is written: empty boxes left out, numbers as numbers. */
  function cleanDraft(d) {
    const out = {};
    for (const [k, v] of Object.entries(d)) {
      if (v === '' || v === undefined) continue;
      out[k] =
        k === 'ms' || k === 'count'
          ? Number(v)
          : k === 'value' && d.action === 'check'
          ? v === true || v === 'true'
          : v;
    }
    return out;
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
    const W = globalThis.__nomadqaWords;
    const why = (r) =>
      r?.ok === false
        ? `<div class="why">${esc(r.message)}${
            r.expected ? `<span class="eg"><b>Expected</b> ${esc(r.expected)}</span>` : ''
          }${r.got ? `<span class="eg"><b>Got</b> ${esc(r.got)}</span>` : ''}</div>`
        : '';
    // ↗ opens the step in NomadQA's Tests (only a test being gone through is in NomadQA already)
    const showBtn = (k) =>
      d ? `<button class="ib" data-a="show" data-k="${k}" title="Open this step in NomadQA">↗</button>` : '';
    const markOf = (r) =>
      `<span class="mk ${r?.ok ? 'ok' : r?.ok === false ? (r.optional ? 'warn' : 'bad') : ''}">${
        r?.ok ? '✓' : r?.ok === false ? '✕' : '·'
      }</span>`;
    /** A step of the group at i: shown under it, moved in; it can be changed, opened in NomadQA or removed. */
    const kid = (c, j, p, i) => {
      const k = `${i}.${j}`;
      const r = p.result?.children?.[j];
      return (
        `<li class="kid"><div class="line">${d ? markOf(r) : ''}<span class="kn">${i + 1}.${
          j + 1
        }</span><span class="txt">${esc(W ? W.stepText(c) : sentence(c))}</span><span class="acts">${showBtn(k)}` +
        `<button class="ib" data-a="edit" data-k="${k}" title="Change" ${busy ? 'disabled' : ''}>✎</button>` +
        `<button class="ib" data-a="del" data-k="${k}" title="Remove from the group" ${
          busy ? 'disabled' : ''
        }>✕</button></span></div>` +
        (d ? why(r) : '') +
        (t.editing === k && t.draft ? editForm(t.draft, k) : '') +
        '</li>'
      );
    };
    const item = (p, i) => {
      const isGroup = p.step.action === 'group' && Array.isArray(p.step.steps);
      // A group that failed shows its steps (the one that failed among them)
      const open = isGroup && (t.open[i] ?? (d && p.result?.ok === false));
      return (
        `<li class="${d && i === d.at ? 'cur' : ''}${isGroup ? ' grp' : ''}"><div class="line">${mark(p, i)}${
          isGroup
            ? `<button class="ib caret" data-a="fold" data-k="${i}" title="${open ? 'Hide' : 'Show'} its steps">${
                open ? '▾' : '▸'
              }</button>`
            : ''
        }<span class="txt"${d ? ` data-a="goto" data-k="${i}" title="Go to this step"` : ''}>${esc(p.text)}${
          p.result?.newTab
            ? ' <span class="tag" title="This step opened a new tab: the test went on there">new tab</span>'
            : ''
        }</span><span class="acts">${showBtn(String(i))}` +
        `<button class="ib" data-a="edit" data-k="${i}" title="${isGroup ? 'Rename' : 'Change'}" ${
          busy ? 'disabled' : ''
        }>✎</button>` +
        `<button class="ib" data-a="up" data-k="${i}" title="Up" ${i && !busy ? '' : 'disabled'}>↑</button>` +
        `<button class="ib" data-a="down" data-k="${i}" title="Down" ${
          i < list.length - 1 && !busy ? '' : 'disabled'
        }>↓</button>` +
        `<button class="ib" data-a="del" data-k="${i}" title="Remove" ${
          busy ? 'disabled' : ''
        }>✕</button></span></div>` +
        (d ? why(p.result) : '') +
        (t.editing === String(i) && t.draft ? editForm(t.draft, String(i)) : '') +
        (open ? `<ol class="kids">${p.step.steps.map((c, j) => kid(c, j, p, i)).join('')}</ol>` : '') +
        '</li>'
      );
    };
    const atEnd = d && d.at >= list.length;
    // The list keeps its place when it is drawn again; a step just added or changed is scrolled to
    const keepTop = tray.querySelector('ol')?.scrollTop ?? 0;
    tray.innerHTML =
      `<header><span class="brand">NomadQA</span><b title="${esc(d?.name ?? '')}">${
        d ? esc(d.name.length > 26 ? `${d.name.slice(0, 25)}…` : d.name) : 'Test steps'
      }</b><span class="n">${list.length}</span>` +
      `<button class="${
        t.pass ? 'on' : ''
      }" data-a="pass" title="The page works as usual: nothing is pinned or added">Just click</button>` +
      `<button class="ib" data-a="dock" title="${
        t.side === 'bottom' ? 'Back to a corner' : 'Under the page, full width (drag its title to make it taller)'
      }">${t.side === 'bottom' ? '◱' : '▭'}</button>` +
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
      b.onclick = () => void trayAction(b.dataset.a, b.dataset.k ?? '');
    });
    const ol = tray.querySelector('ol');
    if (ol) {
      ol.scrollTop = keepTop;
      const show = t.focusAt ?? (d ? d.at : null);
      const li = show !== null && show !== undefined ? ol.children[Math.min(show, ol.children.length - 1)] : null;
      if (li && ((t.focusAt !== undefined && t.focusAt !== null) || d)) li.scrollIntoView({ block: 'nearest' });
      t.focusAt = null;
    }
    // The step being changed: typing keeps the draft; a list or a tick draws it again (other boxes may show)
    tray.querySelectorAll('[data-ed]').forEach((el) => {
      const k = el.dataset.ed;
      if (el.type === 'checkbox')
        el.onchange = () => {
          if (el.checked) t.draft.optional = true;
          else delete t.draft.optional;
          paintTray();
        };
      else if (el.tagName === 'SELECT')
        el.onchange = () => {
          t.draft = k === 'action' ? { action: el.value } : { ...t.draft, [k]: el.value };
          paintTray();
        };
      else {
        el.oninput = () => {
          t.draft[k] = el.value;
          const says = tray.querySelector('.edit .says');
          if (says) says.textContent = `→ ${globalThis.__nomadqaWords.stepText(cleanDraft(t.draft))}`;
        };
        el.onkeydown = (e) => e.key === 'Enter' && void trayAction('save', t.editing);
      }
    });
    if (t.editFocus) {
      tray.querySelector('.edit input, .edit select')?.focus();
      t.editFocus = false;
    }
  }
  /** The test went on in a tab its step opened (Setup from the gear): this tab's list says so, and goes there. */
  function paintMoved(to = '') {
    tray.style.display = 'flex';
    tray.classList.remove('small');
    placeTray();
    tray.style.height = '';
    tray.innerHTML =
      `<header><span class="brand">NomadQA</span><b>Test steps</b></header>` +
      `<div class="note">A step opened a new tab${
        to ? ` (${esc(to)})` : ''
      }: the test goes on there, with its steps. This tab is no longer part of the test.</div>` +
      `<footer><button class="primary" data-a="front">Go to that tab</button><button data-a="off">Hide</button></footer>`;
    tray.querySelectorAll('[data-a]').forEach((b) => {
      b.onclick = () =>
        b.dataset.a === 'front'
          ? void chrome.runtime.sendMessage({ type: 'nomadqa:front' }).catch(() => {})
          : void setMode('off');
    });
  }
  /** The list sits in a bottom corner, or where it was dragged to (out of the way of what is under it). */
  function placeTray() {
    const t = trayState;
    tray.classList.toggle('dock', t.side === 'bottom');
    if (t.side === 'bottom') {
      // Under the page, as wide as it: as tall as was dragged (a third of the window at first)
      const h = Math.max(140, Math.min(t.dockH ?? Math.round(innerHeight * 0.34), innerHeight - 80));
      Object.assign(tray.style, { left: '0px', right: '0px', top: 'auto', bottom: '0px', height: `${h}px` });
    } else if (t.at) {
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
    if (t.side !== 'bottom') tray.style.height = '';
  }
  void chrome.storage.local
    .get('nomadqa.trayAt')
    .then((r) => {
      const v = r['nomadqa.trayAt'];
      if (v) Object.assign(trayState, { side: v.side ?? 'left', at: v.at ?? null, dockH: v.dockH });
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
    const docked = trayState.side === 'bottom';
    const move = (ev) => {
      // Under the page it only grows or shrinks
      if (docked) trayState.dockH = Math.round(innerHeight - ev.clientY + dy);
      else trayState.at = { left: ev.clientX - dx, top: ev.clientY - dy };
      placeTray();
    };
    const up = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      void chrome.storage.local
        .set({ 'nomadqa.trayAt': { side: trayState.side, at: trayState.at, dockH: trayState.dockH } })
        .catch(() => {});
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
  async function trayAction(a, key) {
    const t = trayState;
    const list = [...items()];
    const [i, j = -1] = String(key).split('.').map(Number);
    // A step of a group being worked on: the group stays open (also when its result goes, after a change)
    if (j >= 0) t.open = { ...t.open, [i]: true };
    const W = globalThis.__nomadqaWords;
    const textOf = (step) => (W ? W.stepText(step) : sentence(step));
    /** The group at i with its steps changed by fn(steps). */
    const regroup = (fn) => {
      const steps = [...list[i].step.steps];
      fn(steps);
      const step = { ...list[i].step, steps };
      list[i] = { ...list[i], step, text: textOf(step), result: null };
    };
    const at = t.debug?.at ?? 0;
    t.msg = a === 'find' || a === 'find-go' || a === 'find-add' ? t.msg : '';
    t.msgBad = false;
    if (a === 'small') t.small = !t.small;
    else if (a === 'side') {
      t.side =
        t.at || t.side === 'bottom' ? (t.side === 'bottom' ? 'left' : t.side) : t.side === 'left' ? 'right' : 'left';
      t.at = null;
      void chrome.storage.local.set({ 'nomadqa.trayAt': { side: t.side, at: null, dockH: t.dockH } }).catch(() => {});
    } else if (a === 'dock') {
      t.side = t.side === 'bottom' ? 'left' : 'bottom';
      t.at = null;
      void chrome.storage.local.set({ 'nomadqa.trayAt': { side: t.side, at: null, dockH: t.dockH } }).catch(() => {});
    } else if (a === 'pass') {
      t.pass = !t.pass;
      state.pinned = null;
      tip.style.display = 'none';
      outline(null);
    } else if (a === 'fold') {
      const open = t.open[i] ?? (debugging() && list[i]?.result?.ok === false);
      t.open = { ...t.open, [i]: !open };
    } else if (a === 'show') {
      const d = t.debug;
      if (!d) return;
      void chrome.runtime.sendMessage({ type: 'nomadqa:show', testId: d.testId, step: key }).catch(() => {});
      t.msg = d.dirty ? 'Opened in NomadQA. Your changes here show there after Save to the test.' : '';
    } else if (a === 'edit') {
      t.editing = t.editing === key ? '' : key;
      t.draft = t.editing === key ? structuredClone(j < 0 ? list[i].step : list[i].step.steps[j]) : null;
      t.focusAt = i;
      t.editFocus = true;
      // Log in steps choose among Settings › Logins: their names only
      const stored = (await chrome.storage.local.get('nomadqa.logins').catch(() => ({})))['nomadqa.logins'] ?? [];
      t.logins = stored.map((l) => ({ name: l.name, username: l.username }));
    } else if (a === 'edit-x') {
      t.editing = '';
      t.draft = null;
    } else if (a === 'save') {
      const step = cleanDraft(t.draft ?? (j < 0 ? list[i].step : list[i].step.steps[j]));
      if (j < 0) list[i] = { ...list[i], step, text: textOf(step), result: null };
      else regroup((steps) => (steps[j] = step));
      t.editing = '';
      t.draft = null;
      t.focusAt = i;
      return writeList(list);
    } else if (a === 'up' || a === 'down') {
      const j = a === 'up' ? i - 1 : i + 1;
      t.focusAt = j;
      [list[i], list[j]] = [list[j], list[i]];
      t.open = {};
      return writeList(list, at === i ? j : at === j ? i : at);
    } else if (a === 'del' && j >= 0) {
      t.editing = '';
      // The group's last step: the group goes too
      if (list[i].step.steps.length > 1) {
        regroup((steps) => steps.splice(j, 1));
        return writeList(list);
      }
      list.splice(i, 1);
      return writeList(list, i < at ? at - 1 : at);
    } else if (a === 'del') {
      list.splice(i, 1);
      t.editing = '';
      t.open = {};
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

  // Test steps for what is pinned, by what a person sees (as the Recorder writes them). Each one: a title, a line
  // that says what it does in the test, and its buttons.
  const CLICKS = 'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="link"], [role="option"]';
  const line = (t) =>
    String(t ?? '')
      .split('\n')
      .map((x) => x.trim())
      .find(Boolean) ?? '';
  const pageName = () => document.title.replace(/\s*\|\s*Salesforce\s*$/, '');
  /** What the thing pointed at is, in a word or two. */
  function kindOf(el, d, click, typable) {
    if (click && /^search\b/i.test(d.name ?? '') && Q.deepAll('button.search-button').includes(click))
      return 'Salesforce search';
    if (d.field) return 'Field';
    if (typable) return 'Box to type in';
    if (click?.getAttribute('role') === 'tab') return 'Tab';
    if (click?.matches?.('a, [role="link"]')) return 'Link';
    if (click?.matches?.('[role="menuitem"], [role="option"]')) return 'Menu item';
    if (click) return 'Button';
    return 'Text';
  }
  function stepsFor(el, d) {
    const out = [];
    const setup = Q.inSetup();
    const click = [...Q.ancestors(el)].find((a) => a.matches?.(CLICKS));
    const name = click ? line(click.getAttribute('aria-label') || click.getAttribute('title') || click.innerText) : '';
    const typable = [...Q.ancestors(el)].find((a) => a.matches?.('input, textarea'));
    if (d.field) {
      if (typable && !typable.readOnly && !typable.disabled)
        out.push({
          title: `Type into ${short(d.field)}`,
          desc: `The test types “${short(typable.value ?? '')}” here (change it later in the list).`,
          step: {
            action: 'fill',
            field: d.field,
            ...(d.fieldApi ? { api: d.fieldApi } : {}),
            value: typable.value ?? '',
          },
          text: `Type “${typable.value ?? ''}” in ${d.field}`,
        });
      const value = Q.fieldValue(d.field);
      if (value !== null && value !== undefined)
        out.push({
          title: `Check ${short(d.field)} is “${short(value)}”`,
          desc: 'The test fails when this field shows anything else.',
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
    // A box to type in (a search bar, a list's search, a lookup) or Salesforce's search button: type, then choose
    const boxLabel = typable
      ? (d.field || typable.getAttribute('placeholder') || typable.getAttribute('aria-label') || '').trim()
      : '';
    const globalSearch = !typable && /^search\b/i.test(name);
    if ((typable && !typable.readOnly && !typable.disabled && boxLabel) || globalSearch) {
      const box = typable && !/^search(\.\.\.|…)?$/i.test(boxLabel) ? boxLabel : '';
      out.push({
        title: 'Search and choose…',
        desc: box
          ? `Types in “${short(box)}”, then picks one of its suggestions (or presses Enter).`
          : 'Types in Salesforce search at the top, then picks a result (or presses Enter).',
        form: true,
        box,
        value: typable?.value ?? '',
      });
    }
    if (click && name && name.length <= 60 && !globalSearch && opensList(click))
      out.push({
        title: `Click “${short(name)}”, then type and choose…`,
        desc: 'Opens its list, types in it (if you want), then picks an item — one step, the list stays open.',
        form: 'list',
        label: name,
      });
    if (name && name.length <= 60 && !globalSearch) {
      const blocked = setup && Q.changes(name);
      out.push({
        title: `Click “${short(name)}”`,
        desc: blocked
          ? 'Not on Setup: it would change the org. NomadQA only looks and checks here.'
          : 'The test clicks it, like a person would.',
        blocked,
        go: blocked ? '' : 'Add and click it',
        target: click,
        step: { action: 'click', label: name },
        text: `Click “${name}”`,
      });
    }
    // A button or link: check it is there (a user without access does not see it)
    if (name && name.length <= 60 && !globalSearch)
      out.push({
        title: `Check “${short(name)}” is there`,
        desc: 'The test fails when this button or link is missing (for example, a user without access).',
        step: { action: 'expect', kind: 'button', value: name },
        text: `Check the button or link “${name}” is shown`,
      });
    const text = line(el.innerText);
    if (!d.field && !click && text && text.length <= 120)
      out.push({
        title: `Check “${short(text)}” is shown`,
        desc: 'The test fails when this text is not on the page.',
        step: { action: 'expect', kind: 'text', value: text },
        text: `Check the page shows “${text}”`,
      });
    out.push({
      title: 'Start the test on this page',
      desc: `First step: open “${short(pageName())}”, so the test always begins here.`,
      step: { action: 'open', path: location.pathname + location.search },
      text: `Open “${pageName()}”`,
    });
    return out;
  }
  /** Everything about the element (the Details tab): what it is, where it sits, its path, its parent. */
  function detailsOf(el, d) {
    const rows = [];
    const add = (k, v, copy = true) => v && rows.push([k, String(v), copy]);
    add('Element', `<${d.tag}>`);
    add('Says', d.name);
    if (d.field) add('Field', d.fieldApi ? `${d.field} · ${d.fieldApi}` : d.field);
    if (d.fieldApi) add('Field API name', d.fieldApi);
    if (d.record) add('Record', `${d.record.object} ${d.record.id}`);
    if (d.custom) add('Your component', `${d.custom.tag} (${d.custom.path})`);
    if (d.packaged) add('Package', d.packaged);
    if (d.aura) add('Aura component', d.aura);
    add('Components (outside → in)', [...d.components].reverse().join(' › '));
    // Where it sits: the tab, the section or card, a window
    const anc = [...Q.ancestors(el)];
    const panel = anc.find((a) => a.getAttribute?.('role') === 'tabpanel');
    const tabId = panel?.getAttribute('aria-labelledby');
    const tabEl = tabId ? Q.deepAll(`[id="${CSS.escape(tabId)}"]`)[0] : null;
    add('In the tab', line(tabEl?.innerText ?? panel?.getAttribute('aria-label') ?? ''));
    for (const a of anc) {
      if (!a.matches?.('article, section, .slds-card, records-record-layout-section, force-record-layout-section'))
        continue;
      const head = a.querySelector('h1, h2, h3, .slds-card__header-title, [role="heading"], .slds-section__title');
      const t = line(head?.innerText ?? '');
      if (t && t !== d.name) {
        add('In the section', t);
        break;
      }
    }
    const dialog = anc.find((a) => a.getAttribute?.('role') === 'dialog');
    if (dialog)
      add('In the window', line(dialog.querySelector('h1, h2')?.innerText ?? dialog.getAttribute('aria-label') ?? ''));
    const parent = anc.slice(1).find((a) => a.tagName && a.tagName !== 'SLOT');
    if (parent)
      add(
        'Parent',
        `<${parent.tagName.toLowerCase()}>${parent.id ? `#${parent.id}` : ''} ${short(
          line(parent.getAttribute?.('aria-label') || parent.innerText || '')
        )}`.trim()
      );
    add('Path', cssPath(el));
    add('Page', `${pageName()} · ${location.pathname}`);
    if (el.id) add('Id', el.id);
    const cls = String(el.className?.baseVal ?? el.className ?? '').trim();
    if (cls) add('Classes', cls.split(/\s+/).slice(0, 8).join(' '));
    const data = [...(el.attributes ?? [])].filter((x) =>
      /^(data-|aria-|title$|name$|placeholder$|href$|role$)/.test(x.name)
    );
    for (const x of data.slice(0, 8)) add(x.name, x.value.slice(0, 200));
    const r = Q.screenRect(el);
    add(
      'Position',
      `x ${Math.round(r.x)}, y ${Math.round(r.y)} · ${Math.round(r.width)} × ${Math.round(r.height)} px`,
      false
    );
    return rows;
  }
  /** A path to the element, outside in: tag, id or first class, its place among the same tags. */
  function cssPath(el) {
    const parts = [];
    for (const a of Q.ancestors(el)) {
      if (!a.tagName || a.tagName === 'HTML' || a.tagName === 'BODY') continue;
      let p = a.tagName.toLowerCase();
      if (a.id && !/^\d/.test(a.id)) p += `#${a.id}`;
      else {
        const c = String(a.className?.baseVal ?? a.className ?? '')
          .trim()
          .split(/\s+/)[0];
        if (c) p += `.${c}`;
        const same = a.parentElement ? [...a.parentElement.children].filter((x) => x.tagName === a.tagName) : [];
        if (same.length > 1) p += `:nth-of-type(${same.indexOf(a) + 1})`;
      }
      parts.unshift(p);
      if (parts.length >= 12) break;
    }
    return parts.join(' > ');
  }
  /** The component it is part of, when it says something (not Salesforce's page wrappers). */
  const ownComponent = (d) => {
    const c = d.components[0] ?? '';
    return c.includes('-') && !/^(force-aloha|one-|flexipage-|force-record-layout|records-record-layout)/.test(c)
      ? c
      : '';
  };
  /** What can be copied: only what is useful (a field's API name, your component and its folder, a record Id). */
  function copiesFor(d) {
    const out = [];
    if (d.fieldApi) out.push(['field', 'Field API name', d.fieldApi]);
    if (d.custom) out.push(['path', 'Folder', d.custom.path], ['tag', 'Component', d.custom.tag]);
    else if (ownComponent(d)) out.push(['tag', 'Component', ownComponent(d)]);
    if (d.name) out.push(['name', 'What it says', d.name]);
    if (d.record) out.push(['id', 'Record Id', d.record.id]);
    return out;
  }
  let tipTab = 'test';
  function showInfo(el, x, y) {
    const d = Q.describe(el);
    const click = [...Q.ancestors(el)].find((a) => a.matches?.(CLICKS));
    const typable = [...Q.ancestors(el)].find((a) => a.matches?.('input, textarea'));
    const kind = kindOf(el, d, click, typable);
    const suggested = state.pinned ? stepsFor(el, d) : [];
    const copies = copiesFor(d);
    if (!d.fieldApi && d.field && d.record)
      void apiName(d.record.object, d.field).then((api) => {
        if (!api || (state.pinned !== el && state.hover !== el)) return;
        const full = `${d.record.object}.${api}`;
        const row = tip.querySelector('[data-field]');
        if (row) row.innerHTML = `<code>${esc(full)}</code>`;
        // Found by the label: steps added from here know it too, and it can be copied
        for (const s of suggested) if (s.step?.field === d.field) s.step.api = full;
        const list = tip.querySelector('.copies');
        if (list && !list.querySelector('[data-copy="field"]')) {
          const b = document.createElement('button');
          b.textContent = 'Field API name';
          b.title = full;
          b.setAttribute('data-copy', 'field');
          b.onclick = () => {
            navigator.clipboard.writeText(full);
            b.textContent = 'Copied ✓';
          };
          list.querySelector('.k').after(b);
        }
      });
    const rows = [];
    if (d.field)
      rows.push(['Field', d.fieldApi ? `<code>${esc(d.fieldApi)}</code>` : `<span data-field>${esc(d.field)}</span>`]);
    if (d.custom) rows.push(['Yours', `<code>${esc(d.custom.tag)}</code> · <code>${esc(d.custom.path)}</code>`]);
    else if (d.packaged) rows.push(['Package', `<code>${esc(d.packaged)}</code>`]);
    else if (ownComponent(d)) rows.push(['Component', `<code>${esc(ownComponent(d))}</code>`]);
    if (d.record) rows.push(['Record', `${esc(d.record.object)} · <code>${esc(d.record.id)}</code>`]);
    // Named like a person sees it: the field, or the button / link it is part of (not the icon's dot inside it)
    const title =
      d.field ||
      d.name ||
      (click ? line(click.getAttribute('aria-label') || click.getAttribute('title') || click.innerText) : '') ||
      line(el.innerText) ||
      d.tag;
    const setup = Q.inSetup();
    tip.innerHTML =
      `<div class="th"><span class="chip">${esc(kind)}</span><b title="${esc(title)}">${esc(short(title))}</b>${
        state.pinned ? '<button class="x" data-close title="Close (Esc)">✕</button>' : ''
      }</div>` +
      (rows.length
        ? `<div class="info">${rows
            .map(([k, v]) => `<span class="k">${k}</span><span class="v">${v}</span>`)
            .join('')}</div>`
        : '') +
      (state.pinned
        ? `<div class="tabs"><button data-tab="test" class="${
            tipTab === 'test' ? 'on' : ''
          }">Add to a test</button><button data-tab="details" class="${
            tipTab === 'details' ? 'on' : ''
          }">Details</button></div>`
        : '') +
      (state.pinned && tipTab === 'details'
        ? `<div class="details">${detailsOf(el, d)
            .map(
              ([k, v, copy], i) =>
                `<span class="k">${esc(k)}</span><span class="v">${esc(v)}</span>${
                  copy ? `<button class="cp" data-cp="${i}" title="Copy">⧉</button>` : '<span></span>'
                }`
            )
            .join('')}</div>`
        : !state.pinned
        ? '<div class="hint">Click to pin it and add it to a test · Esc to stop</div>'
        : (setup
            ? '<div class="note">Setup is read-only for NomadQA: tests open pages, search and check here, never change.</div>'
            : '') +
          `<div class="sec">Add to the test</div><div class="acts">${suggested
            .map(
              (s, i) =>
                `<div class="act${s.blocked ? ' off' : ''}"><div class="t"><b>${esc(s.title)}</b><span>${esc(
                  s.desc
                )}</span></div><div class="b">${
                  s.blocked
                    ? ''
                    : s.form
                    ? `<button class="step" data-form="${i}">Fill in…</button>`
                    : `<button class="step" data-step="${i}" title="${esc(s.text)}">Add</button>`
                }${
                  s.go
                    ? `<button class="step primary" data-go="${i}" title="Adds the step, then really clicks it">Add and click</button>`
                    : ''
                }</div></div>`
            )
            .join('')}</div>` +
          (copies.length
            ? `<div class="copies"><span class="k">Copy</span>${copies
                .map(([k, label, v]) => `<button data-copy="${k}" title="${esc(v)}">${esc(label)}</button>`)
                .join('')}</div>`
            : ''));
    function wire() {
      tip.querySelectorAll('[data-tab]').forEach((b) => {
        b.onclick = () => {
          tipTab = b.getAttribute('data-tab');
          showInfo(el, x, y);
        };
      });
      const details = tipTab === 'details' ? detailsOf(el, d) : [];
      tip.querySelectorAll('[data-cp]').forEach((b) => {
        b.onclick = () => {
          navigator.clipboard.writeText(details[Number(b.getAttribute('data-cp'))][1]);
          b.textContent = '✓';
        };
      });
      tip.querySelectorAll('[data-copy]').forEach((b) => {
        b.onclick = () => {
          const c = copies.find(([k]) => k === b.getAttribute('data-copy'));
          if (c) navigator.clipboard.writeText(c[2]);
          b.textContent = 'Copied ✓';
        };
      });
      tip.querySelectorAll('[data-step]').forEach((b) => {
        b.onclick = async () => {
          const s = suggested[Number(b.getAttribute('data-step'))];
          const n = await addPicked([s]);
          b.textContent = `Added ✓ (${n})`;
        };
      });
      // Search and choose: what to type and what to choose, then add it (and do it, like a person would)
      tip.querySelectorAll('[data-form]').forEach((b) => {
        b.onclick = () => {
          const s = suggested[Number(b.getAttribute('data-form'))];
          const row = b.closest('.act');
          if (row.nextElementSibling?.classList.contains('form')) return;
          const where = s.box ? `“${s.box}”` : 'Salesforce search (at the top)';
          const list = s.form === 'list';
          const form = document.createElement('div');
          form.className = 'form';
          form.innerHTML = list
            ? `<label>Then type (optional)<input data-s="text" placeholder="e.g. Sales · empty: type nothing"></label>` +
              `<label>Then choose<input data-s="choose" placeholder="e.g. Sales"></label>` +
              `<div class="b"><button class="step" data-s="add">Add</button><button class="step primary" data-s="go" title="Adds the step, then does it on this page">Add and do it</button></div>` +
              '<div class="msg" data-s="msg"></div>'
            : `<label>Type<input data-s="text" placeholder="e.g. Mia" value="${esc(s.value)}"></label>` +
              `<label>Then choose<input data-s="choose" placeholder="e.g. Mia Brown · empty: press Enter"></label>` +
              `<div class="b"><button class="step" data-s="add">Add</button><button class="step primary" data-s="go" title="Adds the step, then does it on this page">Add and do it</button></div>` +
              '<div class="msg" data-s="msg"></div>';
          row.after(form);
          form.querySelector('[data-s="text"]').focus();
          const stepOf = () => {
            const text = form.querySelector('[data-s="text"]').value.trim();
            const choose = form.querySelector('[data-s="choose"]').value.trim();
            if (list)
              return {
                step: { action: 'click', label: s.label, ...(text ? { type: text } : {}), choose },
                text: `Click “${s.label}”${text ? `, type “${text}”` : ''}, choose “${choose}”`,
                ok: Boolean(choose),
              };
            const step = { action: 'search', text, ...(s.box ? { box: s.box } : {}), ...(choose ? { choose } : {}) };
            return {
              step,
              text: choose
                ? `Search “${text}” in ${where}, choose “${choose}”`
                : `Search “${text}” in ${where}, press Enter`,
            };
          };
          const msg = (t) => (form.querySelector('[data-s="msg"]').textContent = t);
          const missing = (it) =>
            list ? (it.ok ? '' : 'Write what to choose first.') : it.step.text ? '' : 'Type what to search first.';
          form.querySelector('[data-s="add"]').onclick = async () => {
            const it = stepOf();
            if (missing(it)) return msg(missing(it));
            const n = await addPicked([it]);
            msg(`Added ✓ (${n} steps)`);
          };
          form.querySelector('[data-s="go"]').onclick = async () => {
            const it = stepOf();
            if (missing(it)) return msg(missing(it));
            msg(list ? 'Doing it…' : 'Searching…');
            await addPicked([it], { done: true });
            state.pinned = null;
            tip.style.display = 'none';
            outline(null);
            const r = await Q.run(it.step);
            if (!r.ok) alert(`NomadQA: the step was added, but on this page it did not work: ${r.message}`);
          };
          placeTip(el, x, y);
        };
      });
      // Add the click and really do it: the page moves on (a related record, a tab…) and picking goes on there
      tip.querySelectorAll('[data-go]').forEach((b) => {
        b.onclick = async () => {
          const s = suggested[Number(b.getAttribute('data-go'))];
          await addPicked([s], { done: true });
          state.pinned = null;
          tip.style.display = 'none';
          outline(null);
          state.passNext = true;
          s.target.click();
        };
      });
    }
    wire();
    tip.querySelector('[data-close]')?.addEventListener('click', () => {
      state.pinned = null;
      tip.style.display = 'none';
      outline(null);
    });
    tip.style.display = 'block';
    placeTip(el, x, y);
  }
  /** The panel goes next to what is pointed at (below, above, or beside it), never over it. */
  function placeTip(el, x, y) {
    const m = 10;
    const w = tip.offsetWidth;
    const ht = tip.offsetHeight;
    const r = Q.screenRect(el);
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
    const [x, y] = tabPoint(el, e);
    showInfo(el, x, y);
  };
  /** An event's place on the whole tab (an event in Setup's frame is relative to the frame). */
  function tabPoint(el, e) {
    const r = el.getBoundingClientRect();
    const R = Q.screenRect(el);
    return [e.clientX + (R.x - r.x), e.clientY + (R.y - r.y)];
  }

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

  function paintBar() {
    bar.querySelector('.count').textContent = `${state.steps.length} step${state.steps.length === 1 ? '' : 's'}`;
    const last = state.steps[state.steps.length - 1];
    bar.querySelector('.last').textContent = last ? text(last) : '';
  }
  async function save() {
    paintBar();
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
      ? `Click “${s.label}”${s.type ? `, type “${s.type}”` : ''}${s.choose ? `, choose “${s.choose}”` : ''}`
      : s.action === 'open'
      ? `Open ${s.path}`
      : s.action === 'search'
      ? `Search “${s.text}”${s.choose ? `, choose “${s.choose}”` : ''}`
      : s.action === 'expect'
      ? `Check ${s.kind} ${s.field ? `${s.field} = ` : ''}“${s.value}”`
      : `${s.action} ${s.field} = “${s.value}”`;
  /** Changes the recording: read from storage first (the page may have reloaded, or gone on in a new tab). */
  const changeRecording = (fn) =>
    serial(async () => {
      try {
        const rec = (await chrome.storage.local.get('nomadqa.recording'))['nomadqa.recording'];
        if (rec && !rec.done && Array.isArray(rec.steps)) state.steps = rec.steps;
      } catch {
        /* the extension was reloaded */
      }
      fn(state.steps);
      await save();
    });
  function add(step) {
    return changeRecording((steps) => {
      const last = steps[steps.length - 1];
      // Typing in the same field again replaces it; a lookup replaces the search text typed into it
      if (
        last &&
        (last.action === 'fill' || last.action === 'lookup') &&
        step.field &&
        last.field === step.field &&
        step.action !== 'expect'
      )
        steps.pop();
      steps.push(step);
    });
  }
  /** The click before opened a list (App Launcher, a list view's menu): what is typed and chosen in it goes with it. */
  const popupClick = (steps, popup = state.popup) => {
    const last = steps[steps.length - 1];
    return popup && Date.now() - popup.at < 60000 && last?.action === 'click' && last.label === popup.label
      ? last
      : null;
  };
  // Another tab of the same recording (or this page before it reloaded) added a step: the bar shows it
  chrome.storage.onChanged.addListener((ch) => {
    const rec = ch['nomadqa.recording']?.newValue;
    if (state.mode !== 'record' || !rec || rec.done) return;
    state.steps = rec.steps ?? state.steps;
    paintBar();
  });

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
      const [x, y] = tabPoint(el, e);
      showInfo(el, x, y);
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
        // "Search: 00001037" (search for what was typed) is the same as pressing Enter
        const enter = /^search\b[^:]*:/i.test(value) || /^show (more|all) results/i.test(value);
        addSearch({
          action: 'search',
          text: typed.text,
          ...(typed.box ? { box: typed.box } : {}),
          ...(enter ? {} : { choose: value }),
        });
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
    const MENUS =
      '[role="menu"], [role="menuitem"], [role="listbox"], [role="option"], .slds-dropdown, .uiMenuList, .uiPopupTarget, .popupTargetContainer';
    const inPopup = closest(target, `${MENUS}, [role="dialog"], one-app-launcher-modal, one-app-launcher-menu`);
    // A menu item right after a click (the gear's Setup, a "more" menu): the click opened the menu
    const inMenu = closest(target, MENUS);
    if (inMenu && !state.popup && Date.now() - state.lastRecordedClick?.at < 30000)
      state.popup = { label: state.lastRecordedClick.label, at: state.lastRecordedClick.at };
    if (inPopup && state.popup && Date.now() - state.popup.at < 60000) {
      const typed = state.typing && Date.now() - state.typing.at < 60000 ? state.typing.text : '';
      // Kept now: the change runs a moment later, after these are cleared
      const popup = state.popup;
      void changeRecording((steps) => {
        const opener = popupClick(steps, popup);
        if (opener) {
          if (typed) opener.type = typed;
          opener.choose = label;
        } else steps.push({ action: 'click', label });
      });
      state.popup = null;
      state.typing = null;
      return;
    }
    if (opensList(target)) state.popup = { label, at: Date.now() };
    state.lastRecordedClick = { label, at: Date.now() };
    add({ action: 'click', label });
  }
  /** A button that opens a list or a menu (App Launcher, a list view's menu, a "more" menu). */
  const opensList = (el) =>
    Boolean(el.getAttribute?.('aria-haspopup')) ||
    el.hasAttribute?.('aria-expanded') ||
    /app launcher|select a list view|show more|more actions|menu/i.test(
      `${el.getAttribute?.('aria-label') ?? ''} ${el.getAttribute?.('title') ?? ''} ${el.innerText ?? ''}`
    );

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
    const popup = state.popup;
    return changeRecording((steps) => {
      const opener = popupClick(steps, popup);
      if (opener && step.box) {
        opener.type = step.text;
        if (step.choose) opener.choose = step.choose;
        state.popup = null;
        return;
      }
      const last = steps[steps.length - 1];
      if (last?.action === 'click' && /^search$/i.test(last.label ?? '')) steps.pop();
      steps.push(step);
    });
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
  // The recording bar moves out of the way: to the other side, or dragged anywhere
  const barAt = { side: 'right', at: null };
  function placeBar() {
    if (barAt.at)
      Object.assign(bar.style, {
        left: `${Math.max(0, Math.min(barAt.at.left, innerWidth - 120))}px`,
        top: `${Math.max(0, Math.min(barAt.at.top, innerHeight - 40))}px`,
        right: 'auto',
        bottom: 'auto',
      });
    else
      Object.assign(
        bar.style,
        barAt.side === 'left'
          ? { left: '18px', right: 'auto', top: 'auto', bottom: '18px' }
          : { left: 'auto', right: '18px', top: 'auto', bottom: '18px' }
      );
  }
  const keepBar = () => void chrome.storage.local.set({ 'nomadqa.barAt': { ...barAt } }).catch(() => {});
  void chrome.storage.local
    .get('nomadqa.barAt')
    .then((r) => {
      Object.assign(barAt, r['nomadqa.barAt'] ?? {});
      placeBar();
    })
    .catch(() => {});
  bar.querySelector('.side').addEventListener('click', () => {
    barAt.side = barAt.at ? barAt.side : barAt.side === 'left' ? 'right' : 'left';
    barAt.at = null;
    placeBar();
    keepBar();
  });
  bar.addEventListener('pointerdown', (e) => {
    if (e.composedPath().some((x) => x.tagName === 'BUTTON')) return;
    e.preventDefault();
    const r = bar.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const move = (ev) => {
      barAt.at = { left: ev.clientX - dx, top: ev.clientY - dy };
      placeBar();
    };
    const up = () => {
      removeEventListener('pointermove', move, true);
      removeEventListener('pointerup', up, true);
      keepBar();
    };
    addEventListener('pointermove', move, true);
    addEventListener('pointerup', up, true);
  });
  /** The Inspector and the Recorder listen on the page, and on the org's own frames (Setup draws its pages in one). */
  const hooked = new WeakSet();
  function hook(doc) {
    if (hooked.has(doc)) return;
    hooked.add(doc);
    doc.addEventListener(
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
    doc.addEventListener('click', onClick, true);
    doc.addEventListener('change', onChange, true);
    doc.addEventListener('input', onInput, true);
    doc.addEventListener('keydown', onKey, true);
    doc.addEventListener(
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
  }
  hook(document);
  // A frame's page is new after every load in it: hooked again
  setInterval(() => {
    if (state.mode === 'off') return;
    for (const d of Q.frameDocs()) hook(d);
  }, 700);

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
    else if (mode === 'moved') paintMoved(opts.to);
    else tray.style.display = 'none';
    // The background turns it on again after a full page load (a record opened, a step that opens a page)
    chrome.runtime
      .sendMessage({ type: 'nomadqa:inspecting', on: ['inspect', 'debug', 'record'].includes(mode), mode })
      .catch(() => {});
    if (mode === 'record') {
      state.path = location.pathname + location.search;
      if (opts.resume) {
        // The page loaded again (another app) or this is a tab the recording opened: it goes on. Its address
        // settling in the next seconds is the click's doing, not a step of its own
        state.lastClickAt = Date.now();
        void changeRecording(() => {});
      } else {
        state.steps = opts.keep ? state.steps : [{ action: 'open', path: location.pathname }];
        void save();
      }
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
