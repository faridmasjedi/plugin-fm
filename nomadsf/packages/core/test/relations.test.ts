import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  childrenSoql,
  flattenParents,
  recordChildren,
  recordParents,
  type HttpRequest,
} from '../src/index.js';

const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
const ref = (name: string, to: string[]) => ({ name, label: name, type: 'reference', referenceTo: to });
const text = (name: string, nameField = false) => ({ name, label: name, type: 'string', referenceTo: [], nameField });

const CONTACT = '003000000000001AAA';
const ACCOUNT = '001000000000001AAA';
const OWNER = '005000000000001AAA';

/** Contact → Account → (Owner, Parent = the same account again); Created by everywhere. */
function org(): { client: SalesforceClient; soql: string[] } {
  const soql: string[] = [];
  const describes: Record<string, unknown> = {
    Contact: {
      name: 'Contact',
      label: 'Contact',
      fields: [text('Name', true), ref('AccountId', ['Account']), ref('CreatedById', ['User'])],
      childRelationships: [
        { childSObject: 'Case', field: 'ContactId', relationshipName: 'Cases' },
        { childSObject: 'ContactHistory', field: 'ContactId', relationshipName: 'Histories' },
        { childSObject: 'Secret__c', field: 'Contact__c', relationshipName: 'Secrets__r' },
        { childSObject: 'Broken__c', field: 'Contact__c', relationshipName: 'Broken__r' },
        { childSObject: 'Hidden', field: 'ContactId', relationshipName: null },
        { childSObject: 'Case', field: 'CreatedById', relationshipName: null },
      ],
    },
    Account: {
      name: 'Account',
      label: 'Account',
      fields: [text('Name', true), ref('OwnerId', ['User', 'Group']), ref('ParentId', ['Account'])],
      childRelationships: [],
    },
    User: {
      name: 'User',
      label: 'User',
      fields: [text('Name', true), ref('ManagerId', ['User'])],
      childRelationships: [],
    },
    Case: {
      name: 'Case',
      label: 'Case',
      fields: [text('CaseNumber', true), text('CreatedDate')],
      childRelationships: [],
    },
  };
  const records: Record<string, Record<string, unknown>> = {
    [CONTACT]: { Name: 'Ann', AccountId: ACCOUNT, CreatedById: OWNER },
    [ACCOUNT]: { Name: 'Acme', OwnerId: OWNER, ParentId: ACCOUNT },
    [OWNER]: { Name: 'Farid', ManagerId: null },
  };
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const path = r.path.replace(/^\/services\/data\/v[\d.]+/, '');
    const described = /^\/sobjects\/(\w+)\/describe$/.exec(path)?.[1];
    if (described) return json(describes[described]);
    if (path === '/sobjects')
      return json({
        sobjects: ['Contact', 'Account', 'User', 'Case', 'ContactHistory', 'Broken__c', 'Hidden'].map((name) => ({
          name,
          queryable: true,
          keyPrefix: { Account: '001', User: '005', Contact: '003' }[name],
        })),
      });
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    soql.push(q);
    if (q.startsWith('SELECT COUNT()')) {
      if (q.includes('Broken__c')) return { status: 400, headers: {}, body: '[{"message":"no"}]' };
      return json({ totalSize: q.includes('FROM Case') ? 3 : 2, done: true, records: [] });
    }
    const id = /Id = '(\w+)'/.exec(q)?.[1] ?? '';
    return json({ totalSize: 1, done: true, records: [records[id] ?? {}] });
  }, '62.0');
  return { client, soql };
}

describe('record relations', () => {
  it('follows lookups up, without Created by, and stops at a record already shown', async () => {
    const { client } = org();
    const tree = await recordParents(client, 'Contact', CONTACT);
    expect(tree.name).toBe('Ann');
    expect(tree.parents).toHaveLength(1);
    const account = tree.parents[0];
    expect(account).toMatchObject({ field: 'AccountId', object: 'Account', id: ACCOUNT, name: 'Acme' });
    // OwnerId points to User or Group: the Id says which
    expect(account.parents.map((p) => [p.field, p.object, p.name, p.repeated ?? false])).toEqual([
      ['OwnerId', 'User', 'Farid', false],
      ['ParentId', 'Account', '', true],
    ]);
    expect(flattenParents(tree.parents).map((r) => `${r.Level} ${r.Path} ${r.Name}`)).toEqual([
      '1 AccountId Acme',
      '2 AccountId.OwnerId Farid',
      '2 AccountId.ParentId (shown above)',
    ]);

    const withAudit = await recordParents(client, 'Contact', CONTACT, { audit: true, depth: 1 });
    expect(withAudit.parents.map((p) => p.field)).toEqual(['AccountId', 'CreatedById']);
    expect(withAudit.parents.every((p) => p.parents.length === 0)).toBe(true);
  });

  it('counts the children per relationship, skipping what cannot be read', async () => {
    const { client } = org();
    const children = await recordChildren(client, 'Contact', CONTACT);
    // No relationship name (like OwnerId on a user) is still a relationship
    expect(children.map((c) => [c.object, c.field, c.count])).toEqual([
      ['Case', 'ContactId', 3],
      ['Hidden', 'ContactId', 2],
    ]);
    const progress: string[] = [];
    const all = await recordChildren(client, 'Contact', CONTACT, {
      system: true,
      onProgress: (n, total) => progress.push(`${n}/${total}`),
    });
    expect(all.map((c) => [c.object, c.field, c.system])).toEqual([
      ['Case', 'ContactId', false],
      ['Case', 'CreatedById', true],
      ['ContactHistory', 'ContactId', true],
      ['Hidden', 'ContactId', false],
    ]);
    expect(progress.at(-1)).toBe('5/5');
    expect(await childrenSoql(client, { object: 'Case', field: 'ContactId' }, CONTACT, 50)).toBe(
      `SELECT Id, CaseNumber, CreatedDate FROM Case WHERE ContactId = '${CONTACT}' ORDER BY CreatedDate DESC LIMIT 50`
    );
  });
});
