type Named = { name: string; label?: string };

/**
 * Objects in the order a person expects while typing: the exact name or label first, then
 * names and labels that start with the text, then the rest that contain it.
 */
export function rankObjects<T extends Named>(objects: T[], typed: string): T[] {
  const needle = typed.trim().toLowerCase();
  if (!needle) return objects;
  const rank = (o: T): number => {
    const name = o.name.toLowerCase();
    const label = (o.label ?? '').toLowerCase();
    if (name === needle || label === needle) return 0;
    if (name.startsWith(needle)) return 1;
    if (label.startsWith(needle)) return 2;
    if (name.includes(needle) || label.includes(needle)) return 3;
    return 4;
  };
  return objects
    .map((o, i) => ({ o, i, r: rank(o) }))
    .sort((a, b) => a.r - b.r || a.o.name.length - b.o.name.length || a.i - b.i)
    .map((x) => x.o);
}

/** A datalist of objects, ordered by what is typed (browsers keep the options' order). */
export function ObjectOptions({ id, objects, typed }: { id: string; objects: Named[]; typed: string }) {
  return (
    <datalist id={id}>
      {rankObjects(objects, typed).map((o) => (
        <option key={o.name} value={o.name}>
          {o.label}
        </option>
      ))}
    </datalist>
  );
}
