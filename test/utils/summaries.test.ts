import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'chai';
import { parsePackageXml, summarizeStage } from '../../src/utils/pipeline/summaries.js';

describe('pipeline summaries', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fm-sum-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('parses package.xml members per type', () => {
    const path = join(dir, 'package.xml');
    writeFileSync(
      path,
      '<Package><types><members>A</members><members>B</members><name>ApexClass</name></types><types><members>X</members><name>CustomLabel</name></types></Package>'
    );
    expect(parsePackageXml(path)).to.deep.equal({ ApexClass: ['A', 'B'], CustomLabel: ['X'] });
    expect(parsePackageXml(join(dir, 'missing.xml'))).to.deep.equal({});
  });

  it('summarizes deploy results', () => {
    const { metrics } = summarizeStage('deploy', {
      status: 'Failed',
      deployedComponents: 4,
      failedComponents: 1,
      testsRun: 10,
      testsPassed: 9,
    });
    expect(metrics.find((m) => m.label === 'Status')).to.include({ value: 'Failed', tone: 'bad' });
    expect(metrics.find((m) => m.label === 'Tests')?.value).to.equal('9/10');
  });

  it('marks failed scripts', () => {
    expect(summarizeStage('shell', { exitCode: 2 }).metrics[0]).to.include({ value: 2, tone: 'bad' });
  });
});
