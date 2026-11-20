// Find records and clone them: the found records (and, if asked, the records under them) become a preview like a
// plan's, so the same Check, Create, batch and Delete apply. Nothing in the org changes until Create.
import { writableFields, markValues } from './plan.js';

const q = (v) => `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** The fields worth copying: writable, and not ones that must be unique. */
export const copyable = (describe) => writableFields(describe).filter((f) => !f.unique && !f.externalId);

/**
 * The WHERE of a search: a condition as typed (Industry = 'Energy'), or plain words, which look in the name field.
 */
export function whereOf(text, nameField = 'Name') {
  const t = String(text ?? '').trim();
  if (!t) return '';
  if (/;/.test(t)) throw new Error('One condition, without “;”.');
  if (/[=<>]|\b(LIKE|IN|INCLUDES|EXCLUDES|AND|OR|NOT)\b/i.test(t)) return t;
  return `${nameField} LIKE ${q(`%${t.replace(/[%_]/g, '\\$&')}%`)}`;
}

/** Reads these records with many fields. SOQL travels in the address, so long field lists go in parts, joined by Id. */
export async function readWide(sf, object, names, ids) {
  const byId = new Map(ids.map((id) => [id, { Id: id }]));
  const groups = [];
  let cur = [];
  let len = 0;
  for (const n of names) {
    if (len + n.length > 3500 && cur.length) groups.push(cur), (cur = []), (len = 0);
    cur.push(n);
    len += n.length + 2;
  }
  if (cur.length) groups.push(cur);
  for (let i = 0; i < ids.length; i += 100) {
    const part = ids
      .slice(i, i + 100)
      .map(q)
      .join(',');
    for (const g of groups) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await sf.query(`SELECT Id, ${g.join(', ')} FROM ${object} WHERE Id IN (${part})`);
      for (const r of rows) Object.assign(byId.get(r.Id) ?? {}, r);
    }
  }
  return [...byId.values()];
}

/** The Ids of the records under these parents, by the link field (at most `max`). */
export async function childIds(sf, object, field, parentIds, max = 2000) {
  const out = [];
  for (let i = 0; i < parentIds.length && out.length < max; i += 100) {
    const part = parentIds
      .slice(i, i + 100)
      .map(q)
      .join(',');
    // eslint-disable-next-line no-await-in-loop
    const rows = await sf.query(`SELECT Id FROM ${object} WHERE ${field} IN (${part}) LIMIT ${max - out.length}`, {
      max,
    });
    out.push(...rows.map((r) => r.Id));
  }
  return out;
}

const valuesOf = (row, fields, skip) => {
  const values = {};
  for (const f of fields) {
    if (f.name === skip) continue;
    const v = row[f.name];
    if (v !== null && v !== undefined && v !== '') values[f.name] = v;
  }
  return values;
};

/**
 * The preview of the clones: `copies` copies of every found record, each with copies of the records under it.
 * parent: { object, rows, describe }; children: [{ object, field, rows, describe }]; marker: { text, where }.
 */
export function buildClones({ parent, children = [], copies = 1, marker }) {
  const nodes = [{ id: 'p', object: parent.object, count: parent.rows.length, rules: {} }];
  children.forEach((c, i) =>
    nodes.push({ id: `c${i}`, object: c.object, parentId: 'p', parentField: c.field, count: 0, rules: {} })
  );
  const pFields = copyable(parent.describe);
  const pMap = new Map(parent.describe.fields.map((f) => [f.name, f]));
  const kids = children.map((c) => ({
    ...c,
    fields: copyable(c.describe),
    map: new Map(c.describe.fields.map((f) => [f.name, f])),
    n: 0,
  }));
  const records = [];
  let n = 0;
  for (let copy = 1; copy <= Math.max(1, copies); copy++)
    for (const row of parent.rows) {
      n++;
      const values = valuesOf(row, pFields);
      if (marker?.text) markValues(values, pMap, marker);
      const key = `p-${n}`;
      records.push({ nodeId: 'p', object: parent.object, key, n, values, from: row.Id });
      kids.forEach((c, i) => {
        for (const kid of c.rows.filter((r) => r[c.field] === row.Id)) {
          c.n++;
          const v = valuesOf(kid, c.fields, c.field);
          if (marker?.text) markValues(v, c.map, marker);
          v[c.field] = { $ref: key };
          records.push({
            nodeId: `c${i}`,
            object: c.object,
            key: `c${i}-${c.n}`,
            parentKey: key,
            n: c.n,
            values: v,
            from: kid.Id,
          });
        }
      });
    }
  return { nodes, records };
}

/**
 * Clones found in one org, to be made in another: objects it lacks are left out (with what is under them), and so
 * are fields it lacks, links to other records (their Ids are of the first org) and record types.
 * Returns { nodes, records, changes }.
 */
export function fitClones(preview, describes) {
  const changes = [];
  const gone = new Set();
  for (const n of preview.nodes)
    if (!describes[n.object] || gone.has(n.parentId)) {
      gone.add(n.id);
      changes.push(`${n.object} is not in this org: left out.`);
    }
  const nodes = preview.nodes.filter((n) => !gone.has(n.id));
  const dropped = new Map();
  const records = preview.records
    .filter((r) => !gone.has(r.nodeId))
    .map((r) => {
      const fields = new Map(describes[r.object].fields.map((f) => [f.name, f]));
      const values = {};
      for (const [k, v] of Object.entries(r.values)) {
        const f = fields.get(k);
        const keep = v && typeof v === 'object' ? Boolean(f) : f && f.createable && f.type !== 'reference';
        if (keep) values[k] = v;
        else dropped.set(`${r.object}.${k}`, (dropped.get(`${r.object}.${k}`) ?? 0) + 1);
      }
      return { ...r, values };
    });
  if (dropped.size)
    changes.push(
      `Left out ${dropped.size} field(s) this org lacks or that link to records of the other org: ${[...dropped.keys()]
        .slice(0, 12)
        .join(', ')}${dropped.size > 12 ? '…' : ''}`
    );
  return { nodes, records, changes };
}
