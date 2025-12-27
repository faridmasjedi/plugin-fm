import { parseStringPromise, Builder } from 'xml2js';

/**
 * Parses XML string to JavaScript object.
 *
 * @param xmlContent - The XML string to parse
 * @returns Parsed JavaScript object
 */
export async function parseXml(xmlContent: string): Promise<Record<string, unknown>> {
  try {
    const parsed = await parseStringPromise(xmlContent);
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to parse XML: ${(error as Error).message}`);
  }
}

/**
 * Builds XML string from JavaScript object with Salesforce metadata formatting.
 *
 * @param obj - The JavaScript object to convert to XML
 * @returns XML string
 */
export function buildSalesforceXml(obj: Record<string, unknown>): string {
  const builder = new Builder({
    xmldec: { version: '1.0', encoding: 'UTF-8' },
    renderOpts: { pretty: true, indent: '    ' },
  });
  return builder.buildObject(obj);
}

/**
 * Parses XML string with custom error handling (returns default on error).
 *
 * @param xmlContent - The XML string to parse
 * @param defaultValue - Default value to return on parse error
 * @returns Parsed object or default value
 */
export async function parseXmlSafe(
  xmlContent: string,
  defaultValue: Record<string, unknown> = {}
): Promise<Record<string, unknown>> {
  try {
    const parsed = await parseStringPromise(xmlContent);
    return (parsed as Record<string, unknown>) || defaultValue;
  } catch {
    return defaultValue;
  }
}
