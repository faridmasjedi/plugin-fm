import type { SalesforceClient } from './client.js';
import { metadataEnvelope, packageXml, type MetadataComponent } from './metadata.js';
import { escapeXml, xmlBlocks, xmlValue } from './soap.js';
import { makeZip, toBase64 } from './zip.js';

/**
 * Metadata API deploy from the browser: run a zip (validate only or for real) with the test
 * level you choose, follow it, read component and test failures, quick deploy a validation.
 * Deleting components is a deploy of an empty package with destructiveChanges.xml.
 */

export type TestLevel = 'NoTestRun' | 'RunSpecifiedTests' | 'RunLocalTests' | 'RunAllTestsInOrg';

export type DeployOptions = {
  checkOnly?: boolean;
  /** 'Default': Salesforce decides (no tests unless the package holds Apex; works in production too). */
  testLevel?: TestLevel | 'Default';
  runTests?: string[];
  pollMs?: number;
  timeoutMs?: number;
  onProgress?: (status: string, done: number, total: number) => void;
};

export type DeployOutcome = {
  id: string;
  status: string;
  success: boolean;
  checkOnly: boolean;
  componentsDeployed: number;
  componentsTotal: number;
  testsRun: number;
  componentFailures: Array<{ type: string; name: string; problem: string; line?: number }>;
  testFailures: Array<{ name: string; method: string; message: string }>;
  /** Code coverage too low (a validation or deploy fails on it with no failed test). */
  coverageWarnings: Array<{ name: string; message: string }>;
  errorMessage?: string;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const num = (xml: string, tag: string): number => Number(xmlValue(xml, tag) ?? 0);

export function parseDeployResult(result: string, id: string): DeployOutcome {
  const details = xmlValue(result, 'details') ?? '';
  const runTests = xmlValue(details, 'runTestResult') ?? '';
  // The deploy's own fields, without the details: each component there has a <success> of its own, and
  // Salesforce lists the details first (a validation whose tests failed would read as a success)
  const top = result.replace(/<(?:\w+:)?details(?:\s[^>]*)?>[\s\S]*<\/(?:\w+:)?details>/, '');
  return {
    id,
    status: xmlValue(top, 'status') ?? 'Unknown',
    success: xmlValue(top, 'success') === 'true',
    checkOnly: xmlValue(top, 'checkOnly') === 'true',
    componentsDeployed: num(top, 'numberComponentsDeployed'),
    componentsTotal: num(top, 'numberComponentsTotal'),
    testsRun: num(top, 'numberTestsCompleted') + num(top, 'numberTestErrors'),
    componentFailures: xmlBlocks(details, 'componentFailures').map((f) => ({
      type: xmlValue(f, 'componentType') ?? '',
      name: xmlValue(f, 'fullName') ?? '',
      problem: xmlValue(f, 'problem') ?? '',
      line: xmlValue(f, 'lineNumber') ? Number(xmlValue(f, 'lineNumber')) : undefined,
    })),
    testFailures: xmlBlocks(runTests, 'failures').map((f) => ({
      name: xmlValue(f, 'name') ?? '',
      method: xmlValue(f, 'methodName') ?? '',
      message: xmlValue(f, 'message') ?? '',
    })),
    coverageWarnings: xmlBlocks(runTests, 'codeCoverageWarnings').map((w) => ({
      name: xmlValue(w, 'name') ?? '',
      message: xmlValue(w, 'message') ?? '',
    })),
    errorMessage: xmlValue(top, 'errorMessage') || undefined,
  };
}

async function follow(client: SalesforceClient, id: string, options: DeployOptions): Promise<DeployOutcome> {
  const deadline = Date.now() + (options.timeoutMs ?? 60 * 60_000);
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const xml = await client.soap(
      'metadata',
      metadataEnvelope(
        `<met:checkDeployStatus><met:asyncProcessId>${escapeXml(
          id
        )}</met:asyncProcessId><met:includeDetails>true</met:includeDetails></met:checkDeployStatus>`
      )
    );
    const result = xmlValue(xml, 'result') ?? '';
    const outcome = parseDeployResult(result, id);
    const testsTotal = num(result, 'numberTestsTotal');
    options.onProgress?.(
      outcome.status,
      testsTotal ? outcome.testsRun : outcome.componentsDeployed,
      testsTotal || outcome.componentsTotal
    );
    if (xmlValue(result, 'done') === 'true') return outcome;
    if (Date.now() > deadline)
      throw new Error(`Deploy ${id} is still ${outcome.status}; follow it in Setup > Deployment Status.`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(options.pollMs ?? 3000);
  }
}

/** Deploys (or validates) a base64 zip with package.xml at its root. */
export async function deployZip(
  client: SalesforceClient,
  zipBase64: string,
  options: DeployOptions = {}
): Promise<DeployOutcome> {
  const level = options.testLevel ?? 'RunLocalTests';
  if (level === 'RunSpecifiedTests' && !options.runTests?.length) throw new Error('Name the test classes to run.');
  const tests = (options.runTests ?? [])
    .filter((t) => /^\w+$/.test(t))
    .map((t) => `<met:runTests>${t}</met:runTests>`)
    .join('');
  const xml = await client.soap(
    'metadata',
    metadataEnvelope(
      `<met:deploy><met:ZipFile>${zipBase64}</met:ZipFile><met:DeployOptions><met:checkOnly>${Boolean(
        options.checkOnly
      )}</met:checkOnly><met:rollbackOnError>true</met:rollbackOnError><met:singlePackage>true</met:singlePackage>${tests}${
        level === 'Default' ? '' : `<met:testLevel>${level}</met:testLevel>`
      }</met:DeployOptions></met:deploy>`
    )
  );
  const id = xmlValue(xml, 'id');
  if (!id) throw new Error('The Metadata API did not start the deploy.');
  return follow(client, id, options);
}

/** Deploys a validation that succeeded (within 10 days) without running the tests again. */
export async function quickDeploy(
  client: SalesforceClient,
  validationId: string,
  options: DeployOptions = {}
): Promise<DeployOutcome> {
  if (!/^\w{15,18}$/.test(validationId)) throw new Error('Invalid validation Id.');
  const xml = await client.soap(
    'metadata',
    metadataEnvelope(
      `<met:deployRecentValidation><met:validationId>${validationId}</met:validationId></met:deployRecentValidation>`
    )
  );
  const id = xmlValue(xml, 'result') ?? '';
  if (!/^\w{15,18}$/.test(id)) throw new Error('Salesforce did not accept the quick deploy.');
  return follow(client, id, options);
}

/** Zip that deletes the components: an empty package.xml plus destructiveChanges.xml. */
export function destructiveZip(
  components: Array<Pick<MetadataComponent, 'type' | 'fullName'>>,
  version: string
): string {
  if (!components.length) throw new Error('Choose components to delete.');
  const empty = `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <version>${version}</version>\n</Package>\n`;
  return toBase64(
    makeZip([
      { path: 'package.xml', content: empty },
      { path: 'destructiveChanges.xml', content: packageXml(components, version) },
    ])
  );
}

/** Deletes components from the org (validate first with checkOnly). */
export async function deleteFromOrg(
  client: SalesforceClient,
  components: Array<Pick<MetadataComponent, 'type' | 'fullName'>>,
  options: DeployOptions = {}
): Promise<DeployOutcome> {
  return deployZip(client, destructiveZip(components, await client.version()), options);
}
