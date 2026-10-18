import { expect } from 'chai';
import { deployFromProject, parseCliDeploy } from '../../src/utils/dashboard/orgExplorer.js';

describe('deploy from the project (CLI)', () => {
  it('reads sf project deploy output, single or many failures', () => {
    const out = parseCliDeploy(
      {
        result: {
          id: '0Af000000000001',
          status: 'Failed',
          success: false,
          numberComponentsDeployed: 1,
          numberComponentsTotal: 2,
          numberTestsCompleted: 3,
          numberTestErrors: 1,
          details: {
            componentFailures: { componentType: 'ApexClass', fullName: 'A', problem: 'Bad', lineNumber: 4 },
            runTestResult: { failures: [{ name: 'ATest', methodName: 'm', message: 'boom' }] },
          },
        },
      },
      true
    );
    expect(out).to.deep.include({ id: '0Af000000000001', success: false, checkOnly: true, testsRun: 4 });
    expect(out.componentFailures).to.deep.equal([{ type: 'ApexClass', name: 'A', problem: 'Bad', line: 4 }]);
    expect(out.testFailures).to.deep.equal([{ name: 'ATest', method: 'm', message: 'boom' }]);
    expect(parseCliDeploy({ message: 'No org' }, false).errorMessage).to.equal('No org');
  });

  it('refuses unsafe or incomplete requests before calling the CLI', async () => {
    const attempts: Array<[Parameters<typeof deployFromProject>[1], string]> = [
      [{ org: 'a b', members: ['ApexClass:A'] }, 'connected org'],
      [{ org: 'dev', members: ['ApexClass:A; rm -rf'] }, 'Choose components'],
      [{ org: 'dev', members: ['ApexClass:A'], testLevel: 'Everything' }, 'test level'],
      [{ org: 'dev', members: ['ApexClass:A'], testLevel: 'RunSpecifiedTests' }, 'test classes'],
    ];
    for (const [request, message] of attempts) {
      let error = '';
      // eslint-disable-next-line no-await-in-loop
      await deployFromProject('.', request).catch((e: Error) => (error = e.message));
      expect(error, JSON.stringify(request)).to.include(message);
    }
  });
});
