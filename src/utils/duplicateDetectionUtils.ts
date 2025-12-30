import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { MetadataResolver } from '@salesforce/source-deploy-retrieve';

import type { CommandLogger } from './gitUtils.js';
import { parseCustomLabels, parseSharingRules } from './granularMetadataUtils.js';

// Context-aware metadata types (child metadata on objects)
const CONTEXT_AWARE_TYPES = new Set([
  'CustomField',
  'ValidationRule',
  'ListView',
  'RecordType',
  'WebLink',
  'FieldSet',
  'CompactLayout',
  'BusinessProcess',
]);

/**
 * Represents a metadata component with its location
 */
export type MetadataComponent = {
  type: string;
  fullName: string;
  context?: string;
  filePath: string;
  source: 'parent' | 'submodule';
  submodulePath?: string;
};

/**
 * Represents a granular metadata element (CustomLabel or SharingRule)
 */
export type GranularElement = {
  name: string;
  filePath: string;
  source: 'parent' | 'submodule';
  submodulePath?: string;
};

/**
 * Result of duplicate detection
 */
export type DuplicateDetectionResult = {
  hasDuplicates: boolean;
  totalCount: number;
  componentDuplicates: Array<{
    type: string;
    name: string;
    context?: string;
    parentFile: string;
    submoduleFile: string;
    submodulePath: string;
  }>;
  granularDuplicates: {
    customLabels?: Array<{
      labelName: string;
      parentFile: string;
      submoduleFile: string;
      submodulePath: string;
    }>;
    sharingRules?: Array<{
      objectName: string;
      ruleName: string;
      parentFile: string;
      submoduleFile: string;
      submodulePath: string;
    }>;
  };
};

/**
 * Extracts context from a fullName for context-aware types
 * Example: "Account.MyField__c" -> "Account"
 */
function extractContext(fullName: string, typeName: string): string | undefined {
  if (!CONTEXT_AWARE_TYPES.has(typeName)) {
    return undefined;
  }

  // Most context-aware types use dot notation: Object.Element
  const dotIndex = fullName.indexOf('.');
  if (dotIndex > 0) {
    return fullName.substring(0, dotIndex);
  }

  return undefined;
}

/**
 * Creates a unique key for a metadata component
 */
function createComponentKey(component: MetadataComponent): string {
  if (component.context) {
    // For context-aware types: type + context + name
    return `${component.type}:${component.context}:${component.fullName}`;
  }
  // For regular types: type + fullName
  return `${component.type}:${component.fullName}`;
}

/**
 * Re-extracts metadata components to collect all file paths per component
 */
function extractMetadataComponentsWithAllFiles(
  files: string[],
  source: 'parent' | 'submodule',
  submodulePath: string | undefined,
  currentWorkingDir: string
): Map<string, { comp: MetadataComponent; files: string[] }> {
  const resolver = new MetadataResolver();
  const componentMap = new Map<string, { comp: MetadataComponent; files: string[] }>();

  for (const filePath of files) {
    const absolutePath = resolve(currentWorkingDir, filePath);
    if (!existsSync(absolutePath)) continue;

    try {
      const resolvedComponents = resolver.getComponentsFromPath(absolutePath);
      for (const component of resolvedComponents) {
        const key = `${component.type.name}:${component.fullName}`;
        const existing = componentMap.get(key);

        if (!existing) {
          const comp: MetadataComponent = {
            type: component.type.name,
            fullName: component.fullName,
            filePath,
            source,
            submodulePath,
          };
          if (CONTEXT_AWARE_TYPES.has(component.type.name)) {
            comp.context = extractContext(component.fullName, component.type.name);
          }
          componentMap.set(key, { comp, files: [filePath] });
        } else {
          existing.files.push(filePath);
        }
      }
    } catch {
      continue;
    }
  }

  return componentMap;
}

/**
 * Detects component-level duplicates between parent and submodules
 */
function detectComponentDuplicates(
  parentComponents: MetadataComponent[],
  submoduleComponents: MetadataComponent[]
): Array<{
  type: string;
  name: string;
  context?: string;
  parentFile: string;
  submoduleFile: string;
  submodulePath: string;
  parentFiles?: string[];
  submoduleFiles?: string[];
}> {
  const duplicates: Array<{
    type: string;
    name: string;
    context?: string;
    parentFile: string;
    submoduleFile: string;
    submodulePath: string;
    parentFiles?: string[];
    submoduleFiles?: string[];
  }> = [];

  // Create a map of parent components by key
  const parentMap = new Map<string, MetadataComponent>();
  for (const comp of parentComponents) {
    // Skip CustomLabels and SharingRules (handled separately)
    if (comp.type === 'CustomLabels' || comp.type === 'SharingRules') {
      continue;
    }
    const key = createComponentKey(comp);
    parentMap.set(key, comp);
  }

  // Track which duplicates we've already added (by component key)
  const addedDuplicates = new Set<string>();

  // Check submodule components against parent
  for (const subComp of submoduleComponents) {
    // Skip CustomLabels and SharingRules (handled separately)
    if (subComp.type === 'CustomLabels' || subComp.type === 'SharingRules') {
      continue;
    }

    const key = createComponentKey(subComp);
    const parentComp = parentMap.get(key);

    if (parentComp && !addedDuplicates.has(key)) {
      addedDuplicates.add(key);
      duplicates.push({
        type: subComp.type,
        name: subComp.fullName,
        context: subComp.context,
        parentFile: parentComp.filePath,
        submoduleFile: subComp.filePath,
        submodulePath: subComp.submodulePath!,
      });
    }
  }

  return duplicates;
}

/**
 * Extracts CustomLabels from a file
 */
async function extractCustomLabels(
  filePath: string,
  source: 'parent' | 'submodule',
  submodulePath: string | undefined,
  currentWorkingDir: string
): Promise<GranularElement[]> {
  const absolutePath = resolve(currentWorkingDir, filePath);

  if (!existsSync(absolutePath)) {
    return [];
  }

  try {
    const content = readFileSync(absolutePath, 'utf8');
    const labels = await parseCustomLabels(content);

    return labels.map((label) => ({
      name: label.fullName[0],
      filePath,
      source,
      submodulePath,
    }));
  } catch {
    return [];
  }
}

/**
 * Extracts SharingRules from a file
 */
async function extractSharingRules(
  filePath: string,
  source: 'parent' | 'submodule',
  submodulePath: string | undefined,
  currentWorkingDir: string
): Promise<Array<GranularElement & { objectName: string }>> {
  const absolutePath = resolve(currentWorkingDir, filePath);

  if (!existsSync(absolutePath)) {
    return [];
  }

  try {
    // Extract object name from file name
    const fileName = filePath.split('/').pop() ?? '';
    const objectName = fileName.replace('.sharingRules-meta.xml', '');

    const content = readFileSync(absolutePath, 'utf8');
    const rules = await parseSharingRules(content);

    const allRules = [...rules.criteriaRules.map((r) => r.fullName[0]), ...rules.ownerRules.map((r) => r.fullName[0])];

    return allRules.map((ruleName) => ({
      name: ruleName,
      objectName,
      filePath,
      source,
      submodulePath,
    }));
  } catch {
    return [];
  }
}

/**
 * Detects granular metadata duplicates (CustomLabels and SharingRules)
 */
async function detectGranularDuplicates(
  allFiles: { parent: string[]; submodules: Map<string, string[]> },
  currentWorkingDir: string
): Promise<{
  customLabels: Array<{
    labelName: string;
    parentFile: string;
    submoduleFile: string;
    submodulePath: string;
  }>;
  sharingRules: Array<{
    objectName: string;
    ruleName: string;
    parentFile: string;
    submoduleFile: string;
    submodulePath: string;
  }>;
}> {
  const customLabelDuplicates: Array<{
    labelName: string;
    parentFile: string;
    submoduleFile: string;
    submodulePath: string;
  }> = [];

  const sharingRuleDuplicates: Array<{
    objectName: string;
    ruleName: string;
    parentFile: string;
    submoduleFile: string;
    submodulePath: string;
  }> = [];

  // Extract CustomLabels from parent
  const parentLabelFiles = allFiles.parent.filter((f) => f.includes('labels/CustomLabels.labels'));
  const parentLabelPromises = parentLabelFiles.map((file) =>
    extractCustomLabels(file, 'parent', undefined, currentWorkingDir)
  );
  const parentLabelResults = await Promise.all(parentLabelPromises);
  const parentLabels: GranularElement[] = parentLabelResults.flat();

  // Extract CustomLabels from submodules
  const submoduleLabelPromisesList = [];
  for (const [submodulePath, files] of allFiles.submodules.entries()) {
    const submoduleLabelFiles = files.filter((f) => f.includes('labels/CustomLabels.labels'));
    const promises = submoduleLabelFiles.map((file) =>
      extractCustomLabels(file, 'submodule', submodulePath, currentWorkingDir)
    );
    submoduleLabelPromisesList.push(...promises);
  }

  const allSubmoduleLabelResults = await Promise.all(submoduleLabelPromisesList);

  for (const labels of allSubmoduleLabelResults) {
    // Check for duplicates
    for (const subLabel of labels) {
      const parentLabel = parentLabels.find((p) => p.name === subLabel.name);

      if (parentLabel) {
        customLabelDuplicates.push({
          labelName: subLabel.name,
          parentFile: parentLabel.filePath,
          submoduleFile: subLabel.filePath,
          submodulePath: subLabel.submodulePath!,
        });
      }
    }
  }

  // Extract SharingRules from parent
  const parentRuleFiles = allFiles.parent.filter(
    (f) => f.includes('sharingRules/') && f.endsWith('.sharingRules-meta.xml')
  );
  const parentRulePromises = parentRuleFiles.map((file) =>
    extractSharingRules(file, 'parent', undefined, currentWorkingDir)
  );
  const parentRuleResults = await Promise.all(parentRulePromises);
  const parentRules: Array<GranularElement & { objectName: string }> = parentRuleResults.flat();

  // Extract SharingRules from submodules
  const submoduleRulePromisesList = [];
  for (const [submodulePath, files] of allFiles.submodules.entries()) {
    const submoduleRuleFiles = files.filter((f) => f.includes('sharingRules/') && f.endsWith('.sharingRules-meta.xml'));
    const promises = submoduleRuleFiles.map((file) =>
      extractSharingRules(file, 'submodule', submodulePath, currentWorkingDir)
    );
    submoduleRulePromisesList.push(...promises);
  }

  const allSubmoduleRuleResults = await Promise.all(submoduleRulePromisesList);

  for (const rules of allSubmoduleRuleResults) {
    // Check for duplicates (same object + same rule name)
    for (const subRule of rules) {
      const parentRule = parentRules.find((p) => p.objectName === subRule.objectName && p.name === subRule.name);

      if (parentRule) {
        sharingRuleDuplicates.push({
          objectName: subRule.objectName,
          ruleName: subRule.name,
          parentFile: parentRule.filePath,
          submoduleFile: subRule.filePath,
          submodulePath: subRule.submodulePath!,
        });
      }
    }
  }

  return { customLabels: customLabelDuplicates, sharingRules: sharingRuleDuplicates };
}

/**
 * Main function to detect all duplicates
 */
export async function detectDuplicates(
  allFiles: { parent: string[]; submodules: Map<string, string[]> },
  currentWorkingDir: string,
  logger: CommandLogger
): Promise<DuplicateDetectionResult> {
  if (logger.log) logger.log('Extracting metadata components...');

  // Extract parent components with all file paths
  const parentComponentsMap = extractMetadataComponentsWithAllFiles(
    allFiles.parent,
    'parent',
    undefined,
    currentWorkingDir
  );

  // Extract submodule components with all file paths
  const submoduleComponentsMap = new Map<string, { comp: MetadataComponent; files: string[] }>();
  for (const [submodulePath, files] of allFiles.submodules.entries()) {
    const components = extractMetadataComponentsWithAllFiles(files, 'submodule', submodulePath, currentWorkingDir);
    for (const [key, value] of components.entries()) {
      submoduleComponentsMap.set(key, value);
    }
  }

  const parentComponents = Array.from(parentComponentsMap.values()).map((v) => v.comp);
  const submoduleComponents = Array.from(submoduleComponentsMap.values()).map((v) => v.comp);

  if (logger.log) {
    logger.log(
      `Found ${parentComponents.length} parent components and ${submoduleComponents.length} submodule components`
    );
  }

  // Detect component-level duplicates (now with all file paths)
  const componentDuplicates = detectComponentDuplicates(parentComponents, submoduleComponents);

  // Add all file paths to the duplicates
  for (const dup of componentDuplicates) {
    const key = `${dup.type}:${dup.name}`;
    const parentEntry = parentComponentsMap.get(key);
    const submoduleEntry = submoduleComponentsMap.get(key);

    if (parentEntry && submoduleEntry) {
      dup.parentFiles = parentEntry.files;
      dup.submoduleFiles = submoduleEntry.files;
    }
  }

  // Detect granular metadata duplicates
  if (logger.log) logger.log('Checking granular metadata (CustomLabels, SharingRules)...');
  const granularDuplicates = await detectGranularDuplicates(allFiles, currentWorkingDir);

  const totalDuplicates =
    componentDuplicates.length +
    (granularDuplicates.customLabels?.length ?? 0) +
    (granularDuplicates.sharingRules?.length ?? 0);

  return {
    hasDuplicates: totalDuplicates > 0,
    totalCount: totalDuplicates,
    componentDuplicates,
    granularDuplicates: {
      customLabels: granularDuplicates.customLabels.length > 0 ? granularDuplicates.customLabels : undefined,
      sharingRules: granularDuplicates.sharingRules.length > 0 ? granularDuplicates.sharingRules : undefined,
    },
  };
}
