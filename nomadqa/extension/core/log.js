// The Log, as in NomadSF: a bar at the bottom with the last message; open it for every message of this session,
// each with its time, the page it came from, how it went, and its details (Salesforce's own messages).
import { h } from './ui.js';

const entries = [];
let open = false;
let bar = null;

/** Adds a message; returns it so it can be finished later (done, problem). */
export function log(area, text, { status = 'done', detail } = {}) {
  const e = { at: new Date(), area, text, status, detail };
  entries.unshift(e);
  if (entries.length > 500) entries.pop();
  paint();
  return {
    done(more, d) {
      e.status = 'done';
      if (more) e.text = more;
      if (d !== undefined) e.detail = d;
      paint();
    },
    problem(message, d) {
      e.status = 'problem';
      e.text = `${e.text} — ${message}`;
      if (d !== undefined) e.detail = d;
      paint();
    },
    update(more) {
      e.text = more;
      paint();
    },
  };
}

const time = (d) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const mark = { working: '…', done: '✓', problem: '✕' };

function paint() {
  if (!bar) return;
  const last = entries[0];
  const problems = entries.filter((e) => e.status === 'problem').length;
  bar.replaceChildren(
    ...[
      h(
        'button',
        { class: 'log-head', 'aria-expanded': String(open), onclick: () => ((open = !open), paint()) },
        h('span', { class: 'caret' }, open ? '▾' : '▸'),
        h('b', {}, 'Log'),
        h('span', { class: 'pill' }, entries.length),
        problems ? h('span', { class: 'pill bad' }, `${problems} problem${problems > 1 ? 's' : ''}`) : null,
        last
          ? h('span', { class: `log-last ${last.status}` }, h('span', { class: 'area' }, last.area), ` ${last.text}`)
          : h('span', { class: 'muted' }, 'Nothing yet')
      ),
      open
        ? h(
            'div',
            { class: 'log-list' },
            entries.length
              ? entries.map((e) =>
                  h(
                    'div',
                    { class: `log-row ${e.status}` },
                    h('span', { class: 'when' }, time(e.at)),
                    h('span', { class: 'mark' }, mark[e.status] ?? ''),
                    h('span', { class: 'area' }, e.area),
                    h(
                      'span',
                      { class: 'what' },
                      e.text,
                      e.detail
                        ? h('pre', {}, typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail, null, 2))
                        : null
                    )
                  )
                )
              : h('p', { class: 'muted' }, 'Nothing yet.'),
            entries.length
              ? h('div', { class: 'row' }, h('button', { onclick: () => ((entries.length = 0), paint()) }, 'Clear'))
              : null
          )
        : null,
    ].filter(Boolean) // replaceChildren would write null as the text "null"
  );
}

/** Puts the bar on the page (once). */
export function mountLog() {
  bar = h('footer', { class: 'log', role: 'log' });
  document.body.append(bar);
  paint();
}
