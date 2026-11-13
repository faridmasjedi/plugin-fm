import { describe, expect, it } from 'vitest';
import { parseSharingRules } from '../src/index.js';

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
    <sharingCriteriaRules>
        <fullName>Escalated_to_Leads</fullName>
        <accessLevel>Edit</accessLevel>
        <label>Escalated to leads</label>
        <sharedTo><roleAndSubordinatesInternal>Support_Manager</roleAndSubordinatesInternal></sharedTo>
        <criteriaItems><field>Status</field><operation>equals</operation><value>Escalated</value></criteriaItems>
        <criteriaItems><field>Priority</field><operation>notEqual</operation><value>Low</value></criteriaItems>
    </sharingCriteriaRules>
    <sharingOwnerRules>
        <fullName>Tier1_to_Team</fullName>
        <accessLevel>Read</accessLevel>
        <label>Tier 1 to team</label>
        <sharedTo><group>Support_Team</group></sharedTo>
        <sharedFrom><role>Support_Lead</role></sharedFrom>
    </sharingOwnerRules>
    <sharingCriteriaRules>
        <fullName>Everyone_open</fullName>
        <accessLevel>Read</accessLevel>
        <label>Open cases to all</label>
        <sharedTo><allInternalUsers></allInternalUsers></sharedTo>
        <booleanFilter>1 OR 2</booleanFilter>
        <criteriaItems><field>Status</field><operation>equals</operation><value>New</value></criteriaItems>
        <criteriaItems><field>Status</field><operation>equals</operation><value>Open</value></criteriaItems>
    </sharingCriteriaRules>
</SharingRules>`;

describe('sharing rules', () => {
  it('reads owner and criteria rules: which records, with whom, how', () => {
    const r = parseSharingRules(xml);
    expect(r.map((x) => [x.kind, x.label, x.access, x.which, x.to.kind, x.to.name])).toEqual([
      ['Owner', 'Tier 1 to team', 'Read only', 'owned by role Support_Lead', 'group', 'Support_Team'],
      [
        'Criteria',
        'Escalated to leads',
        'Read/Write',
        'Status equals Escalated AND Priority not equal Low',
        'roleAndSubordinatesInternal',
        'Support_Manager',
      ],
      [
        'Criteria',
        'Open cases to all',
        'Read only',
        '1 OR 2: 1. Status equals New; 2. Status equals Open',
        'allInternalUsers',
        '',
      ],
    ]);
  });
});
