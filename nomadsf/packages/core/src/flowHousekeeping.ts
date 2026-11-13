import type { SalesforceClient } from './client.js';
import { query, type Row } from './query.js';
import { deleteByIds, type BatchResult } from './accessManage.js';

/**
 * Develop › Flows: tidying flows — versions that no longer run, active flows on an old API version, interviews left
 * paused, and runs that failed (when the org keeps flow interview logs).
 */

export type FlowVersion = {
  id: string;
  flow: string;
  label: string;
  version: number;
  status: string;
  apiVersion: number;
  processType: string;
  lastModified: string;
};

/** Every version of every flow (Tooling API), newest first per flow. */
export async function flowVersions(client: SalesforceClient): Promise<FlowVersion[]> {
  const rows = (
    await query(
      client,
      'SELECT Id, Definition.DeveloperName, MasterLabel, VersionNumber, Status, ApiVersion, ProcessType, LastModifiedDate FROM Flow ORDER BY Definition.DeveloperName, VersionNumber DESC',
      { tooling: true, maxRows: 50_000 }
    )
  ).rows;
  return rows.map((r) => ({
    id: String(r.Id),
    flow: String(r['Definition.DeveloperName'] ?? ''),
    label: String(r.MasterLabel ?? ''),
    version: Number(r.VersionNumber ?? 0),
    status: String(r.Status ?? ''),
    apiVersion: Number(r.ApiVersion ?? 0),
    processType: String(r.ProcessType ?? ''),
    lastModified: String(r.LastModifiedDate ?? ''),
  }));
}

/** Versions that do not run and are not the newest of their flow (the newest draft is kept: work in progress). */
export function oldVersions(all: FlowVersion[]): FlowVersion[] {
  const newest = new Map<string, number>();
  for (const v of all) newest.set(v.flow, Math.max(newest.get(v.flow) ?? 0, v.version));
  return all.filter((v) => v.status !== 'Active' && v.version !== newest.get(v.flow));
}

/** Active flows on an API version below `below`. */
export function oldApiFlows(all: FlowVersion[], below: number): FlowVersion[] {
  return all.filter((v) => v.status === 'Active' && v.apiVersion > 0 && v.apiVersion < below);
}

/** Deletes flow versions (never an active one), one at a time as the Tooling API takes them. */
export async function deleteFlowVersions(client: SalesforceClient, versions: FlowVersion[]): Promise<BatchResult> {
  const out: BatchResult = { done: 0, errors: [] };
  for (const v of versions) {
    if (v.status === 'Active') {
      out.errors.push(`${v.flow} v${v.version}: active, kept`);
      continue;
    }
    if (!/^301\w{12}(\w{3})?$/.test(v.id)) {
      out.errors.push(`${v.flow} v${v.version}: not a flow version Id`);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await client.tooling('DELETE', `/sobjects/Flow/${v.id}`);
      out.done += 1;
    } catch (e) {
      out.errors.push(`${v.flow} v${v.version}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Interviews waiting (paused, or waiting for a time or an event). */
export async function pausedInterviews(client: SalesforceClient): Promise<Row[]> {
  return (
    await query(
      client,
      'SELECT Id, InterviewLabel, InterviewStatus, CurrentElement, PauseLabel, CreatedDate, CreatedBy.Name FROM FlowInterview ORDER BY CreatedDate',
      { maxRows: 50_000 }
    )
  ).rows;
}

export function deleteInterviews(client: SalesforceClient, ids: string[]): Promise<BatchResult> {
  return deleteByIds(client, ids);
}

/** Runs that ended in an error, when the org keeps flow interview logs (undefined when it does not). */
export async function failedRuns(client: SalesforceClient, days: number): Promise<Row[] | undefined> {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('Days: a whole number from 1 to 3650.');
  try {
    return (
      await query(
        client,
        `SELECT Id, FlowDeveloperName, FlowLabel, FlowVersionNumber, InterviewStatus, InterviewStartTimestamp, CreatedBy.Name FROM FlowInterviewLog WHERE InterviewStatus = 'Error' AND CreatedDate = LAST_N_DAYS:${days} ORDER BY CreatedDate DESC`,
        { maxRows: 50_000 }
      )
    ).rows;
  } catch {
    return undefined;
  }
}
