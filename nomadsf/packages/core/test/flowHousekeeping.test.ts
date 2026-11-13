import { describe, expect, it } from 'vitest';
import { oldApiFlows, oldVersions, type FlowVersion } from '../src/index.js';

const v = (flow: string, version: number, status: string, apiVersion = 60): FlowVersion => ({
  id: `301${flow}${version}`,
  flow,
  label: flow,
  version,
  status,
  apiVersion,
  processType: 'AutoLaunchedFlow',
  lastModified: '',
});

describe('flow housekeeping', () => {
  it('finds versions that do not run, keeping the active and the newest one', () => {
    const all = [
      v('A', 3, 'Draft'),
      v('A', 2, 'Active'),
      v('A', 1, 'Obsolete'),
      v('B', 2, 'Obsolete'),
      v('B', 1, 'Obsolete'),
    ];
    expect(oldVersions(all).map((x) => `${x.flow}${x.version}`)).toEqual(['A1', 'B1']);
  });
  it('finds active flows on an old API version', () => {
    const all = [v('A', 1, 'Active', 48), v('B', 1, 'Active', 62), v('C', 1, 'Obsolete', 40)];
    expect(oldApiFlows(all, 55).map((x) => x.flow)).toEqual(['A']);
  });
});
