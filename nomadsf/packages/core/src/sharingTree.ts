import type { SalesforceClient } from './client.js';
import type { GroupMemberRow } from './accessManage.js';
import { retrieveZip } from './metadata.js';
import { query } from './query.js';
import { fromBase64, readZip } from './zip.js';

/**
 * How an object's records are shared: its org-wide defaults, then every sharing rule — which records (by owner or by
 * criteria), with whom (a group, a role, a role and its subordinates…) and how (Read, Read/Write). The "with whom"
 * comes as a group member, so the Studio can open it to show the people inside.
 */

export type SharingTarget = {
  /** group, role, roleAndSubordinates, roleAndSubordinatesInternal, allInternalUsers, portalRole… */
  kind: string;
  name: string;
  /** Ready to open (who is inside) when it is a group or a role of this org. */
  member?: GroupMemberRow;
};

export type SharingRule = {
  name: string;
  label: string;
  kind: 'Owner' | 'Criteria' | 'Guest' | 'Territory';
  access: string;
  /** Which records: "owned by Role Sales Lead", "Status equals Escalated AND …". */
  which: string;
  from?: SharingTarget;
  to: SharingTarget;
};

export type ObjectSharing = { object: string; internal: string; external: string; rules: SharingRule[]; note?: string };

const MODEL: Record<string, string> = {
  Private: 'Private',
  Read: 'Public Read Only',
  ReadWrite: 'Public Read/Write',
  ReadWriteTransfer: 'Public Read/Write/Transfer',
  FullAccess: 'Public Full Access',
  ControlledByParent: 'Controlled by parent',
  ControlledByCampaign: 'Controlled by campaign',
  ControlledByLeadOrContact: 'Controlled by lead or contact',
};
const ACCESS: Record<string, string> = { Read: 'Read only', Edit: 'Read/Write', All: 'Full access' };

const tag = (xml: string, name: string): string =>
  new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1]?.trim() ?? '';
const blocks = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map((m) => m[1]);
/** <sharedTo><role>Sales_Lead</role></sharedTo> → { kind: role, name: Sales_Lead } */
const target = (xml: string): { kind: string; name: string } => {
  const m = /<(\w+)>([^<]*)<\/\1>|<(\w+)\s*\/>/.exec(xml.trim());
  return m ? { kind: m[1] ?? m[3], name: (m[2] ?? '').trim() } : { kind: '', name: '' };
};

/** Parses a SharingRules file (Metadata API) into rules, not yet linked to the org's groups and roles. */
export function parseSharingRules(
  xml: string
): Array<Omit<SharingRule, 'to' | 'from'> & { to: SharingTarget; from?: SharingTarget }> {
  const out: Array<Omit<SharingRule, 'to' | 'from'> & { to: SharingTarget; from?: SharingTarget }> = [];
  const kinds: Array<[string, SharingRule['kind']]> = [
    ['sharingOwnerRules', 'Owner'],
    ['sharingCriteriaRules', 'Criteria'],
    ['sharingGuestRules', 'Guest'],
    ['sharingTerritoryRules', 'Territory'],
  ];
  for (const [element, kind] of kinds)
    for (const b of blocks(xml, element)) {
      const to = target(tag(b, 'sharedTo'));
      const from = kind === 'Owner' || kind === 'Territory' ? target(tag(b, 'sharedFrom')) : undefined;
      const criteria = blocks(b, 'criteriaItems').map((c) =>
        `${tag(c, 'field')} ${tag(c, 'operation')
          .replace(/([A-Z])/g, ' $1')
          .toLowerCase()} ${tag(c, 'value')}`.trim()
      );
      const filter = tag(b, 'booleanFilter');
      out.push({
        name: tag(b, 'fullName'),
        label: tag(b, 'label') || tag(b, 'fullName'),
        kind,
        access: ACCESS[tag(b, 'accessLevel')] ?? tag(b, 'accessLevel'),
        which: from
          ? `owned by ${from.kind.replace(/([A-Z])/g, ' $1').toLowerCase()} ${from.name}`.replace(/\s+$/, '')
          : criteria.length
          ? filter
            ? `${filter}: ${criteria.map((c, i) => `${i + 1}. ${c}`).join('; ')}`
            : criteria.join(' AND ')
          : 'all records',
        to,
        ...(from ? { from } : {}),
      });
    }
  return out;
}

/** An object's org-wide defaults and sharing rules, each "with whom" linked to the group or role it names. */
export async function objectSharing(client: SalesforceClient, object: string): Promise<ObjectSharing> {
  if (!/^\w+$/.test(object)) throw new Error('Invalid object name.');
  const entity = (
    await query(
      client,
      `SELECT QualifiedApiName, InternalSharingModel, ExternalSharingModel FROM EntityDefinition WHERE QualifiedApiName = '${object}'`
    )
  ).rows[0];
  if (!entity) throw new Error(`No object ${object}.`);
  const internal = MODEL[String(entity.InternalSharingModel)] ?? String(entity.InternalSharingModel ?? '');
  const external = MODEL[String(entity.ExternalSharingModel)] ?? String(entity.ExternalSharingModel ?? '');

  const retrieved = await retrieveZip(client, [{ type: 'SharingRules', fullName: object }]);
  const files = retrieved.zipFile ? await readZip(fromBase64(retrieved.zipFile)) : new Map<string, Uint8Array>();
  const file = [...files].find(([p]) => p.endsWith('.sharingRules'));
  const parsed = file ? parseSharingRules(new TextDecoder().decode(file[1])) : [];

  // The groups and roles the rules name (developer names) → group members that can be opened
  const groupNames = new Set<string>();
  const roleNames = new Set<string>();
  for (const r of parsed)
    for (const t of [r.to, r.from].filter(Boolean) as SharingTarget[]) {
      if (t.kind === 'group') groupNames.add(t.name);
      else if (/^role/.test(t.kind)) roleNames.add(t.name);
    }
  const list = (names: Set<string>) => [...names].map((n) => `'${n.replace(/'/g, "\\'")}'`).join(',');
  const groups = groupNames.size
    ? (
        await query(
          client,
          `SELECT Id, Name, DeveloperName FROM Group WHERE Type = 'Regular' AND DeveloperName IN (${list(groupNames)})`
        )
      ).rows
    : [];
  const roles = roleNames.size
    ? (await query(client, `SELECT Id, Name, DeveloperName FROM UserRole WHERE DeveloperName IN (${list(roleNames)})`))
        .rows
    : [];
  const link = (t: SharingTarget): SharingTarget => {
    if (t.kind === 'group') {
      const g = groups.find((x) => x.DeveloperName === t.name);
      return g
        ? {
            ...t,
            name: String(g.Name),
            member: {
              MemberId: '',
              Kind: 'Public group',
              Name: String(g.Name),
              Detail: String(g.DeveloperName),
              UserOrGroupId: String(g.Id),
            },
          }
        : t;
    }
    const role = roles.find((x) => x.DeveloperName === t.name);
    if (!role || !/^role/.test(t.kind)) return t;
    const subordinates =
      t.kind === 'roleAndSubordinatesInternal' ? 'internal' : t.kind === 'roleAndSubordinates' ? 'all' : undefined;
    return {
      ...t,
      name: String(role.Name),
      member: {
        MemberId: '',
        Kind: subordinates ? 'Role and subordinates' : 'Role',
        Name: String(role.Name),
        Detail: '',
        UserOrGroupId: String(role.Id),
        RoleId: String(role.Id),
        ...(subordinates ? { Subordinates: subordinates as 'all' | 'internal' } : {}),
      },
    };
  };
  const rules = parsed.map((r) => ({ ...r, to: link(r.to), ...(r.from ? { from: link(r.from) } : {}) }));
  return {
    object,
    internal,
    external,
    rules,
    ...(!file ? { note: 'No sharing rules on this object.' } : {}),
  };
}
