// A NomadQA test: steps by meaning, run against an org by a driver (a browser tab, or headless Chrome).
//
// test = { nomadqa: 'test', version: 1, name, cleanup?: true, steps: [step] }
// step = { action, ... } — see ACTIONS. Values may use {{key}} (a record made by a data step: its Id) or
// {{key.Field}} (one of its values).

import { makeFaker } from './fake.js';
import { generate, querySoqls } from './plan.js';
import { createRecords, deleteBatch } from './create.js';

import './words.js';

const W = globalThis.__nomadqaWords;
export const { ACTIONS, KINDS, COUNT_WHAT, OPS, KIND_LABELS, FIELDS, fieldsFor, stepText } = W;
const noValue = (s) => s.op === 'empty' || s.op === 'filled';

/** A query that only reads: SELECT … FROM …, one statement. */
export const isSelect = (soql) =>
  /^\s*SELECT\s[\s\S]+?\sFROM\s+\w+/i.test(String(soql ?? '')) && !/;/.test(String(soql));

/** What is wrong with a step ('' when nothing). */
export function problem(s) {
  if (!s || typeof s !== 'object') return 'not a step';
  const a = ACTIONS[s.action];
  if (!a) return `unknown action “${s.action}”`;
  if (s.action === 'group') {
    if (!Array.isArray(s.steps) || !s.steps.length) return 'the group has no steps';
    for (const [j, c] of s.steps.entries()) {
      const bad = problem(c);
      if (bad) return `step ${j + 1} of the group: ${bad}`;
    }
    return '';
  }
  if (s.action === 'open' && !s.path && !s.record && !(s.object && s.name))
    return 'needs a path, a record, or an object and a name';
  if (s.action === 'expect' && !KINDS.includes(s.kind ?? 'text')) return `unknown check “${s.kind}”`;
  if (s.action === 'expect' && s.op && !OPS[s.op]) return `unknown way to compare “${s.op}”`;
  if (s.action === 'expect' && s.kind === 'count')
    return s.value === undefined || s.value === '' || Number.isNaN(Number(s.value)) ? 'needs how many (a number)' : '';
  if (s.action === 'expect' && s.kind === 'place')
    return !s.field ? 'needs the field' : !(s.section || s.row || s.col) ? 'needs a section, a row or a column' : '';
  if (s.action === 'expect' && s.kind === 'element') return s.css ? '' : 'needs the element’s path';
  if (s.action === 'expect' && noValue(s)) return s.kind === 'field' && !s.field ? 'needs the field' : '';
  if (s.action === 'query' && s.save && !/^[\w-]+$/.test(s.save)) return 'the name to save as: letters, digits, - or _';
  if (s.action === 'expect' && s.kind === 'field' && !s.field) return 'needs the field';
  if (s.action === 'data' && !Array.isArray(s.recipe?.nodes)) return 'needs a recipe';
  if (s.action === 'query' && !isSelect(s.soql)) return 'needs a SELECT query (it only reads)';
  if (s.action === 'open') return '';
  for (const f of a.fields)
    if (s[f] === undefined || s[f] === '')
      if (!(s.action === 'expect' && f === 'kind') && !(s.css && (f === 'label' || f === 'field'))) return `needs ${f}`;
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

/** A failure that knows what was wanted and what the page had: the report shows both. */
function failed(message, expected, got) {
  return Object.assign(new Error(message), { expected, got });
}

const soqlText = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The value as a check wants it (text compared without case) — as the page engine compares. */
export function compare(actual, want, op = 'contains') {
  const a = String(actual ?? '').trim();
  const w = String(want ?? '').trim();
  const num = (v) => parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
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

/** The record a page shows, from its address: { object, id } (either may be empty). */
export function pageRecord(url) {
  const m = /\/lightning\/[ro]\/(\w+)\/(?:(\w{15,18})\/)?/.exec(String(url ?? ''));
  return { object: m?.[1] ?? '', id: m?.[2] && /^[a-zA-Z0-9]{15,18}$/.test(m[2]) && m[2] !== 'list' ? m[2] : '' };
}

/**
 * Runs a test's steps one at a time, keeping what they made ({{found}}, records of a data step, who is logged in).
 * `driver` = { open(url), load?(url), settle?(), url?(), step(step), shot?(), keepSession?(), restoreSession?() }
 * drives the browser; `sf` is the org's API client; `logins` = { name: { url, username, password } }.
 * run(step) → { ok, message, ms, optional?, shot? }; finish() deletes the test data (unless test.cleanup === false)
 * and logs back in as you; it returns how many records were deleted.
 */
export function stepper(test, { driver, sf, describes = {}, logins = {} }) {
  const vars = {};
  const batches = [];
  const who = { as: null, userId: '' };
  const describe = async (o) => describes[o] ?? (describes[o] = await sf.describe(o));
  const here = async () => (driver.url ? pageRecord(await driver.url()) : { object: '', id: '' });

  /** A field by its API name (Title, Contact.Title) also gets its label: the page shows labels. */
  async function withLabel(s) {
    if (!s.field || !/^\w+(\.\w+)?$/.test(s.field)) return s;
    const [o, n] = s.field.includes('.') ? s.field.split('.') : [(await here()).object, s.field];
    if (!o) return s;
    const d = await describe(o).catch(() => null);
    const f = d?.fields.find((x) => x.name.toLowerCase() === n.toLowerCase());
    if (!f) return s;
    // The page may show the word as typed (Name) rather than the field's label (Full Name): both are tried
    // …and the page's own marker of the field finds the label it shows ("Mobile" for MobilePhone)
    return { ...s, field: s.field.includes('.') ? f.label : s.field, fieldAlt: f.label, fieldApi: `${o}.${f.name}` };
  }

  async function userOf(text) {
    const rows = await sf.query(
      `SELECT Id, Name, Username, ProfileId FROM User WHERE IsActive = true AND (Username = ${soqlText(
        text
      )} OR Name = ${soqlText(text)}) LIMIT 2`
    );
    if (!rows.length) throw new Error(`No active user “${text}”.`);
    if (rows.length > 1) throw new Error(`Two users are called “${text}”: give the username.`);
    return rows[0];
  }
  const loggedOut = (url) =>
    /\?ec=30|\/secur\/(?!frontdoor)|login\.salesforce\.com|test\.salesforce\.com/.test(url ?? '');
  async function backToMe() {
    const was = who.as;
    who.as = null;
    who.userId = '';
    if (was === 'loginas') {
      // Logging out of a Login-As goes back to you; if it logged you out instead, your session is put back
      await (driver.load ?? driver.open)(`https://${sf.host}/secur/logout.jsp`).catch(() => {});
      if (driver.restoreSession && (!driver.url || loggedOut(await driver.url().catch(() => ''))))
        await driver.restoreSession().catch(() => {});
      else if (driver.forgetSession) driver.forgetSession();
    }
    if (was === 'login' && driver.restoreSession) await driver.restoreSession().catch(() => {});
  }

  async function layoutName(object, recordId) {
    const userId = who.userId || (await sf.facts()).userId;
    const [user] = await sf.query(`SELECT ProfileId FROM User WHERE Id = ${soqlText(userId)}`);
    let rt = '';
    try {
      rt = (await sf.query(`SELECT RecordTypeId FROM ${object} WHERE Id = ${soqlText(recordId)}`))[0]?.RecordTypeId;
    } catch {
      /* no record types on this object */
    }
    let table = object;
    if (/__c$/.test(object)) {
      const [ns, name] = object.replace(/__c$/, '').includes('__')
        ? object.replace(/__c$/, '').split('__')
        : ['', object.replace(/__c$/, '')];
      const t = await sf.rest(
        'GET',
        `/tooling/query?q=${encodeURIComponent(
          `SELECT Id FROM CustomObject WHERE DeveloperName = ${soqlText(name)}${
            ns ? ` AND NamespacePrefix = ${soqlText(ns)}` : ''
          }`
        )}`
      );
      table = t.records?.[0]?.Id ?? object;
    }
    const res = await sf.rest(
      'GET',
      `/tooling/query?q=${encodeURIComponent(
        `SELECT Layout.Name, RecordTypeId FROM ProfileLayout WHERE ProfileId = ${soqlText(
          user.ProfileId
        )} AND TableEnumOrId = ${soqlText(table)}`
      )}`
    );
    const rows = res.records ?? [];
    const master = (r) => !r.RecordTypeId || /^012000000000000/.test(r.RecordTypeId);
    const hit =
      rows.find((r) => rt && r.RecordTypeId?.slice(0, 15) === rt.slice(0, 15)) ?? rows.find(master) ?? rows[0];
    return hit?.Layout?.Name ?? '';
  }

  /** A group's steps one after the other: the first that fails (not optional) stops it, and is the group's reason. */
  async function runGroup(raw) {
    const children = [];
    let bad = -1;
    for (const [j, c] of raw.steps.entries()) {
      const r = bad >= 0 ? { ok: null, message: 'not run' } : await runStep(c);
      if (r.ok === false && !r.optional && bad < 0) bad = j;
      children.push(r);
    }
    if (bad < 0) {
      const warn = children.filter((r) => r.ok === false).length;
      return {
        ok: true,
        children,
        message: `${children.length} step(s) passed${warn ? `, ${warn} optional failed` : ''}`,
      };
    }
    const { shot, ...r } = children[bad];
    children[bad] = r;
    return {
      ok: false,
      children,
      at: bad,
      message: `Step ${bad + 1} of the group, “${stepText(raw.steps[bad])}”: ${r.message}`,
      expected: r.expected,
      got: r.got,
      url: r.url,
      toasts: r.toasts,
      shot,
    };
  }

  async function runOne(raw) {
    if (raw.action === 'group') {
      const bad = problem(raw);
      if (bad) throw new Error(bad);
      return runGroup(raw);
    }
    const s = withValues(raw, vars);
    const bad = problem(s);
    if (bad) throw new Error(bad);
    if (s.action === 'open') {
      let path = s.path;
      if (s.record) path = `/lightning/r/${s.record}/view`;
      else if (s.object && s.name) {
        const d = await describe(s.object);
        const nameField = d.fields.find((f) => f.nameField)?.name ?? 'Name';
        const rows = await sf.query(
          `SELECT Id FROM ${s.object} WHERE ${nameField} = ${soqlText(s.name)} ORDER BY CreatedDate DESC LIMIT 1`
        );
        if (!rows.length) throw new Error(`No ${s.object} named “${s.name}”.`);
        path = `/lightning/r/${s.object}/${rows[0].Id}/view`;
      }
      await driver.open(`https://${sf.host}${path.startsWith('/') ? path : `/${path}`}`);
      return { ok: true };
    }
    if (s.action === 'data') {
      const recipe = s.recipe;
      for (const n of recipe.nodes) await describe(n.object);
      const lookups = {};
      for (const soql of querySoqls(recipe)) lookups[soql] = (await sf.query(soql, { max: 2000 })).map((x) => x.Id);
      const records = generate(recipe, describes, makeFaker(recipe.seed ?? Date.now() % 100000), { lookups });
      const made = await createRecords(sf, records);
      if (made.failed.length) throw new Error(`${made.failed.length} record(s) not made: ${made.failed[0].message}`);
      const order = [];
      for (const rec of records) if (!order.includes(rec.object)) order.push(rec.object);
      batches.push({ order, ids: made.ids });
      for (const rec of records) vars[rec.key] = { id: made.idByKey[rec.key], values: rec.values };
      return { ok: true, message: `${made.created} record(s) made` };
    }
    if (s.action === 'query') {
      const soql = String(s.soql).trim();
      const res = await sf.rest('GET', `/query?q=${encodeURIComponent(soql)}`);
      const n = res.totalSize ?? 0;
      const want = s.count === undefined || s.count === '' ? null : Number(s.count);
      if (want === null ? n < 1 : n !== want)
        throw failed(
          `Found ${n} row(s), ${want === null ? 'at least 1' : want} wanted.`,
          `${want === null ? 'at least 1' : want} row(s)`,
          `${n} row(s)`
        );
      if (s.save) {
        // The first row, for later steps: {{name}} its Id, {{name.Field}} a value
        const { attributes, ...row } = res.records?.[0] ?? {};
        vars[s.save] = { id: row.Id ?? '', values: row };
      }
      return { ok: true, message: s.save ? `${n} row(s); {{${s.save}}} = ${vars[s.save].id}` : `${n} row(s)` };
    }
    if (s.action === 'shot') {
      const shot = driver.shot ? await driver.shot().catch(() => undefined) : undefined;
      return shot
        ? { ok: true, shot }
        : { ok: true, message: 'Not taken: screenshots need Chrome’s “all sites” permission' };
    }
    if (s.action === 'loginas') {
      const u = await userOf(s.user);
      if (who.as) await backToMe();
      const [org] = await sf.query('SELECT Id FROM Organization LIMIT 1');
      const home = encodeURIComponent('/lightning/page/home');
      if (driver.keepSession) await driver.keepSession();
      await (driver.load ?? driver.open)(
        `https://${sf.host}/servlet/servlet.su?oid=${org.Id}&suorgadminid=${u.Id}&retURL=${home}&targetURL=${home}`
      );
      await driver.open(`https://${sf.host}/lightning/page/home`);
      // Salesforce shows "Logged in as …" while you are someone else; without it, Login-As did not happen
      const as = await driver.step({ action: 'expect', kind: 'text', value: 'Logged in as', timeout: 15000 });
      if (!as?.ok) {
        if (driver.forgetSession) driver.forgetSession();
        throw new Error(
          `Salesforce did not log you in as ${u.Name}: Login-As needs “Administrators Can Log in as Any User” (Setup › Login Access Policies), and you need to be an admin.`
        );
      }
      who.as = 'loginas';
      who.userId = u.Id;
      return { ok: true, message: `Now ${u.Name}` };
    }
    if (s.action === 'login') {
      const l = logins[s.login];
      if (!l?.username)
        throw new Error(`No login “${s.login}”: add it in Settings › Logins (or --logins for the runner).`);
      if (who.as) await backToMe();
      if (driver.keepSession) await driver.keepSession();
      const url = l.url || 'https://login.salesforce.com';
      await (driver.load ?? driver.open)(url.startsWith('http') ? url : `https://${url}`);
      who.as = 'login';
      let typed;
      let link = false;
      for (let k = 0; k < 5; k++) {
        typed = await driver.step({ action: 'login-form', username: l.username, password: l.password ?? '' });
        // "Log In with Username" was clicked: the form shows next; no answer just after it: the page is loading
        if (typed?.link || (!typed && link)) {
          link = true;
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }
        break;
      }
      if (typed && typed.ok === false) throw new Error(typed.message);
      if (driver.settle) await driver.settle();
      const now = driver.url ? await driver.url() : '';
      if (
        /\/(_ui\/identity|secur\/(verification|login))|login\.salesforce|test\.salesforce/.test(now) &&
        !/lightning/.test(now)
      )
        throw new Error(
          `Still on the login page (${now.slice(
            0,
            80
          )}): a wrong username or password, or Salesforce asks to verify it is you.`
        );
      const u = await userOf(l.username).catch(() => null);
      who.userId = u?.Id ?? '';
      return { ok: true, message: `Logged in as ${l.username}` };
    }
    if (s.action === 'expect' && (s.kind === 'recordtype' || s.kind === 'layout')) {
      const { object, id } = await here();
      if (!object || !id) throw new Error('Not on a record page.');
      let actual;
      if (s.kind === 'recordtype' && !(await describe(object)).fields.some((f) => f.name === 'RecordTypeId'))
        actual = 'Master'; // the object has no record types
      else if (s.kind === 'recordtype') {
        try {
          const [row] = await sf.query(`SELECT RecordType.Name FROM ${object} WHERE Id = ${soqlText(id)}`);
          actual = row?.RecordType?.Name ?? 'Master';
        } catch {
          actual = 'Master'; // the object has no record types
        }
      } else actual = await layoutName(object, id);
      const op = s.op ?? 'contains';
      if (!compare(actual, s.value, op))
        throw failed(
          `The ${s.kind === 'layout' ? 'page layout' : 'record type'} is “${actual}”.`,
          `${OPS[op] ?? op} “${s.value}”`,
          `“${actual}”`
        );
      return { ok: true, message: `“${actual}”` };
    }
    const step = await withLabel(s);
    const r = await driver.step(step);
    if (s.action === 'remember' && r?.ok) vars[s.as] = { id: String(r.value ?? ''), values: {} };
    return r;
  }

  /** Runs one step: { ok, message, ms, optional?, shot?, expected?, got?, url?, toasts?, children? }. */
  async function runStep(raw) {
    const started = Date.now();
    let r;
    try {
      r = (await runOne(raw)) ?? { ok: false, message: 'No answer from the page.' };
    } catch (e) {
      r = { ok: false, message: e.message, expected: e.expected, got: e.got };
    }
    r = { ...r, ms: Date.now() - started };
    for (const k of ['expected', 'got', 'url', 'shot']) if (r[k] === undefined) delete r[k];
    if (!r.toasts?.length) delete r.toasts;
    if (r.ok === false) {
      // An optional step may fail: it is reported, and the test goes on
      if (raw.optional) r.optional = true;
      // What the page showed when it failed (a small picture: only for a failed step)
      if (driver.shot && !r.shot) {
        const shot = await driver.shot().catch(() => undefined);
        if (shot) r.shot = shot;
      }
      if (!r.url && driver.url) r.url = await driver.url().catch(() => undefined);
      if (!r.url) delete r.url;
    }
    return r;
  }

  return {
    vars,
    who,
    run: runStep,
    /** Deletes what the test made and logs back in as you; returns how many records were deleted. */
    async finish() {
      await backToMe();
      let cleaned = 0;
      if (test.cleanup !== false)
        for (const b of batches.splice(0).reverse()) {
          const d = await deleteBatch(sf, b).catch(() => ({ deleted: 0 }));
          cleaned += d.deleted;
        }
      return cleaned;
    },
  };
}

/**
 * Runs a test. `onStep(i, result)` reports as it goes. Data made by the test is deleted at the end unless
 * test.cleanup === false; a test that logged in as someone else ends logged in as you again.
 */
/** Runs a test; `signal.on` (■ Stop) stops it: the step that runs ends now, no more run, test data is cleaned. */
export async function runTest(test, { driver, sf, onStep = () => {}, describes = {}, logins = {}, signal } = {}) {
  const st = stepper(test, { driver, sf, describes, logins });
  const results = [];
  const t0 = Date.now();
  let failed = false;
  let stopped = false;
  for (let i = 0; i < test.steps.length; i++) {
    if (signal?.on) stopped = true;
    let r = failed || stopped ? { ok: null, message: 'not run' } : await st.run(test.steps[i]);
    if (r.stopped || (signal?.on && r.ok === false)) {
      stopped = true;
      r = { ok: null, stopped: true, message: 'Stopped by you.' };
    }
    if (r.ok === false && !r.optional) failed = true;
    results.push(r);
    onStep(i, r);
  }
  const cleaned = await st.finish();
  return { ok: !failed && !stopped, ...(stopped ? { stopped: true } : {}), results, ms: Date.now() - t0, cleaned };
}

const xml = (s) =>
  String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/** One <testsuite>: a test case per step, and the test itself (its steps) so the file can be uploaded again. */
function suiteXml(test, run) {
  const { id, host, ...file } = test;
  const cases = test.steps
    .map((s, i) => {
      const r = run.results[i] ?? {};
      const body = r.ok === false ? `<failure message="${xml(r.message)}"/>` : r.ok === null ? '<skipped/>' : '';
      return `    <testcase name="${xml(`${i + 1}. ${stepText(s)}`)}" time="${((r.ms ?? 0) / 1000).toFixed(
        2
      )}">${body}</testcase>`;
    })
    .join('\n');
  const failures = run.results.filter((r) => r.ok === false && !r.optional).length;
  return `  <testsuite name="${xml(test.name)}" tests="${test.steps.length}" failures="${failures}" time="${(
    run.ms / 1000
  ).toFixed(2)}">\n    <properties><property name="nomadqa.test" value="${xml(
    JSON.stringify(file)
  )}"/></properties>\n${cases}\n  </testsuite>`;
}

/** A JUnit report (CI systems read it); NomadQA reads its tests back from it. */
export function junit(test, run) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(test.name)}">\n${suiteXml(
    test,
    run
  )}\n</testsuites>\n`;
}

/** One JUnit report for a group of tests: [{ test, run }]. */
export function groupJunit(name, list) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(name)}">\n${list
    .map((x) => suiteXml(x.test, x.run))
    .join('\n')}\n</testsuites>\n`;
}

const unxml = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

/**
 * The tests in a file: a NomadQA test, a group ({ nomadqa: 'group', tests }), or a JUnit report NomadQA wrote
 * (it carries its tests). Throws when there are none.
 */
export function testsFromFile(text) {
  const t = String(text ?? '').trim();
  if (t.startsWith('<')) {
    const tests = [...t.matchAll(/<property\s+name="nomadqa\.test"\s+value="([^"]*)"/g)].map((m) =>
      JSON.parse(unxml(m[1]))
    );
    if (!tests.length)
      throw new Error('This JUnit report was not written by NomadQA: it has the results, but not the steps.');
    return tests;
  }
  const j = JSON.parse(t);
  const tests = j.nomadqa === 'group' && Array.isArray(j.tests) ? j.tests : [j];
  for (const x of tests)
    if (x?.nomadqa !== 'test' || !Array.isArray(x.steps)) throw new Error('Not a NomadQA test file.');
  return tests;
}
