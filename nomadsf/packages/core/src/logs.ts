import type { SalesforceClient } from './client.js';
import { query, type Row } from './query.js';

export type ApexLogSummary = {
  Id: string;
  'LogUser.Name'?: string;
  Operation: string;
  Status: string;
  Request?: string;
  Location?: string;
  StartTime: string;
  DurationMilliseconds: number;
  LogLength: number;
};

export async function listLogs(
  client: SalesforceClient,
  options: { userId?: string; limit?: number } = {}
): Promise<ApexLogSummary[]> {
  const where = options.userId ? ` WHERE LogUserId = '${options.userId.replace(/[^\w]/g, '')}'` : '';
  const result = await query(
    client,
    `SELECT Id, LogUser.Name, Operation, Status, Request, Location, StartTime, DurationMilliseconds, LogLength FROM ApexLog${where} ORDER BY StartTime DESC LIMIT ${
      options.limit ?? 100
    }`
  );
  return result.rows as unknown as ApexLogSummary[];
}

export function getLogBody(client: SalesforceClient, id: string): Promise<string> {
  if (!/^07L\w{12,15}$/.test(id)) throw new Error('Invalid log id.');
  return client.text(`/sobjects/ApexLog/${id}/Body`);
}

/** Deletes logs in batches of 200; returns how many were deleted. */
export async function deleteLogs(client: SalesforceClient, ids: string[]): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200).filter((id) => /^07L\w{12,15}$/.test(id));
    if (batch.length === 0) continue;
    // eslint-disable-next-line no-await-in-loop
    const results = await client.rest<Array<{ success: boolean }>>(
      'DELETE',
      `/composite/sobjects?ids=${batch.join(',')}&allOrNone=false`
    );
    deleted += results.filter((r) => r.success).length;
  }
  return deleted;
}

export type TraceFlag = {
  Id: string;
  ExpirationDate: string;
  LogType: string;
  DebugLevelId: string;
  'DebugLevel.DeveloperName'?: string;
};

export async function activeTraceFlag(client: SalesforceClient, userId: string): Promise<TraceFlag | undefined> {
  const result = await query(
    client,
    `SELECT Id, ExpirationDate, LogType, DebugLevelId, DebugLevel.DeveloperName FROM TraceFlag WHERE TracedEntityId = '${userId.replace(
      /[^\w]/g,
      ''
    )}' AND ExpirationDate > ${new Date()
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')} ORDER BY ExpirationDate DESC LIMIT 1`,
    { tooling: true }
  );
  return result.rows[0] as TraceFlag | undefined;
}

const NOMADSF_DEBUG_LEVEL = 'NomadSF';

async function nomadDebugLevelId(client: SalesforceClient): Promise<string> {
  const existing = await query(client, `SELECT Id FROM DebugLevel WHERE DeveloperName = '${NOMADSF_DEBUG_LEVEL}'`, {
    tooling: true,
  });
  if (existing.rows[0]) return String(existing.rows[0].Id);
  const created = await client.tooling<{ id: string }>('POST', '/sobjects/DebugLevel', {
    DeveloperName: NOMADSF_DEBUG_LEVEL,
    MasterLabel: NOMADSF_DEBUG_LEVEL,
    ApexCode: 'FINEST',
    ApexProfiling: 'INFO',
    Callout: 'INFO',
    Database: 'INFO',
    System: 'DEBUG',
    Validation: 'INFO',
    Visualforce: 'INFO',
    Workflow: 'INFO',
  });
  return created.id;
}

/**
 * Turns on debug logs for a user for `minutes` (max 24h), like the Developer Console:
 * extends the active trace flag or creates one with the NomadSF debug level.
 */
export async function ensureTraceFlag(
  client: SalesforceClient,
  userId: string,
  minutes = 60
): Promise<{ id: string; expires: string }> {
  const expires = new Date(Date.now() + Math.min(minutes, 24 * 60) * 60_000).toISOString();
  const current = await activeTraceFlag(client, userId);
  if (current) {
    await client.tooling('PATCH', `/sobjects/TraceFlag/${current.Id}`, { ExpirationDate: expires });
    return { id: current.Id, expires };
  }
  const debugLevelId = await nomadDebugLevelId(client);
  const created = await client.tooling<{ id: string }>('POST', '/sobjects/TraceFlag', {
    TracedEntityId: userId,
    DebugLevelId: debugLevelId,
    LogType: 'DEVELOPER_LOG',
    StartDate: new Date().toISOString(),
    ExpirationDate: expires,
  });
  return { id: created.id, expires };
}

export async function disableTraceFlag(client: SalesforceClient, userId: string): Promise<boolean> {
  const current = await activeTraceFlag(client, userId);
  if (!current) return false;
  await client.tooling('DELETE', `/sobjects/TraceFlag/${current.Id}`);
  return true;
}

export type { Row };
