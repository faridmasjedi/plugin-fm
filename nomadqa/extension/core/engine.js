// The NomadQA step engine: finds Salesforce elements by what a person sees (labels, button names) and runs one step.
// Self-contained (no imports): the extension injects it into a tab's isolated world, and the headless runner
// evaluates the same file through Chrome's DevTools protocol. In the isolated world Lightning's components are plain
// DOM; the few real shadow roots are walked too.
(() => {
  if (globalThis.__nomadqa?.version === 2) return;

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
    throw new Error(`Not found within ${Math.round(timeout / 1000)} s: ${typeof what === 'function' ? what() : what}`);
  }
  const busy = () => {
    const dialog = topDialog();
    return deepAll('.slds-spinner_container, lightning-spinner').some(
      (s) => visible(s) && !s.closest?.('.slds-hide') && (!dialog || inScope(s, dialog))
    );
  };

  // While a step clicks, NomadQA's own page script (Inspector, going through a test) lets the click through
  function press(el) {
    const api = globalThis.__nomadqa;
    if (api) api.pressing = true;
    try {
      pressNow(el);
    } finally {
      if (api) api.pressing = false;
    }
  }
  function pressNow(el) {
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

  const OPS = {
    contains: 'contains',
    is: 'is',
    not: 'is not',
    starts: 'starts with',
    empty: 'is empty',
    filled: 'is filled in',
    more: 'is more than',
    less: 'is less than',
    matches: 'matches',
  };
  const num = (v) => parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  /** The value as a check wants it (text compared without case). */
  function compare(actual, want, op = 'contains') {
    const a = String(actual ?? '').trim();
    const w = String(want ?? '').trim();
    switch (op) {
      case 'is':
        return a.toLowerCase() === w.toLowerCase();
      case 'not':
        return a.toLowerCase() !== w.toLowerCase();
      case 'starts':
        return a.toLowerCase().startsWith(w.toLowerCase());
      case 'empty':
        return a === '';
      case 'filled':
        return a !== '';
      case 'more':
        return num(a) > num(w);
      case 'less':
        return num(a) < num(w);
      case 'matches':
        try {
          return new RegExp(w, 'i').test(a);
        } catch {
          return false;
        }
      default:
        return a.toLowerCase().includes(w.toLowerCase());
    }
  }

  // ---------- what a user sees: how many, and where ----------

  const COUNTS = {
    // The record's own action buttons (not "Show more actions"); in a part of the page, its buttons
    // (a related list's own "New" counts only when that list is asked for)
    buttons: (scope) => {
      const ribbon = 'runtime_platform_actions-actions-ribbon li button, runtime_platform_actions-actions-ribbon li a';
      const top = deepAll(`records-highlights2 ${ribbon.replace(', ', ', records-highlights2 ')}`).filter(visible);
      return (
        scope
          ? deepAll('button, a.slds-button, [role="button"]').filter((b) => inScope(b, scope))
          : top.length
          ? top
          : deepAll(ribbon)
      ).filter((b) => visible(b) && !/^show (more|all) actions$/i.test(nameOf(b)) && nameOf(b));
    },
    tabs: (scope) => deepAll('[role="tab"]').filter((t) => visible(t) && inScope(t, scope)),
    fields: (scope) =>
      deepAll('records-record-layout-item, force-record-layout-item').filter(
        (f) => visible(f) && inScope(f, scope) && (f.getAttribute('field-label') ?? f.innerText.trim()) !== ''
      ),
    sections: (scope) =>
      deepAll('records-record-layout-section, force-record-layout-section').filter(
        (x) => visible(x) && inScope(x, scope)
      ),
    'related lists': (scope) =>
      deepAll('lst-related-list-single-container, force-related-list-single-container').filter(
        (x) => visible(x) && inScope(x, scope)
      ),
    rows: (scope) =>
      deepAll('tbody tr, [role="row"]').filter(
        (r) => visible(r) && inScope(r, scope) && !r.querySelector('th[scope="col"], [role="columnheader"]')
      ),
  };

  /** How many of `what` the page (or a part of it, by its title) shows. */
  function count(what, within) {
    const scope = within ? findRegion(within) : null;
    if (within && !scope) return null;
    const list = (COUNTS[what] ?? COUNTS.buttons)(scope);
    // The same element seen twice (a light-DOM copy inside a shadow host) counts once
    return { n: new Set(list).size, names: list.map((x) => nameOf(x).slice(0, 40)).slice(0, 12) };
  }

  const sectionTitle = (sec) => {
    const head =
      sec.querySelector('.test-id__section-header-title, .slds-section__title, h3') ??
      sec.previousElementSibling?.querySelector?.('.slds-section__title, h3');
    return head ? head.innerText.replace(/\s+/g, ' ').trim() : '';
  };

  /** Where a field is on the record's layout: its section (title and number), row and column (from 1). */
  function placeOf(label) {
    const want = norm(label);
    const items = deepAll('records-record-layout-item').filter(
      (i) => visible(i) && norm(i.getAttribute('field-label') ?? '') === want
    );
    const item = items[0];
    if (!item) return null;
    const row = [...ancestors(item)].find((a) => a.matches?.('records-record-layout-row'));
    const sec = [...ancestors(item)].find((a) => a.matches?.('records-record-layout-section'));
    const rows = sec ? [...sec.querySelectorAll('records-record-layout-row')].filter(visible) : [];
    const sections = deepAll('records-record-layout-section').filter(visible);
    return {
      section: sec ? sectionTitle(sec) : '',
      sectionNo: sections.indexOf(sec) + 1,
      row: rows.indexOf(row) + 1,
      col: row ? [...row.querySelectorAll('records-record-layout-item')].indexOf(item) + 1 : 0,
    };
  }
  const placeText = (p) => `${p.section ? `“${p.section}”` : `section ${p.sectionNo}`}, row ${p.row}, column ${p.col}`;

  // A field named as typed, or by its label (a step that gives the API name carries the label in fieldAlt)
  /** The label a record page shows for a field, by its API name (Contact.MobilePhone → "Mobile"). */
  function labelByApi(api) {
    if (!api) return null;
    for (const el of deepAll(`[data-target-selection-name="sfdc:RecordField.${api}"]`).filter(visible)) {
      const item =
        el.querySelector?.('records-record-layout-item, records-highlights-details-item') ??
        [...ancestors(el)].find((a) => a.matches?.('records-record-layout-item, records-highlights-details-item'));
      const label = item?.getAttribute('field-label') || (item && fieldLabelOf(item.querySelector('*') ?? item));
      if (label) return label;
    }
    return null;
  }
  const either = (fn, step) =>
    fn(step.field) ??
    (step.fieldAlt && step.fieldAlt !== step.field ? fn(step.fieldAlt) : null) ??
    (step.fieldApi
      ? (() => {
          const label = labelByApi(step.fieldApi);
          return label ? fn(label) : null;
        })()
      : null);

  /** Runs one step; resolves { ok, message, ms }. */
  async function run(step) {
    const t0 = Date.now();
    const timeout = Number(step.timeout ?? 20000);
    try {
      switch (step.action) {
        case 'click': {
          const el = await until(() => findClickable(step.label, step), timeout, `“${step.label}”`);
          const before = location.href;
          press(el);
          // A click that goes to another page: wait for it, so the next step does not find the old one
          for (let i = 0; i < 12 && location.href === before; i++) await sleep(100);
          if (location.href !== before) await ready(timeout);
          break;
        }
        case 'fill':
        case 'pick':
        case 'lookup':
        case 'check': {
          const f = await until(() => either(findField, step), timeout, `the field “${step.field}”`);
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
          const op = step.op ?? 'contains';
          const kind = step.kind ?? 'text';
          const say = `${OPS[op] ?? op}${op === 'empty' || op === 'filled' ? '' : ` “${want}”`}`;
          if (kind === 'toast')
            await until(() => toasts().find((t) => compare(t, want, op)) ?? null, timeout, `a message that ${say}`);
          else if (kind === 'field')
            await until(
              () => {
                const v = either(fieldValue, step);
                return v !== null && compare(v, want, op) ? true : null;
              },
              timeout,
              () => `${step.field} ${say} (now “${either(fieldValue, step) ?? 'not on the page'}”)`
            );
          else if (kind === 'title')
            await until(
              () => (compare(document.title, want, op) ? true : null),
              timeout,
              () => `the title ${say} (now “${document.title}”)`
            );
          else if (kind === 'url')
            await until(() => (compare(location.href, want, op) ? true : null), timeout, `the address ${say}`);
          else if (kind === 'button')
            await until(() => findClickable(want, step), timeout, `a button or link “${want}”`);
          else if (kind === 'no-button')
            await until(() => (findClickable(want, step) ? null : true), timeout, `no button or link “${want}”`);
          else if (kind === 'count')
            await until(
              () => {
                const c = count(step.what ?? 'buttons', step.within);
                return c && compare(String(c.n), want, op === 'contains' ? 'is' : op) ? true : null;
              },
              timeout,
              () => {
                const c = count(step.what ?? 'buttons', step.within);
                return `${step.what ?? 'buttons'} ${OPS[op === 'contains' ? 'is' : op] ?? op} ${want}${
                  step.within ? ` in “${step.within}”` : ''
                } (now ${
                  c ? `${c.n}${c.names.length ? `: ${c.names.join(', ')}` : ''}` : `no “${step.within}” on the page`
                })`;
              }
            );
          else if (kind === 'place') {
            const fits = (p) =>
              p &&
              (!step.section ||
                (/^\d+$/.test(String(step.section))
                  ? p.sectionNo === Number(step.section)
                  : norm(p.section) === norm(step.section))) &&
              (!step.row || p.row === Number(step.row)) &&
              (!step.col || p.col === Number(step.col));
            await until(
              () => (fits(either(placeOf, step)) ? true : null),
              timeout,
              () => {
                const p = either(placeOf, step);
                return `${step.field} at the place asked (now ${p ? placeText(p) : 'not on the page'})`;
              }
            );
          } else if (kind === 'no-text')
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
        case 'remember': {
          const v = await until(() => either(fieldValue, step), timeout, `the field “${step.field}”`);
          return { ok: true, value: v, message: `${step.as} = “${v}”`, ms: Date.now() - t0 };
        }
        case 'login-form': {
          // The Salesforce login page: username, password, Log In (the newer page asks for an email first: its
          // "Log In with Username" link shows the form — the caller asks again after it)
          const found = await until(
            () => {
              const u = [...document.querySelectorAll('input#username, input[name="username"]')].find(visible);
              if (u) return { u };
              const l = [...document.querySelectorAll('a, button')].find(
                (x) => visible(x) && /^log in with username$/i.test((x.innerText ?? '').trim())
              );
              return l ? { l } : null;
            },
            timeout,
            'the login page'
          );
          if (found.l) {
            press(found.l);
            return { ok: true, link: true, ms: Date.now() - t0 };
          }
          // The password box may show a moment after the username
          const pass = await until(
            () => [...document.querySelectorAll('input#password, input[type="password"]')].find(visible) ?? null,
            5000,
            'the password box on the login page'
          );
          setValue(found.u, step.username ?? '');
          setValue(pass, step.password ?? '');
          const go = document.querySelector('#Login, input[type="submit"], button[type="submit"]');
          if (!go) throw new Error('No “Log In” button on the page.');
          press(go);
          return { ok: true, typed: true, ms: Date.now() - t0 };
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
      if (a.matches?.('records-highlights-details-item, records-record-layout-item, force-record-layout-item')) {
        const leaf = [...a.querySelectorAll('*')].find((x) => x.children.length === 0 && x.textContent.trim());
        if (leaf) return leaf.textContent.replace(/\s+/g, ' ').trim();
      }
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
    version: 2,
    run,
    count,
    placeOf,
    ready,
    compare,
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
