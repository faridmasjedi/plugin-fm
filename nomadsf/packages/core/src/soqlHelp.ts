/**
 * Help for writing SOQL: the date literals Salesforce knows (LAST_N_DAYS:30, THIS_QUARTER…), the pieces people forget
 * (IN, INCLUDES, HAVING, NULLS LAST…) and whole examples — offered by the Query page as clickable pieces and in its
 * autocomplete. `${1:30}` marks a number to type (the editor selects it).
 */

export type SoqlPiece = { label: string; insert: string; hint: string };
export type SoqlHelpGroup = { id: string; title: string; pieces: SoqlPiece[] };

/** Date literals: compared with a date or date/time field (CreatedDate = LAST_N_DAYS:30). */
export const DATE_LITERALS: SoqlPiece[] = [
  { label: 'TODAY', insert: 'TODAY', hint: 'today' },
  { label: 'YESTERDAY', insert: 'YESTERDAY', hint: 'yesterday' },
  { label: 'TOMORROW', insert: 'TOMORROW', hint: 'tomorrow' },
  { label: 'LAST_N_DAYS:n', insert: 'LAST_N_DAYS:${1:30}', hint: 'the last n days, up to now (today included)' },
  { label: 'NEXT_N_DAYS:n', insert: 'NEXT_N_DAYS:${1:30}', hint: 'the next n days' },
  { label: 'N_DAYS_AGO:n', insert: 'N_DAYS_AGO:${1:5}', hint: 'exactly that one day, n days ago' },
  { label: 'THIS_WEEK', insert: 'THIS_WEEK', hint: 'this week (from the locale’s first day)' },
  { label: 'LAST_WEEK', insert: 'LAST_WEEK', hint: 'the whole week before this one' },
  { label: 'LAST_N_WEEKS:n', insert: 'LAST_N_WEEKS:${1:2}', hint: 'the n weeks before this one' },
  { label: 'THIS_MONTH', insert: 'THIS_MONTH', hint: 'this calendar month' },
  { label: 'LAST_MONTH', insert: 'LAST_MONTH', hint: 'the whole month before this one' },
  { label: 'NEXT_MONTH', insert: 'NEXT_MONTH', hint: 'next calendar month' },
  { label: 'LAST_N_MONTHS:n', insert: 'LAST_N_MONTHS:${1:6}', hint: 'the n months before this one (not this month)' },
  { label: 'N_MONTHS_AGO:n', insert: 'N_MONTHS_AGO:${1:3}', hint: 'exactly that month, n months ago' },
  { label: 'LAST_90_DAYS', insert: 'LAST_90_DAYS', hint: 'the last 90 days' },
  { label: 'THIS_QUARTER', insert: 'THIS_QUARTER', hint: 'this calendar quarter' },
  { label: 'LAST_QUARTER', insert: 'LAST_QUARTER', hint: 'the quarter before this one' },
  { label: 'LAST_N_QUARTERS:n', insert: 'LAST_N_QUARTERS:${1:2}', hint: 'the n quarters before this one' },
  { label: 'THIS_YEAR', insert: 'THIS_YEAR', hint: 'this calendar year' },
  { label: 'LAST_YEAR', insert: 'LAST_YEAR', hint: 'last calendar year' },
  { label: 'LAST_N_YEARS:n', insert: 'LAST_N_YEARS:${1:2}', hint: 'the n years before this one' },
  { label: 'N_YEARS_AGO:n', insert: 'N_YEARS_AGO:${1:1}', hint: 'exactly that year, n years ago' },
  { label: 'THIS_FISCAL_YEAR', insert: 'THIS_FISCAL_YEAR', hint: 'this fiscal year (the org’s fiscal settings)' },
  { label: 'LAST_FISCAL_YEAR', insert: 'LAST_FISCAL_YEAR', hint: 'last fiscal year' },
  { label: 'THIS_FISCAL_QUARTER', insert: 'THIS_FISCAL_QUARTER', hint: 'this fiscal quarter' },
  { label: 'a date', insert: '${1:2026-01-31}', hint: 'a Date field: YYYY-MM-DD, no quotes' },
  {
    label: 'a date and time',
    insert: '${1:2026-01-31T00:00:00Z}',
    hint: 'a Date/Time field: in UTC (Z) or with an offset (+10:00), no quotes',
  },
];

export const SOQL_HELP: SoqlHelpGroup[] = [
  { id: 'dates', title: 'Dates', pieces: DATE_LITERALS },
  {
    id: 'filters',
    title: 'Filters',
    pieces: [
      {
        label: "LIKE '%…%'",
        insert: "LIKE '%${1:text}%'",
        hint: 'contains (% is any text, _ one character); not case sensitive',
      },
      { label: "IN ('…')", insert: "IN ('${1:a}', '${2:b}')", hint: 'one of several values' },
      { label: "NOT IN ('…')", insert: "NOT IN ('${1:a}', '${2:b}')", hint: 'none of the values' },
      {
        label: 'IN (SELECT …)',
        insert: 'IN (SELECT ${1:AccountId} FROM ${2:Contact})',
        hint: 'records that have related records (semi-join): WHERE Id IN (SELECT AccountId FROM Contact)',
      },
      {
        label: 'NOT IN (SELECT …)',
        insert: 'NOT IN (SELECT ${1:AccountId} FROM ${2:Contact})',
        hint: 'records with none (anti-join): accounts without contacts',
      },
      {
        label: "INCLUDES ('a;b')",
        insert: "INCLUDES ('${1:a;b}')",
        hint: 'a multi-select picklist: has a AND b; several values separated by commas mean OR',
      },
      { label: "EXCLUDES ('…')", insert: "EXCLUDES ('${1:a}')", hint: 'a multi-select picklist without that value' },
      { label: '= null', insert: '= null', hint: 'empty field' },
      { label: '!= null', insert: '!= null', hint: 'field has a value' },
      {
        label: 'AND ( … OR … )',
        insert: 'AND (${1:Field} = ${2:value} OR ${3:Field} = ${4:value})',
        hint: 'mix AND and OR: brackets are required',
      },
      { label: 'NOT', insert: 'NOT ', hint: "NOT Name LIKE 'Test%'" },
      {
        label: 'Owner.Name',
        insert: '${1:Owner}.${2:Name}',
        hint: 'a parent’s field, through the lookup’s relationship name (up to 5 levels)',
      },
    ],
  },
  {
    id: 'group',
    title: 'Group & count',
    pieces: [
      { label: 'COUNT()', insert: 'SELECT COUNT() FROM ${1:Account}', hint: 'just how many rows' },
      { label: 'COUNT(Id) n', insert: 'COUNT(Id) n', hint: 'a count per group, named n (use with GROUP BY)' },
      { label: 'COUNT_DISTINCT', insert: 'COUNT_DISTINCT(${1:OwnerId})', hint: 'how many different values' },
      {
        label: 'SUM / AVG / MIN / MAX',
        insert: 'SUM(${1:Amount}) total',
        hint: 'SUM, AVG, MIN, MAX of a number, currency or date',
      },
      {
        label: 'GROUP BY',
        insert: 'GROUP BY ${1:StageName}',
        hint: 'one row per value; every non-aggregated field in SELECT must be here',
      },
      {
        label: 'HAVING',
        insert: 'HAVING COUNT(Id) > ${1:1}',
        hint: 'filter the groups (after GROUP BY): duplicates have COUNT(Id) > 1',
      },
      {
        label: 'GROUP BY ROLLUP',
        insert: 'GROUP BY ROLLUP(${1:StageName})',
        hint: 'groups plus subtotals and a grand total',
      },
      {
        label: 'CALENDAR_YEAR',
        insert: 'CALENDAR_YEAR(${1:CreatedDate})',
        hint: 'group by year; also CALENDAR_MONTH, CALENDAR_QUARTER, DAY_IN_MONTH, WEEK_IN_YEAR',
      },
      { label: 'DAY_ONLY', insert: 'DAY_ONLY(${1:CreatedDate})', hint: 'the date of a date/time, to group by day' },
    ],
  },
  {
    id: 'shape',
    title: 'Sort & shape',
    pieces: [
      { label: 'ORDER BY … DESC', insert: 'ORDER BY ${1:CreatedDate} DESC', hint: 'newest first (ASC is the default)' },
      { label: 'NULLS LAST', insert: 'NULLS LAST', hint: 'empty values after the others (after ASC or DESC)' },
      { label: 'LIMIT', insert: 'LIMIT ${1:200}', hint: 'at most that many rows' },
      { label: 'OFFSET', insert: 'OFFSET ${1:100}', hint: 'skip rows (at most 2000), after LIMIT' },
      {
        label: 'FIELDS(ALL)',
        insert: 'FIELDS(ALL)',
        hint: 'every field (needs LIMIT 200 or less); also FIELDS(STANDARD), FIELDS(CUSTOM)',
      },
      {
        label: '(SELECT … children)',
        insert: '(SELECT ${1:Id, Name} FROM ${2:Contacts})',
        hint: 'related records in each row, by the child relationship name (Contacts, Opportunities, Cases…)',
      },
      {
        label: 'toLabel()',
        insert: 'toLabel(${1:StageName})',
        hint: 'a picklist’s label (translated) instead of its value',
      },
      {
        label: 'FORMAT()',
        insert: 'FORMAT(${1:Amount})',
        hint: 'numbers, dates and currency as the user’s locale shows them',
      },
      {
        label: 'convertCurrency()',
        insert: 'convertCurrency(${1:Amount})',
        hint: 'in the user’s currency (multi-currency orgs)',
      },
      {
        label: 'USING SCOPE mine',
        insert: 'USING SCOPE mine',
        hint: 'only records you own (after FROM); also team, delegated',
      },
    ],
  },
];

/** Whole queries for common questions (FROM can be changed to any object). */
export const SOQL_EXAMPLES: SoqlPiece[] = [
  {
    label: 'Duplicates',
    insert:
      'SELECT Email, COUNT(Id) n\nFROM Contact\nWHERE Email != null\nGROUP BY Email\nHAVING COUNT(Id) > 1\nORDER BY COUNT(Id) DESC',
    hint: 'values that appear more than once (here: contacts sharing an e-mail)',
  },
  {
    label: 'Records per month',
    insert:
      'SELECT CALENDAR_YEAR(CreatedDate) y, CALENDAR_MONTH(CreatedDate) m, COUNT(Id) n\nFROM Account\nWHERE CreatedDate = LAST_N_MONTHS:12\nGROUP BY CALENDAR_YEAR(CreatedDate), CALENDAR_MONTH(CreatedDate)\nORDER BY CALENDAR_YEAR(CreatedDate), CALENDAR_MONTH(CreatedDate)',
    hint: 'how many were created each month, the last 12 months',
  },
  {
    label: 'Without related records',
    insert: 'SELECT Id, Name\nFROM Account\nWHERE Id NOT IN (SELECT AccountId FROM Contact)',
    hint: 'parents with no children (accounts without contacts)',
  },
  {
    label: 'With their children',
    insert:
      'SELECT Id, Name, (SELECT Id, Name, StageName FROM Opportunities WHERE IsClosed = false)\nFROM Account\nLIMIT 100',
    hint: 'each record with its related records in one query',
  },
  {
    label: 'Changed recently',
    insert:
      'SELECT Id, Name, LastModifiedBy.Name, LastModifiedDate\nFROM Account\nWHERE LastModifiedDate = LAST_N_DAYS:7\nORDER BY LastModifiedDate DESC',
    hint: 'who changed what in the last 7 days',
  },
  {
    label: 'Count by owner',
    insert:
      'SELECT Owner.Name, COUNT(Id) n\nFROM Opportunity\nWHERE IsClosed = false\nGROUP BY Owner.Name\nORDER BY COUNT(Id) DESC',
    hint: 'how many each person has',
  },
  {
    label: 'Totals with subtotals',
    insert:
      'SELECT StageName, SUM(Amount) total, COUNT(Id) n\nFROM Opportunity\nWHERE CloseDate = THIS_FISCAL_YEAR\nGROUP BY ROLLUP(StageName)',
    hint: 'a sum per stage and the grand total',
  },
];

export const SOQL_KEYWORDS = [
  'SELECT',
  'FROM',
  'WHERE',
  'AND',
  'OR',
  'NOT',
  'LIKE',
  'IN',
  'NOT IN',
  'INCLUDES',
  'EXCLUDES',
  'GROUP BY',
  'HAVING',
  'ORDER BY',
  'ASC',
  'DESC',
  'NULLS FIRST',
  'NULLS LAST',
  'LIMIT',
  'OFFSET',
  'USING SCOPE',
  'FOR VIEW',
  'FOR REFERENCE',
  'WITH SECURITY_ENFORCED',
  'WITH USER_MODE',
];

/**
 * Where the cursor is after `Field <operator> ` (CreatedDate = |, Status__c IN ('…', |): the field path, so the
 * autocomplete can offer date literals, true/false or the picklist's values. Undefined elsewhere.
 */
export function valueContext(before: string): { path: string; operator: string } | undefined {
  const m =
    /([A-Za-z_][\w.]*)\s*(=|!=|<>|<=|>=|<|>)\s*'?[\w:-]*$/.exec(before) ??
    /([A-Za-z_][\w.]*)\s+(NOT\s+IN|IN|INCLUDES|EXCLUDES)\s*\(\s*(?:'[^']*'\s*,\s*)*'?[\w-]*$/i.exec(before);
  return m ? { path: m[1], operator: m[2].toUpperCase().replace(/\s+/, ' ') } : undefined;
}
