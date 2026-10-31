import { buildGraph, selectTests, sourcesFromRecords, type ApexSource, type TestSelection } from './apexGraph.js';
import type { SalesforceClient } from './client.js';
import { query } from './query.js';

/**
 * The test classes to run for a package: those that reach its Apex classes and triggers, through the classes they call
 * and the triggers they fire by writing records (apexGraph.ts). The Apex is read from the source the package comes from
 * — a project folder or a branch, or an org — and the person can add or remove tests before validating.
 */

/** The Apex of a project or branch: its .cls and .trigger files. */
export async function apexSourcesFromFiles(
  files: string[],
  read: (path: string) => Promise<string>
): Promise<ApexSource[]> {
  const apex = files.filter((f) => /\.(cls|trigger)$/.test(f));
  return Promise.all(
    apex.map(async (file) => ({
      name: (file.split('/').pop() ?? file).replace(/\.(cls|trigger)$/, ''),
      kind: file.endsWith('.cls') ? ('class' as const) : ('trigger' as const),
      body: await read(file),
      file,
    }))
  );
}

/** The Apex of an org (its own, not installed packages'), through the Tooling API. */
export async function apexSourcesFromOrg(client: SalesforceClient): Promise<ApexSource[]> {
  const [classes, triggers] = await Promise.all([
    query(client, 'SELECT Name, Body FROM ApexClass WHERE NamespacePrefix = null', { tooling: true, maxRows: 10000 }),
    query(client, 'SELECT Name, Body FROM ApexTrigger WHERE NamespacePrefix = null', {
      tooling: true,
      maxRows: 10000,
    }),
  ]);
  const records = (rows: Array<Record<string, unknown>>): Array<{ Name: string; Body?: string }> =>
    rows.map((r) => ({ Name: String(r.Name), Body: typeof r.Body === 'string' ? r.Body : undefined }));
  return sourcesFromRecords(records(classes.rows), records(triggers.rows));
}

/** The tests for the Apex classes and triggers of a package, from the Apex around them. */
export function testsForPackage(
  sources: ApexSource[],
  components: Array<{ type: string; name: string }>
): TestSelection {
  const apex = components.filter((c) => c.type === 'ApexClass' || c.type === 'ApexTrigger').map((c) => c.name);
  return selectTests(buildGraph(sources), apex);
}
