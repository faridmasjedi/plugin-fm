import { describe, expect, it } from 'vitest';
import { SalesforceClient, searchUsers, setActive, setFrozen, userLogin, type HttpRequest } from '../src/index.js';

function fake(rows: unknown[]) {
  const calls: HttpRequest[] = [];
  const client = new SalesforceClient(async (r) => {
    calls.push(r);
    return {
      status: r.method === 'PATCH' ? 204 : 200,
      headers: {},
      body: r.method === 'PATCH' ? '' : JSON.stringify({ totalSize: rows.length, done: true, records: rows }),
    };
  }, '62.0');
  const soql = (i: number) => decodeURIComponent(calls[i].path.split('q=')[1]).replace(/\+/g, ' ');
  return { calls, client, soql };
}

describe('users', () => {
  it('searches by Id, or by name / username / email with quotes escaped', async () => {
    const { client, soql } = fake([
      {
        Id: '005000000000001AAA',
        Name: 'Ann',
        Username: 'a@x',
        Email: 'a@x',
        Profile: { Name: 'Admin' },
        IsActive: true,
      },
    ]);
    const found = await searchUsers(client, "O'Brien");
    expect(soql(0)).toContain("Name LIKE '%O\\'Brien%'");
    expect(found[0]).toMatchObject({ Name: 'Ann', Profile: 'Admin', IsActive: true });
    await searchUsers(client, '005000000000001AAA');
    expect(soql(1)).toContain("WHERE Id = '005000000000001AAA'");
    expect(await searchUsers(client, '  ')).toEqual([]);
  });

  it('freezes and deactivates', async () => {
    const { calls, client } = fake([{ Id: '0Yw000000000001AAA', IsFrozen: false }]);
    expect(await userLogin(client, '005000000000001AAA')).toEqual({ id: '0Yw000000000001AAA', frozen: false });
    await setFrozen(client, '0Yw000000000001AAA', true);
    expect(calls.at(-1)).toMatchObject({
      method: 'PATCH',
      path: '/services/data/v62.0/sobjects/UserLogin/0Yw000000000001AAA',
      body: '{"IsFrozen":true}',
    });
    await setActive(client, '005000000000001AAA', false);
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: '{"IsActive":false}' });
    await expect(setActive(client, '001000000000001AAA', false)).rejects.toThrow('user Id');
  });
});
