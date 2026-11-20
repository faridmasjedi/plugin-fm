// A NomadQA test: steps by meaning, run against an org by a driver (a browser tab, or headless Chrome).
//
// test = { nomadqa: 'test', version: 1, name, cleanup?: true, steps: [step] }
// step = { action, ... } — see ACTIONS. Values may use {{key}} (a record made by a data step: its Id) or
// {{key.Field}} (one of its values).

import { makeFaker } from './fake.js';
import { generate, querySoqls, checkSoql } from './plan.js';
import { createRecords, deleteBatch } from './create.js';

export const ACTIONS = {
  open: {
    say: 'Open a page',
    fields: ['path'],
    also: 'path: /lightning/o/Account/list · or object + name · or record: {{key}}',
  },
  click: {
    say: 'Click',
    fields: ['label'],
    also: 'a button, link, tab or menu item, by what it says; within: a section title',
  },
  fill: { say: 'Type into a field', fields: ['field', 'value'] },
  pick: { say: 'Choose in a list', fields: ['field', 'value'] },
  lookup: { say: 'Choose a record in a lookup', fields: ['field', 'value'] },
  check: { say: 'Tick or untick', fields: ['field', 'value'] },
  wait: { say: 'Wait', fields: [], also: 'text: until it shows · or ms' },
  press: { say: 'Press a key', fields: ['key'] },
  expect: {
    say: 'Check',
    fields: ['kind', 'value'],
    also: 'kind: text · toast · field (+ field) · title · url · no-text',
  },
  data: {
    say: 'Make test data',
    fields: ['recipe'],
    also: 'a Test data recipe; its records are {{a-1}}, {{c-2.Email}}…',
  },
  query: { say: 'Check records (SOQL)', fields: ['soql'], also: 'count: how many rows it must find' },
};

/** One line a person reads. */
export function stepText(s) {
  switch (s.action) {
    case 'open':
      return s.record ? `Open the record ${s.record}` : s.object ? `Open ${s.object} “${s.name}”` : `Open ${s.path}`;
    case 'click':
      return `Click “${s.label}”${s.within ? ` in ${s.within}` : ''}`;
    case 'fill':
      return `Type “${s.value}” in ${s.field}`;
    case 'pick':
      return `Choose “${s.value}” in ${s.field}`;
    case 'lookup':
      return `Choose the record “${s.value}” in ${s.field}`;
    case 'check':
      return `${s.value === false || s.value === 'false' ? 'Untick' : 'Tick'} ${s.field}`;
    case 'wait':
      return s.text ? `Wait for “${s.text}”` : `Wait ${s.ms ?? 1000} ms`;
    case 'press':
      return `Press ${s.key ?? 'Enter'}`;
    case 'expect':
      return s.kind === 'field'
        ? `Check ${s.field} is “${s.value}”`
        : s.kind === 'toast'
        ? `Check the message “${s.value}”`
        : s.kind === 'no-text'
        ? `Check “${s.value}” is not shown`
        : `Check the ${s.kind ?? 'text'} “${s.value}”`;
    case 'data':
      return `Make test data: ${s.recipe?.name ?? 'a recipe'}`;
    case 'query':
      return `Check that “${s.soql}” finds ${s.count ?? 'at least one'} row(s)`;
    default:
      return s.action;
  }
}

/** What is wrong with a step ('' when nothing). */
export function problem(s) {
  if (!s || typeof s !== 'object') return 'not a step';
  const a = ACTIONS[s.action];
  if (!a) return `unknown action “${s.action}”`;
  if (s.action === 'open' && !s.path && !s.record && !(s.object && s.name))
    return 'needs a path, a record, or an object and a name';
  if (s.action === 'expect' && !['text', 'toast', 'field', 'title', 'url', 'no-text'].includes(s.kind ?? 'text'))
    return `unknown check “${s.kind}”`;
  if (s.action === 'expect' && s.kind === 'field' && !s.field) return 'needs the field';
  if (s.action === 'data' && !Array.isArray(s.recipe?.nodes)) return 'needs a recipe';
  if (s.action === 'query') {
    try {
      checkSoql(String(s.soql ?? '').replace(/^SELECT\s+COUNT\(\)/i, 'SELECT Id'));
    } catch {
      return 'needs a SELECT query';
    }
  }
  if (s.action === 'open') return '';
  for (const f of a.fields)
    if (s[f] === undefined || s[f] === '') if (!(s.action === 'expect' && f === 'kind')) return `needs ${f}`;
  return '';
}

/** {{key}} and {{key.Field}} replaced by what a data step made. */
export function withValues(step, vars) {
  const sub = (v) =>
    typeof v === 'string'
      ? v.replace(/\{\{\s*([\w-]+)(?:\.(\w+))?\s*\}\}/g, (all, key, field) => {
          const r = vars[key];
          if (!r) return all;
          return field ? String(r.values?.[field] ?? '') : r.id;
        })
      : v;
  return Object.fromEntries(Object.entries(step).map(([k, v]) => [k, sub(v)]));
}

/**
 * Runs a test. `driver` = { open(url), step(step) → {ok, message}, shot?() → data URL } drives the browser; `sf` is the
 * org's API client (open by name, data, query). `onStep(i, result)` reports as it goes. Data made by the test is
 * deleted at the end unless test.cleanup === false.
 */
export async function runTest(test, { driver, sf, onStep = () => {}, describes = {} }) {
  const vars = {};
  const batches = [];
  const results = [];
  const t0 = Date.now();
  let failed = false;
  for (let i = 0; i < test.steps.length; i++) {
    const raw = test.steps[i];
    if (failed) {
      results.push({ ok: null, message: 'not run' });
      onStep(i, results[i]);
      continue;
    }
    const s = withValues(raw, vars);
    const started = Date.now();
    let r;
    try {
      const bad = problem(s);
      if (bad) throw new Error(bad);
      if (s.action === 'open') {
        let path = s.path;
        if (s.record) path = `/lightning/r/${s.record}/view`;
        else if (s.object && s.name) {
          const d = describes[s.object] ?? (describes[s.object] = await sf.describe(s.object));
          const nameField = d.fields.find((f) => f.nameField)?.name ?? 'Name';
          const rows = await sf.query(
            `SELECT Id FROM ${s.object} WHERE ${nameField} = '${String(s.name)
              .replace(/\\/g, '\\\\')
              .replace(/'/g, "\\'")}' ORDER BY CreatedDate DESC LIMIT 1`
          );
          if (!rows.length) throw new Error(`No ${s.object} named “${s.name}”.`);
          path = `/lightning/r/${s.object}/${rows[0].Id}/view`;
        }
        await driver.open(`https://${sf.host}${path.startsWith('/') ? path : `/${path}`}`);
        r = { ok: true };
      } else if (s.action === 'data') {
        const recipe = s.recipe;
        for (const n of recipe.nodes) if (!describes[n.object]) describes[n.object] = await sf.describe(n.object);
        const lookups = {};
        for (const soql of querySoqls(recipe)) lookups[soql] = (await sf.query(soql, { max: 2000 })).map((x) => x.Id);
        const records = generate(recipe, describes, makeFaker(recipe.seed ?? Date.now() % 100000), { lookups });
        const made = await createRecords(sf, records);
        if (made.failed.length) throw new Error(`${made.failed.length} record(s) not made: ${made.failed[0].message}`);
        const order = [];
        for (const rec of records) if (!order.includes(rec.object)) order.push(rec.object);
        batches.push({ order, ids: made.ids });
        // Ids come back per object in creation order: map them by object
        const byObject = {};
        for (const rec of records) (byObject[rec.object] ??= []).push(rec);
        for (const [object, list] of Object.entries(byObject))
          list.forEach((rec, i2) => (vars[rec.key] = { id: made.ids[object][i2], values: rec.values }));
        r = { ok: true, message: `${made.created} record(s) made` };
      } else if (s.action === 'query') {
        const soql = String(s.soql).trim();
        const res = await sf.rest('GET', `/query?q=${encodeURIComponent(soql)}`);
        const n = res.totalSize ?? 0;
        const want = s.count === undefined || s.count === '' ? null : Number(s.count);
        if (want === null ? n < 1 : n !== want)
          throw new Error(`Found ${n} row(s), ${want === null ? 'at least 1' : want} wanted.`);
        r = { ok: true, message: `${n} row(s)` };
      } else r = await driver.step(s);
    } catch (e) {
      r = { ok: false, message: e.message };
    }
    r = { ...r, ms: r.ms ?? Date.now() - started };
    if (!r.ok) {
      failed = true;
      if (driver.shot) r.shot = await driver.shot().catch(() => undefined);
    }
    results.push(r);
    onStep(i, r);
  }
  let cleaned = 0;
  if (test.cleanup !== false)
    for (const b of batches.reverse()) {
      const d = await deleteBatch(sf, b).catch(() => ({ deleted: 0 }));
      cleaned += d.deleted;
    }
  return { ok: !failed, results, ms: Date.now() - t0, cleaned };
}

/** A JUnit report (CI systems read it). */
export function junit(test, run) {
  const x = (s) =>
    String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const cases = test.steps
    .map((s, i) => {
      const r = run.results[i] ?? {};
      const body = r.ok === false ? `<failure message="${x(r.message)}"/>` : r.ok === null ? '<skipped/>' : '';
      return `    <testcase name="${x(`${i + 1}. ${stepText(s)}`)}" time="${((r.ms ?? 0) / 1000).toFixed(
        2
      )}">${body}</testcase>`;
    })
    .join('\n');
  const failures = run.results.filter((r) => r.ok === false).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${x(test.name)}" tests="${
    test.steps.length
  }" failures="${failures}" time="${(run.ms / 1000).toFixed(2)}">\n${cases}\n</testsuite>\n`;
}
