import { describe, expect, it } from 'vitest';
import { exportSavedQueries, importSavedQueries, removeSavedQuery, upsertSavedQuery } from '../src/index.js';

const at = new Date('2026-10-17T10:00:00Z');

describe('saved queries', () => {
  it('adds newest first and replaces the same name', () => {
    let list = upsertSavedQuery([], { name: 'Accounts', soql: 'SELECT Id FROM Account', tooling: false }, at);
    list = upsertSavedQuery(list, { name: 'Classes', soql: 'SELECT Id FROM ApexClass', tooling: true }, at);
    list = upsertSavedQuery(list, { name: 'accounts ', soql: 'SELECT Name FROM Account', tooling: false }, at);
    expect(list.map((q) => q.name)).to.deep.equal(['accounts', 'Classes']);
    expect(list[0].soql).to.equal('SELECT Name FROM Account');
  });

  it('refuses an empty name or query', () => {
    expect(() => upsertSavedQuery([], { name: ' ', soql: 'x', tooling: false })).to.throw('name');
    expect(() => upsertSavedQuery([], { name: 'a', soql: ' ', tooling: false })).to.throw('empty');
  });

  it('removes by name', () => {
    const list = upsertSavedQuery([], { name: 'A', soql: 'SELECT Id FROM A', tooling: false }, at);
    expect(removeSavedQuery(list, 'A')).to.deep.equal([]);
  });

  it('round-trips an export and merges imports', () => {
    const mine = upsertSavedQuery([], { name: 'Mine', soql: 'SELECT Id FROM Lead', tooling: false }, at);
    const shared = upsertSavedQuery([], { name: 'Shared', soql: 'SELECT Id FROM Case', tooling: false }, at);
    const { list, added } = importSavedQueries(mine, exportSavedQueries(shared));
    expect(added).to.equal(1);
    expect(list.map((q) => q.name)).to.deep.equal(['Shared', 'Mine']);
    expect(importSavedQueries([], '[{"name":"X","soql":"SELECT Id FROM X"},{"bad":1}]').added).to.equal(1);
    expect(() => importSavedQueries([], 'nope')).to.throw('JSON');
  });
});
