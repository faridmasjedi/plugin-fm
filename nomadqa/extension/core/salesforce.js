// The Salesforce pieces NomadQA needs: which orgs this browser is logged in to, and a small API client.
// Its own copy (NomadQA never imports from NomadSF).

/** The My Domain API host of any Salesforce page host (Lightning, Setup, Visualforce, sites). */
export function apiHostFor(pageHost) {
  const host = String(pageHost).toLowerCase();
  if (host.endsWith('.my.salesforce.com')) return host;
  const rules = [
    [/\.lightning\.force\.com$/, '.my.salesforce.com'],
    [/\.my\.salesforce-setup\.com$/, '.my.salesforce.com'],
    [/--[\w]+(\.sandbox|\.develop|\.scratch)?\.vf\.force\.com$/, '$1.my.salesforce.com'],
    [/\.vf\.force\.com$/, '.my.salesforce.com'],
    [/\.my\.site\.com$/, '.my.salesforce.com'],
  ];
  for (const [pattern, replacement] of rules) if (pattern.test(host)) return host.replace(pattern, replacement);
  if (/^[a-z]+\d+\.salesforce\.com$/.test(host)) return host;
  return undefined;
}

/** Orgs with a session cookie in this browser (the extension's own view of "logged in"). */
export async function browserOrgs() {
  const cookies = await chrome.cookies.getAll({ name: 'sid' });
  const hosts = new Set();
  for (const c of cookies) {
    const host = apiHostFor(c.domain.replace(/^\./, ''));
    if (host && c.value) hosts.add(host);
  }
  return [...hosts].sort().map((host) => ({ host, label: host.replace(/\.my\.salesforce\.com$/, '') }));
}

export async function sessionFor(host) {
  const c = await chrome.cookies.get({ url: `https://${host}`, name: 'sid' });
  if (!c?.value) throw new Error(`Not logged in to ${host}. Open Salesforce in this browser and log in first.`);
  return c.value;
}

const xmlEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const tag = (xml, name) => {
  const m = new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  return m ? m[1] : undefined;
};
const unescapeXml = (s) =>
  String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** A Salesforce API client over fetch. `fetchImpl` is replaceable in tests. */
export class Salesforce {
  constructor(host, sessionId, { version = '62.0', fetchImpl } = {}) {
    this.host = host;
    this.sid = sessionId;
    this.version = version;
    this.fetch = fetchImpl ?? ((...a) => fetch(...a));
    this.describes = new Map();
  }

  get base() {
    return `https://${this.host}`;
  }

  async rest(method, path, body, headers = {}) {
    const url = path.startsWith('/services/') ? this.base + path : `${this.base}/services/data/v${this.version}${path}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.sid}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const first = Array.isArray(data) ? data[0] : data;
      throw new Error(first?.message ?? `${method} ${path}: HTTP ${res.status}`);
    }
    return data;
  }

  /** Every row of a SOQL query (follows the next pages). */
  async query(soql, { max = 50000 } = {}) {
    let page = await this.rest('GET', `/query?q=${encodeURIComponent(soql)}`);
    const rows = [...page.records];
    while (!page.done && page.nextRecordsUrl && rows.length < max) {
      // eslint-disable-next-line no-await-in-loop
      page = await this.rest('GET', page.nextRecordsUrl);
      rows.push(...page.records);
    }
    return rows.map(({ attributes, ...r }) => r);
  }

  async describe(object) {
    if (!this.describes.has(object))
      this.describes.set(object, await this.rest('GET', `/sobjects/${encodeURIComponent(object)}/describe`));
    return this.describes.get(object);
  }

  async objects() {
    const g = await this.rest('GET', '/sobjects');
    return g.sobjects.filter((o) => o.createable && o.queryable && !o.deprecatedAndHidden);
  }

  /** Values of a picklist for one record type (UI API), as [{value, label}]. */
  async picklistFor(object, recordTypeId, field) {
    const r = await this.rest('GET', `/ui-api/object-info/${object}/picklist-values/${recordTypeId}/${field}`);
    return (r.values ?? []).map((v) => ({ value: v.value, label: v.label }));
  }

  /**
   * Inserts records of one object, 200 per call, each on its own (one failing does not stop the others).
   * Returns one result per record: { id } or { error }.
   */
  async insert(object, records, { allowDuplicates = false } = {}) {
    const out = [];
    for (let i = 0; i < records.length; i += 200) {
      const chunk = records.slice(i, i + 200).map((r) => ({ attributes: { type: object }, ...r }));
      // eslint-disable-next-line no-await-in-loop
      const res = await this.rest(
        'POST',
        '/composite/sobjects',
        { allOrNone: false, records: chunk },
        allowDuplicates ? { 'Sforce-Duplicate-Rule-Header': 'allowSave=true' } : {}
      );
      for (const r of res)
        out.push(r.success ? { id: r.id } : { error: (r.errors ?? []).map((e) => e.message).join('; ') || 'failed' });
    }
    return out;
  }

  /** Deletes records by Id, 200 per call; returns how many were deleted and the problems. */
  async remove(ids) {
    let deleted = 0;
    const problems = [];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      // eslint-disable-next-line no-await-in-loop
      const res = await this.rest('DELETE', `/composite/sobjects?allOrNone=false&ids=${chunk.join(',')}`);
      for (const r of res) {
        if (r.success) deleted++;
        else {
          const msg = (r.errors ?? []).map((e) => e.message).join('; ');
          // Already gone (deleted by hand, or with its parent): not a problem
          if (!/entity is deleted|invalid cross reference|INVALID_CROSS_REFERENCE_KEY|ENTITY_IS_DELETED/i.test(msg))
            problems.push(`${r.id ?? ''} ${msg}`.trim());
        }
      }
    }
    return { deleted, problems };
  }

  /** Runs anonymous Apex (SOAP Apex API) and returns { compiled, success, compileProblem, exceptionMessage, line }. */
  async executeAnonymous(apex) {
    const body =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:apex="http://soap.sforce.com/2006/08/apex">' +
      `<env:Header><apex:SessionHeader><apex:sessionId>${xmlEscape(
        this.sid
      )}</apex:sessionId></apex:SessionHeader></env:Header>` +
      `<env:Body><apex:executeAnonymous><apex:String>${xmlEscape(
        apex
      )}</apex:String></apex:executeAnonymous></env:Body>` +
      '</env:Envelope>';
    const res = await this.fetch(`${this.base}/services/Soap/s/${this.version}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: '""' },
      body,
    });
    const xml = await res.text();
    const fault = tag(xml, 'faultstring');
    if (fault) throw new Error(unescapeXml(fault));
    return {
      compiled: tag(xml, 'compiled') === 'true',
      success: tag(xml, 'success') === 'true',
      compileProblem: unescapeXml(tag(xml, 'compileProblem')),
      exceptionMessage: unescapeXml(tag(xml, 'exceptionMessage')),
      line: Number(tag(xml, 'line') ?? -1),
    };
  }

  /** The org's name, whether it is a sandbox, and the user's name. */
  async facts() {
    const [org] = await this.query('SELECT Name, IsSandbox, OrganizationType FROM Organization LIMIT 1');
    const me = await this.rest('GET', '/chatter/users/me').catch(() => null);
    return {
      name: org?.Name ?? '',
      isSandbox: org?.IsSandbox === true,
      type: org?.OrganizationType ?? '',
      user: me?.displayName ?? '',
      userId: me?.id ?? '',
    };
  }
}
