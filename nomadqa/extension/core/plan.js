// A plan (a "recipe" when saved): which objects, how many, how they link, and a rule per field.
// Everything here is plain data in, plain data out: the screens and the tests use the same functions.
//
// plan = { name, seed, nodes: [{ id, object, count, parentId?, parentField?, recordTypeId?, rules: { Field: rule } }] }
// rule = { kind: 'auto' | 'empty' | 'fixed' | 'list' | 'weighted' | 'pattern' | 'range' | 'dates' | 'query', ... }

import { fillPattern } from './fake.js';

/** Fields a person usually wants filled, per standard object (when the object has them). */
const NICE = {
  Account: [
    'Name',
    'Industry',
    'Type',
    'Phone',
    'Website',
    'BillingCity',
    'BillingStreet',
    'AnnualRevenue',
    'NumberOfEmployees',
  ],
  Contact: ['FirstName', 'LastName', 'Email', 'Phone', 'Title', 'MailingCity'],
  Opportunity: ['Name', 'StageName', 'CloseDate', 'Amount', 'Type', 'LeadSource'],
  Case: ['Subject', 'Status', 'Priority', 'Origin', 'Description'],
  Lead: ['FirstName', 'LastName', 'Company', 'Email', 'Phone', 'Status', 'Industry', 'City'],
  Campaign: ['Name', 'Type', 'Status', 'StartDate', 'EndDate'],
  Product2: ['Name', 'ProductCode', 'Family', 'IsActive'],
  Task: ['Subject', 'Status', 'Priority', 'ActivityDate'],
};

const SKIP_TYPES = new Set(['address', 'location', 'encryptedstring', 'base64', 'id', 'anyType', 'complexvalue']);

/** Fields a record can be created with (writable, not compound, not system). */
export function writableFields(describe) {
  return describe.fields.filter((f) => f.createable && !SKIP_TYPES.has(f.type) && !f.autoNumber && !f.calculated);
}

/** Salesforce will refuse the record without it. */
export const isRequired = (f) => f.createable && !f.nillable && !f.defaultedOnCreate && f.type !== 'boolean';

/** The rules a new node starts with: its required fields and the usual ones, each on Auto. */
export function defaultRules(describe, { parentField } = {}) {
  const fields = writableFields(describe);
  const nice = NICE[describe.name];
  // An object with no usual list (a custom object): its own custom fields, up to 15, lookups left out
  const own = nice
    ? []
    : fields
        .filter((f) => f.custom && f.type !== 'reference')
        .slice(0, 15)
        .map((f) => f.name);
  const chosen = fields.filter(
    (f) =>
      f.name !== parentField &&
      f.name !== 'OwnerId' &&
      (isRequired(f) || (nice ?? own).includes(f.name) || (f.nameField && f.type === 'string'))
  );
  const rules = {};
  for (const f of chosen) rules[f.name] = { kind: 'auto' };
  return rules;
}

/** Parents before children (a child's parent may be added after it). */
export function orderNodes(nodes) {
  const out = [];
  const seen = new Set();
  const visit = (n, depth = 0) => {
    if (seen.has(n.id) || depth > 20) return;
    if (n.parentId) {
      const p = nodes.find((x) => x.id === n.parentId);
      if (p) visit(p, depth + 1);
    }
    seen.add(n.id);
    out.push(n);
  };
  for (const n of nodes) visit(n);
  return out;
}

/** How many records each node makes (a child's count is per parent record). */
export function counts(plan) {
  const total = {};
  for (const n of orderNodes(plan.nodes)) {
    const per = Math.max(0, Number(n.count) || 0);
    total[n.id] = n.parentId ? (total[n.parentId] ?? 0) * per : per;
  }
  return total;
}

const clip = (v, f) => (typeof v === 'string' && f.length > 0 && v.length > f.length ? v.slice(0, f.length) : v);

/** Picklist values a record can take (active ones, or the record type's when known). */
const choices = (f, picklists) =>
  (picklists?.[f.name] ?? f.picklistValues?.filter((p) => p.active).map((p) => ({ value: p.value })) ?? []).map(
    (p) => p.value
  );

/**
 * The automatic value of one field, from its type and name, and what the record already has (a person's name for
 * the e-mail, the company for the website, the parent for an opportunity's name).
 */
export function autoValue(f, ctx) {
  const { faker: x, values, parent, object, picklists, n } = ctx;
  const name = f.name;
  const company = values.Name ?? values.Company ?? parent?.Name;
  switch (f.type) {
    case 'picklist': {
      const list = choices(f, picklists);
      return list.length ? x.pick(list) : undefined;
    }
    case 'multipicklist': {
      const list = choices(f, picklists);
      if (!list.length) return undefined;
      return [...new Set([x.pick(list), x.pick(list)])].join(';');
    }
    case 'boolean':
      return /^IsActive$/.test(name) ? true : x.boolean(0.3);
    case 'email':
      return x.email(values.FirstName ?? x.firstName(), values.LastName ?? x.lastName(), parent?.Name ?? '');
    case 'phone':
      return x.digits('+61 2 5550 ####');
    case 'url':
      return x.url(company ?? x.company());
    case 'date':
      if (/Close|Due|End|Expir/i.test(name)) return x.date(7, 120);
      if (/Birth/i.test(name)) return x.date(-24000, -7000);
      if (/Start/i.test(name)) return x.date(-60, 30);
      return x.date(-365, 365);
    case 'datetime':
      return x.datetime(-30, 30);
    case 'time':
      return `${String(x.int(8, 17)).padStart(2, '0')}:${x.pick(['00', '15', '30', '45'])}:00.000Z`;
    case 'int':
      if (/Employees/i.test(name)) return x.int(10, 5000);
      return x.int(1, 100);
    case 'percent':
      return x.number(0, 100, Math.min(f.scale ?? 0, 2));
    case 'currency':
    case 'double': {
      const scale = Math.min(f.scale ?? 2, 2);
      const max = f.precision && f.scale !== undefined ? 10 ** Math.min(f.precision - f.scale, 9) - 1 : 1e6;
      if (/Revenue/i.test(name)) return Math.min(max, Math.round(x.number(100000, 50000000) / 1000) * 1000);
      if (/Amount|Price|Total|Value/i.test(name)) return Math.min(max, x.number(500, 250000, scale));
      return Math.min(max, x.number(1, 1000, scale));
    }
    case 'textarea':
      if (/Street$/.test(name)) return x.street();
      return f.length && f.length < 60 ? x.words(3) : x.sentence();
    case 'reference':
      return undefined; // a lookup is filled by its rule (parent or query), never invented
    case 'string':
    case 'combobox':
    default: {
      if (name === 'FirstName') return x.firstName();
      if (name === 'LastName') return x.lastName();
      if (name === 'Company' || (f.nameField && object === 'Account')) return x.company();
      if (f.nameField && object === 'Opportunity')
        return `${parent?.Name ?? company ?? x.company()} — ${x.pick([
          'Renewal',
          'Expansion',
          'New business',
          'Upgrade',
          'Pilot',
        ])}`;
      if (f.nameField && /Campaign/.test(object)) return `${x.words(2)} ${new Date().getFullYear()}`;
      if (name === 'Subject') return x.sentence();
      if (/City$/.test(name)) return x.city();
      if (/Street$/.test(name)) return x.street();
      if (/(PostalCode|Zip)/i.test(name)) return x.postalCode();
      if (/Title$/.test(name)) return x.title();
      if (/Code$/.test(name)) return `${object.slice(0, 3).toUpperCase()}-${String(n).padStart(4, '0')}`;
      if (f.nameField) return `${ctx.label ?? object} ${String(n).padStart(4, '0')}`;
      return x.words(2);
    }
  }
}

/** One field's value from its rule. `lookups[soql]` holds the Ids a query rule found. */
export function valueOf(rule, f, ctx) {
  const x = ctx.faker;
  switch (rule.kind) {
    case 'empty':
      return undefined;
    case 'fixed':
      return rule.value;
    case 'list':
      return x.pick(
        String(rule.value ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      );
    case 'weighted':
      return x.weighted(rule.value ?? '');
    case 'pattern':
      return fillPattern(rule.value ?? '', ctx.n, ctx.parent ?? {});
    case 'range': {
      const from = Number(rule.from ?? 0);
      const to = Number(rule.to ?? from);
      return f.type === 'int' ? x.int(from, to) : x.number(from, to, Math.min(f.scale ?? 2, 2));
    }
    case 'dates':
      return f.type === 'datetime'
        ? x.datetime(Number(rule.from ?? -30), Number(rule.to ?? 30))
        : x.date(Number(rule.from ?? -30), Number(rule.to ?? 30));
    case 'query': {
      const ids = ctx.lookups?.[rule.soql] ?? [];
      return ids.length ? x.pick(ids) : undefined;
    }
    case 'auto':
    default:
      return autoValue(f, ctx);
  }
}

/** Fields that others are built from go first (names before e-mails, the record name before the website). */
const fieldOrder = (a, b) => {
  const rank = (n) => (/^(FirstName|LastName)$/.test(n) ? 0 : /^(Name|Company)$/.test(n) ? 1 : 2);
  return rank(a) - rank(b);
};

/**
 * Every record of the plan, parents first: [{ nodeId, object, key, parentKey, n, values }]. `values` holds field
 * values; a child's lookup to its parent is `{ $ref: parentKey }` until the parent exists.
 */
export function generate(plan, describes, faker, { lookups = {}, picklists = {} } = {}) {
  const out = [];
  const byNode = {};
  for (const node of orderNodes(plan.nodes)) {
    const d = describes[node.object];
    if (!d) throw new Error(`No description of ${node.object}.`);
    const fields = new Map(d.fields.map((f) => [f.name, f]));
    const parents = node.parentId ? byNode[node.parentId] ?? [] : [null];
    const per = Math.max(0, Number(node.count) || 0);
    const made = [];
    let n = 0;
    for (const parent of parents)
      for (let i = 0; i < per; i++) {
        n++;
        const values = {};
        const ctx = {
          faker,
          values,
          parent: parent?.values,
          object: node.object,
          label: d.label,
          picklists: picklists[node.id],
          lookups,
          n,
        };
        for (const name of Object.keys(node.rules ?? {}).sort(fieldOrder)) {
          const f = fields.get(name);
          if (!f || name === node.parentField) continue;
          const v = clip(valueOf(node.rules[name], f, ctx), f);
          if (v !== undefined && v !== null && v !== '') values[name] = v;
        }
        if (node.recordTypeId) values.RecordTypeId = node.recordTypeId;
        if (parent && node.parentField) values[node.parentField] = { $ref: parent.key };
        const rec = { nodeId: node.id, object: node.object, key: `${node.id}-${n}`, parentKey: parent?.key, n, values };
        made.push(rec);
        out.push(rec);
      }
    byNode[node.id] = made;
  }
  return out;
}

/** The query rules of a plan (to run before generating). */
export const querySoqls = (plan) => [
  ...new Set(
    plan.nodes.flatMap((n) =>
      Object.values(n.rules ?? {})
        .filter((r) => r.kind === 'query' && r.soql)
        .map((r) => r.soql)
    )
  ),
];

/** A query rule's SOQL is read-only and returns Ids. */
export function checkSoql(soql) {
  const s = String(soql ?? '').trim();
  if (!/^SELECT\s+Id\s+FROM\s+\w+/i.test(s)) throw new Error('A query rule starts with SELECT Id FROM …');
  return s;
}

/**
 * A recipe made in one org, fitted to another: objects it lacks are left out (with what is under them), fields it
 * lacks are dropped, a link field it lacks is replaced by another lookup to the same parent (or the records are made
 * on their own), a record type it lacks falls back to the default. `describes` holds the objects this org has.
 * Returns { nodes, changes: [text] }.
 */
export function fitRecipe(recipe, describes) {
  const changes = [];
  const kept = [];
  const gone = new Set();
  for (const n of orderNodes(recipe.nodes)) {
    if (n.parentId && gone.has(n.parentId)) {
      gone.add(n.id);
      continue;
    }
    const d = describes[n.object];
    if (!d) {
      gone.add(n.id);
      changes.push(
        `${n.object} is not in this org: left out${
          recipe.nodes.some((x) => x.parentId === n.id) ? ', with what was under it' : ''
        }.`
      );
      continue;
    }
    const writable = new Map(writableFields(d).map((f) => [f.name, f]));
    const node = { ...n, rules: { ...(n.rules ?? defaultRules(d, { parentField: n.parentField })) } };
    const dropped = Object.keys(node.rules).filter((f) => !writable.has(f));
    for (const f of dropped) delete node.rules[f];
    if (dropped.length) changes.push(`${n.object}: ${dropped.join(', ')} not here (or not writable): left out.`);
    if (n.parentId) {
      const parent = kept.find((x) => x.id === n.parentId);
      const link = (name) => {
        const f = writable.get(name);
        return f?.type === 'reference' && (f.referenceTo ?? []).includes(parent.object) ? f : null;
      };
      if (!link(n.parentField)) {
        const other = [...writable.values()].find(
          (f) => f.type === 'reference' && (f.referenceTo ?? []).includes(parent.object)
        );
        if (other) {
          changes.push(`${n.object}: no ${n.parentField} here; linked to ${parent.object} by ${other.name} instead.`);
          node.parentField = other.name;
          delete node.rules[other.name];
        } else {
          changes.push(`${n.object}: nothing links it to ${parent.object} here, so its records are made on their own.`);
          delete node.parentId;
          delete node.parentField;
        }
      }
    }
    if (n.recordType && !(d.recordTypeInfos ?? []).some((r) => r.developerName === n.recordType && r.available)) {
      changes.push(`${n.object}: no record type ${n.recordType} here; the default is used.`);
      delete node.recordType;
    }
    kept.push(node);
  }
  return { nodes: kept, changes };
}
