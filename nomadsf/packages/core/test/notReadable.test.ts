import { describe, expect, it } from 'vitest';
import {
  SalesforceClient,
  compareConnectedApps,
  compareUsersFully,
  mergeAccess,
  myAccess,
  usersWithInBoth,
  type HttpRequest,
} from '../src/index.js';

/** SOQL answered by matcher; an Error answers 400 (like a missing permission). Describes from `describes`. */
function fakeOrg(answers: Array<[RegExp, unknown[] | Error]>, describes: Record<string, string[]> = {}) {
  return new SalesforceClient(async (r: HttpRequest) => {
    const d = /\/sobjects\/(\w+)\/describe/.exec(r.path);
    if (d)
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          fields: (describes[d[1]] ?? []).map((name) => ({ name, label: name, type: 'boolean' })),
        }),
      };
    const q = decodeURIComponent(r.path.split('q=')[1] ?? '').replace(/\+/g, ' ');
    const hit = answers.find(([re]) => re.test(q))?.[1] ?? [];
    if (hit instanceof Error)
      return {
        status: 400,
        headers: {},
        body: JSON.stringify([{ errorCode: 'INSUFFICIENT_ACCESS', message: hit.message }]),
      };
    return { status: 200, headers: {}, body: JSON.stringify({ totalSize: hit.length, done: true, records: hit }) };
  }, '62.0');
}

const DENIED = new Error('insufficient access rights on cross-reference id');

describe('what the logged-in user may do', () => {
  const fields = ['PermissionsApiEnabled', 'PermissionsViewSetup', 'PermissionsManageProfilesPermissionsets'];
  it('says limited, read only or full', async () => {
    const level = async (row: Record<string, boolean>) =>
      (await myAccess(fakeOrg([[/UserPermissionAccess/, [row]]], { UserPermissionAccess: fields }))).level;
    expect(await level({ PermissionsApiEnabled: true })).toBe('limited');
    expect(await level({ PermissionsApiEnabled: true, PermissionsViewSetup: true })).toBe('read only');
    expect(await level({ PermissionsViewSetup: true, PermissionsManageProfilesPermissionsets: true })).toBe('full');
    const unknown = await myAccess(fakeOrg([[/UserPermissionAccess/, DENIED]], { UserPermissionAccess: fields }));
    expect(unknown).toMatchObject({ known: false, level: 'unknown', can: { changePermissions: true } });
  });
});

describe('a side that cannot be read is unknown, not "does not have"', () => {
  it('shows ? and counts no difference in a section B could not read', () => {
    const [section] = mergeAccess(
      [{ title: 'Object access', rows: [{ key: 'Account', item: 'Account', value: 'Read' }] }],
      [{ title: 'Object access', rows: [], note: 'insufficient access' }]
    );
    expect(section.rows).toEqual([{ key: 'Account', item: 'Account', a: 'Read', b: '?', differs: false }]);
  });

  it("compares two users when one's assignments cannot be read", async () => {
    const user = [/FROM User WHERE Id/, [{ Name: 'Ann', Username: 'ann@x', Profile: { Name: 'Sales' } }]] as [
      RegExp,
      unknown[]
    ];
    const a = fakeOrg([
      user,
      [
        /FROM PermissionSetAssignment WHERE AssigneeId/,
        [{ PermissionSetId: '0PS000000000001AAA', PermissionSet: { Label: 'Ops', Name: 'Ops', Type: 'Regular' } }],
      ],
    ]);
    const b = fakeOrg([user, [/FROM PermissionSetAssignment/, DENIED], [/FROM LoginHistory/, DENIED]]);
    const result = await compareUsersFully(a, '005000000000001AAA', '005000000000002AAA', b);
    expect(result.items.find((i) => i.item === 'Ops')).toMatchObject({ in: 'not read in B', a: '✓', b: '?' });
    expect(result.permissions).toEqual([]);
    expect(result.notesB.join(' ')).toContain('insufficient access');
    expect(result.notesB.join(' ')).toContain('Login history');
    expect(result.details.find((d) => d.field === 'Profile')).toMatchObject({ a: 'Sales', b: 'Sales', same: true });
  });

  it('marks assigned users "not read in B" when B cannot be read', async () => {
    const a = fakeOrg([
      [/PermissionSetAssignment/, [{ Assignee: { Id: '005000000000001AAA', Name: 'Ann', Username: 'ann@x' } }]],
    ]);
    const b = fakeOrg([[/PermissionSetAssignment/, DENIED]]);
    const rows = await usersWithInBoth(a, { kind: 'permset', id: '0PS000000000001AAA' }, b, {
      kind: 'permset',
      id: '0PS000000000002AAA',
    });
    expect(rows.map((r) => [r.Name, r.in])).toEqual([['Ann', 'not read in B']]);
  });

  it('marks an app missing from an org whose lists could not be read as not read there', async () => {
    const a = fakeOrg([[/FROM ConnectedApplication ORDER BY Name/, [{ Id: '0H4000000000001AAA', Name: 'Portal' }]]]);
    const b = fakeOrg([[/FROM ConnectedApplication/, DENIED]]);
    const { apps, notes } = await compareConnectedApps(a, b);
    expect(apps).toEqual([expect.objectContaining({ name: 'Portal', status: 'not read in B' })]);
    expect(notes.join(' ')).toContain('B: Connected apps');
  });
});
