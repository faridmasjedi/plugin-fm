/**
 * Salesforce's row errors in plain words. Bulk API results give `CODE:message:fields--`
 * ("DUPLICATES_DETECTED:Use one of these records?:--"); REST gives `CODE: message (fields)`.
 */

export type RowError = { code: string; message: string; fields: string; meaning: string };

const MEANINGS: Record<string, string> = {
  DUPLICATES_DETECTED:
    'A duplicate rule found a record like this one already in the org. Update that record instead (Upsert or Compare with CSV), change the row, or turn the duplicate rule off for the load (Setup › Duplicate Rules).',
  DUPLICATE_VALUE: 'A field that must be unique already has this value on another record.',
  REQUIRED_FIELD_MISSING: 'A required field is empty: add a column for it, or fill it in.',
  FIELD_CUSTOM_VALIDATION_EXCEPTION:
    'A validation rule of the object refused the row: the message is the rule’s own text.',
  INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST:
    'A picklist value is not one of the values the field allows (check spelling and record type).',
  INVALID_CROSS_REFERENCE_KEY: 'A lookup points to a record that is not in this org (an Id from another org?).',
  MALFORMED_ID: 'A value in an Id or lookup column is not a Salesforce Id.',
  STRING_TOO_LONG: 'A text is longer than the field allows.',
  INVALID_FIELD: 'A column is not a field of the object, or cannot be set this way.',
  INVALID_FIELD_FOR_INSERT_UPDATE: 'A column cannot be set on insert or update (read-only, formula or system field).',
  CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY:
    'A trigger, flow or process failed while saving the row: the message names it and its error.',
  INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY: 'You cannot see or use a record the row points to (sharing).',
  INSUFFICIENT_ACCESS_OR_READONLY: 'You do not have access to change this record.',
  ENTITY_IS_DELETED: 'The record (or one it points to) is in the Recycle Bin.',
  ENTITY_IS_LOCKED: 'The record is locked, usually by an approval process.',
  UNABLE_TO_LOCK_ROW: 'Another job was changing the same record: try the row again.',
  INVALID_EMAIL_ADDRESS: 'An e-mail field holds something that is not an e-mail address.',
  NUMBER_OUTSIDE_VALID_RANGE: 'A number is too big or too small for the field.',
  INVALID_TYPE_ON_FIELD_IN_RECORD: 'A value has the wrong type for its field (text in a number or date field…).',
  LIMIT_EXCEEDED: 'A Salesforce limit was reached (e.g. too many child records).',
  STORAGE_LIMIT_EXCEEDED: 'The org has no data storage left.',
};

/** One error text as code, message, fields and what it means. */
export function explainError(text: string): RowError {
  const raw = (text ?? '').trim();
  // Bulk: CODE:message:fields-- ; REST: CODE: message (fields)
  const bulk = /^([A-Z_]+):(.*?):([^:]*)--$/s.exec(raw);
  const rest = /^([A-Z_]+):\s*(.*?)(?:\s*\(([^)]*)\))?$/s.exec(raw);
  const [code, message, fields] = bulk
    ? [bulk[1], bulk[2], bulk[3]]
    : rest
    ? [rest[1], rest[2], rest[3] ?? '']
    : ['', raw, ''];
  return {
    code,
    message: message.trim(),
    fields: fields.trim(),
    meaning: MEANINGS[code] ?? '',
  };
}

/** A Bulk failures table with the error split into Code, Message, Fields and What it means. */
export function explainFailures(
  rows: Array<Record<string, string>>,
  errorColumn = 'sf__Error'
): Array<Record<string, string>> {
  return rows.map((r) => {
    const e = explainError(r[errorColumn] ?? '');
    return {
      'Error code': e.code,
      'Error message': e.message,
      'Error fields': e.fields,
      'What it means': e.meaning,
      ...r,
    };
  });
}
