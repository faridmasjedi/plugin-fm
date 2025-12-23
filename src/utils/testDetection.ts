import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { resolve, basename, join } from 'node:path';

export type TestClassInfo = {
  className: string;
  filePath: string;
  testsClasses: boolean;
  references: string[];
};

export type TestDetectionResult = {
  testClasses: string[];
  coverage: {
    changedClasses: string[];
    testedClasses: string[];
    untestedClasses: string[];
  };
};

/**
 * Service for intelligent Apex test detection.
 */
export class TestDetectionService {
  /**
   * Analyzes changed Apex files and determines which test classes to run.
   */
  public static async detectTestsForChanges(changedFiles: string[], projectRoot: string): Promise<TestDetectionResult> {
    const apexFiles = changedFiles.filter((f) => f.endsWith('.cls') || f.endsWith('.trigger'));

    if (apexFiles.length === 0) {
      return {
        testClasses: [],
        coverage: {
          changedClasses: [],
          testedClasses: [],
          untestedClasses: [],
        },
      };
    }

    // Extract class/trigger names from changed files
    const changedComponents = this.extractComponentNames(apexFiles);

    // Find all test classes in the project
    const allTestClasses = await this.findAllTestClasses(projectRoot);

    // Determine which test classes cover the changed components
    const relevantTests = this.matchTestsToComponents(changedComponents, allTestClasses);

    // Build coverage report
    const testedClasses = changedComponents.filter((c) => relevantTests.some((t) => t.references.includes(c)));
    const untestedClasses = changedComponents.filter((c) => !testedClasses.includes(c));

    return {
      testClasses: relevantTests.map((t) => t.className),
      coverage: {
        changedClasses: changedComponents,
        testedClasses,
        untestedClasses,
      },
    };
  }

  /**
   * Finds test classes for trigger handlers.
   */
  public static async findTestsForTriggers(triggerFiles: string[], projectRoot: string): Promise<string[]> {
    // Triggers usually have associated handler classes
    // Pattern: AccountTrigger -> AccountTriggerHandler -> AccountTriggerHandlerTest

    const handlerClasses: string[] = [];

    for (const triggerFile of triggerFiles) {
      const triggerName = basename(triggerFile).replace('.trigger', '');

      // Common patterns for trigger handlers
      const possibleHandlers = [
        `${triggerName}Handler`,
        `${triggerName}TriggerHandler`,
        triggerName.replace('Trigger', 'Handler'),
      ];

      handlerClasses.push(...possibleHandlers);
    }

    // Find test classes for handlers
    const result = await this.detectTestsForChanges(
      handlerClasses.map((h) => `classes/${h}.cls`),
      projectRoot
    );

    return result.testClasses;
  }

  /**
   * Validates that test classes exist and are accessible.
   */
  public static validateTestClasses(
    testClasses: string[],
    projectRoot: string
  ): { valid: string[]; invalid: string[] } {
    const valid: string[] = [];
    const invalid: string[] = [];

    for (const testClass of testClasses) {
      const possiblePaths = [
        resolve(projectRoot, 'force-app/main/default/classes', `${testClass}.cls`),
        resolve(projectRoot, 'src/classes', `${testClass}.cls`),
      ];

      const exists = possiblePaths.some((p) => existsSync(p) && this.isTestClass(p));

      if (exists) {
        valid.push(testClass);
      } else {
        invalid.push(testClass);
      }
    }

    return { valid, invalid };
  }

  /**
   * Extracts class and trigger names from file paths.
   */
  private static extractComponentNames(filePaths: string[]): string[] {
    return filePaths.map((f) => {
      const fileName = basename(f);
      return fileName.replace(/\.(cls|trigger)$/, '');
    });
  }

  /**
   * Finds all test classes in the project.
   */
  private static async findAllTestClasses(projectRoot: string): Promise<TestClassInfo[]> {
    const testClasses: TestClassInfo[] = [];
    const clsFiles = await this.findApexFiles(projectRoot);

    for (const file of clsFiles) {
      if (this.isTestClass(file)) {
        const info = this.analyzeTestClass(file);
        if (info) {
          testClasses.push(info);
        }
      }
    }

    return testClasses;
  }

  /**
   * Recursively finds all .cls files in a directory.
   */
  private static async findApexFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    async function walk(directory: string): Promise<void> {
      try {
        const entries = await readdir(directory, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = join(directory, entry.name);

          // Skip node_modules and .git
          if (entry.name === 'node_modules' || entry.name === '.git') {
            continue;
          }

          if (entry.isDirectory()) {
            // eslint-disable-next-line no-await-in-loop
            await walk(fullPath);
          } else if (entry.isFile() && entry.name.endsWith('.cls')) {
            files.push(fullPath);
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    await walk(dir);
    return files;
  }

  /**
   * Checks if a file is a test class.
   */
  private static isTestClass(filePath: string): boolean {
    if (!existsSync(filePath)) return false;

    try {
      const content = readFileSync(filePath, 'utf8');
      return content.includes('@isTest') || content.includes('@IsTest');
    } catch {
      return false;
    }
  }

  /**
   * Analyzes a test class to find what it tests.
   */
  private static analyzeTestClass(filePath: string): TestClassInfo | null {
    try {
      const content = readFileSync(filePath, 'utf8');
      const className = basename(filePath).replace('.cls', '');

      // Find all class references in the test
      const references = this.extractClassReferences(content);

      return {
        className,
        filePath,
        testsClasses: true,
        references,
      };
    } catch {
      return null;
    }
  }

  /**
   * Extracts class references from Apex code.
   */
  private static extractClassReferences(content: string): string[] {
    const references = new Set<string>();

    // Remove comments
    const cleanContent = this.removeComments(content);

    // Pattern 1: new ClassName()
    const newPattern = /new\s+([A-Z][A-Za-z0-9_]*)\s*\(/g;
    let match;
    while ((match = newPattern.exec(cleanContent)) !== null) {
      references.add(match[1]);
    }

    // Pattern 2: ClassName.method()
    const staticPattern = /([A-Z][A-Za-z0-9_]*)\.[A-Za-z0-9_]+\s*\(/g;
    while ((match = staticPattern.exec(cleanContent)) !== null) {
      // Skip System, Test, and other common classes
      if (!['System', 'Test', 'Database', 'Schema', 'String', 'Integer', 'Decimal'].includes(match[1])) {
        references.add(match[1]);
      }
    }

    // Pattern 3: ClassName variableName (declarations)
    const declPattern = /\b([A-Z][A-Za-z0-9_]*)\s+[a-z][A-Za-z0-9_]*\s*=/g;
    while ((match = declPattern.exec(cleanContent)) !== null) {
      if (
        ![
          'System',
          'Test',
          'Database',
          'Schema',
          'List',
          'Set',
          'Map',
          'String',
          'Integer',
          'Decimal',
          'Boolean',
        ].includes(match[1])
      ) {
        references.add(match[1]);
      }
    }

    return Array.from(references);
  }

  /**
   * Removes comments from Apex code.
   */
  private static removeComments(content: string): string {
    // Remove single-line comments
    let cleaned = content.replace(/\/\/.*$/gm, '');

    // Remove multi-line comments
    cleaned = cleaned.replace(/\/\*[\s\S]*?\*\//g, '');

    return cleaned;
  }

  /**
   * Matches test classes to changed components.
   */
  private static matchTestsToComponents(changedComponents: string[], allTestClasses: TestClassInfo[]): TestClassInfo[] {
    const relevantTests: TestClassInfo[] = [];

    for (const component of changedComponents) {
      // Find tests that reference this component
      const matchingTests = allTestClasses.filter((test) => test.references.includes(component));
      relevantTests.push(...matchingTests);

      // Also check for naming convention: ComponentTest, Component_Test, TestComponent
      const conventionTests = allTestClasses.filter(
        (test) =>
          test.className === `${component}Test` ||
          test.className === `${component}_Test` ||
          test.className === `Test${component}` ||
          (test.className.startsWith(component) && test.className.includes('Test'))
      );
      relevantTests.push(...conventionTests);
    }

    // Remove duplicates
    const uniqueTests = Array.from(new Map(relevantTests.map((t) => [t.className, t])).values());

    return uniqueTests;
  }
}
