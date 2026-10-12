import { expect } from 'chai';
import {
  interpolate,
  isTruthy,
  toArgv,
  validatePipelineConfig,
  PipelineConfigError,
} from '../../src/utils/pipeline/config.js';

describe('pipeline config', () => {
  const context = {
    env: { ORG: 'uat' },
    run: { id: 'r1', release: 'R-1', branch: 'main', commit: 'abc' },
    stages: { validate: { status: 'passed', result: { validationId: '0Af123', ok: true } } },
  };

  it('interpolates env, run and stage results', () => {
    const out = interpolate(
      {
        org: '${env.ORG}',
        name: 'Release ${run.release} on ${run.branch}',
        id: '${stages.validate.result.validationId}',
      },
      context
    );
    expect(out).to.deep.equal({ org: 'uat', name: 'Release R-1 on main', id: '0Af123' });
  });

  it('keeps the type of a whole-value expression', () => {
    expect(interpolate('${stages.validate.result.ok}', context)).to.equal(true);
  });

  it('fails on unresolved expressions', () => {
    expect(() => interpolate('${stages.missing.result.x}', context)).to.throw(PipelineConfigError);
  });

  it('converts with-flags to argv', () => {
    expect(toArgv({ mode: 'validation', progress: true, async: false, tests: ['A', 'B'], skip: null })).to.deep.equal([
      '--mode',
      'validation',
      '--progress',
      '--tests',
      'A',
      '--tests',
      'B',
    ]);
  });

  it('rejects invalid pipelines with all problems listed', () => {
    expect(() =>
      validatePipelineConfig({
        stages: [
          { id: 'a', uses: 'build' },
          { id: 'a', uses: 'build' },
          { id: 'b', uses: 'script' },
          { id: 'c', uses: 'nope' as 'build' },
        ],
      })
    )
      .to.throw(PipelineConfigError)
      .with.property('message')
      .that.matches(/duplicate id/)
      .and.matches(/"run" is required/)
      .and.matches(/"uses" must be one of/);
  });

  it('defaults the pipeline name', () => {
    expect(validatePipelineConfig({ stages: [{ id: 'a', uses: 'build' }] }).name).to.equal('Salesforce pipeline');
  });

  it('validates on: events and tag stages', () => {
    expect(() =>
      validatePipelineConfig({
        stages: [
          { id: 'a', uses: 'build', on: ['merge' as 'pr'] },
          { id: 't', uses: 'tag' },
        ],
      })
    )
      .to.throw(PipelineConfigError)
      .with.property('message')
      .that.matches(/"on" must be a list/)
      .and.matches(/"with.branch" is required/);
  });

  it('evaluates when: truthiness', () => {
    expect([true, 'true', 'yes', 1, 'x'].map(isTruthy)).to.deep.equal([true, true, true, true, true]);
    expect([false, 'false', 'FALSE', '', '0', 0, 'no', 'off', null, undefined].map(isTruthy).some(Boolean)).to.equal(
      false
    );
  });
});
