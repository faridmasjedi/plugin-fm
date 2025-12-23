import { DEFAULT_API_VERSION } from './constants.js';

/**
 * Generates a Salesforce manifest XML (Package.xml or destructiveChanges.xml).
 *
 * @param metadataComponents An object where keys are metadata types and values are sets of full names.
 * @param version The Salesforce API version to use.
 * @returns The generated XML content.
 */
function generateManifestXml(
  metadataComponents: { [key: string]: Set<string> },
  version: string = DEFAULT_API_VERSION
): string {
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';

  for (const [type, members] of Object.entries(metadataComponents)) {
    xml += '    <types>\n';
    for (const member of Array.from(members)) {
      xml += `        <members>${member}</members>\n`;
    }
    xml += `        <name>${type}</name>\n    </types>\n`;
  }

  xml += `    <version>${version}</version>\n</Package>`;
  return xml;
}

/**
 * Generates the package.xml content for new/modified metadata components.
 *
 * @param metadataComponents An object where keys are metadata types and values are sets of full names.
 * @param version The Salesforce API version to use.
 * @returns The generated package.xml content.
 */
export function generatePackageXml(
  metadataComponents: { [key: string]: Set<string> },
  version: string = DEFAULT_API_VERSION
): string {
  return generateManifestXml(metadataComponents, version);
}

/**
 * Generates the destructiveChanges.xml content for deleted metadata components.
 *
 * @param metadataComponents An object where keys are metadata types and values are sets of full names (for deleted components).
 * @param version The Salesforce API version to use.
 * @returns The generated destructiveChanges.xml content.
 */
export function generateDestructiveChangesXml(
  metadataComponents: { [key: string]: Set<string> },
  version: string = DEFAULT_API_VERSION
): string {
  return generateManifestXml(metadataComponents, version);
}

/**
 * Generates an empty package.xml content.
 *
 * @param version The Salesforce API version to use.
 * @returns An empty package.xml content.
 */
export function generateEmptyPackageXml(version: string = DEFAULT_API_VERSION): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n    <version>${version}</version>\n</Package>`;
}
