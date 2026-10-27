import { describe, expect, it } from 'vitest';
import { checkLoginUrl, checkRequest, toChoices } from '../src/orgs';
import { studioHash } from '../src/app';

describe('Studio orgs in VS Code', () => {
  it('lists the CLI logins by alias, with their kind', () => {
    const auths = [
      { username: 'a@x.com', aliases: ['dev'], isDevHub: true, instanceUrl: 'https://a.my.salesforce.com' },
      { username: 'b@x.com', aliases: [], isScratchOrg: true },
      { username: 'c@x.com', isSandbox: true },
      { username: 'd@x.com' },
    ] as unknown as Parameters<typeof toChoices>[0];
    expect(toChoices(auths)).toEqual([
      { id: 'dev', label: 'dev', type: 'Dev Hub', instanceUrl: 'https://a.my.salesforce.com' },
      { id: 'b@x.com', label: 'b@x.com', type: 'Scratch', instanceUrl: undefined },
      { id: 'c@x.com', label: 'c@x.com', type: 'Sandbox', instanceUrl: undefined },
      { id: 'd@x.com', label: 'd@x.com', type: 'Production', instanceUrl: undefined },
    ]);
  });

  it('sends only Salesforce API requests', () => {
    expect(checkRequest({ path: '/services/data/v62.0/query?q=SELECT+Id+FROM+Account' })).toEqual({
      method: 'GET',
      path: '/services/data/v62.0/query?q=SELECT+Id+FROM+Account',
      streaming: false,
    });
    expect(checkRequest({ method: 'post', path: '/cometd/62.0' }).streaming).toBe(true);
    expect(() => checkRequest({ path: '/secur/frontdoor.jsp' })).toThrow(/services/);
    expect(() => checkRequest({ path: '/services/../secur' })).toThrow(/services/);
    expect(() => checkRequest({ method: 'GET', path: '/cometd/62.0' })).toThrow(/services/);
    expect(() => checkRequest({ method: 'HEAD', path: '/services/data' })).toThrow(/Method/);
  });

  it('logs in on Salesforce addresses only', () => {
    expect(checkLoginUrl('https://test.salesforce.com')).toBe('https://test.salesforce.com');
    expect(checkLoginUrl('https://acme.my.salesforce.com/x')).toBe('https://acme.my.salesforce.com');
    expect(() => checkLoginUrl('http://login.salesforce.com')).toThrow();
    expect(() => checkLoginUrl('https://salesforce.com.evil.io')).toThrow();
  });

  it('opens the Studio on a tool, a record or a query', () => {
    expect(studioHash({ kind: 'studio' })).toBe('');
    expect(studioHash({ kind: 'studio', page: 'logs' })).toBe('logs');
    expect(studioHash({ kind: 'record', id: '001000000000001AAA' })).toBe('record=001000000000001AAA');
    expect(studioHash({ kind: 'query', soql: ' SELECT Id FROM Account ' })).toBe('query=SELECT%20Id%20FROM%20Account');
    expect(() => studioHash({ kind: 'record', id: 'nope' })).toThrow();
  });
});
