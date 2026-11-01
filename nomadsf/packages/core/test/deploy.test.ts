import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  crc32,
  deleteFromOrg,
  deployZip,
  destructiveZip,
  makeZip,
  parseDeployResult,
  quickDeploy,
  type HttpRequest,
} from '../src/index.js';

describe('zip writer', () => {
  it('writes zips that unzip reads back', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const dir = mkdtempSync(join(tmpdir(), 'nsf-zip-'));
    try {
      const file = join(dir, 'p.zip');
      writeFileSync(
        file,
        makeZip([
          { path: 'package.xml', content: '<Package/>' },
          { path: 'classes/A.cls', content: 'class A {} // é' },
        ])
      );
      expect(execFileSync('unzip', ['-l', file], { encoding: 'utf8' })).toMatch(/package\.xml[\s\S]*classes\/A\.cls/);
      expect(execFileSync('unzip', ['-p', file, 'classes/A.cls'], { encoding: 'utf8' })).toBe('class A {} // é');
      execFileSync('unzip', ['-t', file]); // CRCs check out
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const DONE = `<result><id>0AfX</id><done>true</done><status>Failed</status><success>false</success><checkOnly>true</checkOnly>
<numberComponentsDeployed>1</numberComponentsDeployed><numberComponentsTotal>2</numberComponentsTotal><numberTestsCompleted>3</numberTestsCompleted><numberTestErrors>1</numberTestErrors><numberTestsTotal>4</numberTestsTotal>
<details><componentFailures><componentType>ApexClass</componentType><fullName>Old</fullName><problem>Referenced by Foo</problem><lineNumber>7</lineNumber></componentFailures>
<runTestResult><failures><name>FooTest</name><methodName>t1</methodName><message>boom</message></failures></runTestResult></details></result>`;

function fakeMetadata() {
  const bodies: string[] = [];
  const client = new SalesforceClient(async (r: HttpRequest) => {
    bodies.push(r.body ?? '');
    const body = r.body ?? '';
    if (body.includes('<met:deploy>')) return { status: 200, headers: {}, body: '<result><id>0AfX</id></result>' };
    if (body.includes('deployRecentValidation'))
      return { status: 200, headers: {}, body: '<result>0AfQ00000000001AAA</result>' };
    return { status: 200, headers: {}, body: DONE };
  }, '62.0');
  return { bodies, client };
}

describe('deploy', () => {
  it('sends the test level and tests, and reads component and test failures', async () => {
    const { bodies, client } = fakeMetadata();
    const progress: string[] = [];
    const out = await deployZip(client, 'UEsFBg==', {
      checkOnly: true,
      testLevel: 'RunSpecifiedTests',
      runTests: ['FooTest', 'bad name'],
      pollMs: 1,
      onProgress: (s, d, t) => progress.push(`${s} ${d}/${t}`),
    });
    expect(bodies[0]).toContain('<met:checkOnly>true</met:checkOnly>');
    expect(bodies[0]).toContain('<met:runTests>FooTest</met:runTests><met:testLevel>RunSpecifiedTests</met:testLevel>');
    expect(bodies[0]).not.toContain('bad name');
    expect(out).toMatchObject({ id: '0AfX', success: false, checkOnly: true, testsRun: 4 });
    expect(out.componentFailures).toEqual([{ type: 'ApexClass', name: 'Old', problem: 'Referenced by Foo', line: 7 }]);
    expect(out.testFailures).toEqual([{ name: 'FooTest', method: 't1', message: 'boom' }]);
    expect(progress[0]).toBe('Failed 4/4');
    await expect(deployZip(client, 'x', { testLevel: 'RunSpecifiedTests' })).rejects.toThrow('test classes');
  });

  it("reads the deploy's own success, not a component's (Salesforce lists the details first)", () => {
    const failedTests = `<checkOnly>true</checkOnly><details><componentSuccesses><fullName>InvoiceTrigger</fullName><success>true</success></componentSuccesses>
<runTestResult><codeCoverageWarnings><id>01q1</id><message>Test coverage of selected Apex Trigger is 0%, at least 1% test coverage is required</message><name>OpportunityTrigger</name></codeCoverageWarnings>
<failures><name>InvoiceServiceTest</name><methodName>t1</methodName><message>Expected: 1, Actual: 0</message></failures></runTestResult></details>
<done>true</done><numberComponentsDeployed>1</numberComponentsDeployed><numberComponentsTotal>1</numberComponentsTotal><numberTestErrors>1</numberTestErrors>
<numberTestsCompleted>6</numberTestsCompleted><status>Failed</status><success>false</success>`;
    expect(parseDeployResult(failedTests, '0AfX')).toMatchObject({
      success: false,
      status: 'Failed',
      checkOnly: true,
      componentsDeployed: 1,
      testsRun: 7,
      testFailures: [{ name: 'InvoiceServiceTest', method: 't1', message: 'Expected: 1, Actual: 0' }],
      coverageWarnings: [
        {
          name: 'OpportunityTrigger',
          message: 'Test coverage of selected Apex Trigger is 0%, at least 1% test coverage is required',
        },
      ],
    });
  });

  it('deletes with an empty package plus destructiveChanges.xml', async () => {
    const zip = Uint8Array.from(atob(destructiveZip([{ type: 'ApexClass', fullName: 'Old' }], '62.0')), (c) =>
      c.charCodeAt(0)
    );
    const text = new TextDecoder().decode(zip);
    expect(text).toContain('destructiveChanges.xml');
    expect(text).toMatch(/<members>Old<\/members>\s*<name>ApexClass<\/name>/);
    const { bodies, client } = fakeMetadata();
    await deleteFromOrg(client, [{ type: 'ApexClass', fullName: 'Old' }], { testLevel: 'RunLocalTests', pollMs: 1 });
    expect(bodies[0]).toContain('<met:testLevel>RunLocalTests</met:testLevel>');
    expect(() => destructiveZip([], '62.0')).toThrow('Choose');
  });

  it('quick deploys a validation', async () => {
    const { bodies, client } = fakeMetadata();
    await quickDeploy(client, '0AfX00000000001', { pollMs: 1 });
    expect(bodies[0]).toContain('<met:validationId>0AfX00000000001</met:validationId>');
    expect(bodies[1]).toContain('<met:asyncProcessId>0AfQ00000000001AAA</met:asyncProcessId>');
  });
});
