/**
 * Ready-to-work orgs in one command: create a scratch org or sandbox, deploy the project,
 * assign permission sets, load sample data and run setup Apex. Each step is an `sf` command,
 * so the plan can be shown (--dry-run) before anything runs.
 */

export type OrgCreateOptions = {
  type: 'scratch' | 'sandbox';
  alias: string;
  definitionFile?: string;
  durationDays?: number;
  devHub?: string;
  /** Sandbox: production org to create it from, name and license. */
  productionOrg?: string;
  sandboxName?: string;
  licenseType?: string;
  sourceSandbox?: string;
  deploy: boolean;
  permsets: string[];
  dataPlans: string[];
  apexScripts: string[];
  setDefault: boolean;
  open: boolean;
};

export type OrgCreateStep = { id: string; label: string; args: string[]; waitMinutes?: number };

const NAME = /^[\w.@+-]{1,80}$/;
const FILE = /^[\w./ -]+$/;

function check(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) throw new Error(`Invalid ${what}: ${value}`);
  return value;
}

export function planOrgCreate(o: OrgCreateOptions): OrgCreateStep[] {
  const alias = check(o.alias, NAME, 'alias');
  const steps: OrgCreateStep[] = [];
  if (o.type === 'scratch') {
    const args = [
      'org',
      'create',
      'scratch',
      '--definition-file',
      check(o.definitionFile ?? 'config/project-scratch-def.json', FILE, 'definition file'),
      '--alias',
      alias,
      '--duration-days',
      String(o.durationDays ?? 7),
      '--wait',
      '20',
    ];
    if (o.devHub) args.push('--target-dev-hub', check(o.devHub, NAME, 'Dev Hub'));
    if (o.setDefault) args.push('--set-default');
    steps.push({ id: 'create', label: `Create scratch org ${alias}`, args, waitMinutes: 20 });
  } else {
    if (!o.productionOrg) throw new Error('Creating a sandbox needs --target-org (the production org).');
    const name = check(
      o.sandboxName ?? alias.replace(/\W/g, '').slice(0, 10),
      /^[A-Za-z][A-Za-z0-9]{0,9}$/,
      'sandbox name (letters and digits, max 10)'
    );
    const args = [
      'org',
      'create',
      'sandbox',
      '--name',
      name,
      '--alias',
      alias,
      '--target-org',
      check(o.productionOrg, NAME, 'production org'),
      '--wait',
      '120',
      '--no-prompt',
    ];
    if (o.sourceSandbox)
      args.push('--source-sandbox-name', check(o.sourceSandbox, /^[A-Za-z][A-Za-z0-9]{0,9}$/, 'source sandbox'));
    else
      args.push(
        '--license-type',
        check(o.licenseType ?? 'Developer', /^(Developer|Developer_Pro|Partial|Full)$/, 'license type')
      );
    if (o.setDefault) args.push('--set-default');
    steps.push({ id: 'create', label: `Create sandbox ${name} from ${o.productionOrg}`, args, waitMinutes: 120 });
  }
  if (o.deploy) {
    steps.push({
      id: 'deploy',
      label: 'Deploy the project',
      args: ['project', 'deploy', 'start', '--target-org', alias, '--wait', '60'],
    });
  }
  for (const permset of o.permsets) {
    steps.push({
      id: `permset:${permset}`,
      label: `Assign ${permset}`,
      args: ['org', 'assign', 'permset', '--name', check(permset, /^\w+$/, 'permission set'), '--target-org', alias],
    });
  }
  for (const plan of o.dataPlans) {
    steps.push({
      id: `data:${plan}`,
      label: `Import data ${plan}`,
      args: ['data', 'import', 'tree', '--plan', check(plan, FILE, 'data plan'), '--target-org', alias],
    });
  }
  for (const script of o.apexScripts) {
    steps.push({
      id: `apex:${script}`,
      label: `Run ${script}`,
      args: ['apex', 'run', '--file', check(script, FILE, 'Apex script'), '--target-org', alias],
    });
  }
  if (o.open) steps.push({ id: 'open', label: 'Open the org', args: ['org', 'open', '--target-org', alias] });
  return steps;
}
