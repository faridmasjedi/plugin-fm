import { describe, expect, it } from 'vitest';
import { explainError, explainFailures } from '../src/index.js';

describe('row errors in plain words', () => {
  it('reads the Bulk API form, CODE:message:fields--', () => {
    const e = explainError('DUPLICATES_DETECTED:Use one of these records?:--');
    expect(e).toMatchObject({ code: 'DUPLICATES_DETECTED', message: 'Use one of these records?', fields: '' });
    expect(e.meaning).toContain('duplicate rule');
    expect(explainError('REQUIRED_FIELD_MISSING:Required fields are missing: [LastName]:LastName --')).toMatchObject({
      code: 'REQUIRED_FIELD_MISSING',
      message: 'Required fields are missing: [LastName]',
      fields: 'LastName',
    });
  });

  it('reads the REST form, and leaves other text as the message', () => {
    expect(explainError('STRING_TOO_LONG: Name: data value too large (Name)')).toMatchObject({
      code: 'STRING_TOO_LONG',
      message: 'Name: data value too large',
      fields: 'Name',
    });
    expect(explainError('Linking: something broke')).toEqual({
      code: '',
      message: 'Linking: something broke',
      fields: '',
      meaning: '',
    });
  });

  it('adds the explained columns to a failures table, keeping every original column', () => {
    const [row] = explainFailures([{ sf__Id: '', sf__Error: 'ENTITY_IS_LOCKED:locked:--', Name: 'Acme' }]);
    expect(row).toMatchObject({ 'Error code': 'ENTITY_IS_LOCKED', 'Error message': 'locked', Name: 'Acme' });
    expect(row['What it means']).toContain('approval');
  });
});
