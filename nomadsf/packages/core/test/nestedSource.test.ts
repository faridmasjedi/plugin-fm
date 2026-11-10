import { describe, expect, it } from 'vitest';
import {
  analyzeProject,
  projectCodeIndex,
  projectMetadataZip,
  readZip,
  resolveComponent,
  type ProjectFs,
} from '../src/index.js';

// A big project keeps its classes in sub-folders, and some Apex outside any type folder: the CLI accepts both
const d = 'force-app/main/default';
const files: Record<string, string> = {
  'sfdx-project.json': JSON.stringify({ packageDirectories: [{ path: 'force-app', default: true }] }),
  [`${d}/classes/Top.cls`]: 'public class Top {}',
  [`${d}/classes/Top.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/classes/services/Billing.cls`]: 'public class Billing {}',
  [`${d}/classes/services/Billing.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/classes/services/deep/er/Tax.cls`]: 'public class Tax {}',
  [`${d}/classes/services/deep/er/Tax.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/permissionsets/admin/Ops.permissionset-meta.xml`]: '<PermissionSet/>',
  [`${d}/domains/cases/CaseService.cls`]: 'public class CaseService {}',
  [`${d}/domains/cases/CaseService.cls-meta.xml`]: '<ApexClass/>',
  [`${d}/domains/cases/CaseTrigger.trigger`]: 'trigger CaseTrigger on Case (before insert) {}',
  [`${d}/domains/cases/CaseTrigger.trigger-meta.xml`]: '<ApexTrigger/>',
  [`${d}/domains/cases/Case_Close.flow-meta.xml`]: '<Flow/>',
  [`${d}/domains/cases/Case_Agent.permissionset-meta.xml`]: '<PermissionSet/>',
  [`${d}/flows/archive/2024/Old_Flow.flow-meta.xml`]: '<Flow/>',
};

const fs: ProjectFs = {
  name: 'big',
  list: async (dir) => {
    const prefix = dir ? `${dir}/` : '';
    const names = new Map<string, 'file' | 'dir'>();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(prefix)) continue;
      const [first, ...rest] = path.slice(prefix.length).split('/');
      names.set(first, rest.length ? 'dir' : 'file');
    }
    return [...names].map(([name, kind]) => ({ name, kind }));
  },
  readText: async (path) => files[path],
};

describe('components in sub-folders and outside type folders', () => {
  it('the project lists every class, wherever it is kept', async () => {
    const info = await analyzeProject(fs);
    const types = info.packageDirectories[0].types;
    expect(types.find((t) => t.type === 'ApexClass')?.names).toEqual(['Billing', 'CaseService', 'Tax', 'Top']);
    expect(types.find((t) => t.type === 'ApexTrigger')?.names).toEqual(['CaseTrigger']);
    expect(types.find((t) => t.type === 'PermissionSet')?.names).toEqual(['Case_Agent', 'Ops']);
    expect(types.find((t) => t.type === 'Flow')?.names).toEqual(['Case_Close', 'Old_Flow']);
    const index = projectCodeIndex(info, 'ApexClass');
    expect(index.get('Top')).toEqual([`${d}/classes`]);
    expect(index.get('Tax')).toEqual([`${d}/classes/services/deep/er`]);
    expect(index.get('CaseService')).toEqual([`${d}/domains/cases`]);
  });

  it('resolves each file to its component', () => {
    expect(resolveComponent(`${d}/classes/services/Billing.cls`, ['force-app'])).toMatchObject({
      type: 'ApexClass',
      name: 'Billing',
      typeFolder: 'classes',
    });
    expect(resolveComponent(`${d}/domains/cases/CaseTrigger.trigger-meta.xml`, ['force-app'])).toMatchObject({
      type: 'ApexTrigger',
      name: 'CaseTrigger',
    });
    expect(resolveComponent(`${d}/domains/cases/README.md`, ['force-app'])).toBeUndefined();
  });

  it('puts them where the Metadata API wants them in the deploy zip', async () => {
    const info = await analyzeProject(fs);
    const result = await projectMetadataZip({
      fs,
      info,
      deploy: [
        { type: 'ApexClass', name: 'Tax' },
        { type: 'ApexClass', name: 'CaseService' },
        { type: 'ApexTrigger', name: 'CaseTrigger' },
        { type: 'PermissionSet', name: 'Ops' },
        { type: 'Flow', name: 'Case_Close' },
        { type: 'Flow', name: 'Old_Flow' },
      ],
      apiVersion: '62.0',
    });
    expect(result.notConverted).toEqual([]);
    expect([...(await readZip(result.zip)).keys()].sort()).toEqual([
      'classes/CaseService.cls',
      'classes/CaseService.cls-meta.xml',
      'classes/Tax.cls',
      'classes/Tax.cls-meta.xml',
      'flows/Case_Close.flow',
      'flows/Old_Flow.flow',
      'package.xml',
      'permissionsets/Ops.permissionset',
      'triggers/CaseTrigger.trigger',
      'triggers/CaseTrigger.trigger-meta.xml',
    ]);
  });
});
