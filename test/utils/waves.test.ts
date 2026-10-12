import { expect } from 'chai';
import {
  DEFAULT_WAVES,
  MetadataTypeDetector,
  assignWaves,
  detectProductAreas,
  validateWaves,
} from '../../src/utils/waveUtils.js';

describe('deployment waves', () => {
  const types: Record<string, string> = {
    'force-app/main/default/dataStreamDefinitions/Web.dataStreamDefinition-meta.xml': 'DataStreamDefinition',
    'force-app/main/default/omniScripts/Intake.os-meta.xml': 'OmniScript',
    'force-app/main/default/genAiPlugins/Help.genAiPlugin-meta.xml': 'GenAiPlugin',
    'force-app/main/default/classes/A.cls': 'ApexClass',
    'force-app/main/omni-legacy/vlocity/DataPack.json': 'Unknown',
  };
  const detector = { typeOf: (file: string): string | undefined => types[file] };

  it('splits files by built-in type groups, keeping Agentforce in the default wave', () => {
    const waves = assignWaves(
      {
        changedFiles: Object.keys(types).filter((f) => !f.endsWith('Intake.os-meta.xml')),
        deletedFiles: ['force-app/main/default/omniScripts/Intake.os-meta.xml'],
      },
      DEFAULT_WAVES,
      detector
    );
    expect(waves.map((w) => [w.wave.id, w.changedFiles.length, w.deletedFiles.length])).to.deep.equal([
      ['data-cloud', 1, 0],
      ['core', 3, 0],
      ['omnistudio', 0, 1],
    ]);
    expect(waves[1].types).to.include('GenAiPlugin');
  });

  it('matches path patterns, first matching wave wins', () => {
    const config = validateWaves({
      waves: [
        { id: 'one', paths: ['force-app/main/default/classes/**'] },
        { id: 'core', default: true },
        { id: 'three', types: ['ApexClass'], paths: ['force-app/main/omni-legacy/**'] },
      ],
    });
    const waves = assignWaves({ changedFiles: Object.keys(types), deletedFiles: [] }, config, detector);
    expect(waves[0].changedFiles).to.deep.equal(['force-app/main/default/classes/A.cls']);
    expect(waves[2].changedFiles).to.deep.equal(['force-app/main/omni-legacy/vlocity/DataPack.json']);
    expect(waves[1].changedFiles).to.have.length(3);
  });

  it('validates the waves file', () => {
    expect(() => validateWaves({ waves: [{ id: 'a' }, { id: 'a', types: ['@nope'] }] }))
      .to.throw()
      .with.property('message')
      .that.matches(/duplicate id/)
      .and.matches(/unknown type group "@nope"/)
      .and.matches(/Exactly one wave/);
  });

  it('detects product areas', () => {
    expect(detectProductAreas(['DataStreamDefinition', 'GenAiFunction', 'ApexClass'])).to.deep.equal({
      dataCloud: true,
      agentforce: true,
      omnistudio: false,
    });
  });

  it('detects the type of deleted files from the registry', () => {
    const real = new MetadataTypeDetector(process.cwd());
    expect(real.typeOf('force-app/main/default/dataStreamDefinitions/Web.dataStreamDefinition-meta.xml')).to.equal(
      'DataStreamDefinition'
    );
    expect(real.typeOf('force-app/main/default/omniScripts/Intake_English_1.os-meta.xml')).to.equal('OmniScript');
    expect(real.typeOf('force-app/main/default/classes/Gone.cls')).to.equal('ApexClass');
  });
});
