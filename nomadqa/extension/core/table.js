// Tables as in NomadSF: Filters (Matches / Is empty / Is not empty, numbered, with filter logic), Columns, Copy, CSV,
// JSON, sorting by a heading, and boxes per group that open and close. Its state survives the page being drawn again.
import { h, download } from './ui.js';
import { parseFilterLogic } from './filterLogic.js';

const states = new Map();
const text = (v) =>
  v === null || v === undefined ? '' : typeof v === 'object' ? v.$ref ?? JSON.stringify(v) : String(v);
const blank = (v) => text(v).trim() === '';

/** =exact, !not, >n, <n, else contains (as in NomadSF). */
export function matches(value, filter) {
  const v = text(value).toLowerCase();
  const f = String(filter).toLowerCase();
  if (f.startsWith('=')) return v === f.slice(1);
  if (f.startsWith('!')) return !v.includes(f.slice(1));
  if (/^[<>]/.test(f) && !Number.isNaN(parseFloat(f.slice(1))))
    return f[0] === '<' ? parseFloat(v) < parseFloat(f.slice(1)) : parseFloat(v) > parseFloat(f.slice(1));
  return v.includes(f);
}

const hiddenKey = (cols) => `nomadqa.cols:${cols.join(',')}`;
function readHidden(cols) {
  try {
    return new Set(JSON.parse(localStorage.getItem(hiddenKey(cols)) ?? '[]'));
  } catch {
    return new Set();
  }
}

/**
 * A table. `columns`: [key] or [[key, label]]. `cell(key, row)` may return a Node to draw instead of the value;
 * `value(key, row)` gives what filters, sorting and exports use (default: row[key]).
 */
export function dataTable({ name, columns, rows, cell, value, groupBy, note, maxShown = 300 }) {
  const cols = columns.map((c) => (Array.isArray(c) ? c : [c, c]));
  const keys = cols.map(([k]) => k);
  const labelOf = Object.fromEntries(cols);
  const st =
    states.get(name) ??
    (states.set(name, {
      conditions: [],
      logic: '',
      panel: null,
      sort: null,
      open: new Set(),
      hidden: readHidden(keys),
    }),
    states.get(name));
  const val = (k, r) => (value ? value(k, r) : r[k]);
  const root = h('div', { class: 'dt' });

  const visibleCols = () => {
    const shown = keys.filter((k) => !st.hidden.has(k));
    return shown.length ? shown : keys;
  };
  const isOn = (c) => (c.op ?? 'has') !== 'has' || c.value !== '';
  const filtered = () => {
    let out = rows;
    const conds = st.conditions;
    if (conds.some(isOn)) {
      let logic;
      try {
        logic = parseFilterLogic(st.logic, conds.length);
      } catch {
        logic = (r) => r.every(Boolean);
      }
      const test = (c, r) => {
        const op = c.op ?? 'has';
        const vals = c.column ? [val(c.column, r)] : keys.map((k) => val(k, r));
        if (op === 'empty') return c.column ? blank(vals[0]) : vals.some(blank);
        if (op === 'filled') return c.column ? !blank(vals[0]) : vals.every((v) => !blank(v));
        return vals.some((v) => matches(v, c.value));
      };
      out = out.filter((r) => logic(conds.map((c) => !isOn(c) || test(c, r))));
    }
    if (st.sort || groupBy)
      out = [...out].sort((a, b) => {
        if (groupBy) {
          const g = text(val(groupBy, a)).localeCompare(text(val(groupBy, b)));
          if (g) return g;
        }
        if (!st.sort) return 0;
        const x = val(st.sort.col, a);
        const y = val(st.sort.col, b);
        const nx = Number(x);
        const ny = Number(y);
        const cmp =
          text(x) !== '' && text(y) !== '' && !Number.isNaN(nx) && !Number.isNaN(ny)
            ? nx - ny
            : text(x).localeCompare(text(y));
        return cmp * st.sort.dir;
      });
    return out;
  };

  const exportRows = () => {
    const vc = visibleCols();
    return filtered().map((r) => Object.fromEntries(vc.map((k) => [labelOf[k], text(val(k, r))])));
  };
  const csv = () => {
    const vc = visibleCols();
    const q = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    return (
      [
        vc.map((k) => q(labelOf[k])).join(','),
        ...filtered().map((r) => vc.map((k) => q(text(val(k, r)))).join(',')),
      ].join('\n') + '\n'
    );
  };
  const tsv = () => {
    const vc = visibleCols();
    return [
      vc.map((k) => labelOf[k]).join('\t'),
      ...filtered().map((r) => vc.map((k) => text(val(k, r)).replace(/[\t\n]/g, ' ')).join('\t')),
    ].join('\n');
  };

  function rowEl(r, vc) {
    return h(
      'tr',
      {},
      vc.map((k) => {
        const custom = cell?.(k, r);
        const t = text(val(k, r));
        return h(
          'td',
          { title: custom ? undefined : t.length > 40 ? t : undefined, class: custom ? 'cell' : undefined },
          custom ?? (t.length > 300 ? `${t.slice(0, 300)}…` : t)
        );
      })
    );
  }
  function head(vc) {
    return h(
      'thead',
      {},
      h(
        'tr',
        {},
        vc.map((k) =>
          h(
            'th',
            {
              class: 'sortable',
              onclick: () => {
                st.sort = st.sort?.col === k ? { col: k, dir: st.sort.dir === 1 ? -1 : 1 } : { col: k, dir: 1 };
                paint();
              },
            },
            labelOf[k],
            st.sort?.col === k ? (st.sort.dir === 1 ? ' ▲' : ' ▼') : ''
          )
        )
      )
    );
  }

  function body() {
    const list = filtered();
    const vc = visibleCols();
    if (!groupBy)
      return h(
        'div',
        { class: 'table-box' },
        h(
          'table',
          { class: 'records' },
          head(vc),
          h(
            'tbody',
            {},
            list.slice(0, maxShown).map((r) => rowEl(r, vc))
          )
        )
      );
    const groups = new Map();
    for (const r of list) {
      const g = text(val(groupBy, r));
      groups.set(g, [...(groups.get(g) ?? []), r]);
    }
    const filtering = st.conditions.some(isOn);
    const isOpen = (g) => filtering || groups.size <= 1 !== st.open.has(g);
    const shownCols = vc.filter((k) => k !== groupBy);
    return h(
      'div',
      { class: 'dt-groups' },
      [...groups].map(([g, items]) => {
        const open = isOpen(g);
        return h(
          'div',
          { class: `dt-group${open ? ' open' : ''}` },
          h(
            'button',
            {
              class: 'dt-group-head',
              'aria-expanded': String(open),
              onclick: () => (st.open.has(g) ? st.open.delete(g) : st.open.add(g), paint()),
            },
            h('span', { class: 'caret' }, open ? '▾' : '▸'),
            h('b', {}, g || '—'),
            h('span', { class: 'pill' }, items.length)
          ),
          open
            ? h(
                'div',
                { class: 'table-box' },
                h(
                  'table',
                  { class: 'records' },
                  head(shownCols),
                  h(
                    'tbody',
                    {},
                    items.slice(0, maxShown).map((r) => rowEl(r, shownCols))
                  )
                )
              )
            : null,
          open && items.length > maxShown
            ? h(
                'p',
                { class: 'muted small', style: 'padding: 0 12px 8px' },
                `Showing ${maxShown} of ${items.length}: filter, or export for all.`
              )
            : null
        );
      })
    );
  }

  function filtersPanel() {
    if (!st.conditions.length) st.conditions.push({ column: '', op: 'has', value: '' });
    const opts = [['', 'Any column'], ...cols];
    const setC = (i, patch, redraw = true) => {
      Object.assign(st.conditions[i], patch);
      redraw ? paint() : paintRows();
    };
    let logicInput;
    return h(
      'aside',
      { class: 'dt-panel' },
      h(
        'div',
        { class: 'row' },
        h('b', { class: 'grow' }, 'Filters'),
        h('button', { class: 'link', onclick: () => ((st.conditions = []), (st.logic = ''), paint()) }, 'Clear')
      ),
      st.conditions.map((c, i) =>
        h(
          'div',
          { class: 'dt-condition' },
          h(
            'div',
            { class: 'row', style: 'flex-wrap: nowrap' },
            st.conditions.length > 1 ? h('span', { class: 'dt-n' }, i + 1) : null,
            h(
              'select',
              { 'aria-label': 'Column', onchange: (e) => setC(i, { column: e.target.value }) },
              opts.map(([k, l]) => h('option', { value: k, selected: k === c.column }, l))
            ),
            h(
              'button',
              {
                class: 'icon',
                'aria-label': 'Remove this filter',
                onclick: () => (st.conditions.splice(i, 1), (st.logic = ''), paint()),
              },
              '✕'
            )
          ),
          h(
            'div',
            { class: 'row', style: 'flex-wrap: nowrap' },
            h(
              'select',
              { 'aria-label': 'How', onchange: (e) => setC(i, { op: e.target.value }) },
              [
                ['has', 'Matches'],
                ['filled', 'Is not empty'],
                ['empty', 'Is empty'],
              ].map(([k, l]) => h('option', { value: k, selected: k === (c.op ?? 'has') }, l))
            ),
            (c.op ?? 'has') === 'has'
              ? h('input', {
                  value: c.value,
                  placeholder: c.column ? 'Value' : 'Text in any column',
                  oninput: (e) => setC(i, { value: e.target.value }, false),
                })
              : null
          )
        )
      ),
      h(
        'button',
        { onclick: () => (st.conditions.push({ column: '', op: 'has', value: '' }), paint()) },
        '+ Add a filter'
      ),
      st.conditions.length > 1
        ? h(
            'label',
            { class: 'dt-logic' },
            h('span', {}, 'Filter logic'),
            (logicInput = h('input', {
              value: st.logic,
              placeholder: st.conditions.map((_, i) => i + 1).join(' AND '),
              oninput: (e) => {
                st.logic = e.target.value;
                let bad = '';
                try {
                  parseFilterLogic(st.logic, st.conditions.length);
                } catch (err) {
                  bad = err.message;
                }
                logicInput.classList.toggle('bad', Boolean(bad));
                logicInput.title = bad;
                paintRows();
              },
            })),
            h('small', { class: 'muted' }, 'e.g. 1 OR 2 OR (3 AND 4) · NOT 2 · empty = all of them')
          )
        : null,
      h('p', { class: 'muted small' }, 'Matches: contains · =exact · !not · >10 · <5')
    );
  }

  function columnsPanel() {
    const save = () => {
      try {
        localStorage.setItem(hiddenKey(keys), JSON.stringify([...st.hidden]));
      } catch {
        /* not kept */
      }
      paint();
    };
    return h(
      'aside',
      { class: 'dt-panel' },
      h(
        'div',
        { class: 'row' },
        h('b', { class: 'grow' }, 'Columns'),
        h('button', { class: 'link', onclick: () => ((st.hidden = new Set()), save()) }, 'Show all'),
        h('button', { class: 'link', onclick: () => ((st.hidden = new Set(keys.slice(1))), save()) }, 'None')
      ),
      h(
        'div',
        { class: 'dt-cols' },
        cols.map(([k, l]) =>
          h(
            'label',
            { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: !st.hidden.has(k),
              onchange: (e) => (e.target.checked ? st.hidden.delete(k) : st.hidden.add(k), save()),
            }),
            l
          )
        )
      ),
      h('p', { class: 'muted small' }, 'Remembered for this kind of table. Copy, CSV and JSON take the columns shown.')
    );
  }

  let countEl;
  let mainEl;
  function paintRows() {
    const list = filtered();
    countEl.textContent = `${list.length.toLocaleString()} of ${rows.length.toLocaleString()} rows`;
    mainEl.replaceChildren(body());
  }
  function paint() {
    const active = st.conditions.filter(isOn).length;
    const hiddenN = keys.length - visibleCols().length;
    countEl = h('span', { class: 'muted small' });
    mainEl = h('div', { class: 'dt-body' });
    const groups = groupBy ? new Set(filtered().map((r) => text(val(groupBy, r)))) : null;
    root.replaceChildren(
      h(
        'div',
        { class: 'dt-bar' },
        countEl,
        note ? h('span', { class: 'muted small' }, note) : null,
        h('span', { class: 'grow' }),
        h(
          'button',
          {
            class: st.panel === 'filters' || active ? 'on' : '',
            onclick: () => ((st.panel = st.panel === 'filters' ? null : 'filters'), paint()),
          },
          `⚲ Filters${active ? ` (${active})` : ''}`
        ),
        h(
          'button',
          {
            class: st.panel === 'columns' || hiddenN ? 'on' : '',
            onclick: () => ((st.panel = st.panel === 'columns' ? null : 'columns'), paint()),
          },
          `▥ Columns${hiddenN ? ` (${keys.length - hiddenN}/${keys.length})` : ''}`
        ),
        groups && groups.size > 1
          ? h(
              'button',
              { onclick: () => ((st.open = st.open.size ? new Set() : new Set(groups)), paint()) },
              st.open.size ? 'Close all' : 'Open all'
            )
          : null,
        h('button', { onclick: () => navigator.clipboard.writeText(tsv()) }, 'Copy'),
        h('button', { onclick: () => download(`${name}.csv`, `﻿${csv()}`, 'text/csv') }, 'CSV'),
        h(
          'button',
          { onclick: () => download(`${name}.json`, JSON.stringify(exportRows(), null, 2), 'application/json') },
          'JSON'
        )
      ),
      h(
        'div',
        { class: `dt-main${st.panel ? ' with-panel' : ''}` },
        mainEl,
        st.panel === 'filters' ? filtersPanel() : st.panel === 'columns' ? columnsPanel() : null
      )
    );
    paintRows();
  }
  paint();
  return root;
}
