// The org's own "switch automation off" for one user: a hierarchy custom setting (a checkbox at the user's level) or a
// custom permission (given by a permission set). NomadQA never changes automation: it finds the switch, shows what
// checks it, turns it on for the running user while creating data, and puts it back exactly as it was.

const LIKE = /bypass|skip|disable|deactivat|override/i;
const tooling = (sf, soql) =>
  sf.rest('GET', `/tooling/query?q=${encodeURIComponent(soql)}`).then((r) => r.records ?? []);
const quoted = (list) => list.map((x) => `'${String(x).replace(/'/g, "\\'")}'`).join(',');

/**
 * Switches that look like a bypass — or, with `all`, every hierarchy custom setting checkbox and custom permission:
 * [{ kind: 'setting', object, field, label } | { kind: 'permission', id, name, label }]. Reads only.
 */
export async function findSwitches(sf, { all = false } = {}) {
  const out = [];
  const settings = await sf.query('SELECT QualifiedApiName, Label FROM EntityDefinition WHERE IsCustomSetting = true', {
    max: 2000,
  });
  for (const s of settings) {
    const d = await sf.describe(s.QualifiedApiName).catch(() => null);
    if (!d || !d.fields.some((f) => f.name === 'SetupOwnerId')) continue; // hierarchy settings only (per user)
    const named = all || LIKE.test(s.QualifiedApiName) || LIKE.test(s.Label);
    for (const f of d.fields)
      if (f.custom && f.type === 'boolean' && (named || LIKE.test(f.name) || LIKE.test(f.label)))
        out.push({ kind: 'setting', object: s.QualifiedApiName, field: f.name, label: `${s.Label} › ${f.label}` });
  }
  const perms = await sf
    .query('SELECT Id, DeveloperName, MasterLabel FROM CustomPermission', { max: 2000 })
    .catch(() => []);
  for (const p of perms)
    if (all || LIKE.test(p.DeveloperName) || LIKE.test(p.MasterLabel))
      out.push({ kind: 'permission', id: p.Id, name: p.DeveloperName, label: `Custom permission ${p.MasterLabel}` });
  return out;
}

const mentions = (text, sw) => {
  const t = String(text ?? '').toLowerCase();
  return sw.kind === 'setting'
    ? t.includes(sw.object.toLowerCase()) && t.includes(sw.field.toLowerCase())
    : t.includes(sw.name.toLowerCase());
};

/** Which active validation rules and triggers on these objects check the switch. */
export async function coverage(sf, sw, objects) {
  const rules = [];
  const triggers = [];
  if (!objects.length) return { rules, triggers };
  const vrs = await tooling(
    sf,
    `SELECT Id, ValidationName, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = true AND EntityDefinition.QualifiedApiName IN (${quoted(
      objects
    )})`
  );
  for (const v of vrs.slice(0, 60)) {
    const [m] = await tooling(sf, `SELECT Metadata FROM ValidationRule WHERE Id = '${v.Id}'`).catch(() => []);
    rules.push({
      name: v.ValidationName,
      object: v.EntityDefinition?.QualifiedApiName,
      checks: mentions(m?.Metadata?.errorConditionFormula, sw),
    });
  }
  const trs = await tooling(
    sf,
    `SELECT Name, TableEnumOrId, Body FROM ApexTrigger WHERE Status = 'Active' AND TableEnumOrId IN (${quoted(
      objects
    )})`
  ).catch(() => []);
  for (const t of trs) triggers.push({ name: t.Name, object: t.TableEnumOrId, checks: mentions(t.Body, sw) });
  return { rules, triggers };
}

/** Turns the switch on for this user; returns what to undo (null when the user already had it on). */
export async function turnOn(sf, sw, userId) {
  if (sw.kind === 'setting') {
    const [row] = await sf.query(`SELECT Id, ${sw.field} FROM ${sw.object} WHERE SetupOwnerId = '${userId}' LIMIT 1`);
    if (row) {
      if (row[sw.field] === true) return null;
      await sf.rest('PATCH', `/sobjects/${sw.object}/${row.Id}`, { [sw.field]: true });
      return { kind: 'patch', object: sw.object, id: row.Id, field: sw.field, old: row[sw.field] ?? false };
    }
    const made = await sf.rest('POST', `/sobjects/${sw.object}`, { SetupOwnerId: userId, [sw.field]: true });
    return { kind: 'delete', object: sw.object, id: made.id };
  }
  const grants = await sf.query(
    `SELECT ParentId FROM SetupEntityAccess WHERE SetupEntityId = '${sw.id}' AND Parent.IsOwnedByProfile = false`
  );
  if (!grants.length)
    throw new Error(`No permission set gives ${sw.label}: make one that does, or use a custom setting.`);
  const sets = grants.map((g) => g.ParentId);
  const has = await sf.query(
    `SELECT Id FROM PermissionSetAssignment WHERE AssigneeId = '${userId}' AND PermissionSetId IN (${quoted(
      sets
    )}) LIMIT 1`
  );
  if (has.length) return null;
  const made = await sf.rest('POST', '/sobjects/PermissionSetAssignment', {
    AssigneeId: userId,
    PermissionSetId: sets[0],
  });
  return { kind: 'unassign', id: made.id };
}

/** Puts the switch back exactly as it was. */
export async function turnOff(sf, undo) {
  if (!undo) return;
  if (undo.kind === 'patch') await sf.rest('PATCH', `/sobjects/${undo.object}/${undo.id}`, { [undo.field]: undo.old });
  else if (undo.kind === 'delete') await sf.rest('DELETE', `/sobjects/${undo.object}/${undo.id}`);
  else if (undo.kind === 'unassign') await sf.rest('DELETE', `/sobjects/PermissionSetAssignment/${undo.id}`);
}
