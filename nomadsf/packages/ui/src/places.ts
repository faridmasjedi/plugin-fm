import type { Place } from '@nomadsf/core';
import type { ToolId } from './workspace';

/**
 * What people come to do, and where in the Studio it is done: the tool, and the tab or mode to open it on (the
 * page's remembered choice, set before it opens). Found by ⌘K from words like "stop a batch job".
 */
export type StudioPlace = Place & {
  tool: ToolId;
  /** The tab inside the tool, by name (shown as Hub › Tool › Tab). */
  where?: string;
  /** The page's remembered choices to set first: storage key → value. */
  set?: Record<string, string>;
};

const P = (tool: ToolId, say: string, also = '', where?: string, set?: Record<string, string>): StudioPlace => ({
  tool,
  say,
  also,
  where,
  set,
});

export const PLACES: StudioPlace[] = [
  // ---------- Develop ----------
  P('code', 'edit an Apex class', 'open change save write new class classes code developer console', 'Apex classes', {
    'code.kind': 'ApexClass',
  }),
  P('code', 'edit an Apex trigger', 'open change save new trigger', 'Triggers', { 'code.kind': 'ApexTrigger' }),
  P('code', 'edit a Lightning web component', 'lwc js html css bundle code', 'LWC', { 'code.kind': 'LWC' }),
  P('code', 'edit an Aura component', 'aura bundle cmp controller code', 'Aura', { 'code.kind': 'Aura' }),
  P('code', 'edit a Visualforce page', 'vf page visualforce code', 'Visualforce pages', { 'code.kind': 'ApexPage' }),
  P('code', 'edit a Visualforce component', 'vf component', 'Visualforce components', { 'code.kind': 'ApexComponent' }),
  P('code', 'compare my code with the project', 'org vs repo local file different branch'),
  P('code', 'deploy a class from the project', 'push local file to org'),
  P('code', 'explain or review code with AI', 'ai explain review improve'),
  P('code', 'what uses this class', 'dependencies where used references depends'),
  P('apex', 'run anonymous Apex', 'execute script snippet run code'),
  P('apex', 'write Apex with AI', 'generate script ai'),
  P('apextests', 'run Apex tests', 'unit test run failing tests'),
  P('apextests', 'find a test class by name and run it', 'search test class filter run one'),
  P('apextests', 'see code coverage', 'coverage percentage 75 uncovered lines'),
  P('logs', 'read debug logs', 'debug log errors exception what happened'),
  P('logs', 'debug logs for a user', 'turn on trace flag logging level enable'),
  P('logs', 'explain a debug log with AI', 'ai error why failed'),
  P('jobs', 'see scheduled jobs', 'scheduled apex cron schedule next run', 'Scheduled', { 'jobs.tab2': 'scheduled' }),
  P('jobs', 'stop a scheduled job', 'unschedule delete schedule abort', 'Scheduled', { 'jobs.tab2': 'scheduled' }),
  P('jobs', 'see batch and queueable jobs', 'apex jobs async batch queueable future progress failed', 'Apex jobs', {
    'jobs.tab2': 'apex',
  }),
  P('jobs', 'stop a running batch job', 'abort cancel queued processing', 'Apex jobs', { 'jobs.tab2': 'apex' }),
  P(
    'jobs',
    'see background jobs',
    'sharing recalculation index rebuild cleanup chatter digest setup background operation',
    'Background jobs',
    {
      'jobs.tab2': 'background',
    }
  ),
  P(
    'automation',
    'what runs when a record is saved',
    'what happens order of execution triggers flows validation rules save insert update'
  ),
  P('automation', 'which triggers and flows are on an object', 'automation trigger flow process builder workflow rule'),
  P('automation', 'what does a trigger call', 'tree methods classes dependencies flow apex action subflow'),
  P('events', 'subscribe to platform events', 'cdc change data capture streaming listen publish event'),
  P('rest', 'call the REST API', 'rest explorer workbench endpoint http get post request'),

  // ---------- Data ----------
  P('query', 'run a SOQL query', 'query records select export table'),
  P('query', 'write a query with AI', 'ai soql question natural language'),
  P('query', 'export records to CSV', 'export download records excel'),
  P('record', 'look at one record', 'inspect record id all fields view'),
  P('record', 'edit a field on a record', 'change value update record inline'),
  P('record', 'see related records', 'children parent lookup related list'),
  P('data', 'import records from a CSV', 'insert upsert load data loader file', 'From a CSV file', {
    'data.tab': 'csv',
  }),
  P('data', 'update records from a CSV', 'mass update bulk change file', 'From a CSV file', { 'data.tab': 'csv' }),
  P('data', 'delete records from a CSV', 'mass delete bulk ids file', 'From a CSV file', { 'data.tab': 'csv' }),
  P('data', 'update records found by a query', 'mass update bulk where condition', 'From a query', {
    'data.tab': 'query',
  }),
  P('data', 'delete records found by a query', 'mass delete bulk where condition', 'From a query', {
    'data.tab': 'query',
  }),
  P('data', 'map CSV columns to fields with AI', 'ai mapping columns'),
  P('csvcompare', 'compare a CSV with the org', 'csv vs org match sync make the same reconcile'),
  P('lookup', 'find Ids for names in a CSV', 'vlookup ids names external id lookup column'),
  P('schema', 'see the fields of an object', 'schema describe object fields api names types'),
  P('schema', 'see relationships of an object', 'lookup master detail parent child'),
  P('schema', 'see record types and picklists', 'recordtype picklist values'),
  P('fields', 'find unused fields', 'field usage empty fill rate how full', 'Usage', { 'fields.tab': 'usage' }),
  P('fields', 'who can see a field', 'field level security fls visible', 'Access', { 'fields.tab': 'access' }),

  // ---------- Release ----------
  P('project', 'open my Salesforce project', 'repository folder sfdx project overview', 'Overview', {
    'project.tab': 'overview',
  }),
  P('project', 'compare my project with the org', 'repo vs org different only in org only in project', 'Compare', {
    'project.tab': 'compare',
  }),
  P('project', 'retrieve from the org into my project', 'pull changes write files source'),
  P('package', 'compare two branches', 'git branch diff pull request merge feature main', 'Branch ↔ Branch', {
    'compare.mode': 'branches',
  }),
  P('package', 'build package.xml from a branch', 'packagexml destructive manifest delta', 'Branch ↔ Branch', {
    'compare.mode': 'branches',
  }),
  P('package', 'deploy my branch to an org', 'compare branch with org repo deploy validate', 'Branch ↔ Org', {
    'compare.mode': 'branch-org',
  }),
  P('package', 'compare a branch with an org', 'git branch vs sandbox repo', 'Branch ↔ Org', {
    'compare.mode': 'branch-org',
  }),
  P('package', 'deploy a package.xml from a branch', 'manifest packagexml', 'From a manifest', {
    'compare.mode': 'manifest',
  }),
  P('package', 'compare two orgs and package the difference', 'sandbox vs sandbox', 'Org ↔ Org', {
    'compare.mode': 'org-org',
  }),
  P('metadata', 'retrieve metadata', 'download zip packagexml flows layouts objects'),
  P('metadata', 'find one component by name in a long list', 'search class flow name filter thousands'),
  P('metadata', 'see or change a flow, layout or other metadata', 'xml metadata edit deploy'),
  P('metadata', 'validate a deployment', 'check only test level run tests'),
  P('deployments', 'see deployment history', 'deploy status failed errors past deployments'),
  P('deployments', 'quick deploy a validated deployment', 'quick deploy validation'),
  P('deployments', 'why did a deployment fail', 'deploy error component failure test failure'),

  // ---------- Access ----------
  P('access', 'find a user', 'search user username email profile role'),
  P('access', 'freeze or deactivate a user', 'freeze unfreeze activate deactivate disable'),
  P('access', 'login as a user', 'log in as impersonate become user'),
  P('access', 'edit a user', 'change user email role profile manager'),
  P('access', "see a user's permission sets", 'what does a user have assigned', 'Permission sets & groups', {
    'user.tab': 'perms',
  }),
  P('access', "see a user's system permissions", 'can a user modify all view all', 'System permissions', {
    'user.tab': 'system',
  }),
  P('access', "see a user's login history", 'when did a user log in', 'Login history', { 'user.tab': 'logins' }),
  P('permsets', 'assign a permission set', 'give add permission set users'),
  P('permsets', 'remove a permission set from users', 'unassign take away'),
  P('permsets', 'who has a permission set', 'assignees assigned users'),
  P('permsets', 'create a permission set or group', 'new permission set group'),
  P('permissions', 'what does a profile allow', 'profile object field system permissions'),
  P(
    'permissions',
    'edit object permissions of a permission set',
    'read create edit delete view all modify all crud',
    'Object access',
    {
      'perms.tab': 'objects',
    }
  ),
  P('permissions', 'edit field access of a permission set', 'fls field level security read edit', 'Field access', {
    'perms.tab': 'fields',
  }),
  P(
    'permissions',
    'give a system permission',
    'modify all data api enabled user permission',
    'User & system permissions',
    {
      'perms.tab': 'system',
    }
  ),
  P(
    'permissions',
    'which Apex classes or pages a profile can use',
    'apex class access visualforce apps',
    'Apps, classes & more',
    {
      'perms.tab': 'setup',
    }
  ),
  P('custperms', 'who has a custom permission', 'custom permission grant'),
  P('groups', 'add users to a public group or queue', 'group queue members add remove'),
  P(
    'groups',
    'who is in a role or group inside a group or queue',
    'members of role subordinates nested group queue who is in'
  ),
  P('assigned', 'list users of a profile, role or license', 'assigned users members profile role license group queue'),
  P('objectaccess', 'who can edit an object', 'why cant user edit read create delete object records access users'),
  P('objectaccess', 'who can see a field on an object', 'field visibility users'),
  P('accessmap', 'overview of every user and their access', 'all users matrix permission sets profiles'),
  P('compare', 'compare two users', 'why can user a and not user b access difference', 'Two users', {
    'access.compare.mode': 'users',
  }),
  P('compare', 'compare two profiles', 'profile difference', 'Profiles', { 'access.compare.mode': 'Profile' }),
  P('compare', 'compare two permission sets', 'permission set difference', 'Permission sets', {
    'access.compare.mode': 'Permission set',
  }),
  P('myaccess', 'what can my user do here', 'my permissions am i admin my access'),

  // ---------- Org ----------
  P('company', 'see the org Id and edition', 'company information org id edition locale currency fiscal year'),
  P('health', 'check org security', 'security health check risks password policies session', 'Security', {
    'health.tab': 'security',
  }),
  P('health', 'see licenses in use', 'user licenses permission set licenses used available', 'Licenses', {
    'health.tab': 'licenses',
  }),
  P('limits', 'see org limits', 'api calls daily limits remaining', 'Limits', { 'limits.tab': 'limits' }),
  P('limits', 'see data and file storage', 'storage usage space full', 'Storage', { 'limits.tab': 'storage' }),
  P('apps', 'see connected apps', 'oauth connected app external client app policies'),
  P('apps', 'who uses a connected app', 'oauth tokens users revoke'),
  P('audit', 'see login history', 'logins failed login ip', 'Login history', { 'audit.tab': 'login' }),
  P(
    'audit',
    'who changed setup',
    'setup audit trail changes configuration who changed validationrule flow field layout profile metadata',
    'Setup audit trail',
    {
      'audit.tab': 'audit',
    }
  ),
  P('activity', 'what did I change from here', 'activity history changes made by nomadsf'),

  // ---------- Data protection ----------
  P('backup', 'back up data', 'backup records objects files', 'What to back up', { 'backup.tab': 'what' }),
  P('backup', 'schedule a backup', 'daily weekly automatic backup', 'Settings', { 'backup.tab': 'when' }),
  P('backup', 'restore records from a backup', 'restore undo deleted recover', 'Backups & restore', {
    'backup.tab': 'runs',
  }),
  P('lifecycle', 'archive old records', 'retention archive old cases', 'Steps', { 'lifecycle.tab': 'steps' }),
  P('lifecycle', 'anonymize personal data', 'gdpr mask scramble personal sandbox refresh', 'Steps', {
    'lifecycle.tab': 'steps',
  }),
  P('lifecycle', 'delete records in steps', 'purge cleanup hard delete'),

  // ---------- Org to org ----------
  P('migrate', 'copy records to another org', 'seed sandbox copy data migrate related records'),
  P('orgdiff', 'compare metadata of two orgs', 'sandbox vs production difference deploy package between'),
  P('orgdiff', 'deploy from one org to another', 'move metadata between orgs'),
  P('orgaccess', 'find a user in two orgs', 'user in both orgs', 'Find a user', { 'orgaccess.tab': 'find' }),
  P('orgaccess', 'compare a user in two orgs', 'user access differs between orgs', 'Compare', {
    'orgaccess.tab': 'compare',
    'access.compare.mode': 'users',
  }),
  P('orgaccess', 'copy permissions from one org to another', 'copy access permission set profile into org', 'Compare', {
    'orgaccess.tab': 'compare',
  }),
  P('orgaccess', 'compare every profile and permission set of two orgs', 'all access everything', 'Compare', {
    'orgaccess.tab': 'compare',
    'access.compare.mode': 'all',
  }),
  P('orgapps', 'compare connected apps of two orgs', 'oauth connected apps difference'),

  // ---------- Settings ----------
  P('settings', 'add or log in to an org', 'connect org login new org sandbox'),
  P('settingsai', 'connect an AI', 'ai provider api key openai anthropic model'),
  P('settingsproject', 'choose my project folder', 'project folder github repository'),
];
