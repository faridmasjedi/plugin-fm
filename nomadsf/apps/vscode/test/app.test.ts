import { describe, expect, it } from 'vitest';
import { browserCommand, studioHash } from '../src/app';

describe('Studio links', () => {
  it('builds links for pages, records and queries', () => {
    expect(studioHash({ kind: 'studio', page: 'limits' })).toBe('limits');
    expect(studioHash({ kind: 'record', id: '001000000000001AAA' })).toBe('record=001000000000001AAA');
    expect(studioHash({ kind: 'query', soql: ' SELECT Id FROM Account ' })).toBe('query=SELECT%20Id%20FROM%20Account');
    expect(() => studioHash({ kind: 'record', id: 'hello' })).toThrow('record Id');
    expect(() => studioHash({ kind: 'query', soql: 'DELETE x' })).toThrow('SOQL');
  });
});

describe('browserCommand', () => {
  // A front door link: a query inside the query must reach the browser unchanged
  const url =
    'https://x.my.salesforce.com/secur/frontdoor.jsp?sid=00D%21AQ.a%2Bb&retURL=%2Flightning%2Fo%2FAccount%2Flist%3Fa%3D1%26filterName%3DAll';
  it('passes the link as one argument, as written', () => {
    expect(browserCommand('darwin', url)).toEqual(['open', [url]]);
    expect(browserCommand('linux', url)).toEqual(['xdg-open', [url]]);
    expect(browserCommand('win32', url)).toEqual(['rundll32', ['url.dll,FileProtocolHandler', url]]);
  });
});
