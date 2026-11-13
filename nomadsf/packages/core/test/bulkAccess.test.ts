import { describe, expect, it } from 'vitest';
import { bulkAccess, type BulkItem, type SalesforceClient } from '../src/index.js';

// Ann (005A…) already has the permission set and is in the queue; Bob (005B…) has nothing
const ANN = '005000000000001AAA';
const BOB = '005000000000002AAA';
const PS = '0PS000000000001AAA';
const QUEUE = '00G000000000001AAA';

/** A fake org: answers the two lookups, records what is inserted and deleted. */
function fakeOrg() {
  const inserted: Array<Record<string, unknown>> = [];
  const deleted: string[] = [];
  const client = {
    rest: async (method: string, path: string, body?: { records: Array<Record<string, unknown>> }) => {
      if (method === 'POST') {
        inserted.push(...body!.records);
        return body!.records.map(() => ({ success: true, errors: [] }));
      }
      if (method === 'DELETE') {
        const ids = decodeURIComponent(path)
          .match(/ids=([^&]+)/)![1]
          .split(',');
        deleted.push(...ids);
        return ids.map(() => ({ success: true, errors: [] }));
      }
      const soql = decodeURIComponent(path.replace(/^\/query\/?\?q=/, '').replace(/\+/g, ' '));
      const records = /FROM PermissionSetAssignment/.test(soql)
        ? [{ Id: '0Pa000000000001AAA', AssigneeId: ANN, PermissionSetId: PS, PermissionSetGroupId: null }]
        : /FROM GroupMember/.test(soql)
        ? [{ Id: '011000000000001AAA', GroupId: QUEUE, UserOrGroupId: ANN }]
        : [];
      return { done: true, totalSize: records.length, records: records.map((r) => ({ attributes: {}, ...r })) };
    },
    version: async () => '62.0',
  } as unknown as SalesforceClient;
  return { client, inserted, deleted };
}

const items: BulkItem[] = [
  { kind: 'Permission set', id: PS, label: 'Sales Ops' },
  { kind: 'Queue', id: QUEUE, label: 'Tier 1 Support' },
];
const users = [
  { id: ANN, name: 'Ann Lee' },
  { id: BOB, name: 'Bob Ray' },
];

describe('access in bulk', () => {
  it('adds only what each user lacks, and says so per user', async () => {
    const org = fakeOrg();
    const lines = await bulkAccess(org.client, items, users, 'add', '2026-12-31');
    expect(lines.map((l) => `${l.user}|${l.item}|${l.result}`)).toEqual([
      'Ann Lee|Sales Ops|already had it',
      'Ann Lee|Tier 1 Support|already had it',
      'Bob Ray|Sales Ops|added',
      'Bob Ray|Tier 1 Support|added',
    ]);
    expect(org.inserted).toEqual([
      expect.objectContaining({ AssigneeId: BOB, PermissionSetId: PS, ExpirationDate: '2026-12-31' }),
      expect.objectContaining({ GroupId: QUEUE, UserOrGroupId: BOB }),
    ]);
  });

  it('removes only what each user has', async () => {
    const org = fakeOrg();
    const lines = await bulkAccess(org.client, items, users, 'remove');
    expect(lines.filter((l) => l.result === 'removed').map((l) => `${l.user}|${l.item}`)).toEqual([
      'Ann Lee|Sales Ops',
      'Ann Lee|Tier 1 Support',
    ]);
    expect(lines.filter((l) => l.result === 'did not have it')).toHaveLength(2);
    expect(org.deleted).toEqual(['0Pa000000000001AAA', '011000000000001AAA']);
  });

  it('asks for users and items', async () => {
    const org = fakeOrg();
    await expect(bulkAccess(org.client, items, [], 'add')).rejects.toThrow('Choose at least one user');
    await expect(bulkAccess(org.client, [], users, 'add')).rejects.toThrow('Choose at least one permission set');
  });
});
