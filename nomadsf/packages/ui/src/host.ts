import { SalesforceClient, apiHostFor, fetchTransport, proxyTransport, query, type HttpResponse } from '@nomadsf/core';
import { call, inVsCodeWebview } from './embed';

/**
 * Where the Studio runs decides how it reaches Salesforce:
 * - app: served by `sf fm dashboard`; requests go through the local server, which
 *   adds the Salesforce CLI's token (the token never reaches the page).
 * - extension: opened from a Salesforce tab; uses that browser session's `sid` cookie.
 * - vscode: shipped inside the VS Code extension; the extension adds the Salesforce CLI's
 *   token (read from the CLI's login files, no CLI or local app needed).
 */
export type HostKind = 'app' | 'extension' | 'vscode';

export type OrgChoice = { id: string; label: string; type?: string; instanceUrl?: string };

export type Host = {
  kind: HostKind;
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

/** Kind of org from its My Domain host (the session check tells production from the rest). */
function typeFromHost(host: string): string | undefined {
  if (/\.sandbox\.my\.salesforce\.com$/.test(host)) return 'Sandbox';
  if (/\.scratch\.my\.salesforce\.com$/.test(host)) return 'Scratch';
  if (/\.develop\.my\.salesforce\.com$/.test(host)) return 'Developer';
  return undefined;
}

const orgChoice = (host: string): OrgChoice => ({
  id: host,
  label: host.replace(/\.my\.salesforce\.com$/, ''),
  type: typeFromHost(host),
  instanceUrl: `https://${host}`,
});

/**
 * Orgs this browser is logged in to: every Salesforce API host with a `sid` cookie. The org of
 * the tab the Studio was opened from comes first. No CLI and nothing stored by NomadSF.
 */
export async function browserOrgs(preferred = ''): Promise<OrgChoice[]> {
  const cookies = await chrome.cookies.getAll({ name: 'sid' });
  const hosts = new Set<string>();
  for (const cookie of cookies) {
    const host = apiHostFor(cookie.domain.replace(/^\./, ''));
    if (host && cookie.value) hosts.add(host);
  }
  if (preferred) hosts.delete(preferred);
  return [...(preferred ? [preferred] : []), ...[...hosts].sort()].map(orgChoice);
}

function extensionHost(): Host {
  const host = new URLSearchParams(location.search).get('host') ?? '';
  return {
    kind: 'extension',
    orgs: () => browserOrgs(host),
    async client(org) {
      const cookie = await chrome.cookies.get({ url: `https://${org.id}`, name: 'sid' });
      if (!cookie?.value)
        throw new Error(`Not logged in to ${org.id}. Open Salesforce in this browser and log in first.`);
      return new SalesforceClient(fetchTransport(`https://${org.id}`, cookie.value));
    },
  };
}

/** Orgs and requests go through the VS Code extension (bridge.ts there), which holds the tokens. */
function vscodeHost(): Host {
  return {
    kind: 'vscode',
    orgs: () => call<OrgChoice[]>('orgs'),
    async client(org) {
      return new SalesforceClient((request) => call<HttpResponse>('sf', org.id, request));
    },
  };
}

export function detectHost(): Host {
  return isExtension() ? extensionHost() : inVsCodeWebview() ? vscodeHost() : appHost();
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

/**
 * Opens a page of the org logged in. The extension uses the browser's own session; the app
 * asks the Salesforce CLI (`sf org open --path`), which logs the browser in first; VS Code
 * opens it through the org's front door with the CLI login.
 */
export async function openInOrg(kind: HostKind, org: OrgChoice, path: string): Promise<void> {
  if (kind === 'extension') {
    window.open(`${org.instanceUrl ?? ''}${path}`, '_blank', 'noopener');
    return;
  }
  if (kind === 'vscode') {
    await call('openOrg', org.id, path);
    return;
  }
  const res = await fetch('/api/orgs/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-fm-dashboard': '1' },
    body: JSON.stringify({ org: org.id, path }),
  });
  if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? res.statusText);
}

export type OrgCheck = { ok: true; facts: OrgFacts } | { ok: false; error: string };

/** Is the login to this org still valid? Reads its name and type (production, sandbox…). */
export async function checkOrg(org: OrgChoice): Promise<OrgCheck> {
  try {
    const client = await detectHost().client(org);
    return { ok: true, facts: await orgFacts(client) };
  } catch (e) {
    const message = (e as Error).message;
    return {
      ok: false,
      error: /session|INVALID_SESSION|401|logged in/i.test(message) ? 'Session expired: log in again' : message,
    };
  }
}
