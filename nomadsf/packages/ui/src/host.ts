import { SalesforceClient, fetchTransport, proxyTransport, query } from '@nomadsf/core';

/**
 * Where the Studio runs decides how it reaches Salesforce:
 * - app: served by `sf fm dashboard`; requests go through the local server, which
 *   adds the Salesforce CLI's token (the token never reaches the page).
 * - extension: opened from a Salesforce tab; uses that browser session's `sid` cookie.
 */
export type OrgChoice = { id: string; label: string; type?: string; instanceUrl?: string };

export type Host = {
  kind: 'app' | 'extension';
  orgs(): Promise<OrgChoice[]>;
  client(org: OrgChoice): Promise<SalesforceClient>;
};

const isExtension = (): boolean =>
  typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id) && Boolean(chrome.cookies);

function appHost(): Host {
  return {
    kind: 'app',
    async orgs() {
      const res = await fetch('/api/orgs');
      const orgs = (await res.json()) as Array<{
        alias?: string;
        username: string;
        type: string;
        instanceUrl?: string;
      }>;
      return orgs.map((o) => ({
        id: o.alias ?? o.username,
        label: o.alias ?? o.username,
        type: o.type,
        instanceUrl: o.instanceUrl,
      }));
    },
    async client(org) {
      return new SalesforceClient(proxyTransport(`/api/sf/${encodeURIComponent(org.id)}`, { 'x-fm-dashboard': '1' }));
    },
  };
}

function extensionHost(): Host {
  const host = new URLSearchParams(location.search).get('host') ?? '';
  return {
    kind: 'extension',
    async orgs() {
      return host
        ? [{ id: host, label: host.replace(/\.my\.salesforce\.com$/, ''), instanceUrl: `https://${host}` }]
        : [];
    },
    async client(org) {
      const cookie = await chrome.cookies.get({ url: `https://${org.id}`, name: 'sid' });
      if (!cookie?.value)
        throw new Error(`Not logged in to ${org.id}. Open Salesforce in this browser and log in first.`);
      return new SalesforceClient(fetchTransport(`https://${org.id}`, cookie.value));
    },
  };
}

export function detectHost(): Host {
  return isExtension() ? extensionHost() : appHost();
}

export type OrgFacts = { isSandbox: boolean; organizationType: string; name: string; instanceUrl?: string };

/** Production check used to warn before running code or changing data. */
export async function orgFacts(client: SalesforceClient): Promise<OrgFacts> {
  const result = await query(client, 'SELECT Name, IsSandbox, OrganizationType FROM Organization LIMIT 1');
  const row = result.rows[0] ?? {};
  return {
    isSandbox: Boolean(row.IsSandbox),
    organizationType: String(row.OrganizationType ?? ''),
    name: String(row.Name ?? ''),
  };
}
