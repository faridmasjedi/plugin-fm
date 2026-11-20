// A tiny way to build the page (no framework): h('div', { class: 'card', onclick }, children…).

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'style') el.setAttribute('style', v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = Boolean(v);
    else if (k === 'selected') el.selected = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
}

/** A dropdown from [[value, label]] pairs. */
export const select = (value, options, onchange, props = {}) =>
  h(
    'select',
    { ...props, onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label))
  );

/** Asks to type `expected` (the org's name) before a change; resolves true when confirmed. */
export function askTyped(message, expected, { ok = 'Continue', danger = false, extra } = {}) {
  return new Promise((resolve) => {
    const input = h('input', { placeholder: expected, autocomplete: 'off', spellcheck: 'false' });
    const okButton = h('button', { class: danger ? 'primary danger' : 'primary', disabled: true }, ok);
    const close = (answer) => {
      backdrop.remove();
      resolve(answer);
    };
    input.addEventListener('input', () => (okButton.disabled = input.value.trim() !== expected));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !okButton.disabled) close(true);
      if (e.key === 'Escape') close(false);
    });
    okButton.addEventListener('click', () => close(true));
    const backdrop = h(
      'div',
      { class: 'backdrop', onmousedown: (e) => e.target === backdrop && close(false) },
      h(
        'div',
        { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
        h('p', {}, message),
        extra ? h('div', { class: 'notice warn' }, extra) : null,
        h('label', { class: 'muted small' }, 'Type ', h('b', {}, expected), ' to confirm'),
        input,
        h('div', { class: 'actions' }, h('button', { onclick: () => close(false) }, 'Cancel'), okButton)
      )
    );
    document.body.append(backdrop);
    input.focus();
  });
}

export function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

export function download(name, text, type = 'text/plain') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}
