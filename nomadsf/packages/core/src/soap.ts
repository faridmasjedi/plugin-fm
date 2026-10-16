import { SESSION_PLACEHOLDER, type SalesforceClient } from './client.js';

/** Tiny XML helpers: SOAP responses here are flat and well known, so no XML library is needed. */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** Text of the first element named `tag` (any namespace prefix); undefined when missing or nil. */
export function xmlValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<(?:\\w+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(xml);
  return match ? unescapeXml(match[1]) : undefined;
}

export const LOG_CATEGORIES = [
  'Db',
  'Workflow',
  'Validation',
  'Callout',
  'Apex_code',
  'Apex_profiling',
  'Visualforce',
  'System',
  'Wave',
  'Nba',
] as const;
export const LOG_LEVELS = ['NONE', 'ERROR', 'WARN', 'INFO', 'DEBUG', 'FINE', 'FINER', 'FINEST'] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type LogLevels = Partial<Record<LogCategory, LogLevel>>;

/** Same defaults as the Developer Console. */
export const DEFAULT_LOG_LEVELS: LogLevels = {
  Db: 'INFO',
  Workflow: 'INFO',
  Validation: 'INFO',
  Callout: 'INFO',
  Apex_code: 'DEBUG',
  Apex_profiling: 'INFO',
  Visualforce: 'INFO',
  System: 'DEBUG',
};

export type ExecuteAnonymousResult = {
  compiled: boolean;
  success: boolean;
  compileProblem?: string;
  exceptionMessage?: string;
  exceptionStackTrace?: string;
  line?: number;
  column?: number;
  log: string;
  durationMs: number;
};

export function executeAnonymousEnvelope(code: string, levels: LogLevels = DEFAULT_LOG_LEVELS): string {
  const categories = Object.entries(levels)
    .map(
      ([category, level]) =>
        `<apex:categories><apex:category>${category}</apex:category><apex:level>${level}</apex:level></apex:categories>`
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:apex="http://soap.sforce.com/2006/08/apex">
<soapenv:Header>
<apex:DebuggingHeader>${categories}<apex:debugLevel>NONE</apex:debugLevel></apex:DebuggingHeader>
<apex:SessionHeader><apex:sessionId>${SESSION_PLACEHOLDER}</apex:sessionId></apex:SessionHeader>
</soapenv:Header>
<soapenv:Body><apex:executeAnonymous><apex:String>${escapeXml(
    code
  )}</apex:String></apex:executeAnonymous></soapenv:Body>
</soapenv:Envelope>`;
}

export function parseExecuteAnonymous(xml: string, durationMs = 0): ExecuteAnonymousResult {
  const result = xmlValue(xml, 'result') ?? '';
  const number = (tag: string): number | undefined => {
    const value = xmlValue(result, tag);
    return value && Number(value) >= 0 ? Number(value) : undefined;
  };
  return {
    compiled: xmlValue(result, 'compiled') === 'true',
    success: xmlValue(result, 'success') === 'true',
    compileProblem: xmlValue(result, 'compileProblem') || undefined,
    exceptionMessage: xmlValue(result, 'exceptionMessage') || undefined,
    exceptionStackTrace: xmlValue(result, 'exceptionStackTrace') || undefined,
    line: number('line'),
    column: number('column'),
    log: xmlValue(xml, 'debugLog') ?? '',
    durationMs,
  };
}

/** Runs anonymous Apex like the Developer Console and returns the debug log with it. */
export async function executeAnonymous(
  client: SalesforceClient,
  code: string,
  levels?: LogLevels
): Promise<ExecuteAnonymousResult> {
  const start = Date.now();
  const xml = await client.soap('apex', executeAnonymousEnvelope(code, levels));
  return parseExecuteAnonymous(xml, Date.now() - start);
}

export type UserInfo = {
  userId: string;
  userName: string;
  userFullName: string;
  organizationId: string;
  organizationName: string;
  userTimeZone?: string;
  userLocale?: string;
};

export async function getUserInfo(client: SalesforceClient): Promise<UserInfo> {
  const xml = await client.soap(
    'partner',
    `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">
<soapenv:Header><urn:SessionHeader><urn:sessionId>${SESSION_PLACEHOLDER}</urn:sessionId></urn:SessionHeader></soapenv:Header>
<soapenv:Body><urn:getUserInfo/></soapenv:Body>
</soapenv:Envelope>`
  );
  const field = (tag: string): string => xmlValue(xml, tag) ?? '';
  return {
    userId: field('userId'),
    userName: field('userName'),
    userFullName: field('userFullName'),
    organizationId: field('organizationId'),
    organizationName: field('organizationName'),
    userTimeZone: field('userTimeZone') || undefined,
    userLocale: field('userLocale') || undefined,
  };
}
