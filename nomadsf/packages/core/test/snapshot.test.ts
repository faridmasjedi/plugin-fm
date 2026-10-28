import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  applySnapshot,
  diffSnapshot,
  parseSnapshot,
  snapshotCsv,
  type HttpRequest,
  type SnapshotLine,
} from '../src/index.js';

const line = (Section: SnapshotLine['Section'], Name: string, Value = ''): SnapshotLine => ({ Section, Name, Value });

describe('user snapshot', () => {
  const kept: SnapshotLine[] = [
    line('info', 'user', 'ann@acme.com'),
    line('field', 'Title', 'Head of Sales'),
    line('field', 'IsActive', 'true'),
    line('field', 'Username', 'ann@acme.com'),
    line('lookup', 'ProfileId', 'Sales Manager'),
    line('lookup', 'ManagerId', 'bob@acme.com'),
    line('permissionSet', 'Sales_Ops'),
    line('license', 'SalesConsoleUser'),
    line('group', 'Support_Queue', 'Queue'),
    line('app', 'Salesforce CLI'),
  ];

  it('goes to CSV and back, also after Excel (byte-order mark)', () => {
    expect(parseSnapshot(`﻿${snapshotCsv(kept)}`)).toEqual(kept);
    expect(() => parseSnapshot('a,b\n1,2')).toThrow(/Section, Name and Value/);
  });

  it('lists what differs: fields, lookups by name, missing and extra access', () => {
    const now: SnapshotLine[] = [
      line('info', 'user', 'ann@acme.com.uat'),
      line('field', 'Title', 'Sales Rep'),
      line('field', 'IsActive', 'TRUE'),
      line('field', 'Username', 'ann@acme.com.uat'),
      line('lookup', 'ProfileId', 'Standard User'),
      line('lookup', 'ManagerId', 'bob@acme.com.uat'),
      line('permissionSet', 'Old_Access'),
      line('license', 'SalesConsoleUser'),
      line('app', 'Data Loader'),
    ];
    const diff = diffSnapshot(kept, now);
    expect(diff.map((d) => `${d.section}:${d.name}:${d.action}`)).toEqual([
      'field:Title:set the field',
      'lookup:ProfileId:point it to the snapshot’s record',
      'permissionSet:Old_Access:remove',
      'permissionSet:Sales_Ops:assign',
      'group:Support_Queue:add to the queue',
      'app:Data Loader:used here only (revoke it in Org › Connected apps)',
      'app:Salesforce CLI:the user connects it (signs in to the app)',
    ]);
    expect(diff.filter((d) => d.checkOnly).map((d) => d.name)).toEqual(['Data Loader', 'Salesforce CLI']);
    expect(diff.find((d) => d.name === 'Old_Access')?.extra).toBe(true);
  });

  it('applies the chosen differences by name in the other org, and reports what failed', async () => {
    const sent: string[] = [];
    const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
    const client = new SalesforceClient(async (r: HttpRequest) => {
      if (r.path.endsWith('/sobjects/User/describe'))
        return json({
          fields: [
            { name: 'Title', type: 'string', updateable: true, createable: true, referenceTo: [] },
            { name: 'ProfileId', type: 'reference', updateable: true, createable: true, referenceTo: ['Profile'] },
          ],
        });
      if (r.method !== 'GET') {
        sent.push(`${r.method} ${r.path.replace(/^\/services\/data\/v[\d.]+/, '')} ${r.body ?? ''}`);
        return json({ id: '0Pa000000000001AAA', success: true });
      }
      const soql = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
      if (soql.includes("FROM Profile WHERE Name = 'Sales Manager'"))
        return json({ totalSize: 1, done: true, records: [{ Id: '00e000000000001AAA' }] });
      if (soql.includes("FROM PermissionSet WHERE Name = 'Sales_Ops'"))
        return json({ totalSize: 1, done: true, records: [{ Id: '0PS000000000001AAA' }] });
      return json({ totalSize: 0, done: true, records: [] });
    }, '62.0');
    const result = await applySnapshot(client, '005000000000001AAA', [
      { key: 'a', section: 'field', name: 'Title', snapshot: 'Head of Sales', org: 'Sales Rep', action: '' },
      { key: 'b', section: 'lookup', name: 'ProfileId', snapshot: 'Sales Manager', org: 'Standard User', action: '' },
      { key: 'c', section: 'permissionSet', name: 'Sales_Ops', snapshot: '✓', org: '', action: '' },
      { key: 'd', section: 'permissionSet', name: 'Missing_Set', snapshot: '✓', org: '', action: '' },
    ]);
    expect(sent).toEqual([
      'PATCH /sobjects/User/005000000000001AAA {"Title":"Head of Sales","ProfileId":"00e000000000001AAA"}',
      'POST /sobjects/PermissionSetAssignment {"AssigneeId":"005000000000001AAA","PermissionSetId":"0PS000000000001AAA"}',
    ]);
    expect(result.failed).toEqual([
      { item: 'add permissionSet Missing_Set', error: 'Permission set Missing_Set is not in this org.' },
    ]);
  });
});
