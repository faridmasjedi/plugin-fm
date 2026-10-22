import type { SalesforceClient } from './client.js';
import { parseDeployResult, type DeployOutcome } from './deploy.js';
import { metadataEnvelope } from './metadata.js';
import { query, type Row } from './query.js';
import { executeAnonymous, xmlValue } from './soap.js';

/** What runs when a record is saved; scheduled and background jobs; deployment history. */

const NAME = /^\w+$/;
const ID = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

// ---------- what runs on save ----------

export type SaveStep = {
  order: number;
  when: string;
  kind: string;
  name: string;
  active: boolean;
  events: string;
  detail: string;
};

/**
 * The automation on an object in Salesforce's order of execution: before-save flows, before
 * triggers, validation rules, duplicate rules, after triggers, assignment rules, workflow
 * rules, after-save flows (and delete flows). Escalation and auto-response rules cannot be
 * read with the API.
 */
export async function saveOrder(
  client: SalesforceClient,
  sobject: string
): Promise<{ steps: SaveStep[]; notes: string[] }> {
  if (!NAME.test(sobject)) throw new Error('Invalid object name.');
  const notes: string[] = [];
  const optional = async (what: string, soql: string, tooling = false): Promise<Row[]> => {
    try {
      return (await query(client, soql, { maxRows: 5000, tooling })).rows;
    } catch (e) {
      notes.push(`${what}: ${(e as Error).message}`);
      return [];
    }
  };
  // Custom objects are named by their Id in ApexTrigger / WorkflowRule
  const entity = (
    await optional('Object', `SELECT DurableId FROM EntityDefinition WHERE QualifiedApiName = '${sobject}'`)
  )[0];
  const table = String(entity?.DurableId ?? sobject);
  const [triggers, flows, rules, duplicates, assignment, workflow] = await Promise.all([
    optional(
      'Apex triggers',
      `SELECT Id, Name, Status, UsageBeforeInsert, UsageBeforeUpdate, UsageBeforeDelete, UsageAfterInsert, UsageAfterUpdate, UsageAfterDelete, UsageAfterUndelete FROM ApexTrigger WHERE TableEnumOrId = '${table}' ORDER BY Name`,
      true
    ),
    optional(
      'Record-triggered flows',
      `SELECT ApiName, Label, TriggerType, RecordTriggerType, IsActive, TriggerOrder, ProcessType FROM FlowDefinitionView WHERE TriggerObjectOrEvent.QualifiedApiName = '${sobject}' ORDER BY TriggerOrder NULLS LAST, Label`
    ),
    optional(
      'Validation rules',
      `SELECT ValidationName, Active, ErrorMessage, ErrorDisplayField FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = '${sobject}' ORDER BY ValidationName`,
      true
    ),
    optional(
      'Duplicate rules',
      `SELECT MasterLabel, IsActive FROM DuplicateRule WHERE SobjectType = '${sobject}' ORDER BY MasterLabel`
    ),
    optional(
      'Assignment rules',
      `SELECT Name, Active FROM AssignmentRule WHERE SobjectType = '${sobject}' ORDER BY Name`
    ),
    optional('Workflow rules', `SELECT Name FROM WorkflowRule WHERE TableEnumOrId = '${table}' ORDER BY Name`, true),
  ]);

  const events = (t: Row, when: 'Before' | 'After'): string =>
    ['Insert', 'Update', 'Delete', 'Undelete']
      .filter((e) => t[`Usage${when}${e}`] === true)
      .map((e) => e.toLowerCase())
      .join(', ');
  const flowEvents = (f: Row): string =>
    String(f.RecordTriggerType ?? '')
      .replace('CreateAndUpdate', 'insert, update')
      .replace('Create', 'insert')
      .replace('Update', 'update')
      .replace('Delete', 'delete');
  const steps: Array<Omit<SaveStep, 'order'> & { rank: number }> = [];
  const add = (rank: number, when: string, kind: string, name: string, active: boolean, ev: string, detail = '') =>
    steps.push({ rank, when, kind, name, active, events: ev, detail });

  for (const f of flows.filter((x) => x.TriggerType === 'RecordBeforeDelete'))
    add(0, 'Before delete', 'Flow (before delete)', String(f.Label), f.IsActive === true, 'delete', String(f.ApiName));
  for (const f of flows.filter((x) => x.TriggerType === 'RecordBeforeSave'))
    add(
      1,
      'Before save',
      'Flow (fast field updates)',
      String(f.Label),
      f.IsActive === true,
      flowEvents(f),
      `${f.ApiName}${f.TriggerOrder ? ` · order ${f.TriggerOrder}` : ''}`
    );
  for (const t of triggers.filter((x) => events(x, 'Before')))
    add(2, 'Before save', 'Apex trigger (before)', String(t.Name), t.Status === 'Active', events(t, 'Before'));
  for (const r of rules)
    add(
      3,
      'Before save',
      'Validation rule',
      String(r.ValidationName),
      r.Active === true,
      'insert, update',
      String(r.ErrorMessage ?? '')
    );
  for (const d of duplicates)
    add(4, 'Before save', 'Duplicate rule', String(d.MasterLabel), d.IsActive === true, 'insert, update');
  for (const t of triggers.filter((x) => events(x, 'After')))
    add(5, 'After save', 'Apex trigger (after)', String(t.Name), t.Status === 'Active', events(t, 'After'));
  for (const a of assignment) add(6, 'After save', 'Assignment rule', String(a.Name), a.Active === true, 'insert');
  for (const w of workflow)
    add(7, 'After save', 'Workflow rule', String(w.Name), true, 'insert, update', 'legacy workflow');
  for (const f of flows.filter((x) => x.TriggerType === 'RecordAfterSave'))
    add(
      8,
      'After save',
      'Flow (actions and related records)',
      String(f.Label),
      f.IsActive === true,
      flowEvents(f),
      `${f.ApiName}${f.TriggerOrder ? ` · order ${f.TriggerOrder}` : ''}`
    );

  if (['Case', 'Lead'].includes(sobject))
    notes.push('Escalation and auto-response rules also run (they cannot be read with the API).');
  return {
    steps: steps.sort((a, b) => a.rank - b.rank).map(({ rank: _rank, ...s }, i) => ({ ...s, order: i + 1 })),
    notes,
  };
}

// ---------- jobs ----------

const JOB_TYPES: Record<string, string> = {
  '1': 'Data export',
  '3': 'Dashboard refresh',
  '4': 'Reporting snapshot',
  '6': 'Scheduled flow',
  '7': 'Scheduled Apex',
  '8': 'Report run',
  '9': 'Batch job',
  A: 'Reporting notification',
};

export async function scheduledJobs(client: SalesforceClient): Promise<Row[]> {
  const rows = (
    await query(
      client,
      'SELECT Id, CronJobDetail.Name, CronJobDetail.JobType, State, NextFireTime, PreviousFireTime, CronExpression, TimesTriggered, StartTime, EndTime, CreatedBy.Name FROM CronTrigger ORDER BY NextFireTime NULLS LAST',
      { maxRows: 5000 }
    )
  ).rows;
  return rows.map((r) => ({
    Id: r.Id,
    Name: r['CronJobDetail.Name'],
    Type: JOB_TYPES[String(r['CronJobDetail.JobType'])] ?? r['CronJobDetail.JobType'],
    State: r.State,
    NextRun: r.NextFireTime ?? '',
    LastRun: r.PreviousFireTime ?? '',
    Cron: r.CronExpression,
    Runs: r.TimesTriggered,
    By: r['CreatedBy.Name'],
  }));
}

/** Batch, queueable, future and scheduled Apex jobs of the last days (not test runs). */
export async function asyncJobs(client: SalesforceClient, lastDays = 7): Promise<Row[]> {
  const days = Math.max(1, Math.min(180, Math.floor(lastDays)));
  const rows = (
    await query(
      client,
      `SELECT Id, JobType, ApexClass.Name, MethodName, Status, ExtendedStatus, JobItemsProcessed, TotalJobItems, NumberOfErrors, CreatedDate, CompletedDate, CreatedBy.Name FROM AsyncApexJob WHERE JobType != 'TestRequest' AND JobType != 'ApexToken' AND CreatedDate = LAST_N_DAYS:${days} ORDER BY CreatedDate DESC`,
      { maxRows: 5000 }
    )
  ).rows;
  return rows.map((r) => ({
    Id: r.Id,
    Type: r.JobType,
    Class: [r['ApexClass.Name'], r.MethodName].filter(Boolean).join('.'),
    Status: r.Status,
    Progress: r.TotalJobItems ? `${r.JobItemsProcessed}/${r.TotalJobItems}` : '',
    Errors: r.NumberOfErrors ?? 0,
    Detail: r.ExtendedStatus ?? '',
    Started: r.CreatedDate,
    Finished: r.CompletedDate ?? '',
    By: r['CreatedBy.Name'],
  }));
}

/** Stops a scheduled job (CronTrigger Id) or a running batch / queueable (AsyncApexJob Id). */
export async function abortJob(client: SalesforceClient, jobId: string): Promise<void> {
  if (!ID.test(jobId) || !/^(08e|707)/.test(jobId)) throw new Error('Not a scheduled or background job Id.');
  const result = await executeAnonymous(client, `System.abortJob('${jobId}');`);
  if (!result.success) throw new Error(result.compileProblem ?? result.exceptionMessage ?? 'Could not stop the job.');
}

// ---------- deployments ----------

export async function deployHistory(client: SalesforceClient, limit = 100): Promise<Row[]> {
  const rows = (
    await query(
      client,
      `SELECT Id, Status, CheckOnly, StartDate, CompletedDate, NumberComponentsDeployed, NumberComponentsTotal, NumberComponentErrors, NumberTestsCompleted, NumberTestsTotal, NumberTestErrors, CreatedBy.Name FROM DeployRequest ORDER BY StartDate DESC LIMIT ${Math.max(
        1,
        Math.min(500, Math.floor(limit))
      )}`,
      { tooling: true }
    )
  ).rows;
  const tenDays = Date.now() - 10 * 24 * 3_600_000;
  return rows.map((r) => ({
    Id: r.Id,
    Kind: r.CheckOnly ? 'Validation' : 'Deploy',
    Status: r.Status,
    Started: r.StartDate ?? '',
    Finished: r.CompletedDate ?? '',
    Components: `${r.NumberComponentsDeployed ?? 0}/${r.NumberComponentsTotal ?? 0}${
      Number(r.NumberComponentErrors) ? ` · ${r.NumberComponentErrors} failed` : ''
    }`,
    Tests: Number(r.NumberTestsTotal)
      ? `${r.NumberTestsCompleted ?? 0}/${r.NumberTestsTotal}${
          Number(r.NumberTestErrors) ? ` · ${r.NumberTestErrors} failed` : ''
        }`
      : '',
    By: r['CreatedBy.Name'],
    // A validation that succeeded in the last 10 days, with tests, can be quick deployed
    QuickDeploy:
      r.CheckOnly &&
      r.Status === 'Succeeded' &&
      Number(r.NumberTestsTotal) > 0 &&
      Date.parse(String(r.CompletedDate)) > tenDays
        ? 'yes'
        : '',
  }));
}

/** One deployment with its component and test failures (Metadata API checkDeployStatus). */
export async function deployDetails(client: SalesforceClient, id: string): Promise<DeployOutcome> {
  if (!ID.test(id)) throw new Error('Invalid deployment Id.');
  const xml = await client.soap(
    'metadata',
    metadataEnvelope(
      `<met:checkDeployStatus><met:asyncProcessId>${id}</met:asyncProcessId><met:includeDetails>true</met:includeDetails></met:checkDeployStatus>`
    )
  );
  return parseDeployResult(xmlValue(xml, 'result') ?? '', id);
}
