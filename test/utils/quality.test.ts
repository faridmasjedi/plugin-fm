import { expect } from 'chai';
import { countBySeverity, pmdRulesetToSelectors, toSarif, type Violation } from '../../src/utils/qualityUtils.js';

describe('quality utils', () => {
  it('translates a PMD ruleset into Code Analyzer selectors', () => {
    const xml = `<ruleset>
      <rule ref="category/apex/security.xml"/>
      <rule ref="category/apex/bestpractices.xml/ApexUnitTestClassShouldHaveAsserts"/>
      <rule name="NoSoqlInLoops" language="apex" class="net.sourceforge.pmd.lang.rule.xpath.XPathRule"/>
    </ruleset>`;
    expect(pmdRulesetToSelectors(xml)).to.deep.equal([
      'pmd:Security',
      'pmd:ApexUnitTestClassShouldHaveAsserts',
      'pmd:NoSoqlInLoops',
    ]);
  });

  const violations: Violation[] = [
    { engine: 'pmd', rule: 'pmd:A', severity: 1, file: 'a.cls', line: 3, message: 'm1' },
    { engine: 'pmd', rule: 'pmd:A', severity: 3, file: 'b.cls', line: 1, message: 'm2' },
    { engine: 'eslint', rule: 'eslint:no-var', severity: 4, file: 'c.js', message: 'm3' },
  ];

  it('counts by severity', () => {
    expect(countBySeverity(violations)).to.deep.equal({ 1: 1, 2: 0, 3: 1, 4: 1, 5: 0 });
  });

  it('builds one SARIF run per engine with mapped levels', () => {
    const sarif = toSarif(violations, ['pmd', 'eslint']) as {
      runs: Array<{ tool: { driver: { rules: unknown[] } }; results: Array<{ level: string }> }>;
    };
    expect(sarif.runs).to.have.length(2);
    expect(sarif.runs[0].tool.driver.rules).to.have.length(1);
    expect(sarif.runs[0].results.map((r) => r.level)).to.deep.equal(['error', 'warning']);
    expect(sarif.runs[1].results[0].level).to.equal('note');
  });
});
