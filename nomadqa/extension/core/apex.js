// Records written as Apex: the "check without saving" script (inserts, reports, rolls back) and the
// @IsTest data factory class.

const str = (s) =>
  `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`;

/** A field value as an Apex literal of the field's type. */
export function apexLiteral(value, type) {
  if (value === null || value === undefined) return 'null';
  switch (type) {
    case 'boolean':
      return value === true || value === 'true' ? 'true' : 'false';
    case 'int':
      return String(Math.trunc(Number(value)));
    case 'double':
    case 'currency':
    case 'percent': {
      const n = Number(value);
      return Number.isFinite(n) ? `${n}${Number.isInteger(n) ? '.0' : ''}` : 'null';
    }
    case 'date':
      return `Date.valueOf(${str(value)})`;
    case 'datetime':
      return `(Datetime) JSON.deserialize(${str(JSON.stringify(value))}, Datetime.class)`;
    case 'time': {
      const [h, m, s] = String(value).split(/[:.]/);
      return `Time.newInstance(${Number(h) || 0}, ${Number(m) || 0}, ${Number(s) || 0}, 0)`;
    }
    default:
      return str(value);
  }
}

const apexName = (s) => s.replace(/[^A-Za-z0-9_]/g, '_');

/** The fixed part of the check: reads the records from DATA, inserts them in order, reports, rolls back. */
const CHECK_APEX = `class NomadQACheckDoneException extends Exception {}
Map<String, SObject> made = new Map<String, SObject>();
List<String> out = new List<String>();
Map<String, Schema.SObjectType> gd = Schema.getGlobalDescribe();
Map<String, Map<String, Schema.SObjectField>> fms = new Map<String, Map<String, Schema.SObjectField>>();
List<Object> recs = (List<Object>) JSON.deserializeUntyped(DATA);
Integer i = 0;
while (i < recs.size()) {
  String node = (String) ((Map<String, Object>) recs[i]).get('n');
  List<SObject> batch = new List<SObject>();
  List<String> keys = new List<String>();
  while (i < recs.size() && (String) ((Map<String, Object>) recs[i]).get('n') == node) {
    Map<String, Object> r = (Map<String, Object>) recs[i];
    i++;
    String o = (String) r.get('o');
    String p = (String) r.get('p');
    if (p != null && (!made.containsKey(p) || made.get(p).Id == null)) { out.add(r.get('k') + '\\tits parent was not saved'); continue; }
    if (!fms.containsKey(o)) fms.put(o, gd.get(o).getDescribe().fields.getMap());
    Map<String, Schema.SObjectField> fm = fms.get(o);
    SObject s = gd.get(o).newSObject();
    Map<String, Object> v = (Map<String, Object>) r.get('v');
    for (String f : v.keySet()) {
      Object x = v.get(f);
      if (x instanceof Map<String, Object>) { s.put(f, made.get((String) ((Map<String, Object>) x).get('$ref')).Id); continue; }
      Schema.DisplayType t = fm.get(f.toLowerCase()).getDescribe().getType();
      String sx = String.valueOf(x);
      if (t == Schema.DisplayType.DATE) s.put(f, Date.valueOf(sx));
      else if (t == Schema.DisplayType.DATETIME) s.put(f, (Datetime) JSON.deserialize('"' + sx + '"', Datetime.class));
      else if (t == Schema.DisplayType.INTEGER) s.put(f, Integer.valueOf(sx));
      else if (t == Schema.DisplayType.DOUBLE || t == Schema.DisplayType.CURRENCY || t == Schema.DisplayType.PERCENT) s.put(f, Decimal.valueOf(sx));
      else if (t == Schema.DisplayType.BOOLEAN) s.put(f, Boolean.valueOf(sx));
      else if (t == Schema.DisplayType.TIME) { List<String> q = sx.split('[:.]'); s.put(f, Time.newInstance(Integer.valueOf(q[0]), Integer.valueOf(q[1]), Integer.valueOf(q[2]), 0)); }
      else s.put(f, sx);
    }
    batch.add(s);
    keys.add((String) r.get('k'));
  }
  if (!batch.isEmpty()) {
    Database.SaveResult[] res = Database.insert(batch, false);
    for (Integer j = 0; j < res.size(); j++) {
      if (res[j].isSuccess()) made.put(keys[j], batch[j]);
      else {
        Database.Error e = res[j].getErrors()[0];
        out.add(keys[j] + '\\t' + e.getMessage() + (e.getFields().isEmpty() ? '' : ' (' + String.join(e.getFields(), ', ') + ')'));
      }
    }
  }
}
throw new NomadQACheckDoneException('NOMADQA' + JSON.serialize(out));`;

/** Anonymous Apex is limited in size: a script holds whole families (a record and all under it) up to this. */
export const CHECK_CHARS = 30000;

/**
 * Anonymous Apex scripts that insert the records (parents first, each child linked to its parent), collect what
 * failed, and throw at the end: an exception rolls the whole transaction back, so nothing stays in the org.
 * Validation rules, required fields, triggers and flows all run. Several scripts when the records do not fit in one.
 */
export function checkScripts(records, maxChars = CHECK_CHARS) {
  const byKey = new Map(records.map((r) => [r.key, r]));
  const rootOf = (r) => {
    let x = r;
    for (let i = 0; x.parentKey && byKey.has(x.parentKey) && i < 50; i++) x = byKey.get(x.parentKey);
    return x.key;
  };
  const families = new Map();
  records.forEach((r, i) => {
    const root = rootOf(r);
    if (!families.has(root)) families.set(root, []);
    families
      .get(root)
      .push({
        i,
        item: { n: r.nodeId, k: r.key, o: r.object, ...(r.parentKey ? { p: r.parentKey } : {}), v: r.values },
      });
  });
  const room = maxChars - CHECK_APEX.length - 40;
  const chunks = [];
  let current = [];
  let size = 0;
  for (const fam of families.values()) {
    const len = JSON.stringify(fam.map((x) => x.item)).length + 2;
    if (current.length && size + len > room) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(...fam);
    size += len;
  }
  if (current.length) chunks.push(current);
  return chunks.map((chunk) => {
    const data = JSON.stringify(chunk.sort((a, b) => a.i - b.i).map((x) => x.item));
    return `String DATA = ${str(data)};\n${CHECK_APEX}`;
  });
}

/** What a check found: { ok: n, failed: [{ key, message }] }, or throws with Salesforce's own problem. */
export function readCheck(result, total) {
  if (!result.compiled) throw new Error(`The check did not compile: ${result.compileProblem} (line ${result.line})`);
  const m = /NOMADQA(\[[\s\S]*\])/.exec(result.exceptionMessage ?? '');
  if (!m) throw new Error(result.exceptionMessage || 'The check stopped before the end.');
  const failed = JSON.parse(m[1]).map((line) => {
    const [key, ...rest] = String(line).split('\t');
    return { key, message: rest.join('\t') };
  });
  return { ok: total - failed.length, failed };
}

/** An @IsTest class that makes the same records in an Apex test (lookups found by query are left out). */
export function factoryClass(records, types, className = 'NomadQATestData') {
  const nodes = [];
  for (const r of records) if (!nodes.includes(r.nodeId)) nodes.push(r.nodeId);
  const body = [];
  nodes.forEach((nodeId, ni) => {
    const list = records.filter((r) => r.nodeId === nodeId);
    const object = list[0].object;
    body.push(`        // ${object}: ${list.length}`, `        List<SObject> l${ni} = new List<SObject>();`);
    for (const r of list) {
      const sets = [];
      for (const [field, value] of Object.entries(r.values)) {
        if (value && typeof value === 'object' && value.$ref)
          sets.push(`'${field}' => byKey.get(${str(value.$ref)}).Id`);
        else if (field === 'RecordTypeId' || types[object]?.[field] === 'reference') continue;
        else sets.push(`'${field}' => ${apexLiteral(value, types[object]?.[field])}`);
      }
      body.push(`        l${ni}.add(make('${object}', ${str(r.key)}, new Map<String, Object>{ ${sets.join(', ')} }));`);
    }
    body.push(`        insert l${ni};`, `        all.put('${object}', l${ni});`);
  });
  return `/**
 * Test data made with NomadQA: ${records.length} records. Call ${className}.make() in a test method.
 */
@IsTest
public class ${className} {
    private static Map<String, SObject> byKey = new Map<String, SObject>();

    private static SObject make(String objectName, String key, Map<String, Object> fields) {
        SObject s = Schema.getGlobalDescribe().get(objectName).newSObject();
        for (String f : fields.keySet()) s.put(f, fields.get(f));
        byKey.put(key, s);
        return s;
    }

    /** Inserts the records, parents first, and returns them by object. */
    public static Map<String, List<SObject>> make() {
        Map<String, List<SObject>> all = new Map<String, List<SObject>>();
${body.join('\n')}
        return all;
    }
}
`;
}
