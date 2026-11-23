// The steps a test can have, the boxes each one asks for, and the sentence a person reads for it. One file for the
// Tests screen, the list on the Salesforce page (a content script: no import there, so this sets
// globalThis.__nomadqaWords) and the headless runner (steps.js imports it).
(() => {
  if (globalThis.__nomadqaWords?.version === 1) return;

  const ACTIONS = {
    open: {
      say: 'Open a page',
      fields: ['path'],
      also: 'path: /lightning/o/Account/list · or object + name · or record: {{key}}',
    },
    click: {
      say: 'Click',
      fields: ['label'],
      also: 'a button, link, tab or menu item, by what it says; within: a section title; type, choose: in the list it opens (App Launcher, a list view menu) type, then choose an item; css: or the element by its exact path (CSS, XPath, or DevTools’ Copy JS path)',
    },
    fill: { say: 'Type into a field', fields: ['field', 'value'], also: 'css: or the box by its exact path' },
    pick: { say: 'Choose in a list', fields: ['field', 'value'] },
    lookup: { say: 'Choose a record in a lookup', fields: ['field', 'value'] },
    check: { say: 'Tick or untick', fields: ['field', 'value'] },
    search: {
      say: 'Search and choose',
      fields: ['text'],
      also: 'box: where to type (empty: Salesforce’s search at the top; or a field, or a box by what it shows: Search this list…); choose: the result to click (empty: press Enter)',
    },
    wait: { say: 'Wait', fields: [], also: 'text: until it shows · or ms' },
    press: { say: 'Press a key', fields: ['key'] },
    expect: {
      say: 'Check',
      fields: ['kind', 'value'],
      also: 'kind: text · toast · field (+ field) · title · url · no-text · button · no-button · count (+ what, within) · place (+ field, section, row, col) · recordtype · layout · element (+ css: its exact path; value: its text, optional); op: contains · is · not · starts · empty · filled · more · less · matches',
    },
    login: {
      say: 'Log in (login page)',
      fields: ['login'],
      also: 'a login from Settings › Logins: its username and password stay in this browser, the test only names it',
    },
    loginas: {
      say: 'Log in as a user',
      fields: ['user'],
      also: 'Salesforce’s Login-As (an admin, no password): the user’s username or name; back to you at the end',
    },
    remember: { say: 'Remember a value', fields: ['field', 'as'], also: 'a field on the page, used later as {{as}}' },
    shot: { say: 'Take a screenshot', fields: [] },
    data: {
      say: 'Make test data',
      fields: ['recipe'],
      also: 'a Test data recipe; its records are {{a-1}}, {{c-2.Email}}…',
    },
    query: {
      say: 'Find records (SOQL)',
      fields: ['soql'],
      also: 'count: how many rows it must find; save: a name for the first row — {{name}} its Id, {{name.Field}} a value',
    },
    group: {
      say: 'Group of steps',
      fields: ['name'],
      also: 'steps: [step, …] run one after the other as one step (the first that fails stops the group)',
    },
  };

  const KINDS = [
    'text',
    'toast',
    'field',
    'title',
    'url',
    'no-text',
    'button',
    'no-button',
    'count',
    'place',
    'recordtype',
    'layout',
    'element',
  ];
  /** What a count check counts. */
  const COUNT_WHAT = ['buttons', 'tabs', 'fields', 'sections', 'related lists', 'rows'];
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
  const noValue = (s) => s.op === 'empty' || s.op === 'filled';

  const KIND_LABELS = {
    text: 'Text on the page',
    toast: 'A message (toast)',
    field: 'A field',
    title: 'The page title',
    url: 'The address',
    'no-text': 'Text is NOT shown',
    button: 'A button or link is shown',
    'no-button': 'A button or link is NOT shown',
    count: 'How many (buttons, tabs, fields…)',
    place: 'Where a field is (section, row, column)',
    recordtype: 'The record type',
    layout: 'The page layout (of who is logged in)',
    element: 'An element, by its exact path',
  };
  /** The box for an element's exact path: what DevTools copies (right-click the element › Copy). */
  const PATH_BOX = [
    'css',
    'Or its exact path (optional)',
    'DevTools › Copy selector, XPath or JS path',
    { wide: true },
  ];
  const FIELD_HINT = 'label or API name: Industry, Account.Industry';

  // What each step asks for: [key, label, placeholder, { options, wide, when, placeholder }]. options and when take
  // the step; options also takes { logins: [{ name, username }] } (Settings › Logins).
  const FIELDS = {
    open: [
      // One way to open: only the one in use shows (all of them on a new step)
      ['path', 'Page', '/lightning/o/Account/list', { wide: true, when: (s) => s.path || !(s.record || s.object) }],
      ['record', 'or a record', '{{found}} or an Id', { when: (s) => s.record || !(s.path || s.object) }],
      ['object', 'or an object', 'Account', { when: (s) => s.object || !(s.path || s.record) }],
      ['name', '… by its name', 'Acme', { when: (s) => s.object || !(s.path || s.record) }],
    ],
    click: [
      ['label', 'What it says', 'Save'],
      ['within', 'In (optional)', 'a section or dialog title'],
      ['type', 'Then type (optional)', 'in the list it opens'],
      ['choose', 'Then choose (optional)', 'an item of that list'],
      PATH_BOX,
    ],
    fill: [['field', 'Field', 'Last Name or LastName'], ['value', 'Value', 'Smith or {{found.Name}}'], PATH_BOX],
    pick: [
      ['field', 'Field', 'Stage or StageName'],
      ['value', 'Value', 'Closed Won'],
    ],
    lookup: [
      ['field', 'Field', 'Account Name or AccountId'],
      ['value', 'Record name', 'Acme'],
    ],
    search: [
      ['text', 'Type', 'Mia Brown'],
      ['box', 'In (optional)', 'empty = Salesforce search at the top'],
      ['choose', 'Then choose (optional)', 'empty: press Enter'],
    ],
    check: [
      ['field', 'Field', 'Active or Active__c'],
      [
        'value',
        'Ticked',
        '',
        {
          options: [
            ['true', 'Ticked'],
            ['false', 'Not ticked'],
          ],
        },
      ],
    ],
    wait: [
      ['text', 'Until this text shows', 'Saved'],
      ['ms', 'or milliseconds', '1000'],
    ],
    press: [['key', 'Key', 'Enter, Escape, Tab…']],
    expect: [
      ['kind', 'What to check', '', { options: KINDS.map((k) => [k, KIND_LABELS[k]]) }],
      ['field', 'Field', FIELD_HINT, { when: (s) => s.kind === 'field' || s.kind === 'place' }],
      [
        'css',
        'Its exact path',
        'DevTools › Copy selector, XPath or JS path',
        { wide: true, when: (s) => s.kind === 'element' },
      ],
      [
        'what',
        'Count',
        '',
        { options: COUNT_WHAT.map((w) => [w, w[0].toUpperCase() + w.slice(1)]), when: (s) => s.kind === 'count' },
      ],
      [
        'within',
        'In (optional)',
        'a section, card or related list title',
        { when: (s) => ['count', 'button', 'no-button'].includes(s.kind) },
      ],
      ['section', 'Section', 'its title, or 1, 2…', { when: (s) => s.kind === 'place' }],
      ['row', 'Row', '1', { when: (s) => s.kind === 'place' }],
      ['col', 'Column', '1 = left, 2 = right', { when: (s) => s.kind === 'place' }],
      [
        'op',
        'How',
        '',
        {
          options: (s) =>
            s.kind === 'count'
              ? [
                  ['is', 'is exactly'],
                  ['more', 'is more than'],
                  ['less', 'is less than'],
                  ['not', 'is not'],
                ]
              : Object.entries(OPS),
          when: (s) => ['field', 'toast', 'title', 'url', 'count', 'recordtype', 'layout', 'element'].includes(s.kind),
        },
      ],
      [
        'value',
        'Value',
        'Technology',
        {
          when: (s) => s.op !== 'empty' && s.op !== 'filled' && s.kind !== 'place',
          placeholder: (s) =>
            s.kind === 'count'
              ? '2'
              : s.kind === 'recordtype'
              ? 'Partner'
              : s.kind === 'layout'
              ? 'Contact Layout'
              : s.kind === 'element'
              ? 'its text (empty: only that it is there)'
              : 'Technology',
        },
      ],
    ],
    login: [
      [
        'login',
        'Login (Settings › Logins)',
        '',
        {
          options: (s, ctx = {}) => [
            ['', ctx.logins?.length ? 'Choose a login…' : 'None yet: add one in Settings'],
            ...(ctx.logins ?? []).filter((l) => l.name).map((l) => [l.name, `${l.name} · ${l.username}`]),
          ],
        },
      ],
    ],
    loginas: [['user', 'User (username or name)', 'ann.lee@acme.com or Ann Lee', { wide: true }]],
    remember: [
      ['field', 'Field on the page', 'Account Number or AccountNumber'],
      ['as', 'Remember as', 'number → use {{number}} later'],
    ],
    shot: [],
    query: [
      ['soql', 'Query', "SELECT Id, Name FROM Account WHERE Name LIKE 'Acme%' LIMIT 1", { wide: true }],
      ['count', 'Rows it must find', 'empty = at least one'],
      ['save', 'Save the first row as', 'found → {{found}}, {{found.Name}}'],
    ],
    data: [],
    group: [['name', 'Name of the group', 'e.g. Open the Sales app', { wide: true }]],
  };

  /** The boxes a step shows now (some only for one kind of check). */
  const fieldsFor = (s) => (FIELDS[s.action] ?? []).filter(([, , , o]) => !o?.when || o.when(s));

  /** A field as written, with its API name when the step knows it: Title (Contact.Title). */
  const fieldName = (s) => (s.api && s.api !== s.field ? `${s.field} (${s.api})` : s.field);
  const where = (s) => (s.within ? ` in “${s.within}”` : '');
  /** An exact path, short enough to read. */
  const pathText = (p) => {
    const t = String(p ?? '')
      .replace(/\s+/g, ' ')
      .trim();
    return `the element ${t.length > 48 ? `…${t.slice(-46)}` : t}`;
  };

  function sentence(s) {
    switch (s.action) {
      case 'open':
        return s.record ? `Open the record ${s.record}` : s.object ? `Open ${s.object} “${s.name}”` : `Open ${s.path}`;
      case 'click':
        return `Click ${s.css ? pathText(s.css) : `“${s.label}”`}${s.within ? ` in ${s.within}` : ''}${
          s.type ? `, type “${s.type}”` : ''
        }${s.choose ? `, choose “${s.choose}”` : ''}`;
      case 'fill':
        return `Type “${s.value}” in ${s.field ? fieldName(s) : pathText(s.css)}`;
      case 'pick':
        return `Choose “${s.value}” in ${fieldName(s)}`;
      case 'lookup':
        return `Choose the record “${s.value}” in ${fieldName(s)}`;
      case 'search': {
        const box = s.box ? `“${s.box}”` : 'Salesforce search (at the top)';
        return s.choose
          ? `Search “${s.text}” in ${box}, choose “${s.choose}”`
          : `Search “${s.text}” in ${box}, press Enter`;
      }
      case 'check':
        return `${s.value === false || s.value === 'false' ? 'Untick' : 'Tick'} ${fieldName(s)}`;
      case 'wait':
        return s.text ? `Wait for “${s.text}”` : `Wait ${s.ms ?? 1000} ms`;
      case 'press':
        return `Press ${s.key ?? 'Enter'}`;
      case 'expect': {
        const how = `${OPS[s.op ?? 'contains'] ?? s.op}${noValue(s) ? '' : ` “${s.value}”`}`;
        if (s.kind === 'count')
          return `Check the number of ${s.what ?? 'buttons'}${where(s)} ${
            OPS[!s.op || s.op === 'contains' ? 'is' : s.op] ?? s.op
          } ${s.value}`;
        if (s.kind === 'place')
          return `Check ${fieldName(s)} is ${[
            s.section ? (/^\d+$/.test(String(s.section)) ? `in section ${s.section}` : `in “${s.section}”`) : '',
            s.row ? `row ${s.row}` : '',
            s.col ? `column ${s.col}` : '',
          ]
            .filter(Boolean)
            .join(', ')}`;
        if (s.kind === 'recordtype') return `Check the record type ${how}`;
        if (s.kind === 'layout') return `Check the page layout ${how}`;
        if (s.kind === 'element')
          return s.value || noValue(s) ? `Check ${pathText(s.css)} ${how}` : `Check ${pathText(s.css)} is shown`;
        return s.kind === 'field'
          ? `Check ${fieldName(s)} ${how}`
          : s.kind === 'toast'
          ? `Check a message ${how}`
          : s.kind === 'no-text'
          ? `Check “${s.value}” is not shown`
          : s.kind === 'button'
          ? `Check the button or link “${s.value}” is shown${where(s)}`
          : s.kind === 'no-button'
          ? `Check there is no button or link “${s.value}”${where(s)}`
          : s.kind === 'title' || s.kind === 'url'
          ? `Check the ${s.kind} ${how}`
          : `Check the page shows “${s.value}”`;
      }
      case 'remember':
        return `Remember ${fieldName(s)} as {{${s.as}}}`;
      case 'login':
        return `Log in on the login page as “${s.login}”`;
      case 'loginas':
        return `Log in as ${s.user} (Login-As)`;
      case 'shot':
        return 'Take a screenshot';
      case 'data':
        return `Make test data: ${s.recipe?.name ?? 'a recipe'}`;
      case 'query':
        return s.save
          ? `Find a record: “${s.soql}” → {{${s.save}}}`
          : `Check that “${s.soql}” finds ${s.count ?? 'at least one'} row(s)`;
      case 'group': {
        const n = Array.isArray(s.steps) ? s.steps.length : 0;
        return `${s.name || 'Group'} (${n} step${n === 1 ? '' : 's'})`;
      }
      default:
        return s.action;
    }
  }

  /** One line a person reads. */
  function stepText(s) {
    const text = sentence(s);
    return s.optional ? `${text} (optional)` : text;
  }

  globalThis.__nomadqaWords = {
    version: 1,
    ACTIONS,
    KINDS,
    COUNT_WHAT,
    OPS,
    KIND_LABELS,
    FIELDS,
    fieldsFor,
    stepText,
  };
})();
