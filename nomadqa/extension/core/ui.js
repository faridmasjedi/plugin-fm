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

/** From this many options a list can be searched (as in NomadSF); shorter lists stay the browser's own. */
const SEARCH_FROM = 13;

/** A dropdown from [[value, label, sub?]] options: a searchable list when there are many. */
export function select(value, options, onchange, props = {}) {
  if (options.length >= SEARCH_FROM || props.searchable) return searchSelect(value, options, onchange, props);
  const { searchable, open, placeholder, ...rest } = props;
  return h(
    'select',
    { ...rest, onchange: (e) => onchange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v, selected: v === value }, label))
  );
}

/**
 * A list you can type in (like NomadSF's): the chosen one stays shown; a click opens the list with a search box on
 * top, at most 320 px tall; ↑ ↓ Enter choose, Esc closes. `open: true` opens it at once.
 */
export function searchSelect(value, options, onchange, { placeholder = 'Choose…', open = false, ...props } = {}) {
  const wrap = h('span', { class: 'search-select' });
  const current = options.find((o) => o[0] === value);
  const text = h('span', { class: 'search-select-text' }, current ? current[1] : placeholder);
  const button = h(
    'button',
    {
      type: 'button',
      class: 'search-select-button',
      'aria-haspopup': 'listbox',
      'aria-label': props['aria-label'],
      title: props.title,
    },
    text,
    h('span', { class: 'search-select-caret', 'aria-hidden': 'true' }, '▾')
  );
  let pop = null;
  const outside = (e) => {
    if (!wrap.contains(e.target)) close();
  };
  function close() {
    pop?.remove();
    pop = null;
    document.removeEventListener('mousedown', outside, true);
  }
  function show() {
    const input = h('input', {
      placeholder: 'Type to find…',
      'aria-label': 'Find',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const list = h('ul', { class: 'search-select-list', role: 'listbox' });
    let active = Math.max(
      0,
      options.findIndex((o) => o[0] === value)
    );
    let shown = [];
    const mark = () => [...list.children].forEach((li, i) => li.classList.toggle('active', i === active));
    const choose = (o) => {
      close();
      text.textContent = o[1];
      onchange(o[0]);
    };
    const draw = () => {
      const f = input.value.trim().toLowerCase();
      shown = options
        .filter(
          (o) =>
            !f ||
            String(o[1]).toLowerCase().includes(f) ||
            String(o[0]).toLowerCase().includes(f) ||
            String(o[2] ?? '')
              .toLowerCase()
              .includes(f)
        )
        .slice(0, 400);
      active = Math.min(active, Math.max(0, shown.length - 1));
      list.replaceChildren(
        ...(shown.length
          ? shown.map((o, i) =>
              h(
                'li',
                {
                  role: 'option',
                  class: `${i === active ? 'active ' : ''}${o[0] === value ? 'chosen' : ''}`,
                  onmousedown: (e) => (e.preventDefault(), choose(o)),
                  onmousemove: () => active !== i && ((active = i), mark()),
                },
                o[1],
                o[2] ? h('span', { class: 'sub' }, o[2]) : null
              )
            )
          : [h('li', { class: 'disabled' }, 'Nothing matches')])
      );
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => ((active = 0), draw()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = Math.max(0, Math.min(shown.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1)));
        mark();
        list.children[active]?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (shown[active]) choose(shown[active]);
      } else if (e.key === 'Escape') {
        close();
        button.focus();
      }
    });
    pop = h('div', { class: 'search-select-pop' }, input, list);
    wrap.append(pop);
    draw();
    input.focus();
    document.addEventListener('mousedown', outside, true);
  }
  button.addEventListener('click', () => (pop ? close() : show()));
  wrap.append(button);
  if (open) setTimeout(show, 0);
  return wrap;
}

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
