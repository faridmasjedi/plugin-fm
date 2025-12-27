import type { DeploymentProgress } from './deploymentService.js';
import type { Logger } from './types.js';

/**
 * Service for reporting deployment progress with formatted output.
 */
export class ProgressReporter {
  private startTime: number;
  private lastUpdate: number = 0;
  private readonly updateInterval: number = 2000; // 2 seconds
  private headerShown: boolean = false;
  private lastLineCount: number = 0;

  public constructor() {
    this.startTime = Date.now();
  }

  /**
   * Displays a compact progress line (for CI/CD).
   */
  public static displayCompactProgress(progress: DeploymentProgress): string {
    return `[${progress.status}] ${progress.progress}% | Components: ${progress.componentsDeployed}/${progress.componentsTotal} | Tests: ${progress.testsPassed}/${progress.testsCompleted} passed`;
  }

  /**
   * Gets emoji for deployment status.
   */
  private static getStatusEmoji(status: DeploymentProgress['status']): string {
    const emojiMap: Record<DeploymentProgress['status'], string> = {
      Queued: '⏳',
      InProgress: '🔄',
      Succeeded: '✅',
      Failed: '❌',
      Canceled: '⛔',
      Pending: '⏱️',
    };

    return emojiMap[status] ?? '❓';
  }

  /**
   * Formats duration in human-readable format.
   */
  private static formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Clears previous console lines.
   */
  private static clearLines(count: number): void {
    // Use ANSI escape codes to move cursor up and clear lines
    if (process.stdout.isTTY) {
      for (let i = 0; i < count; i++) {
        process.stdout.write('\x1b[1A'); // Move cursor up
        process.stdout.write('\x1b[2K'); // Clear line
      }
    }
  }

  /**
   * Displays deployment progress with formatted output.
   */
  public displayProgress(
    progress: DeploymentProgress,
    logger: Logger,
    mode: 'validation' | 'deployment' | 'quick' = 'deployment'
  ): void {
    const now = Date.now();

    // Throttle updates to avoid spamming
    if (now - this.lastUpdate < this.updateInterval && progress.status === 'InProgress') {
      return;
    }

    this.lastUpdate = now;

    // Show header only once
    if (!this.headerShown) {
      const modeLabel = mode === 'validation' ? 'Validation' : 'Deployment';
      logger.log('');
      logger.log(`🔄 ${modeLabel} Progress`);
      this.headerShown = true;
    } else {
      // Clear previous status lines
      ProgressReporter.clearLines(this.lastLineCount);
    }

    const output = this.formatProgress(progress);
    // Count lines in output (for next update's clear)
    this.lastLineCount = output.split('\n').length;
    logger.log(output);
  }

  /**
   * Displays final summary after deployment completes.
   */
  public displayFinalSummary(
    progress: DeploymentProgress,
    logger: { log: (message: string) => void },
    mode: 'validation' | 'deployment' | 'quick' = 'deployment'
  ): void {
    const lines: string[] = [];
    const modeLabel = mode === 'validation' ? 'VALIDATION' : 'DEPLOYMENT';

    lines.push('');
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push(
      `           ${ProgressReporter.getStatusEmoji(progress.status)} ${modeLabel} ${progress.status.toUpperCase()}`
    );
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push('');
    lines.push(`Job ID: ${progress.id}`);

    if (progress.validationId) {
      lines.push(`Validation ID: ${progress.validationId}`);
      lines.push('');
      lines.push('💡 To quick deploy this validation, run:');
      lines.push(`   sf fm deploy --mode quick --validation-id ${progress.validationId} --target-org <org>`);
    }

    lines.push('');
    lines.push('📊 STATISTICS:');
    lines.push(`   Components Deployed: ${progress.componentsDeployed}/${progress.componentsTotal}`);
    lines.push(`   Tests Executed: ${progress.testsCompleted}/${progress.testsTotal}`);
    lines.push(`   Tests Passed: ${progress.testsPassed}`);
    lines.push(`   Tests Failed: ${progress.testsFailed}`);

    if (progress.codeCoverage !== undefined) {
      lines.push(`   Code Coverage: ${progress.codeCoverage}%`);
    }

    const duration = ProgressReporter.formatDuration(Date.now() - this.startTime);
    lines.push(`   Total Duration: ${duration}`);

    if (progress.testFailures.length > 0) {
      lines.push('');
      lines.push('❌ TEST FAILURES:');
      progress.testFailures.forEach((failure, index) => {
        lines.push(`   ${index + 1}. ${failure.className}.${failure.methodName}`);
        lines.push(`      ${failure.message}`);
        if (failure.stackTrace) {
          const stackLines = failure.stackTrace.split('\n').slice(0, 3); // Show first 3 lines of stack
          stackLines.forEach((line) => {
            lines.push(`      ${line}`);
          });
        }
      });
    }

    if (progress.errors.length > 0) {
      lines.push('');
      lines.push('❌ COMPONENT ERRORS:');
      progress.errors.forEach((error) => {
        lines.push(`   ${error.type}: ${error.file}`);
        if (error.line) {
          lines.push(`      Line ${error.line}: ${error.message}`);
        } else {
          lines.push(`      ${error.message}`);
        }
      });
    }

    if (progress.warnings.length > 0) {
      lines.push('');
      lines.push('⚠️  WARNINGS:');
      progress.warnings.forEach((warning) => {
        lines.push(`   ${warning.type}: ${warning.file}`);
        lines.push(`      ${warning.message}`);
      });
    }

    lines.push('');
    lines.push('═══════════════════════════════════════════════════════════');

    logger.log(lines.join('\n'));
  }

  /**
   * Formats progress information into a readable display.
   */
  private formatProgress(progress: DeploymentProgress): string {
    const statusParts: string[] = [];

    // Status
    statusParts.push(`Status: ${progress.status === 'InProgress' ? '⚙️  In Progress' : progress.status}`);

    // Components
    statusParts.push(`📦 Components: ${progress.componentsDeployed}/${progress.componentsTotal}`);

    // Tests (if started)
    if (progress.testsTotal > 0 && progress.testsCompleted > 0) {
      let testString = `🧪 Tests: ${progress.testsCompleted}/${progress.testsTotal}`;

      if (progress.testsFailed > 0) {
        testString += ` ( ❌ ${progress.testsFailed} Failed )`;
      }

      statusParts.push(testString);

      if (progress.codeCoverage !== undefined) {
        const coverageIcon = progress.codeCoverage >= 75 ? '✅' : '⚠️';
        statusParts.push(`${coverageIcon} Coverage: ${progress.codeCoverage}%`);
      }
    }

    // Add current activity indicator (on same line)
    if (progress.status === 'InProgress') {
      // Show current test if available (tests are running)
      if (progress.currentTest) {
        statusParts.push(`▶️  ${progress.currentTest}`);
      } else if (progress.testsCompleted > 0 && progress.testsCompleted < progress.testsTotal) {
        // Tests running but no specific test info
        statusParts.push('▶️  Running tests...');
      } else if (progress.lastCompletedComponent && progress.componentsDeployed < progress.componentsTotal) {
        // Components still deploying
        statusParts.push(`▶️  ${progress.lastCompletedComponent}`);
      }
    }

    const statusLine = statusParts.join(' | ');

    // Time on next line
    const elapsed = ProgressReporter.formatDuration(Date.now() - this.startTime);
    const timeLine = `⏱️  ${elapsed}`;

    return statusLine + '\n' + timeLine;
  }
}
