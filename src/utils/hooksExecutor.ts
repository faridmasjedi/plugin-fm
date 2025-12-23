import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type HookResult = {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  duration: number;
};

export type HookContext = {
  jobId?: string;
  targetOrg: string;
  mode: string;
  manifestDir: string;
};

/**
 * Service for executing pre and post deployment hooks.
 */
export class HooksExecutor {
  /**
   * Executes a pre-deployment hook.
   */
  public static executePreHook(
    scriptPath: string,
    context: HookContext,
    logger: { log: (message: string) => void; warn: (message: string) => void }
  ): HookResult {
    logger.log(`Executing pre-deployment hook: ${scriptPath}`);

    if (!existsSync(scriptPath)) {
      throw new Error(`Pre-deployment script not found: ${scriptPath}`);
    }

    return this.executeHook(scriptPath, context, 'pre');
  }

  /**
   * Executes a post-deployment hook.
   */
  public static executePostHook(
    scriptPath: string,
    context: HookContext,
    logger: { log: (message: string) => void; warn: (message: string) => void }
  ): HookResult {
    logger.log(`Executing post-deployment hook: ${scriptPath}`);

    if (!existsSync(scriptPath)) {
      throw new Error(`Post-deployment script not found: ${scriptPath}`);
    }

    return this.executeHook(scriptPath, context, 'post');
  }

  /**
   * Discovers and executes hooks from a .fm-hooks directory.
   */
  public static async executeHooksFromDirectory(
    projectRoot: string,
    type: 'pre' | 'post',
    context: HookContext,
    logger: { log: (message: string) => void; warn: (message: string) => void }
  ): Promise<HookResult[]> {
    const hooksDir = resolve(projectRoot, '.fm-hooks', type);

    if (!existsSync(hooksDir)) {
      return [];
    }

    const fs = await import('node:fs/promises');
    const files = await fs.readdir(hooksDir);

    // Filter for executable scripts
    const scripts = files.filter((f) => f.endsWith('.sh') || f.endsWith('.js') || f.endsWith('.ts')).sort(); // Execute in alphabetical order

    const results: HookResult[] = [];

    for (const script of scripts) {
      const scriptPath = resolve(hooksDir, script);
      logger.log(`Executing ${type}-deployment hook: ${script}`);

      const result = this.executeHook(scriptPath, context, type);
      results.push(result);

      if (!result.success) {
        logger.warn(`Hook ${script} failed with exit code ${result.exitCode}`);
        logger.warn(`Error: ${result.stderr}`);
        // Continue executing other hooks even if one fails
      } else {
        logger.log(`Hook ${script} completed successfully in ${result.duration}ms`);
        if (result.stdout) {
          logger.log(`Output:\n${result.stdout}`);
        }
      }
    }

    return results;
  }

  /**
   * Validates a hook script.
   */
  public static validateHook(scriptPath: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!existsSync(scriptPath)) {
      errors.push(`Script file does not exist: ${scriptPath}`);
      return { valid: false, errors };
    }

    try {
      // Check if file is readable
      readFileSync(scriptPath, 'utf8');
    } catch (error) {
      errors.push(`Cannot read script file: ${(error as Error).message}`);
      return { valid: false, errors };
    }

    // Check if it's a supported script type
    const supportedExtensions = ['.sh', '.js', '.ts', '.py'];
    const hasValidExtension = supportedExtensions.some((ext) => scriptPath.endsWith(ext));

    if (!hasValidExtension) {
      errors.push(`Unsupported script type. Must be one of: ${supportedExtensions.join(', ')}`);
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Creates a sample hook script.
   */
  public static generateSampleHook(type: 'pre' | 'post', language: 'bash' | 'javascript' = 'bash'): string {
    if (language === 'bash') {
      return this.generateBashHook(type);
    } else {
      return this.generateJavaScriptHook(type);
    }
  }

  /**
   * Executes a hook script with context.
   */
  private static executeHook(scriptPath: string, context: HookContext, type: 'pre' | 'post'): HookResult {
    const startTime = Date.now();

    try {
      // Set environment variables for the hook
      const env = {
        ...process.env,
        FM_HOOK_TYPE: type,
        FM_DEPLOY_MODE: context.mode,
        FM_TARGET_ORG: context.targetOrg,
        FM_MANIFEST_DIR: context.manifestDir,
        ...(context.jobId && { FM_JOB_ID: context.jobId }),
      };

      // Make script executable
      try {
        execSync(`chmod +x "${scriptPath}"`, { stdio: 'ignore' });
      } catch {
        // If chmod fails, try to run anyway
      }

      // Execute the script
      const result = execSync(`"${scriptPath}"`, {
        env,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024, // 10MB
        timeout: 5 * 60 * 1000, // 5 minutes
      });

      const duration = Date.now() - startTime;

      return {
        success: true,
        exitCode: 0,
        stdout: result.toString(),
        stderr: '',
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const err = error as { status?: number; stdout?: Buffer; stderr?: Buffer };

      return {
        success: false,
        exitCode: err.status ?? 1,
        stdout: err.stdout?.toString() ?? '',
        stderr: err.stderr?.toString() ?? (error as Error).message,
        duration,
      };
    }
  }

  private static generateBashHook(type: 'pre' | 'post'): string {
    const action = type === 'pre' ? 'backup' : 'cleanup';

    return `#!/bin/bash

# ${type.toUpperCase()}-DEPLOYMENT HOOK
# This script runs ${type === 'pre' ? 'before' : 'after'} deployment

# Environment variables available:
# - FM_HOOK_TYPE: "pre" or "post"
# - FM_DEPLOY_MODE: "validation", "deployment", or "quick"
# - FM_TARGET_ORG: Target Salesforce org
# - FM_MANIFEST_DIR: Path to manifest directory
# - FM_JOB_ID: Deployment job ID (available in post hooks)

echo "Running ${type}-deployment ${action}..."

# Your ${action} logic here
# Example: ${type === 'pre' ? 'Backup data' : 'Clear cache'}

echo "${type}-deployment hook completed successfully"
exit 0
`;
  }

  private static generateJavaScriptHook(type: 'pre' | 'post'): string {
    return `#!/usr/bin/env node

/**
 * ${type.toUpperCase()}-DEPLOYMENT HOOK
 * This script runs ${type === 'pre' ? 'before' : 'after'} deployment
 */

const { execSync } = require('child_process');

async function main() {
  console.log('Running ${type}-deployment hook...');

  // Access environment variables
  const {
    FM_HOOK_TYPE,
    FM_DEPLOY_MODE,
    FM_TARGET_ORG,
    FM_MANIFEST_DIR,
    FM_JOB_ID,
  } = process.env;

  console.log(\`Mode: \${FM_DEPLOY_MODE}\`);
  console.log(\`Target Org: \${FM_TARGET_ORG}\`);

  // Your ${type}-deployment logic here

  console.log('${type}-deployment hook completed successfully');
  process.exit(0);
}

main().catch((error) => {
  console.error('Hook failed:', error);
  process.exit(1);
});
`;
  }
}
