import { describe, expect, it } from 'vitest';
import { SECURITY_TILES, SalesforceClient, securityTimeline, whoCanSee, type HttpRequest } from '../src/index.js';

type Answer = [RegExp, unknown[] | Record<string, unknown>];
function org(answers: Answer[]) {
  return new SalesforceClient(async (r: HttpRequest) => {
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    const hit = answers.find(([re]) => re.test(q || r.path));
    const body =
      hit && !Array.isArray(hit[1])
        ? hit[1]
        : { totalSize: (hit?.[1] as unknown[] | undefined)?.length ?? 0, done: true, records: hit?.[1] ?? [] };
    return { status: 200, headers: {}, body: JSON.stringify(body) };
  }, '62.0');
}

describe('security dashboard tiles', () => {
  it('each tile reads one thing and says how it looks', async () => {
    const c = org([
      [/FROM LoginHistory/, [{}, {}, {}, {}, {}, {}]],
      [/\/limits/, { DailyApiRequests: { Max: 1000, Remaining: 150 } }],
      [/FROM AsyncApexJob/, []],
    ]);
    const tile = (id: string) => SECURITY_TILES.find((t) => t.id === id)!.read(c);
    expect(await tile('failedLogins')).toMatchObject({ value: '6', level: 'warn' });
    expect(await tile('api')).toMatchObject({ value: '85%', level: 'bad' });
    expect(await tile('failedJobs')).toMatchObject({ value: '0', level: 'good' });
  });
});

describe('timeline', () => {
  it('puts setup changes, logins with names and NomadSF activity together, newest first; a part it cannot read is a note', async () => {
    const c = org([
      [
        /FROM SetupAuditTrail/,
        [
          {
            CreatedDate: '2026-11-11T09:42:00.000+0000',
            CreatedBy: { Name: 'Ann Lee' },
            Section: 'Customize Invoices',
            Display: 'Changed Due field',
          },
        ],
      ],
      [
        /FROM LoginHistory/,
        [
          {
            LoginTime: '2026-11-11T09:12:00.000+0000',
            UserId: '005000000000001AAA',
            Status: 'Success',
            Browser: 'Chrome',
          },
        ],
      ],
      [/FROM User WHERE Id IN/, [{ Id: '005000000000001AAA', Name: 'Ann Lee' }]],
    ]);
    const t = await securityTimeline(c, {
      days: 7,
      kinds: ['Setup', 'Login', 'NomadSF'],
      activity: [{ at: new Date().toISOString(), user: 'me@x', action: 'deploy' }],
    });
    expect(t.rows.map((r) => [r.kind, r.who])).toEqual([
      ['NomadSF', 'me@x'],
      ['Setup', 'Ann Lee'],
      ['Login', 'Ann Lee'],
    ]);
  });
});

describe('who can see a record', () => {
  it("Salesforce's answer, and why: object permission, role above the owner, a sharing rule through a group", async () => {
    const c = org([
      [/\/sobjects$/, { sobjects: [{ name: 'Case', keyPrefix: '500', label: 'Case' }] }],
      [
        /FROM UserRecordAccess/,
        [{ HasReadAccess: true, HasEditAccess: false, HasDeleteAccess: false, HasTransferAccess: false }],
      ],
      [
        /FROM User WHERE Id = '005000000000002AAA'/,
        [{ Id: '005000000000002AAA', Name: 'Bob Ray', UserRoleId: '00E000000000002AAA', UserRole: { Name: 'Agent' } }],
      ],
      [
        /FROM ObjectPermissions/,
        [
          {
            PermissionsRead: true,
            PermissionsEdit: false,
            Parent: { Label: 'Support Agent', IsOwnedByProfile: false },
          },
        ],
      ],
      [/FROM Case WHERE Id/, [{ Id: '500000000000001AAA', OwnerId: '005000000000001AAA', Owner: { Name: 'Ann Lee' } }]],
      [/FROM User WHERE Id = '005000000000001AAA'/, [{ UserRoleId: '00E000000000001AAA', UserRole: { Name: 'Lead' } }]],
      [
        /FROM UserRole/,
        [
          { Id: '00E000000000001AAA', ParentRoleId: null },
          { Id: '00E000000000002AAA', ParentRoleId: '00E000000000001AAA' },
        ],
      ],
      [/FROM CaseShare/, [{ UserOrGroupId: '00G000000000009AAA', CaseAccessLevel: 'Read', RowCause: 'Rule' }]],
      [/FROM GroupMember/, [{ GroupId: '00G000000000009AAA' }]],
      [/FROM Group WHERE/, []],
    ]);
    const r = await whoCanSee(c, '005000000000002AAA', '500000000000001AAA');
    expect([r.object, r.read, r.edit]).toEqual(['Case', true, false]);
    expect(r.steps.map((s) => [s.area, s.applies])).toEqual([
      ['Object', true],
      ['Owner', false],
      ['Sharing', true],
    ]);
    expect(r.steps[0].text).toContain('no Edit');
    expect(r.editNeeds).toContain('Edit on Case');
  });
});
