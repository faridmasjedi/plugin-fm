// The NomadQA step engine: finds Salesforce elements by what a person sees (labels, button names) and runs one step.
// Self-contained (no imports): the extension injects it into a tab's isolated world, and the headless runner
// evaluates the same file through Chrome's DevTools protocol. In the isolated world Lightning's components are plain
// DOM; the few real shadow roots are walked too.
(() => {
  if (globalThis.__nomadqa?.version === 1) return;

  const norm = (s) =>
    String(s ?? '')
      .replace(/ /g, ' ')
      .replace(/^\s*\*\s*/, '')
      .replace(/\s*\*\s*$/, '')
      .replace(/\s*\(?required\)?\s*$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Every element matching `selector`, in the document and every open shadow root. */
  function deepAll(selector, root = document) {
    const out = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) out.push(...deepAll(selector, el.shadowRoot));
    return out;
  }
  const parentOf = (el) => el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  const ancestors = function* (el) {
    for (let x = el; x; x = parentOf(x)) yield x;
  };

  function visible(el) {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    for (const a of ancestors(el)) {
      const s = getComputedStyle(a);
      if (s.display === 'none' || s.visibility === 'hidden' || a.getAttribute?.('aria-hidden') === 'true') return false;
    }
    return true;
  }

  /** The dialog on top, when one is open: steps look there first. */
  function topDialog() {
    const dialogs = deepAll('[role="dialog"], section.slds-modal, .modal-container').filter(visible);
    return dialogs[dialogs.length - 1] ?? null;
  }
  const inScope = (el, scope) => !scope || [...ancestors(el)].includes(scope);

  const nameOf = (el) =>
    norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || el.value || '');

  const CLICKABLE =
    'button, a, [role="button"], [role="menuitem"], [role="menuitemradio"], [role="tab"], [role="option"], [role="link"], [role="treeitem"], input[type="submit"], input[type="button"], one-app-nav-bar-item-root a';

  /** Buttons, links, tabs and menu items whose name is `label` (exact first, then starting with it). */
  function findClickable(label, { within } = {}) {
    const want = norm(label);
    const dialog = topDialog();
    let all = deepAll(CLICKABLE).filter(visible);
    if (within) {
      const box = findRegion(within);
      if (box) all = all.filter((el) => inScope(el, box));
    }
    const pick = (list) =>
      list.find((el) => nameOf(el) === want) ?? list.find((el) => nameOf(el).startsWith(want)) ?? null;
    return (dialog && pick(all.filter((el) => inScope(el, dialog)))) || pick(all);
  }

  /** A part of the page by its heading (a related list, a card, a section). */
  function findRegion(title) {
    const want = norm(title);
    const heads = deepAll('h1, h2, h3, .slds-card__header-title, [role="heading"]').filter(
      (h) => visible(h) && norm(h.innerText).startsWith(want)
    );
    for (const h of heads)
      for (const a of ancestors(h))
        if (
          a.matches?.(
            'article, section, .slds-card, lst-related-list-single-container, force-related-list-single-container'
          )
        )
          return a;
    return heads[0] ? parentOf(heads[0]) : null;
  }

  const FIELD_BOX =
    'lightning-input, lightning-textarea, lightning-combobox, lightning-grouped-combobox, lightning-input-field, lightning-lookup, lightning-datepicker, lightning-timepicker, lightning-input-rich-text, .slds-form-element';

  /** The control a field's label belongs to: { box, control, kind: 'text' | 'checkbox' | 'combobox' | 'lookup' }. */
  function findField(label) {
    const want = norm(label);
    const dialog = topDialog();
    const labels = deepAll('label, legend, .slds-form-element__label').filter(
      (l) => visible(l) && norm(l.innerText) === want
    );
    const ordered = dialog ? [...labels.filter((l) => inScope(l, dialog)), ...labels] : labels;
    for (const l of ordered) {
      let control = null;
      const id = l.getAttribute('for');
      if (id) control = deepAll(`[id="${CSS.escape(id)}"]`)[0] ?? null;
      let box = null;
      for (const a of ancestors(l))
        if (a.matches?.(FIELD_BOX)) {
          box = a;
          if (
            a.matches(
              'lightning-input, lightning-textarea, lightning-combobox, lightning-grouped-combobox, lightning-input-field, lightning-lookup'
            )
          )
            break;
        }
      box = box ?? parentOf(l);
      if (!control || control.matches('label'))
        control =
          box.querySelector('input[role="combobox"], button[role="combobox"], [role="combobox"]') ??
          box.querySelector('input:not([type="hidden"]), textarea, select');
      if (!control) continue;
      const lookup =
        box.matches?.('lightning-grouped-combobox, lightning-lookup') ||
        box.querySelector?.('lightning-grouped-combobox');
      const kind =
        control.type === 'checkbox'
          ? 'checkbox'
          : control.getAttribute('role') === 'combobox' || control.tagName === 'SELECT'
          ? lookup
            ? 'lookup'
            : 'combobox'
          : 'text';
      return { box, control, kind, label: l };
    }
    return null;
  }

  /** Waits until `find()` returns something (Salesforce answers in its own time). */
  async function until(find, timeout, what) {
    const end = Date.now() + timeout;
    const patience = Date.now() + timeout / 2;
    let last;
    while (Date.now() < end) {
      // A spinner that never goes away (a background card) must not block the step for ever
      if (!busy() || Date.now() > patience) {
        last = await find();
        if (last) return last;
      }
      await sleep(200);
    }
    throw new Error(`Not found within ${Math.round(timeout / 1000)} s: ${what}`);
  }
  const busy = () => {
    const dialog = topDialog();
    return deepAll('.slds-spinner_container, lightning-spinner').some(
      (s) => visible(s) && !s.closest?.('.slds-hide') && (!dialog || inScope(s, dialog))
    );
  };

  function press(el) {
    el.scrollIntoView?.({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const at = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
      view: window,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', at));
    el.dispatchEvent(new MouseEvent('mousedown', at));
    el.focus?.();
    el.dispatchEvent(new PointerEvent('pointerup', at));
    el.dispatchEvent(new MouseEvent('mouseup', at));
    el.click();
  }

  function setValue(el, value, { change = true } = {}) {
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: String(value) })
    );
    if (change) el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  /** The options of an open combobox or lookup. */
  const options = () => deepAll('[role="option"], lightning-base-combobox-item').filter(visible);
  const optionText = (o) =>
    norm(o.getAttribute('data-value') ?? '') || norm(o.getAttribute('title') ?? '') || norm(o.innerText);

  async function choose(field, value, timeout) {
    const want = norm(value);
    press(field.control);
    const opt = await until(
      () => {
        const list = options();
        return (
          list.find((o) => norm(o.innerText) === want || norm(o.getAttribute('data-value')) === want) ??
          list.find((o) => norm(o.innerText).startsWith(want)) ??
          null
        );
      },
      timeout,
      `option “${value}”`
    );
    press(opt);
  }

  async function lookup(field, value, timeout) {
    const want = norm(value);
    // Like a person: click in, then type (a lookup searches as you type; a "change" would end the search)
    press(field.control);
    await sleep(300);
    setValue(field.control, value, { change: false });
    field.control.dispatchEvent(
      new KeyboardEvent('keyup', { bubbles: true, composed: true, key: String(value).slice(-1) })
    );
    const opt = await until(
      () =>
        options().find((o) => {
          const t = norm(o.innerText);
          return t.startsWith(want) && !/^(show (more|all) results|new )/.test(t);
        }) ?? null,
      timeout,
      `a record “${value}” in ${field.label.innerText.trim()}`
    );
    press(opt);
  }

  /** A field's shown value on a record page: the highlights panel, the details layout, or a form. */
  function fieldValue(label) {
    const want = norm(label);
    const boxes = deepAll(
      'records-highlights-details-item, records-record-layout-item, force-record-layout-item, .slds-form-element, dl > div'
    ).filter(visible);
    for (const box of boxes) {
      const lab = [...box.querySelectorAll('*')].find(
        (x) => x.children.length === 0 && norm(x.textContent) === want && visible(x)
      );
      if (!lab) continue;
      const text = box.innerText.replace(/\s+/g, ' ').trim();
      const at = text.toLowerCase().indexOf(lab.textContent.trim().toLowerCase());
      const rest = (at >= 0 ? text.slice(at + lab.textContent.trim().length) : text)
        .replace(/^\s*(Help|Edit [^\n]*)\s*/i, '')
        .trim();
      if (box.matches('.slds-form-element')) {
        const control = box.querySelector('input, textarea, button[role="combobox"]');
        if (control) return control.value ?? control.innerText;
      }
      return rest.replace(new RegExp(`\\s*Edit ${lab.textContent.trim()}\\s*$`, 'i'), '').trim();
    }
    return null;
  }

  const toasts = () =>
    deepAll('.toastMessage, .forceToastMessage, [role="alert"], .slds-notify__content')
      .filter(visible)
      .map((t) => t.innerText.replace(/\s+/g, ' ').trim());
  const pageText = () => {
    const parts = [document.body?.innerText ?? ''];
    for (const el of deepAll('*')) if (el.shadowRoot) parts.push(el.shadowRoot.textContent ?? '');
    return parts.join('\n').replace(/\s+/g, ' ');
  };

  /** Runs one step; resolves { ok, message, ms }. */
  async function run(step) {
    const t0 = Date.now();
    const timeout = Number(step.timeout ?? 20000);
    try {
      switch (step.action) {
        case 'click': {
          const el = await until(() => findClickable(step.label, step), timeout, `“${step.label}”`);
          press(el);
          break;
        }
        case 'fill':
        case 'pick':
        case 'lookup':
        case 'check': {
          const f = await until(() => findField(step.field), timeout, `the field “${step.field}”`);
          if (step.action === 'check' || f.kind === 'checkbox') {
            const want = step.value === true || /^(true|yes|1|on|checked)$/i.test(String(step.value));
            if (f.control.checked !== want) press(f.control);
          } else if (step.action === 'pick' || (f.kind === 'combobox' && step.action === 'fill'))
            await choose(f, step.value, timeout);
          else if (step.action === 'lookup' || f.kind === 'lookup') await lookup(f, step.value, timeout);
          else setValue(f.control, step.value ?? '');
          break;
        }
        case 'wait':
          if (step.text)
            await until(
              () => (pageText().toLowerCase().includes(String(step.text).toLowerCase()) ? true : null),
              timeout,
              `the text “${step.text}”`
            );
          else await sleep(Number(step.ms ?? 1000));
          break;
        case 'expect': {
          const want = String(step.value ?? '');
          if (step.kind === 'toast')
            await until(
              () => toasts().find((t) => t.toLowerCase().includes(want.toLowerCase())) ?? null,
              timeout,
              `a message “${want}”`
            );
          else if (step.kind === 'field')
            await until(
              () => {
                const v = fieldValue(step.field);
                return v !== null && v.toLowerCase().includes(want.toLowerCase()) ? v : null;
              },
              timeout,
              `${step.field} = “${want}” (now “${fieldValue(step.field) ?? 'not on the page'}”)`
            );
          else if (step.kind === 'title')
            await until(
              () => (document.title.toLowerCase().includes(want.toLowerCase()) ? true : null),
              timeout,
              `the title “${want}” (now “${document.title}”)`
            );
          else if (step.kind === 'url')
            await until(
              () => (location.href.includes(want) ? true : null),
              timeout,
              `the address to contain “${want}”`
            );
          else if (step.kind === 'no-text')
            await until(
              () => (pageText().toLowerCase().includes(want.toLowerCase()) ? null : true),
              timeout,
              `“${want}” to be gone`
            );
          else
            await until(
              () => (pageText().toLowerCase().includes(want.toLowerCase()) ? true : null),
              timeout,
              `the text “${want}”`
            );
          break;
        }
        case 'press':
          (document.activeElement ?? document.body).dispatchEvent(
            new KeyboardEvent('keydown', { key: step.key ?? 'Enter', bubbles: true, composed: true })
          );
          break;
        default:
          throw new Error(`The page cannot run “${step.action}”.`);
      }
      return { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, message: e.message, ms: Date.now() - t0, url: location.href, toasts: toasts().slice(0, 3) };
    }
  }

  /** Waits until Lightning has drawn the page (the app's navigation, no spinner). */
  async function ready(timeout = 60000) {
    await until(
      () =>
        document.readyState === 'complete' &&
        deepAll('one-appnav, .oneHeader, one-app-nav-bar, .slds-global-header').some(visible)
          ? true
          : null,
      timeout,
      'Salesforce to finish loading'
    );
    await sleep(400);
    return true;
  }

  // ---------- what an element is (inspector, recorder) ----------

  const fieldLabelOf = (el) => {
    for (const a of ancestors(el)) {
      if (
        a.matches?.(
          'lightning-input, lightning-textarea, lightning-combobox, lightning-grouped-combobox, lightning-input-field, lightning-lookup, .slds-form-element'
        )
      ) {
        const l = a.querySelector('label, legend, .slds-form-element__label');
        if (l && l.innerText.trim())
          return l.innerText
            .replace(/^\s*\*\s*/, '')
            .replace(/\s*\*\s*$/, '')
            .replace(/\s+/g, ' ')
            .trim();
      }
    }
    return '';
  };

  function describe(el) {
    const chain = [];
    let auraClass = '';
    let selection = '';
    for (const a of ancestors(el)) {
      if (!a.tagName) continue;
      const tag = a.tagName.toLowerCase();
      if (tag.includes('-') && chain.length < 8 && !chain.includes(tag)) chain.push(tag);
      if (!auraClass && a.getAttribute?.('data-aura-class')) auraClass = a.getAttribute('data-aura-class');
      if (!selection && /^sfdc:/.test(a.getAttribute?.('data-target-selection-name') ?? ''))
        selection = a.getAttribute('data-target-selection-name');
    }
    const custom = chain.find((t) => /^c-/.test(t));
    const ns = chain.find(
      (t) =>
        !/^(lightning|force|one|records|flexipage|forcegenerated|lst|runtime|laf|ui|aura|slds|lwc|community|interop|navex|support|sfa|dxp|emailui|forcechatter|forcesearch)-/.test(
          t
        ) && !/^c-/.test(t)
    );
    const field = /^sfdc:RecordField\.(\w+)\.(\w+)$/.exec(selection);
    const record = /\/lightning\/r\/(\w+)\/(\w{15,18})\//.exec(location.pathname);
    const toCamel = (t) => t.replace(/^c-/, '').replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
    return {
      tag: el.tagName.toLowerCase(),
      name: nameOf(el)
        ? (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim().slice(0, 80)
        : '',
      field: fieldLabelOf(el),
      fieldApi: field ? `${field[1]}.${field[2]}` : '',
      components: chain,
      custom: custom
        ? { tag: custom, bundle: toCamel(custom), path: `force-app/main/default/lwc/${toCamel(custom)}` }
        : null,
      packaged: ns ?? '',
      aura: auraClass,
      record: record ? { object: record[1], id: record[2] } : null,
    };
  }

  globalThis.__nomadqa = {
    version: 1,
    run,
    ready,
    describe,
    findClickable,
    findField,
    fieldValue,
    toasts,
    deepAll,
    visible,
    nameOf,
    norm,
    ancestors,
    fieldLabelOf,
  };
})();
