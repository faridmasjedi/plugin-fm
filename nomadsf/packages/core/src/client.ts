/**
 * Minimal Salesforce API client for NomadSF Studio. It runs anywhere `fetch` exists
 * (browser, extension, Node 18+) and talks to Salesforce through a Transport, so the
 * same code works with a CLI login (local app proxy), a browser session (extension)
 * or an IDE host.
 */

export type HttpRequest = {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path from the instance root, e.g. /services/data/v62.0/query?q=... */
  path: string;
  headers?: Record<string, string>;
  /** Request body; `{{SESSION_ID}}` is replaced with the session by the transport (needed for SOAP). */
  body?: string;
};

export type HttpResponse = { status: number; headers: Record<string, string>; body: string };

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export const SESSION_PLACEHOLDER = '{{SESSION_ID}}';

export class SalesforceError extends Error {
  public constructor(message: string, public readonly status: number, public readonly errorCode?: string) {
    super(message);
    this.name = 'SalesforceError';
  }
}

/** Transport that calls Salesforce directly with a session id or OAuth access token. */
export function fetchTransport(instanceUrl: string, accessToken: string, fetchImpl: typeof fetch = fetch): Transport {
  const base = instanceUrl.replace(/\/$/, '');
  return async (request) => {
    const response = await fetchImpl(base + request.path, {
      method: request.method,
      headers: { Authorization: `Bearer ${accessToken}`, ...request.headers },
      body: request.body?.split(SESSION_PLACEHOLDER).join(accessToken),
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return { status: response.status, headers, body: await response.text() };
  };
}

/**
 * Transport for a host that keeps the credentials (e.g. the NomadSF local app):
 * the request is posted as JSON to `endpoint`, which forwards it to Salesforce.
 */
export function proxyTransport(endpoint: string, extraHeaders: Record<string, string> = {}): Transport {
  return async (request) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify(request),
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // keep the raw text
      }
      throw new SalesforceError(message, response.status);
    }
    return JSON.parse(text) as HttpResponse;
  };
}

type ErrorBody = Array<{ message?: string; errorCode?: string }> | { message?: string; errorCode?: string };

function errorFrom(response: HttpResponse): SalesforceError {
  try {
    const parsed = JSON.parse(response.body) as ErrorBody;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (first?.message) return new SalesforceError(first.message, response.status, first.errorCode);
  } catch {
    // not JSON (e.g. a SOAP fault or an HTML error page)
  }
  const fault = /<faultstring>([\s\S]*?)<\/faultstring>/.exec(response.body)?.[1];
  return new SalesforceError(fault ?? (response.body.slice(0, 300) || `HTTP ${response.status}`), response.status);
}

export class SalesforceClient {
  private versionPromise?: Promise<string>;

  public constructor(private readonly transport: Transport, apiVersion?: string) {
    if (apiVersion) this.versionPromise = Promise.resolve(apiVersion.replace(/^v/, ''));
  }

  /** Latest API version the org supports (e.g. "64.0"). */
  public version(): Promise<string> {
    this.versionPromise ??= this.raw({ method: 'GET', path: '/services/data/' }).then((response) => {
      const versions = JSON.parse(response.body) as Array<{ version: string }>;
      return versions[versions.length - 1].version;
    });
    return this.versionPromise;
  }

  /** Sends a request and throws a SalesforceError for HTTP errors. */
  public async raw(request: HttpRequest): Promise<HttpResponse> {
    const response = await this.transport(request);
    if (response.status >= 400) throw errorFrom(response);
    return response;
  }

  /** REST call relative to /services/data/vXX.X (e.g. "/query?q=..."); returns parsed JSON. */
  public async rest<T>(method: HttpRequest['method'], path: string, body?: unknown): Promise<T> {
    const version = await this.version();
    const response = await this.raw({
      method,
      path: `/services/data/v${version}${path}`,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return (response.body ? JSON.parse(response.body) : undefined) as T;
  }

  /** Same as rest(), for the Tooling API. */
  public tooling<T>(method: HttpRequest['method'], path: string, body?: unknown): Promise<T> {
    return this.rest<T>(method, `/tooling${path}`, body);
  }

  /** Plain-text resource (e.g. an ApexLog body). */
  public async text(path: string): Promise<string> {
    const version = await this.version();
    return (await this.raw({ method: 'GET', path: `/services/data/v${version}${path}` })).body;
  }

  /** SOAP call; `envelope` uses {{SESSION_ID}} for the session header. */
  public async soap(endpoint: 'apex' | 'partner' | 'metadata', envelope: string): Promise<string> {
    const version = await this.version();
    const path = `/services/Soap/${{ apex: 's', partner: 'u', metadata: 'm' }[endpoint]}/${version}`;
    const response = await this.raw({
      method: 'POST',
      path,
      headers: { 'content-type': 'text/xml; charset=UTF-8', SOAPAction: '""' },
      body: envelope,
    });
    return response.body;
  }
}
