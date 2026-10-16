/**
 * Saved SOQL queries: named, kept per user, exportable to a JSON file the team can share
 * (for example committed as nomadsf-queries.json in the project).
 */

export type SavedQuery = {
  name: string;
  soql: string;
  tooling: boolean;
  savedAt: string;
};

export const SAVED_QUERIES_FILE = 'nomadsf-queries.json';

/** Adds a query, replacing one with the same name (case-insensitive); newest first. */
export function upsertSavedQuery(
  list: SavedQuery[],
  query: Omit<SavedQuery, 'savedAt'>,
  now = new Date()
): SavedQuery[] {
  const name = query.name.trim();
  if (!name) throw new Error('Give the query a name.');
  if (!query.soql.trim()) throw new Error('The query is empty.');
  const entry: SavedQuery = { name, soql: query.soql.trim(), tooling: query.tooling, savedAt: now.toISOString() };
  return [entry, ...list.filter((q) => q.name.toLowerCase() !== name.toLowerCase())];
}

export function removeSavedQuery(list: SavedQuery[], name: string): SavedQuery[] {
  return list.filter((q) => q.name !== name);
}

export function exportSavedQueries(list: SavedQuery[]): string {
  return `${JSON.stringify({ nomadsf: 'queries', version: 1, queries: list }, null, 2)}\n`;
}

/** Reads an export (or a plain array) and merges it in; imported queries win on the same name. */
export function importSavedQueries(list: SavedQuery[], text: string): { list: SavedQuery[]; added: number } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not a JSON file.');
  }
  const raw = Array.isArray(parsed) ? parsed : (parsed as { queries?: unknown })?.queries;
  if (!Array.isArray(raw)) throw new Error('No saved queries in this file.');
  const incoming = raw
    .filter(
      (q): q is Partial<SavedQuery> & { name: string; soql: string } =>
        typeof q === 'object' && q !== null && typeof q.name === 'string' && typeof q.soql === 'string'
    )
    .map((q) => ({
      name: q.name.trim(),
      soql: q.soql.trim(),
      tooling: Boolean(q.tooling),
      savedAt: typeof q.savedAt === 'string' ? q.savedAt : new Date().toISOString(),
    }))
    .filter((q) => q.name && q.soql);
  const names = new Set(incoming.map((q) => q.name.toLowerCase()));
  return { list: [...incoming, ...list.filter((q) => !names.has(q.name.toLowerCase()))], added: incoming.length };
}
