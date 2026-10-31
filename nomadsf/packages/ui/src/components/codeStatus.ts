/** Where a component is, once a project is open: both (same / different when checked), or one side only. */
export type CodeStatus = 'same' | 'different' | 'in both' | 'only in org' | 'only in project';
export type Show = 'all' | CodeStatus;
export const SHOW: Array<{ id: Show; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'different', label: 'Different' },
  { id: 'same', label: 'Same' },
  { id: 'in both', label: 'Not checked' },
  { id: 'only in org', label: 'Only in org' },
  { id: 'only in project', label: 'Only in project' },
];
/** The short tag in a list (Code and Other metadata). */
export const TAG: Record<CodeStatus, string> = {
  same: '=',
  different: '≠',
  'in both': '',
  'only in org': 'org',
  'only in project': 'project',
};
