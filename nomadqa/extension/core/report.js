// Reports for people (QAs): one HTML page for a run or a group, with the reason for every failure (the step, what
// was wanted, what the page had, its messages and a picture of it), and a short Markdown summary (GitHub's job
// page shows it). Used by the Tests screen and the headless runner alike.
import { stepText } from './steps.js';

const esc = (s) =>
  String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const secs = (ms) => `${((ms ?? 0) / 1000).toFixed(1)} s`;

/** The step that made a test fail: { i, step, result, inner? } (inner: the step of a group that failed). */
export function failureOf(test, run) {
  const i = (run.results ?? []).findIndex((r) => r?.ok === false && !r.optional);
  if (i < 0) return null;
  const step = test.steps?.[i] ?? { action: '?' };
  const result = run.results[i];
  const inner = step.action === 'group' && result.at >= 0 ? step.steps?.[result.at] : null;
  return { i, step, result, inner };
}

/** One line for a failure: "Step 3, Check Industry is “Energy”: Industry is “Energy” (now “Media”)". */
export function failureLine(test, run) {
  const f = failureOf(test, run);
  if (!f) return '';
  return `Step ${f.i + 1}, ${stepText(f.step)}: ${f.result.message ?? 'failed'}`;
}

function statusOf(r) {
  if (!r) return ['', '·', 'not run'];
  if (r.ok) return ['ok', '✓', 'passed'];
  if (r.ok === null) return ['skip', '·', 'not run'];
  return r.optional ? ['warn', '!', 'failed (optional)'] : ['bad', '✕', 'failed'];
}

function stepRows(steps, results, prefix = '') {
  return steps
    .map((s, i) => {
      const r = results?.[i];
      const [cls, mark, word] = statusOf(r);
      const sub =
        s.action === 'group' && Array.isArray(s.steps)
          ? stepRows(s.steps, r?.children ?? [], `${prefix}${i + 1}.`)
          : '';
      return `<tr class="${cls}"><td class="n">${prefix}${
        i + 1
      }</td><td class="m" title="${word}">${mark}</td><td>${esc(stepText(s))}${
        r && r.ok !== null && r.message ? `<div class="msg">${esc(r.message)}</div>` : ''
      }</td><td class="t">${r?.ms !== undefined && r.ok !== null ? secs(r.ms) : ''}</td></tr>${sub}`;
    })
    .join('');
}

function failureCard(test, run) {
  const f = failureOf(test, run);
  if (!f) return '';
  const r = f.result;
  const row = (k, v) => (v ? `<div class="k">${k}</div><div class="v">${v}</div>` : '');
  return `<div class="why"><div class="why-head">Why it failed</div><div class="grid">${row(
    'Step',
    `${f.i + 1}. ${esc(stepText(f.step))}${
      f.inner ? `<br><span class="muted">inside the group: ${r.at + 1}. ${esc(stepText(f.inner))}</span>` : ''
    }`
  )}${row('Reason', esc(r.message))}${row('Expected', esc(r.expected))}${row('Got', esc(r.got))}${row(
    'Salesforce said',
    (r.toasts ?? []).map(esc).join('<br>')
  )}${row('Page', r.url ? `<a href="${esc(r.url)}">${esc(r.url)}</a>` : '')}</div>${
    r.shot
      ? `<a href="${r.shot}" target="_blank"><img src="${r.shot}" alt="The page when step ${f.i + 1} failed"></a>`
      : ''
  }</div>`;
}

/**
 * An HTML report. items = [{ test, run }] (run = { ok, ms, results, cleaned? }); results may carry a `shot` (a data
 * URL) on a failed step. `title`, `org`, `at` (an ISO date) describe the run.
 */
export function htmlReport({ title, org = '', at = new Date().toISOString(), items }) {
  const passed = items.filter((x) => x.run.ok).length;
  const failedN = items.length - passed;
  const total = items.reduce((n, x) => n + (x.run.ms ?? 0), 0);
  const when = new Date(at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
  const tests = items
    .map(({ test, run }, k) => {
      const f = failureOf(test, run);
      return `<details class="test ${run.ok ? 'ok' : 'bad'}"${run.ok ? '' : ' open'} id="t${
        k + 1
      }"><summary><span class="badge ${run.ok ? 'ok' : 'bad'}">${run.ok ? 'Passed' : 'Failed'}</span><b>${esc(
        test.name
      )}</b>${
        test.group ? `<span class="pill">${esc(test.group)}</span>` : ''
      }<span class="grow"></span><span class="muted">${test.steps?.length ?? 0} steps · ${secs(
        run.ms
      )}</span></summary>${
        f ? failureCard(test, run) : ''
      }<table><thead><tr><th>#</th><th></th><th>Step</th><th>Time</th></tr></thead><tbody>${stepRows(
        test.steps ?? [],
        run.results
      )}</tbody></table>${
        run.cleaned ? `<p class="muted">${run.cleaned} test record(s) deleted after the test.</p>` : ''
      }</details>`;
    })
    .join('');
  const failedList = items
    .map((x, k) => ({ ...x, k }))
    .filter((x) => !x.run.ok)
    .map((x) => `<li><a href="#t${x.k + 1}">${esc(x.test.name)}</a> — ${esc(failureLine(x.test, x.run))}</li>`)
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · NomadQA report</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2430;--muted:#667085;--line:#e4e7ec;--ok:#12805c;--okbg:#e7f6ef;--bad:#c0362c;--badbg:#fdecea;--warn:#a15c00;--warnbg:#fff4e0}
@media (prefers-color-scheme: dark){:root{--bg:#14171c;--card:#1d2128;--ink:#e6e9ee;--muted:#9aa3b2;--line:#2e343e;--ok:#4cc38a;--okbg:#173527;--bad:#f0776c;--badbg:#3a1d1b;--warn:#f0b35a;--warnbg:#3a2d17}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 48px}h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted)}
.sum{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:120px}
.tile b{display:block;font-size:20px}.tile.ok b{color:var(--ok)}.tile.bad b{color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px;margin:12px 0}.card ul{margin:6px 0 0;padding-left:18px}
.test{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:10px 0;overflow:hidden}.test.bad{border-color:var(--bad)}
summary{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;list-style:none}summary::-webkit-details-marker{display:none}
.grow{flex:1}.badge{font-size:12px;font-weight:600;border-radius:999px;padding:2px 9px}.badge.ok{background:var(--okbg);color:var(--ok)}.badge.bad{background:var(--badbg);color:var(--bad)}
.pill{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted)}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:6px 14px;border-top:1px solid var(--line);vertical-align:top}th{font-size:12px;color:var(--muted);font-weight:600}
td.n{width:48px;color:var(--muted)}td.m{width:24px;font-weight:700}td.t{width:70px;color:var(--muted);white-space:nowrap}
tr.ok td.m{color:var(--ok)}tr.bad td.m{color:var(--bad)}tr.bad{background:var(--badbg)}tr.warn td.m{color:var(--warn)}tr.skip{color:var(--muted)}
.msg{font-size:12px;color:var(--muted);margin-top:2px}tr.bad .msg{color:var(--bad)}
.why{margin:0 14px 12px;border:1px solid var(--bad);border-radius:8px;padding:10px 12px;background:var(--badbg)}.why-head{font-weight:700;color:var(--bad);margin-bottom:6px}
.grid{display:grid;grid-template-columns:130px 1fr;gap:4px 12px}.k{color:var(--muted)}.v{word-break:break-word}
.why img{display:block;max-width:100%;margin-top:10px;border:1px solid var(--line);border-radius:6px}
a{color:inherit}@media (max-width:600px){.grid{grid-template-columns:1fr}.k{margin-top:6px}td.t{display:none}}
</style></head><body><main>
<h1>${esc(title)}</h1><div class="muted">${esc(org)}${org ? ' · ' : ''}${esc(when)} · NomadQA</div>
<div class="sum"><div class="tile"><span class="muted">Tests</span><b>${
    items.length
  }</b></div><div class="tile ok"><span class="muted">Passed</span><b>${passed}</b></div><div class="tile ${
    failedN ? 'bad' : ''
  }"><span class="muted">Failed</span><b>${failedN}</b></div><div class="tile"><span class="muted">Time</span><b>${secs(
    total
  )}</b></div></div>
${failedList ? `<div class="card"><b>Failed</b><ul>${failedList}</ul></div>` : ''}
${tests}
</main></body></html>
`;
}

/** A short Markdown summary (GitHub shows it on the job's page): a table of tests, and why each failure failed. */
export function markdownSummary({ title, org = '', items }) {
  const passed = items.filter((x) => x.run.ok).length;
  const cell = (s) =>
    String(s ?? '')
      .replace(/\|/g, '\\|')
      .replace(/\n/g, ' ');
  const lines = [
    `## ${passed === items.length ? '✅' : '❌'} ${cell(title)}: ${passed} of ${items.length} passed`,
    org ? `Org: ${cell(org)}` : null,
    '',
    '| Test | Result | Time |',
    '| --- | --- | --- |',
    ...items.map(({ test, run }) => `| ${cell(test.name)} | ${run.ok ? '✅ passed' : '❌ failed'} | ${secs(run.ms)} |`),
  ];
  for (const { test, run } of items) {
    const f = failureOf(test, run);
    if (!f) continue;
    const r = f.result;
    lines.push(
      '',
      `### ❌ ${cell(test.name)}`,
      `- **Step ${f.i + 1}:** ${cell(stepText(f.step))}`,
      `- **Reason:** ${cell(r.message)}`,
      r.expected ? `- **Expected:** ${cell(r.expected)}` : null,
      r.got ? `- **Got:** ${cell(r.got)}` : null,
      r.toasts?.length ? `- **Salesforce said:** ${cell(r.toasts.join(' · '))}` : null,
      r.url ? `- **Page:** ${cell(r.url)}` : null
    );
  }
  return `${lines.filter((l) => l !== null).join('\n')}\n`;
}
