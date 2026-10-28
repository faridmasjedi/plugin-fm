import { describe, expect, it } from 'vitest';
import { SalesforceClient, createdBetween, storageReport, type HttpRequest } from '../src/index.js';

const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });

describe('storage', () => {
  it('reads data and file storage, and records per object (largest first; empty and setup objects left out)', async () => {
    const client = new SalesforceClient(async (r: HttpRequest) => {
      if (r.path.endsWith('/limits'))
        return json({ DataStorageMB: { Max: 5, Remaining: 3 }, FileStorageMB: { Max: 20, Remaining: 20 } });
      if (r.path.endsWith('/sobjects'))
        return json({
          sobjects: ['Case', 'Lead', 'Account']
            .map((name) => ({ name, layoutable: true, customSetting: false }))
            .concat([{ name: 'FieldPermissions', layoutable: false, customSetting: false }]),
        });
      return json({
        sObjects: [
          { name: 'Case', count: 1024 },
          { name: 'Lead', count: 0 },
          { name: 'Account', count: 2048 },
          { name: 'FieldPermissions', count: 34600 },
        ],
      });
    }, '62.0');
    const r = await storageReport(client);
    expect(r.dataMB).toEqual({ used: 2, max: 5 });
    expect(r.fileMB).toEqual({ used: 0, max: 20 });
    expect(r.objects).toEqual([
      { object: 'Account', records: 2048, estimatedMB: 4 },
      { object: 'Case', records: 1024, estimatedMB: 2 },
    ]);
  });

  it('filters records created in a period, and refuses anything but dates', () => {
    expect(createdBetween('2026-01-01', '2026-02-01')).toBe(
      'CreatedDate >= 2026-01-01T00:00:00Z AND CreatedDate < 2026-02-01T00:00:00Z'
    );
    expect(createdBetween(undefined, '2026-02-01')).toBe('CreatedDate < 2026-02-01T00:00:00Z');
    expect(createdBetween()).toBe('');
    expect(() => createdBetween("2026-01-01' OR Name != '")).toThrow(/YYYY-MM-DD/);
  });
});
