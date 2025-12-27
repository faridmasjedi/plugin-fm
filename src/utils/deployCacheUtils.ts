import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Gets the path to the SF CLI deploy cache file.
 */
function getDeployCachePath(): string {
  return join(homedir(), '.sf', 'deploy-cache.json');
}

/**
 * Updates the wait time for a specific job ID in the deploy cache.
 * This is needed because SF CLI defaults to 33 minutes when using --async,
 * but we want to reflect the actual wait time used for monitoring.
 *
 * @param jobId The deployment job ID
 * @param waitMinutes The wait time in minutes to set in the cache
 */
export function updateDeployCacheWaitTime(jobId: string, waitMinutes: number): void {
  try {
    const cachePath = getDeployCachePath();

    // Check if cache file exists
    if (!existsSync(cachePath)) {
      return;
    }

    // Read the cache file
    const cacheContent = readFileSync(cachePath, 'utf8');
    const cache = JSON.parse(cacheContent) as Record<string, Record<string, unknown>>;

    // Update the wait time for this job ID if it exists
    if (cache[jobId]) {
      cache[jobId].wait = waitMinutes;

      // Write back to file
      writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
    }
  } catch (error) {
    // Silently fail - this is not critical functionality
    // The deployment will still work, just the cache won't be updated
  }
}
