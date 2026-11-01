import { describe, expect, it } from 'vitest';
import { SalesforceClient, findUsers, type HttpRequest } from '../src/index.js';

describe('finding users to assign', () => {
  it('finds them by part of their name, one or several, safely quoted', async () => {
    const seen: string[] = [];
    const client = new SalesforceClient(async (r: HttpRequest) => {
      seen.push(decodeURIComponent(r.path));
      return { status: 200, headers: {}, body: JSON.stringify({ totalSize: 0, done: true, records: [] }) };
    }, '62.0');
    await findUsers(client, { names: ['Ann', " O'Brien ", '50%'] });
    const soql = seen.find((p) => p.includes('FROM User')) ?? '';
    expect(soql).toContain("Name LIKE '%Ann%'");
    expect(soql).toContain("Name LIKE '%O\\'Brien%'");
    expect(soql).toContain("Name LIKE '%50\\%%'");
    expect(soql).toContain('IsActive = true');
  });
});
