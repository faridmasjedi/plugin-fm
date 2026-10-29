import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  childRecords,
  childRelations,
  childrenSoql,
  copyObjects,
  copySheets,
  copyUsers,
  fromCopySheets,
  planUsers,
  recordLookups,
  relationCounts,
  userCopy,
  withoutEntries,
  type FileTable,
  type HttpRequest,
  type UserCopy,
} from '../src/index.js';

const json = (body: unknown) => ({ status: 200, headers: {}, body: JSON.stringify(body) });
const ref = (name: string, to: string[]) => ({ name, label: name, type: 'reference', referenceTo: to });
const text = (name: string, nameField = false) => ({ name, label: name, type: 'string', referenceTo: [], nameField });
const soqlOf = (r: HttpRequest): string => decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');

const CONTACT = '003000000000001AAA';
const ACCOUNT = '001000000000001AAA';
const OWNER = '005000000000001AAA';

function org(): { client: SalesforceClient; soql: string[] } {
  const soql: string[] = [];
  const describes: Record<string, unknown> = {
    Contact: {
      name: 'Contact',
      fields: [text('Name', true), ref('AccountId', ['Account']), ref('CreatedById', ['User'])],
      childRelationships: [
        { childSObject: 'Case', field: 'ContactId' },
        { childSObject: 'Case', field: 'ContactId' },
        { childSObject: 'ContactHistory', field: 'ContactId' },
        { childSObject: 'Secret__c', field: 'Contact__c' },
      ],
    },
    Account: { name: 'Account', fields: [text('Name', true), ref('OwnerId', ['User', 'Group'])] },
    User: {
      name: 'User',
      fields: [text('Name', true)],
      childRelationships: [
        { childSObject: 'Account', field: 'OwnerId' },
        { childSObject: 'PermissionSetAssignment', field: 'AssigneeId' },
      ],
    },
    Case: { name: 'Case', fields: [text('CaseNumber', true), text('CreatedDate')] },
    PermissionSetAssignment: { name: 'PermissionSetAssignment', fields: [text('Id')] },
  };
  const records: Record<string, Record<string, unknown>> = {
    [CONTACT]: { Name: 'Ann', AccountId: ACCOUNT, CreatedById: OWNER },
    [ACCOUNT]: { Name: 'Acme', OwnerId: OWNER },
    [OWNER]: { Name: 'Farid' },
  };
  const client = new SalesforceClient(async (r: HttpRequest) => {
    const path = r.path.replace(/^\/services\/data\/v[\d.]+/, '');
    const described = /^\/sobjects\/(\w+)\/describe$/.exec(path)?.[1];
    if (described) return json(describes[described]);
    if (path === '/sobjects')
      return json({
        sobjects: ['Contact', 'Account', 'User', 'Case', 'ContactHistory', 'PermissionSetAssignment'].map((name) => ({
          name,
          label: name === 'PermissionSetAssignment' ? 'Permission Set Assignment' : name,
          queryable: true,
          keyPrefix: { Account: '001', User: '005', Contact: '003' }[name],
        })),
      });
    const q = soqlOf(r);
    soql.push(q);
    if (q.includes('FROM PermissionSetAssignment'))
      return json({
        totalSize: 2,
        done: true,
        records: [
          { Id: '0Pa000000000001AAA', 'PermissionSet.Label': 'Sales Ops' },
          { Id: '0Pa000000000002AAA', 'PermissionSetGroup.MasterLabel': 'Support' },
        ],
      });
    const id = /Id = '(\w+)'/.exec(q)?.[1] ?? '';
    return json({ totalSize: 1, done: true, records: [records[id] ?? {}] });
  }, '62.0');
  return { client, soql };
}

describe('record relations', () => {
  it('lists the lookups with a value and their names, Created by aside', async () => {
    const { client } = org();
    expect(await recordLookups(client, 'Contact', CONTACT)).toEqual([
      { field: 'AccountId', label: 'AccountId', object: 'Account', id: ACCOUNT, name: 'Acme' },
    ]);
    // OwnerId points to User or Group: the Id tells which
    expect((await recordLookups(client, 'Account', ACCOUNT))[0]).toMatchObject({ object: 'User', name: 'Farid' });
  });

  it('lists relationships without reading their records; a user’s access first', async () => {
    const { client, soql } = org();
    const list = await childRelations(client, 'Contact');
    expect(list.map((c) => [c.object, c.field, c.system])).toEqual([
      ['Case', 'ContactId', false],
      ['ContactHistory', 'ContactId', true],
    ]);
    expect(soql).toEqual([]);
    expect((await childRelations(client, 'User')).map((c) => [c.objectLabel, c.access])).toEqual([
      ['Permission Set Assignment', true],
      ['Account', false],
    ]);
  });

  it('reads the records of one relationship when asked, named by what they give', async () => {
    const { client } = org();
    expect(await childrenSoql(client, { object: 'Case', field: 'ContactId' }, CONTACT, 50)).toBe(
      `SELECT Id, CaseNumber, CreatedDate FROM Case WHERE ContactId = '${CONTACT}' ORDER BY CreatedDate DESC LIMIT 50`
    );
    const access = await childRecords(client, { object: 'PermissionSetAssignment', field: 'AssigneeId' }, OWNER);
    expect(access.map((a) => a.name)).toEqual(['Permission set: Sales Ops', 'Permission set group: Support']);
  });

  it('counts what points to a record when asked, leaving out empty and system relationships', async () => {
    const { client, soql } = org();
    const progress: string[] = [];
    const counted = await relationCounts(client, 'Contact', CONTACT, (n, total) => progress.push(`${n}/${total}`));
    expect(counted.map((c) => [c.object, c.count])).toEqual([['Case', 1]]);
    expect(soql.filter((q) => q.startsWith('SELECT COUNT()'))).toEqual([
      `SELECT COUNT() FROM Case WHERE ContactId = '${CONTACT}'`,
    ]);
    expect(progress).toEqual(['1/1']);
  });
});

describe('copying a record and what is ticked', () => {
  const user: UserCopy = {
    username: 'ann@acme.com',
    lines: [
      { Section: 'info', Name: 'user', Value: 'ann@acme.com' },
      { Section: 'field', Name: 'Title', Value: 'Lead' },
      { Section: 'lookup', Name: 'ProfileId', Value: 'Sales' },
      { Section: 'permissionSet', Name: 'Sales_Ops', Value: '' },
      { Section: 'permissionSetGroup', Name: 'Support', Value: '' },
    ],
  };

  it('copies exactly what is ticked: a whole relationship by its lookup, single records by Id', () => {
    expect(
      copyObjects([
        { object: 'Account', where: `Id = '${ACCOUNT}'` },
        { object: 'Contact', where: `AccountId = '${ACCOUNT}'` },
        { object: 'Contact', where: "Id = '003000000000002AAA'" },
        { object: 'Contact', where: "Id = '003000000000002AAA'" },
      ])
    ).toEqual([
      { name: 'Account', where: `Id = '${ACCOUNT}'` },
      { name: 'Contact', where: `(AccountId = '${ACCOUNT}') OR (Id = '003000000000002AAA')` },
    ]);
  });

  it('keeps users and long metadata files in a workbook and reads them back', () => {
    const xml = `<PermissionSet>${'x'.repeat(70_000)}</PermissionSet>`;
    const sheets = copySheets({
      records: { Account: [{ Id: ACCOUNT, Name: 'Acme' }] },
      users: [user],
      metadata: [{ type: 'PermissionSet', name: 'Sales_Ops', xml }],
    });
    expect(sheets.map((s) => s.name)).toEqual(['Account', 'NomadSF users', 'NomadSF metadata']);
    expect(sheets[2].columns).toEqual(['Type', 'Name', 'Xml1', 'Xml2', 'Xml3']);
    const asFile: FileTable[] = sheets.map((s) => ({
      name: s.name,
      columns: s.columns,
      rows: s.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, String(v ?? '')]))),
    }));
    const back = fromCopySheets(asFile);
    expect(back.tables.map((t) => t.name)).toEqual(['Account']);
    expect(back.users).toEqual([user]);
    expect(back.metadata[0].xml).toBe(xml);
  });

  it('takes a user with only the access ticked', () => {
    const snapshot = [...user.lines, { Section: 'license' as const, Name: 'Sales_Console', Value: '' }];
    const copy = userCopy(snapshot, [{ Section: 'permissionSet', Name: 'Sales_Ops', Value: '' }]);
    expect(copy.username).toBe('ann@acme.com');
    expect(copy.lines.filter((l) => !['info', 'field', 'lookup'].includes(l.Section))).toEqual([
      { Section: 'permissionSet', Name: 'Sales_Ops', Value: '' },
    ]);
  });

  it('in the target: finds what is missing, makes it from its file, then the user', async () => {
    const sent: string[] = [];
    const target = new SalesforceClient(async (r: HttpRequest) => {
      const path = r.path.replace(/^\/services\/data\/v[\d.]+/, '');
      if (r.path.includes('/services/Soap/m/')) {
        sent.push('deploy');
        if ((r.body ?? '').includes('checkDeployStatus'))
          return {
            status: 200,
            headers: {},
            body: '<result><done>true</done><success>true</success><status>Succeeded</status><id>0Af000000000001AAA</id></result>',
          };
        return { status: 200, headers: {}, body: '<result><id>0Af000000000001AAA</id></result>' };
      }
      if (path.endsWith('/sobjects/User/describe'))
        return json({
          fields: [
            { name: 'Title', type: 'string', updateable: true, createable: true, referenceTo: [] },
            { name: 'ProfileId', type: 'reference', updateable: true, createable: true, referenceTo: ['Profile'] },
          ],
        });
      if (r.method !== 'GET') {
        sent.push(`${r.method} ${path}`);
        return json({ id: path.endsWith('/sobjects/User') ? '005000000000009AAA' : '0Pa000000000009AAA' });
      }
      const q = soqlOf(r);
      if (q.includes('FROM PermissionSet WHERE NamespacePrefix = null AND Name IN'))
        return json({ totalSize: 0, done: true, records: [] });
      if (q.includes('FROM PermissionSetGroup WHERE DeveloperName IN'))
        return json({ totalSize: 1, done: true, records: [{ DeveloperName: 'Support' }] });
      if (q.includes("FROM Profile WHERE Name = 'Sales'"))
        return json({ totalSize: 1, done: true, records: [{ Id: '00e000000000001AAA' }] });
      if (q.includes("FROM PermissionSet WHERE Name = 'Sales_Ops'"))
        return json({ totalSize: 1, done: true, records: [{ Id: '0PS000000000001AAA' }] });
      if (q.includes("FROM PermissionSetGroup WHERE DeveloperName = 'Support'"))
        return json({ totalSize: 1, done: true, records: [{ Id: '0PG000000000001AAA' }] });
      if (q.includes("FROM User WHERE Id = '005000000000009AAA'"))
        return json({ totalSize: 1, done: true, records: [{ Username: 'ann@acme.com.uat' }] });
      return json({ totalSize: 0, done: true, records: [] });
    }, '62.0');
    const plan = await planUsers(target, [user], 'UAT');
    expect(plan.users).toEqual([{ username: 'ann@acme.com', suggested: 'ann@acme.com.uat', access: 2 }]);
    expect(plan.create).toEqual([{ type: 'PermissionSet', name: 'Sales_Ops' }]);
    const out = await copyUsers(target, [user], plan, {
      usernames: {},
      metadata: [{ type: 'PermissionSet', name: 'Sales_Ops', xml: '<PermissionSet/>' }],
    });
    expect(out.failed).toEqual([]);
    expect(out.done[0]).toBe('created PermissionSet Sales_Ops');
    expect(sent.filter((s) => s !== 'deploy')).toEqual([
      'POST /sobjects/User',
      'POST /sobjects/PermissionSetAssignment',
      'POST /sobjects/PermissionSetAssignment',
    ]);
  });

  it('leaves out the entries of a permission set that name what the target lacks', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <fieldPermissions>
        <editable>true</editable>
        <field>Case.Reason__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <label>Testing PSG</label>
    <recordTypeVisibilities>
        <recordType>Case.Test_Escalation_Case</recordType>
        <visible>true</visible>
    </recordTypeVisibilities>
    <recordTypeVisibilities>
        <recordType>Case.Other</recordType>
        <visible>true</visible>
    </recordTypeVisibilities>
</PermissionSet>`;
    const out = withoutEntries(xml, ['Case.Test_Escalation_Case']);
    expect(out).not.toContain('Test_Escalation_Case');
    expect(out).toContain('<recordType>Case.Other</recordType>');
    expect(out).toContain('<field>Case.Reason__c</field>');
    expect(out).toContain('<label>Testing PSG</label>');
    expect(withoutEntries(out, ['Case.Reason__c'])).not.toContain('fieldPermissions');
  });
});
