import { describe, expect, it } from 'vitest';
import { checkColumns, type FieldRule } from '../src/index.js';

const f = (name: string, extra: Partial<FieldRule> = {}): FieldRule => ({
  name,
  label: name,
  type: 'string',
  createable: true,
  updateable: true,
  calculated: false,
  externalId: false,
  idLookup: false,
  ...extra,
});
const user: FieldRule[] = [
  f('Id', { type: 'id', createable: false, updateable: false, idLookup: true }),
  f('Name', { createable: false, updateable: false, calculated: true }),
  f('FirstName'),
  f('Username', { idLookup: true }),
  f('CreatedDate', { createable: false, updateable: false }),
  f('Federation_Id__c', { externalId: true }),
  f('ProfileId', { type: 'reference', relationshipName: 'Profile', referenceTo: ['Profile'] }),
  f('ManagerId', { type: 'reference', relationshipName: 'Manager', referenceTo: ['User'] }),
  f('Initial__c', { updateable: false }),
];
const ok = (report: ReturnType<typeof checkColumns>) => Object.fromEntries(report.columns.map((c) => [c.column, c.ok]));

describe('which columns Salesforce accepts', () => {
  it('insert: no Id, no formulas or system fields', () => {
    const r = checkColumns(user, ['Id', 'Name', 'FirstName', 'CreatedDate', 'Nope__c', 'Profile.Name'], 'insert');
    expect(ok(r)).toEqual({
      Id: false,
      Name: false,
      FirstName: true,
      CreatedDate: false,
      Nope__c: false,
      'Profile.Name': true,
    });
    expect(r.columns.find((c) => c.column === 'Name')!.reason).toContain('Formula');
    expect(r.columns.find((c) => c.column === 'Id')!.reason).toContain('Ids are not allowed');
    expect(r.problems).toEqual([]);
  });

  it('update: needs Id, refuses fields set only on create', () => {
    expect(checkColumns(user, ['FirstName'], 'update').problems).toContain('Update needs an Id column.');
    const r = checkColumns(user, ['Id', 'FirstName', 'Initial__c', 'Name'], 'update');
    expect(ok(r)).toEqual({ Id: true, FirstName: true, Initial__c: false, Name: false });
    const full = checkColumns(
      [...user.filter((x) => x.name !== 'Name'), f('Name', { createable: false, updateable: false }), f('LastName')],
      ['Id', 'Name'],
      'update'
    );
    expect(full.columns[1].reason).toContain('FirstName and LastName');
    expect(r.problems).toEqual([]);
  });

  it('upsert: matches on an external Id; create-only fields are allowed', () => {
    expect(checkColumns(user, ['FirstName'], 'upsert').problems[0]).toContain('external Id field');
    expect(checkColumns(user, ['FirstName'], 'upsert', 'Federation_Id__c').problems[0]).toContain(
      'no Federation_Id__c column'
    );
    const r = checkColumns(user, ['Federation_Id__c', 'FirstName', 'Initial__c'], 'upsert', 'Federation_Id__c');
    expect(ok(r)).toEqual({ Federation_Id__c: true, FirstName: true, Initial__c: true });
    expect(r.columns.find((c) => c.column === 'Initial__c')!.reason).toContain('only when a new record');
    expect(ok(checkColumns(user, ['FirstName'], 'upsert', 'FirstName'))).toEqual({ FirstName: false });
  });

  it('delete: only the Id is used', () => {
    const r = checkColumns(user, ['Id', 'FirstName'], 'delete');
    expect(ok(r)).toEqual({ Id: true, FirstName: false });
    expect(checkColumns(user, ['FirstName'], 'hardDelete').problems).toContain('Delete needs an Id column.');
  });

  it('flags a file where nothing can be set', () => {
    expect(checkColumns(user, ['Id', 'Name'], 'update').problems).toContain('No column can be set for this operation.');
  });
});

describe('changed records', () => {
  it('keeps only changed rows and columns, empties cleared cells', async () => {
    const { changedRecords } = await import('../src/index.js');
    const original = new Map([
      [0, { Id: '001A', Name: 'Acme', Phone: '1', Industry: 'Tech' }],
      [1, { Id: '001B', Name: 'Globex', Phone: '2', Industry: 'Retail' }],
      [2, { Id: '001C', Name: 'Initech', Phone: '3', Industry: '' }],
    ]);
    const rows = [
      { id: 0, values: { Id: '001A', Name: 'Acme Corp', Phone: '1', Industry: 'Tech' } },
      { id: 1, values: { Id: '001B', Name: 'Globex', Phone: '2', Industry: 'Retail' } },
      { id: 2, values: { Id: '001C', Name: 'Initech', Phone: '', Industry: '' } },
    ];
    const out = changedRecords(['Name', 'Phone', 'Industry'], rows, original);
    expect(out.columns).toEqual(['Id', 'Name', 'Phone']);
    expect(out.rows).toEqual([
      { Id: '001A', Name: 'Acme Corp' },
      { Id: '001C', Phone: '#N/A' },
    ]);
    expect(out.cells).toBe(2);
  });

  it('a related record is found only by an External ID or unique field of its object', () => {
    const r = checkColumns(user, ['Id', 'Manager.Name', 'Manager.Username'], 'upsert', 'Id', { User: user });
    expect(ok(r)).toEqual({ Id: true, 'Manager.Name': false, 'Manager.Username': true });
    expect(r.columns.find((c) => c.column === 'Manager.Name')!.reason).toBe(
      'User records cannot be found by Name: use Manager.Id or Manager.Username or Manager.Federation_Id__c.'
    );
  });
});
