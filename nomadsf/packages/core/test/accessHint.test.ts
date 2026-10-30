import { describe, expect, it } from 'vitest';
import { SalesforceClient, accessHint } from '../src/index.js';

describe('access hints', () => {
  it('explains permission errors in plain words', () => {
    expect(accessHint('insufficient access rights on object id', 400, 'INSUFFICIENT_ACCESS_OR_READONLY')).toContain(
      'may not have permission'
    );
    expect(accessHint('API is not enabled for this Organization or Partner', 403, 'API_DISABLED_FOR_ORG')).toContain(
      'API Enabled'
    );
    expect(accessHint("sObject type 'Secret__c' is not supported.", 400, 'INVALID_TYPE')).toContain(
      'may not have access'
    );
    expect(accessHint("No such column 'Salary__c' on entity 'Contact'", 400, 'INVALID_FIELD')).toContain(
      'field-level security'
    );
    expect(accessHint('Forbidden', 403)).toContain('may not have permission');
    expect(accessHint('unexpected token: FORM', 400, 'MALFORMED_QUERY')).toBeUndefined();
  });

  it('adds the hint to REST and SOAP errors', async () => {
    const rest = new SalesforceClient(
      async () => ({
        status: 400,
        headers: {},
        body: JSON.stringify([{ message: "sObject type 'Secret__c' is not supported.", errorCode: 'INVALID_TYPE' }]),
      }),
      '62.0'
    );
    await expect(rest.rest('GET', '/query?q=x')).rejects.toThrow(/not supported\.\nIf the name is right/);
    const soap = new SalesforceClient(
      async () => ({
        status: 500,
        headers: {},
        body: '<soapenv:Fault><faultcode>sf:INSUFFICIENT_ACCESS</faultcode><faultstring>INSUFFICIENT_ACCESS: no</faultstring></soapenv:Fault>',
      }),
      '62.0'
    );
    await expect(soap.soap('metadata', '<x/>')).rejects.toThrow(/may not have permission/);
  });

  it('says an org that answers with a web page may no longer exist', async () => {
    const gone = new SalesforceClient(
      async () => ({ status: 420, headers: {}, body: '<!DOCTYPE HTML>\n<html lang=en-US><title>Error Page</title>' }),
      '62.0'
    );
    await expect(gone.soap('metadata', '<x/>')).rejects.toThrow(/may no longer exist/);
  });
});
