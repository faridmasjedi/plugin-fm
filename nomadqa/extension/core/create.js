// Creating the records in the org (parents first), deleting a batch, and CSV files of a plan.

/**
 * Creates the records object by object (parents first); a child gets its parent's new Id, and is not tried when its
 * parent failed. Up to `parallel` calls of 200 records go at once. `progress(done, total)` after each call,
 * `saved(object, ids)` with the Ids each call made (to keep the batch as it grows), `stop()` true ends it early.
 * Returns { ids: {object: [ids]}, created, failed: [{key, object, message}], stopped }.
 */
export async function createRecords(
  sf,
  records,
  { allowDuplicates = false, parallel = 4, progress = () => {}, saved = () => {}, stop = () => false } = {}
) {
  const idOf = new Map();
  const ids = {};
  const failed = [];
  const nodes = [];
  for (const r of records) if (!nodes.includes(r.nodeId)) nodes.push(r.nodeId);
  let done = 0;
  let stopped = false;
  for (const nodeId of nodes) {
    if (stopped) break;
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
      if (missing) failed.push({ key: r.key, object, message: 'its parent was not created' });
      else ready.push({ r, values });
    }
    done += list.length - ready.length;
    const chunks = [];
    for (let i = 0; i < ready.length; i += 200) chunks.push(ready.slice(i, i + 200));
    let next = 0;
    const worker = async () => {
      while (next < chunks.length && !stopped) {
        if (stop()) {
          stopped = true;
          break;
        }
        const chunk = chunks[next++];
        let res;
        try {
          res = await sf.insert(
            object,
            chunk.map((x) => x.values),
            { allowDuplicates }
          );
        } catch (e) {
          res = chunk.map(() => ({ error: e.message }));
        }
        const made = [];
        res.forEach((x, i) => {
          if (x.id) {
            idOf.set(chunk[i].r.key, x.id);
            made.push(x.id);
          } else failed.push({ key: chunk[i].r.key, object, message: x.error });
        });
        if (made.length) {
          (ids[object] ??= []).push(...made);
          saved(object, made);
        }
        done += chunk.length;
        progress(done, records.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, chunks.length) }, worker));
    progress(done, records.length);
  }
  return { ids, idByKey: Object.fromEntries(idOf), created: idOf.size, failed, stopped };
}

/** Failures counted by object and message: [{ object, message, count }]. */
export function failureSummary(failed) {
  const by = new Map();
  for (const f of failed) {
    const k = `${f.object}\u0000${f.message}`;
    by.set(k, { object: f.object, message: f.message, count: (by.get(k)?.count ?? 0) + 1 });
  }
  return [...by.values()].sort((a, b) => b.count - a.count);
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
