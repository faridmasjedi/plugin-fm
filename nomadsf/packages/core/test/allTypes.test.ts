import { describe, expect, it } from 'vitest';
import {
  REGISTRY_FOLDERS,
  REGISTRY_IN_FOLDER,
  REGISTRY_SUFFIXES,
  analyzeProject,
  resolveComponent,
  type ProjectFs,
} from '../src/index.js';

// Every type the Salesforce CLI knows (sourceRegistry.ts, generated from its registry): found in its folder, in a
// sub-folder of it, and — for endings no other type has — outside any folder, by the resolver and the project scan alike
const d = 'force-app/main/default';
/** Types kept in folders of their own: a component is Folder/Name, in nested folders too. */
const FOLDERED = new Set(['reports', 'dashboards', 'documents', 'email']);
const where = (folder: string, sub: string): string => (FOLDERED.has(folder) ? `F/${sub}` : sub);
/** Folders of reports and the like are listed under the type itself (package.xml: Report "Sales"). */
const expected = (type: string): string =>
  type.replace(/^(Report|Dashboard|Document|EmailTemplate|Email)Folder$/, '$1').replace(/^Email$/, 'EmailTemplate');
const cases = Object.entries(REGISTRY_IN_FOLDER)
  .map(([key, type]) => {
    const [folder, ending] = key.split('/');
    return {
      folder,
      ending,
      type: expected(type),
      kind: REGISTRY_FOLDERS[folder][1],
      n: `C${ending.replace(/\W/g, '')}`,
    };
  })
  .filter((c) => (c.kind === 'file' || c.kind === 'content') && c.folder !== 'labels')
  .filter((c) => !/Folder$/.test(REGISTRY_IN_FOLDER[`${c.folder}/${c.ending}`]));

describe('every metadata type the Salesforce CLI knows', () => {
  it('is found in its folder and in a sub-folder of it', () => {
    const wrong: string[] = [];
    for (const c of cases)
      for (const sub of ['', 'sub/x/']) {
        const dir = where(c.folder, sub);
        const path = `${d}/${c.folder}/${dir}${c.n}.${c.ending}-meta.xml`;
        const name = FOLDERED.has(c.folder) ? `${dir}${c.n}` : c.n;
        const found = resolveComponent(path, ['force-app']);
        if (found?.type !== c.type || found.name !== name) wrong.push(`${path} → ${found?.type}:${found?.name}`);
      }
    expect(cases.length).toBeGreaterThan(400);
    expect(wrong).toEqual([]);
  });

  it('is found outside any folder by its ending, when no other type has that ending', () => {
    const wrong = Object.entries(REGISTRY_SUFFIXES)
      .map(([ending, [type]]) => ({ ending, type, path: `${d}/billing/X.${ending}-meta.xml` }))
      .filter(({ type, path }) => resolveComponent(path, ['force-app'])?.type !== type)
      .map(({ path }) => path);
    expect(Object.keys(REGISTRY_SUFFIXES).length).toBeGreaterThan(400);
    expect(wrong).toEqual([]);
  });

  it('a project folder named like a type folder: a file there goes by its own ending', () => {
    expect(resolveComponent(`${d}/rules/Bill.cls`, ['force-app'])).toMatchObject({ type: 'ApexClass', name: 'Bill' });
    expect(resolveComponent(`${d}/functions/Ops.permissionset-meta.xml`, ['force-app'])).toMatchObject({
      type: 'PermissionSet',
      name: 'Ops',
    });
  });

  it('the project scan lists them all, the same way', async () => {
    const files: Record<string, string> = {
      'sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'force-app' }] }),
    };
    for (const c of cases) files[`${d}/${c.folder}/${where(c.folder, 'sub/')}${c.n}.${c.ending}-meta.xml`] = '<x/>';
    const fs: ProjectFs = {
      name: 'all',
      readText: async (p) => files[p],
      list: async (dir) => {
        const prefix = dir ? `${dir}/` : '';
        const m = new Map<string, 'file' | 'dir'>();
        for (const p of Object.keys(files))
          if (p.startsWith(prefix)) {
            const [f, ...r] = p.slice(prefix.length).split('/');
            m.set(f, r.length ? 'dir' : 'file');
          }
        return [...m].map(([name, kind]) => ({ name, kind }));
      },
    };
    const listed = new Map((await analyzeProject(fs)).packageDirectories[0].types.map((t) => [t.type, t.names]));
    const missing = cases
      .filter((c) => !listed.get(c.type)?.includes(FOLDERED.has(c.folder) ? `F/sub/${c.n}` : c.n))
      .map((c) => `${c.type}:${c.n}`);
    expect(missing).toEqual([]);
  });
});
