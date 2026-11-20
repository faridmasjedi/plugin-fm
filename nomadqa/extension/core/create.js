// Creating the records in the org (parents first), deleting a batch, and CSV files of a plan.

/**
 * Creates the records node by node; a child gets its parent's new Id, and is not tried when its parent failed.
 * `progress(done, total)` is called as it goes. Returns { ids: {object: [ids]}, created, failed: [{key, message}] }.
 */
export async function createRecords(sf, records, { allowDuplicates = false, progress = () => {} } = {}) {
  const idOf = new Map();
  const ids = {};
  const failed = [];
  const nodes = [];
  for (const r of records) if (!nodes.includes(r.nodeId)) nodes.push(r.nodeId);
  let done = 0;
  for (const nodeId of nodes) {
    const list = records.filter((r) => r.nodeId === nodeId);
    const object = list[0].object;
    const ready = [];
    for (const r of list) {
      const values = {};
      let missing = '';
      for (const [k, v] of Object.entries(r.values)) {
        if (v && typeof v === 'object' && v.$ref) {
          if (!idOf.has(v.$ref)) missing = v.$ref;
          else values[k] = idOf.get(v.$ref);
        } else values[k] = v;
      }
      if (missing) failed.push({ key: r.key, message: 'its parent was not created' });
      else ready.push({ r, values });
    }
    // eslint-disable-next-line no-await-in-loop
    const res = ready.length
      ? await sf.insert(
          object,
          ready.map((x) => x.values),
          { allowDuplicates }
        )
      : [];
    res.forEach((x, i) => {
      if (x.id) {
        idOf.set(ready[i].r.key, x.id);
        (ids[object] ??= []).push(x.id);
      } else failed.push({ key: ready[i].r.key, message: x.error });
    });
    done += list.length;
    progress(done, records.length);
  }
  return { ids, created: idOf.size, failed };
}

/** Deletes a batch: children before parents (the reverse of how it was made). */
export async function deleteBatch(sf, batch) {
  let deleted = 0;
  const problems = [];
  for (const object of [...batch.order].reverse()) {
    const list = batch.ids[object] ?? [];
    if (!list.length) continue;
    // eslint-disable-next-line no-await-in-loop
    const r = await sf.remove(list);
    deleted += r.deleted;
    problems.push(...r.problems);
  }
  return { deleted, problems };
}

/** How many records of a batch are still in the org. */
export async function stillThere(sf, batch) {
  let n = 0;
  for (const [object, list] of Object.entries(batch.ids)) {
    for (let i = 0; i < list.length; i += 300) {
      const chunk = list
        .slice(i, i + 300)
        .map((id) => `'${id}'`)
        .join(',');
      // eslint-disable-next-line no-await-in-loop
      const r = await sf.rest(
        'GET',
        `/query?q=${encodeURIComponent(`SELECT COUNT() FROM ${object} WHERE Id IN (${chunk})`)}`
      );
      n += r.totalSize ?? 0;
    }
  }
  return n;
}

const cell = (v) => {
  const s = v && typeof v === 'object' ? v.$ref ?? JSON.stringify(v) : String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One CSV per object, with a key per record and its parent's key (to join them in Data Loader or Excel). */
export function csvFiles(records) {
  const files = {};
  const byObject = new Map();
  for (const r of records) byObject.set(r.object, [...(byObject.get(r.object) ?? []), r]);
  for (const [object, list] of byObject) {
    const fields = [...new Set(list.flatMap((r) => Object.keys(r.values)))];
    const rows = [['NomadQA key', 'Parent key', ...fields].join(',')];
    for (const r of list)
      rows.push([r.key, r.parentKey ?? '', ...fields.map((f) => cell(r.values[f]))].map(cell).join(','));
    files[`${object}.csv`] = `${rows.join('\n')}\n`;
  }
  return files;
}
