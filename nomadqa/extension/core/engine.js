// The NomadQA step engine: finds Salesforce elements by what a person sees (labels, button names) and runs one step.
// Self-contained (no imports): the extension injects it into a tab's isolated world, and the headless runner
// evaluates the same file through Chrome's DevTools protocol. In the isolated world Lightning's components are plain
// DOM; the few real shadow roots are walked too.
(() => {
  if (globalThis.__nomadqa?.version === 6) return;

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

  /** A frame's page when it is the org's own (Setup draws its pages in one); null for another site's. */
  const frameDoc = (f) => {
    try {
      return f.contentDocument?.documentElement ? f.contentDocument : null;
    } catch {
      return null;
    }
  };
  /** Every element matching `selector`, in the document, every open shadow root and the org's own frames. */
  function deepAll(selector, root = document) {
    const out = [...root.querySelectorAll(selector)];
    for (const el of root.querySelectorAll('*')) {
      // NomadQA's own panel on the page (the list of steps, the Inspector) is not part of the page being tested
      if (el.shadowRoot && el.id !== 'nomadqa-host') out.push(...deepAll(selector, el.shadowRoot));
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        const doc = frameDoc(el);
        if (doc) out.push(...deepAll(selector, doc));
      }
    }
    return out;
  }
  /** The pages of the org's own frames (Setup's), deepest last. */
  const frameDocs = () => deepAll('iframe, frame').map(frameDoc).filter(Boolean);
  const parentOf = (el) =>
    el.parentElement ??
    (el.getRootNode().nodeType === 11 && el.getRootNode().host
      ? el.getRootNode().host
      : el === el.ownerDocument?.documentElement
      ? el.ownerDocument.defaultView?.frameElement ?? null
      : null);
  /** Where an element is on the screen of the whole tab (an element in a frame: plus where the frame is). */
  function screenRect(el) {
    const r = el.getBoundingClientRect();
    let x = r.x;
    let y = r.y;
    for (let w = el.ownerDocument?.defaultView; w && w.frameElement; w = w.frameElement.ownerDocument.defaultView) {
      const f = w.frameElement.getBoundingClientRect();
      x += f.x + (w.frameElement.clientLeft || 0);
      y += f.y + (w.frameElement.clientTop || 0);
    }
    return { x, y, width: r.width, height: r.height, top: y, left: x, right: x + r.width, bottom: y + r.height };
  }
  const ancestors = function* (el) {
    for (let x = el; x; x = parentOf(x)) yield x;
  };

  function visible(el) {
    if (!el?.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    for (const a of ancestors(el)) {
      const s = (a.ownerDocument?.defaultView ?? window).getComputedStyle(a);
      if (s.display === 'none' || s.visibility === 'hidden' || a.getAttribute?.('aria-hidden') === 'true') return false;
    }
    return true;
  }

  /**
   * The element at an exact path, as DevTools copies it (right-click the element › Copy):
   * - JS path: document.querySelector("a").shadowRoot.querySelector("b") — followed exactly, through shadow roots;
   * - XPath: //div[@id="x"]/button — in the page and the org's own frames;
   * - selector: div.x > button — in the page, every shadow root and the org's frames (the first shown wins).
   */
  function byPath(path) {
    const p = String(path ?? '').trim();
    if (!p) return null;
    if (/^document\s*\.\s*querySelector/.test(p)) {
      const parts = [
        ...p.matchAll(/querySelector\(\s*(["'`])((?:\\.|(?!\1).)*)\1\s*\)(\s*\.\s*(shadowRoot|contentDocument))?/g),
      ];
      let root = document;
      let el = null;
      for (const [, , sel, , into] of parts) {
        el = root?.querySelector(sel.replace(/\\(["'`\\])/g, '$1')) ?? null;
        if (!el) return null;
        root = into === 'shadowRoot' ? el.shadowRoot : into === 'contentDocument' ? frameDoc(el) : el;
      }
      return el;
    }
    if (/^\(*\//.test(p)) {
      for (const doc of [document, ...frameDocs()]) {
        try {
          const el = doc.evaluate(p, doc, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
          if (el) return el.nodeType === 1 ? el : el.parentElement;
        } catch {
          return null;
        }
      }
      return null;
    }
    try {
      const all = deepAll(p);
      return all.find(visible) ?? all[0] ?? null;
    } catch {
      return null;
    }
  }
  /**
   * An element's exact paths, as DevTools would copy them: { selector, xpath, js, best }. selector is one that finds
   * only it (in the page and every shadow root); xpath only when it is not inside a shadow root (XPath cannot go
   * in); js goes through each shadow root. best: the selector when there is one, else the JS path.
   */
  function pathsOf(el) {
    if (!el?.tagName) return null;
    const cssq = (v) => `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    // Attributes that say what it is (ids and values with long numbers change from one load to the next)
    const steady = (v) => v && v.length <= 80 && !/\d{3,}/.test(v) && !/^\s*javascript:/i.test(v);
    const ATTRS = [
      'name',
      'title',
      'aria-label',
      'data-name',
      'data-id',
      'data-target-selection-name',
      'data-label',
      'placeholder',
    ];
    const own = (e) => {
      const tag = e.tagName.toLowerCase();
      const out = [];
      if (steady(e.id) && !/^\d/.test(e.id)) out.push(`${tag}#${CSS.escape(e.id)}`);
      for (const a of ATTRS) if (steady(e.getAttribute(a))) out.push(`${tag}[${a}=${cssq(e.getAttribute(a))}]`);
      return out;
    };
    const only = (root, sel, e) => {
      try {
        const all = root.querySelectorAll(sel);
        return all.length === 1 && all[0] === e;
      } catch {
        return false;
      }
    };
    const nth = (e) => {
      const tag = e.tagName.toLowerCase();
      const sib = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : [];
      return sib.length > 1 ? `${tag}:nth-of-type(${sib.indexOf(e) + 1})` : tag;
    };
    /** A selector that finds only e in its own root (a page, a frame's page, a shadow root); steady: by what it is,
     * not by where it sits among its neighbours. */
    const inRoot = (e) => {
      const root = e.getRootNode();
      for (const s of own(e)) if (only(root, s, e)) return { sel: s, steady: true };
      const tag = e.tagName.toLowerCase();
      if (only(root, tag, e)) return { sel: tag, steady: true };
      // Under the nearest parent that can be named
      const chain = [nth(e)];
      for (let a = e.parentElement; a && chain.length < 8; a = a.parentElement) {
        const named = own(a).find((s) => only(root, s, a));
        if (named) {
          for (const sel of [`${named} ${tag}`, `${named} ${chain.join(' > ')}`])
            if (only(root, sel, e)) return { sel, steady: sel === `${named} ${tag}` };
        }
        chain.unshift(nth(a));
        if (only(root, chain.join(' > '), e)) return { sel: chain.join(' > '), steady: false };
      }
      return { sel: chain.join(' > '), steady: false };
    };
    // From the page down to it: through frames (contentDocument) and shadow roots (shadowRoot)
    const parts = [];
    for (let e = el; e; ) {
      const root = e.getRootNode();
      // (nodeType, not instanceof: a frame's page has its own Document and ShadowRoot)
      const shadow = root.nodeType === 11 && root.host;
      const how = shadow ? '.shadowRoot' : root !== document ? '.contentDocument' : '';
      parts.unshift({ ...inRoot(e), how });
      e = shadow ? root.host : root !== document ? root.defaultView?.frameElement ?? null : null;
    }
    const js = `document${parts.map((x, i) => `${i ? x.how : ''}.querySelector(${JSON.stringify(x.sel)})`).join('')}`;
    const last = parts[parts.length - 1];
    const deep = deepAll(last.sel);
    const selector = deep.length === 1 && deep[0] === el ? last.sel : parts.length === 1 ? last.sel : '';
    // XPath: in its page or frame's page (not inside a shadow root): by an attribute, by its text, or by place
    let xpath = '';
    let xSteady = false;
    const doc = el.getRootNode();
    if (doc.nodeType === 9) {
      const docs = [document, ...frameDocs()];
      const xone = (x) => {
        try {
          let n = 0;
          let hit = null;
          for (const d of docs) {
            const r = d.evaluate(x, d, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
            n += r.snapshotLength;
            if (r.snapshotLength) hit = hit ?? r.snapshotItem(0);
          }
          return n === 1 && hit === el;
        } catch {
          return false;
        }
      };
      const xq = (v) => (v.includes('"') ? `'${v}'` : `"${v}"`);
      const tag = el.tagName.toLowerCase();
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      const tries = [
        ...['id', ...ATTRS]
          .filter((a) => steady(el.getAttribute(a)))
          .map((a) => `//${tag}[@${a}=${xq(el.getAttribute(a))}]`),
        ...(text && text.length <= 40 && !text.includes('"') ? [`//${tag}[normalize-space()=${xq(text)}]`] : []),
      ];
      xpath = tries.find(xone) ?? '';
      xSteady = Boolean(xpath);
      if (!xpath) {
        const steps = [];
        for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
          const sib = e.parentElement ? [...e.parentElement.children].filter((x) => x.tagName === e.tagName) : [];
          steps.unshift(`${e.tagName.toLowerCase()}${sib.length > 1 ? `[${sib.indexOf(e) + 1}]` : ''}`);
        }
        xpath = `/${steps.join('/')}`;
      }
    }
    // What a step uses: what it is (a selector, its text) before where it sits
    const best =
      selector && last.steady ? selector : xSteady ? xpath : parts.every((x) => x.steady) ? js : selector || js;
    return { selector, xpath, js, best };
  }

  /** What an element shows: a box's value, or its text. */
  const elText = (el) =>
    String((el.matches?.('input, textarea, select') ? el.value : el.innerText ?? el.textContent) ?? '')
      .replace(/\s+/g, ' ')
      .trim();
  /** The box to type in at a path: the element, or the input inside it (a Lightning input's own box). */
  const boxAt = (el) =>
    !el
      ? null
      : el.matches('input, textarea, select')
      ? el
      : el.querySelector?.('input, textarea, select') ??
        el.shadowRoot?.querySelector('input, textarea, select') ??
        null;

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
    // What it says, or what it reads out (a button "Search..." reads "Search"); a trailing … does not count
    const bare = (t) => t.replace(/(\.\.\.|…)$/, '').trim();
    const w = bare(want);
    const names = (el) => [nameOf(el), norm(el.innerText ?? '')].map(bare);
    const pick = (list) =>
      list.find((el) => names(el).includes(w)) ??
      list.find((el) => names(el).some((n) => n && n.startsWith(w))) ??
      null;
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
  // ■ Stop (going through a test on the page): the step that waits stops now, as if its time ran out
  let stopped = false;
  const stopError = () => Object.assign(new Error('Stopped by you.'), { stopped: true });
  /** Waits ms, or less when stopped. */
  async function pause(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (stopped) throw stopError();
      await sleep(Math.min(200, end - Date.now()));
    }
  }
  async function until(find, timeout, what) {
    const end = Date.now() + timeout;
    const patience = Date.now() + timeout / 2;
    let last;
    while (Date.now() < end) {
      if (stopped) throw stopError();
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
    // A press may reload the whole page (another app): the driver then reads this to know the step was done
    try {
      if (api?.stepId) sessionStorage.setItem('nomadqa.pressed', api.stepId);
    } catch {
      /* no storage here */
    }
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
      view: el.ownerDocument?.defaultView ?? window,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', at));
    el.dispatchEvent(new MouseEvent('mousedown', at));
    el.focus?.();
    el.dispatchEvent(new PointerEvent('pointerup', at));
    el.dispatchEvent(new MouseEvent('mouseup', at));
    // A "javascript:" link: Chrome does not follow it when an extension clicks it; the page's own world does
    // (content/main.js). Anywhere else (the headless runner runs in the page's world) a plain click does it
    if (/^\s*javascript:/i.test(el.closest?.('a[href]')?.getAttribute('href') ?? '')) {
      const link = el.closest('a[href]');
      link.dispatchEvent(new CustomEvent('nomadqa:click'));
      if (link.getAttribute('data-nomadqa-clicked')) return void link.removeAttribute('data-nomadqa-clicked');
    }
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

  // ---------- a click that opens a list (App Launcher, a list view's menu…): type in it, then choose ----------
  const ITEMS = `${CLICKABLE}, [role="option"], [role="listitem"] a, one-app-launcher-menu-item, lightning-base-combobox-item`;
  async function clickThen(el, step, timeout) {
    const shownBefore = new Set(deepAll(`${TYPABLE}, ${ITEMS}`).filter(visible));
    press(el);
    if (String(step.type ?? '') !== '') {
      // The box the click opened: the one with the cursor, or one that was not there before
      const box = await until(
        () => {
          const active = deepActive();
          if (active?.matches?.(TYPABLE) && visible(active)) return active;
          return deepAll(TYPABLE).find((i) => visible(i) && !shownBefore.has(i) && !i.disabled && !i.readOnly) ?? null;
        },
        timeout,
        `a box to type in after clicking “${step.label}”`
      );
      press(box);
      await sleep(200);
      setValue(box, step.type, { change: false });
      box.dispatchEvent(
        new KeyboardEvent('keyup', { bubbles: true, composed: true, key: String(step.type).slice(-1) })
      );
      await sleep(400);
    }
    if (String(step.choose ?? '').trim() === '') return;
    const want = norm(step.choose);
    // "Click X, choose X" where X was a link (a permission set, Setup's menu): the click was the whole step. The
    // gear's Setup is the same name too, but there the menu shows it at once
    const same = !step.type && want === norm(step.label ?? '');
    // What the click opened comes first (new on the page), then anything else with that name
    const item = await until(
      () => {
        const all = deepAll(ITEMS).filter((x) => visible(x) && x !== el);
        const fresh = all.filter((x) => !shownBefore.has(x));
        const name = (x) =>
          norm(String(x.getAttribute('aria-label') || x.getAttribute('title') || x.innerText || '').split('\n')[0]);
        for (const list of [fresh, all]) {
          const hit = list.find((x) => name(x) === want) ?? list.find((x) => name(x).startsWith(want));
          if (hit) return hit;
        }
        return null;
      },
      same ? Math.min(timeout, 4000) : timeout,
      () => `“${step.choose}” in what “${step.label}” opened`
    ).catch((e) => {
      if (same && !e.stopped) return null;
      throw e;
    });
    if (!item) return 'Clicked; it opened no list, so there was nothing to choose.';
    if (inSetup() && changes(step.choose)) readOnly(`choosing “${step.choose}”`);
    press(item);
  }
  /** The element with the cursor, inside shadow roots and frames. */
  function deepActive() {
    let a = document.activeElement;
    for (let i = 0; i < 10 && a; i++) {
      const inner = a.shadowRoot?.activeElement ?? (a.tagName === 'IFRAME' ? frameDoc(a)?.activeElement : null);
      if (!inner) break;
      a = inner;
    }
    return a;
  }

  // ---------- search and choose: a search bar, a list's search, a lookup or any box that suggests ----------
  const TYPABLE =
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea';
  const boxName = (i) => norm(i.getAttribute('placeholder') || i.getAttribute('aria-label') || i.getAttribute('title'));
  // Salesforce's search at the top: no box named, or named like it (never a list's "Search this list…")
  const isSearchWord = (want) =>
    !want || /^(search( salesforce)?|salesforce search|global search)( \(at the top\))?(\.\.\.|…)?$/.test(want);
  const IN_LIST = 'force-list-view-manager, lst-list-view-manager-header, .forceListViewManager, lst-object-home';
  /** Is this box Salesforce's own search (in the header, or the search window it opens)? */
  const isGlobalBox = (i) =>
    ![...ancestors(i)].some((a) => a.matches?.(IN_LIST)) &&
    [...ancestors(i)].some(
      (a) =>
        /^(SEARCH_|FORCESEARCH|FORCE-SEARCH)/.test(a.tagName) ||
        /forceSearch|slds-global-header|oneHeader|search-dialog/i.test(
          String(a.className?.baseVal ?? a.className ?? '')
        )
    );
  /** The box to type in: a field by its label, a box by what it shows (Search this list…), or Salesforce's search. */
  function findBox(box) {
    const want = norm(box);
    const dialog = topDialog();
    const all = deepAll(TYPABLE).filter((i) => visible(i) && !i.disabled && !i.readOnly);
    const list = dialog ? [...all.filter((i) => inScope(i, dialog)), ...all] : all;
    if (!isSearchWord(want)) {
      const f = findField(box);
      if (f?.control?.matches?.(TYPABLE)) return f.control;
      return list.find((i) => boxName(i) === want) ?? list.find((i) => boxName(i).startsWith(want)) ?? null;
    }
    // Salesforce's own search, at the top (its box shows once its button is clicked) — never a list's search
    // On an object's pages its window has a second box first (where to search: "Cases"): the one that says Search
    const global = list.filter(isGlobalBox);
    return (
      global.find((i) => /^search/.test(norm(i.getAttribute('placeholder')))) ??
      global.find((i) => i.type === 'search') ??
      global.find((i) => i.getAttribute('role') !== 'combobox') ??
      null
    );
  }
  const globalSearchButton = () =>
    deepAll('button.search-button, button[aria-label="Search"], .forceSearchDesktopHeader button').find(visible) ??
    null;
  const RESULT_SKIP = /^(show (more|all) results|search for |new |see more|view all)/;
  function enter(el) {
    for (const type of ['keydown', 'keypress', 'keyup'])
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          which: 13,
          bubbles: true,
          composed: true,
          cancelable: true,
        })
      );
  }
  async function search(step, timeout) {
    const want = norm(step.box);
    let opened = false;
    const input = await until(
      () => {
        const found = findBox(step.box);
        if (found) return found;
        if (isSearchWord(want) && !opened) {
          const b = globalSearchButton();
          if (b) (opened = true), press(b);
        }
        return null;
      },
      timeout,
      `a box “${step.box || 'Search'}” to type in`
    );
    press(input);
    await sleep(300);
    setValue(input, step.text ?? '', { change: false });
    input.dispatchEvent(
      new KeyboardEvent('keyup', { bubbles: true, composed: true, key: String(step.text ?? '').slice(-1) })
    );
    const before = where();
    if (!String(step.choose ?? '').trim()) {
      await sleep(400);
      enter(input);
    } else {
      const choose = norm(step.choose);
      const suggestion = () => {
        const list = deepAll('[role="option"], lightning-base-combobox-item, search_dialog-instant-result-item')
          .filter(visible)
          .filter((o) => !RESULT_SKIP.test(norm(o.innerText)));
        return (
          list.find((o) => norm(String(o.innerText).split('\n')[0]) === choose) ??
          list.find((o) => norm(o.innerText).startsWith(choose)) ??
          list.find((o) => norm(o.innerText).includes(choose)) ??
          null
        );
      };
      // Among the suggestions; when none fits (a case number is not suggested), like a person: Enter, then the
      // result on the page of results
      const pick = await until(suggestion, Math.min(timeout / 2, 8000), '').catch(() => null);
      if (pick) press(pick.querySelector?.('a[href]') ?? pick);
      else {
        enter(input);
        await settleAfter(before, timeout);
        const result = await until(
          () => findClickable(step.choose),
          timeout,
          () => `“${step.choose}” among what “${step.text}” suggests, or in its search results`
        );
        const now = where();
        press(result);
        await settleAfter(now, timeout);
        return;
      }
    }
    // Searching or choosing a record usually opens a page: wait for it
    await settleAfter(before, timeout);
  }

  /** A field's shown value on a record page: the highlights panel, the details layout, or a form. */
  function fieldValue(label) {
    const want = norm(label);
    const classic = classicValue(want);
    if (classic !== null) return classic;
    const boxes = deepAll(
      'records-highlights-details-item, records-record-layout-item, force-record-layout-item, .slds-form-element, dl > div'
    ).filter(visible);
    for (const box of boxes) {
      const lab = [...box.querySelectorAll('*')].find(
        (x) => x.children.length === 0 && norm(x.textContent) === want && visible(x)
      );
      if (!lab) continue;
      // Words only for screen readers ("Preview" after a link, "Edit …") are not the value
      let text = box.innerText.replace(/\s+/g, ' ').trim();
      for (const hidden of box.querySelectorAll('.assistiveText, .slds-assistive-text')) {
        const t = (hidden.innerText || hidden.textContent || '').replace(/\s+/g, ' ').trim();
        if (t && norm(t) !== want) text = text.replace(t, '').replace(/\s+/g, ' ').trim();
      }
      const at = text.toLowerCase().indexOf(lab.textContent.trim().toLowerCase());
      const rest = (at >= 0 ? text.slice(at + lab.textContent.trim().length) : text)
        .replace(/^\s*(Help|Edit [^\n]*)\s*/i, '')
        .trim();
      // A form (new, edit): the box's own value — a chosen lookup record shows in a read-only box
      const control = [...box.querySelectorAll('input:not([type="hidden"]), textarea, button[role="combobox"]')].find(
        visible
      );
      if (control)
        return control.type === 'checkbox'
          ? String(control.checked)
          : control.tagName === 'BUTTON'
          ? control.getAttribute('data-value') || control.innerText.trim()
          : control.value;
      return rest.replace(new RegExp(`\\s*Edit ${lab.textContent.trim()}\\s*$`, 'i'), '').trim();
    }
    return null;
  }

  /** Setup's classic pages: a label cell, then its value (a tick shows as a picture: Checked / Not Checked). */
  function classicValue(want) {
    const cell = deepAll('td.labelCol, th.labelCol, td.requiredLabel').find(
      (c) => visible(c) && norm(c.innerText.replace(/:\s*$/, '')) === want
    );
    if (!cell) return null;
    const value = cell.nextElementSibling;
    if (!value) return null;
    const tick = value.querySelector('img.checkImg, img[title="Checked"], img[title="Not Checked"]');
    if (tick) return tick.getAttribute('title') || tick.getAttribute('alt') || '';
    const box = value.querySelector('input[type="checkbox"]');
    if (box) return box.checked ? 'Checked' : 'Not Checked';
    return value.innerText.replace(/\s+/g, ' ').trim();
  }

  // ---------- Setup is read-only: NomadQA checks it, it never changes it ----------
  // Setup, and your own settings (from the user icon: /lightning/settings/…, classic My Settings)
  const inSetup = () =>
    /salesforce-setup\.com$/.test(location.host) ||
    /^\/(lightning\/setup|setup|lightning\/settings|_ui\/core\/userprofile|_ui\/system\/user)\//.test(
      location.pathname
    ) ||
    /setupid=PersonalSetup|setupid=PersonalInfo/i.test(location.search);
  const CHANGES =
    /^(save|quick save|delete|del|remove|new|clone|edit|activate|deactivate|assign|unassign|enable|disable|reset|unlock|freeze|unfreeze|deploy|submit|confirm|ok|add|create|import|upload|login|log in|grant|revoke|change|update|install|uninstall|upgrade|execute|schedule|send|merge|transfer|mass |set up|setup |manage assignments|edit assignments)\b/i;
  const changes = (name) => CHANGES.test(String(name ?? '').trim());
  function readOnly(what) {
    throw new Error(
      `Setup and personal settings are read-only for NomadQA: ${what} would change them, so it is not done. Steps there open pages, search and check.`
    );
  }
  /** Where the page is: the address of the tab and of Setup's frame (a click inside the frame changes only that). */
  const where = () => [location.href, ...frameDocs().map((d) => d.location?.href ?? '')].join(' | ');
  /** After a click or a search: when the page (or Setup's frame) goes elsewhere, wait for it to be drawn. */
  async function settleAfter(before, timeout) {
    for (let i = 0; i < 15 && where() === before; i++) await sleep(100);
    if (where() === before) return;
    if (location.href !== before.split(' | ')[0]) await ready(timeout);
    await until(
      () => (frameDocs().every((d) => d.readyState === 'complete') ? true : null),
      timeout,
      'the page to load'
    );
  }

  const toasts = () =>
    deepAll('.toastMessage, .forceToastMessage, [role="alert"], .slds-notify__content')
      .filter(visible)
      .map((t) => t.innerText.replace(/\s+/g, ' ').trim());
  const pageText = () => {
    const parts = [document.body?.innerText ?? '', ...frameDocs().map((d) => d.body?.innerText ?? '')];
    for (const el of deepAll('*'))
      if (el.shadowRoot && el.id !== 'nomadqa-host') parts.push(el.shadowRoot.textContent ?? '');
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
  /** A failed check: what it wanted, and what the page shows now. */
  function expectedAndGot(kind, step, want, op, say) {
    const c = kind === 'count' ? count(step.what ?? 'buttons', step.within) : null;
    const p = kind === 'place' ? either(placeOf, step) : null;
    const v = kind === 'field' ? either(fieldValue, step) : null;
    switch (kind) {
      case 'toast':
        return { expected: `a message that ${say}`, got: toasts().join(' · ') || 'no message' };
      case 'field':
        return { expected: `${step.field} ${say}`, got: v === null ? 'the field is not on the page' : `“${v}”` };
      case 'title':
        return { expected: `the title ${say}`, got: `“${document.title}”` };
      case 'url':
        return { expected: `the address ${say}`, got: location.href };
      case 'button':
        return { expected: `the button or link “${want}” shown`, got: 'not on the page' };
      case 'no-button':
        return { expected: `no button or link “${want}”`, got: 'it is on the page' };
      case 'count':
        return {
          expected: `${step.what ?? 'buttons'} ${OPS[op === 'contains' ? 'is' : op] ?? op} ${want}`,
          got: c ? `${c.n}${c.names.length ? `: ${c.names.join(', ')}` : ''}` : `no “${step.within}” on the page`,
        };
      case 'place':
        return {
          expected: [
            step.section ? `section ${step.section}` : '',
            step.row ? `row ${step.row}` : '',
            step.col ? `column ${step.col}` : '',
          ]
            .filter(Boolean)
            .join(', '),
          got: p ? placeText(p) : 'the field is not on the page',
        };
      case 'no-text':
        return { expected: `“${want}” not shown`, got: 'it is on the page' };
      case 'element': {
        const el = byPath(step.css);
        return {
          expected: want ? `the element ${say}` : 'the element on the page',
          got: el ? `“${elText(el)}”` : `nothing at “${step.css}”`,
        };
      }
      default:
        return { expected: `“${want}” on the page`, got: 'not on the page' };
    }
  }

  async function run(step) {
    const t0 = Date.now();
    globalThis.__nomadqa.stepId = step.__id ?? '';
    const timeout = Number(step.timeout ?? 20000);
    stopped = false;
    try {
      switch (step.action) {
        case 'click': {
          const el = step.css
            ? await until(() => byPath(step.css), timeout, `the element at “${step.css}”`)
            : await until(() => findClickable(step.label, step), timeout, `“${step.label}”`);
          if (inSetup() && ((step.label && changes(step.label)) || changes(nameOf(el))))
            readOnly(`clicking “${step.label || nameOf(el)}”`);
          const before = where();
          if (step.type || step.choose) {
            await clickThen(el, step, timeout);
            await settleAfter(before, timeout);
            break;
          }
          press(el);
          // A click that goes to another page: wait for it, so the next step does not find the old one
          await settleAfter(before, timeout);
          break;
        }
        case 'fill':
        case 'pick':
        case 'lookup':
        case 'check': {
          if (step.css && (step.action === 'fill' || step.action === 'check')) {
            const box = await until(() => boxAt(byPath(step.css)), timeout, `a box at “${step.css}”`);
            if (inSetup()) readOnly(`typing in “${step.css}”`);
            if (step.action === 'check' || box.type === 'checkbox') {
              const want = step.value === true || /^(true|yes|1|on|checked)$/i.test(String(step.value));
              if (box.checked !== want) press(box);
            } else setValue(box, step.value ?? '');
            break;
          }
          const f = await until(() => either(findField, step), timeout, `the field “${step.field}”`);
          // Some of Setup's ticks are saved at once
          if (inSetup() && (step.action === 'check' || f.kind === 'checkbox')) readOnly(`ticking “${step.field}”`);
          if (step.action === 'check' || f.kind === 'checkbox') {
            const want = step.value === true || /^(true|yes|1|on|checked)$/i.test(String(step.value));
            if (f.control.checked !== want) press(f.control);
          } else if (step.action === 'pick' || (f.kind === 'combobox' && step.action === 'fill'))
            await choose(f, step.value, timeout);
          else if (step.action === 'lookup' || f.kind === 'lookup') await lookup(f, step.value, timeout);
          else setValue(f.control, step.value ?? '');
          break;
        }
        case 'search':
          await search(step, timeout);
          break;
        case 'wait':
          if (step.text)
            await until(
              () => (pageText().toLowerCase().includes(String(step.text).toLowerCase()) ? true : null),
              timeout,
              `the text “${step.text}”`
            );
          else await pause(Number(step.ms ?? 1000));
          break;
        case 'expect': {
          const want = String(step.value ?? '');
          const op = step.op ?? 'contains';
          const kind = step.kind ?? 'text';
          const say = `${OPS[op] ?? op}${op === 'empty' || op === 'filled' ? '' : ` “${want}”`}`;
          try {
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
            } else if (kind === 'element')
              await until(
                () => {
                  const el = byPath(step.css);
                  if (!el) return null;
                  if (!want && op !== 'empty' && op !== 'filled') return true;
                  return compare(elText(el), want, op) ? true : null;
                },
                timeout,
                () => {
                  const el = byPath(step.css);
                  return el ? `the element ${say} (now “${elText(el)}”)` : `the element at “${step.css}”`;
                }
              );
            else if (kind === 'no-text')
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
          } catch (e) {
            // What was wanted, and what the page had when the time ran out (for the report)
            Object.assign(e, expectedAndGot(kind, step, want, op, say));
            throw e;
          }
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
          if (
            inSetup() &&
            (step.key ?? 'Enter') === 'Enter' &&
            !/search|find/i.test(
              `${document.activeElement?.getAttribute?.('placeholder') ?? ''} ${document.activeElement?.type ?? ''}`
            )
          )
            readOnly('pressing Enter (it may send a form)');
          (document.activeElement ?? document.body).dispatchEvent(
            new KeyboardEvent('keydown', { key: step.key ?? 'Enter', bubbles: true, composed: true })
          );
          break;
        default:
          throw new Error(`The page cannot run “${step.action}”.`);
      }
      return { ok: true, ms: Date.now() - t0 };
    } catch (e) {
      return {
        ok: false,
        ...(e.stopped || stopped ? { stopped: true } : {}),
        message: e.message,
        expected: e.expected,
        got: e.got,
        ms: Date.now() - t0,
        url: location.href,
        toasts: toasts().slice(0, 3),
      };
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
      // Setup's classic pages: a label cell and its value cell
      if (a.matches?.('td.labelCol, th.labelCol')) return a.innerText.replace(/:\s*$/, '').replace(/\s+/g, ' ').trim();
      if (a.matches?.('td.dataCol, td.data2Col') && a.previousElementSibling?.matches?.('.labelCol'))
        return a.previousElementSibling.innerText.replace(/:\s*$/, '').replace(/\s+/g, ' ').trim();
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
    version: 6,
    run,
    inSetup,
    changes,
    screenRect,
    frameDocs,
    count,
    placeOf,
    ready,
    compare,
    describe,
    findClickable,
    findField,
    byPath,
    pathsOf,
    stop: () => void (stopped = true),
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
