import type { DeploymentProgress } from './deploymentService.js';

export type ProgressBar = {
  total: number;
  current: number;
  width: number;
  label: string;
};

/**
 * Service for reporting deployment progress with formatted output.
 */
export class ProgressReporter {
  private startTime: number;
  private lastUpdate: number = 0;
  private readonly updateInterval: number = 2000; // 2 seconds

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
   * Creates a visual progress bar.
   */
  private static createProgressBar(bar: ProgressBar): string {
    const percentage = bar.total > 0 ? (bar.current / bar.total) * 100 : 0;
    const filled = Math.floor((bar.width * percentage) / 100);
    const empty = bar.width - filled;

    const filledBar = '█'.repeat(filled);
    const emptyBar = '░'.repeat(empty);

    return `  [${filledBar}${emptyBar}] ${bar.label || `${bar.current}/${bar.total}`}`;
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
  public displayProgress(progress: DeploymentProgress, logger: { log: (message: string) => void }): void {
    const now = Date.now();

    // Throttle updates to avoid spamming
    if (now - this.lastUpdate < this.updateInterval && progress.status === 'InProgress') {
      return;
    }

    this.lastUpdate = now;

    // Clear previous lines and redraw
    ProgressReporter.clearLines(10);

    const output = this.formatProgress(progress);
    logger.log(output);
  }

  /**
   * Displays final summary after deployment completes.
   */
  public displayFinalSummary(progress: DeploymentProgress, logger: { log: (message: string) => void }): void {
    const lines: string[] = [];

    lines.push('');
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push(
      `           ${ProgressReporter.getStatusEmoji(progress.status)} DEPLOYMENT ${progress.status.toUpperCase()}`
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

    if (progress.errors.length > 0) {
      lines.push('');
      lines.push('❌ ERRORS:');
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
    const lines: string[] = [];

    lines.push('');
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push(`           ${ProgressReporter.getStatusEmoji(progress.status)} ${progress.status.toUpperCase()}`);
    lines.push('═══════════════════════════════════════════════════════════');
    lines.push('');

    // Overall progress bar
    lines.push('Overall Progress:');
    lines.push(
      ProgressReporter.createProgressBar({
        total: 100,
        current: progress.progress,
        width: 50,
        label: `${progress.progress}%`,
      })
    );
    lines.push('');

    // Component progress
    lines.push(`📦 Components: ${progress.componentsDeployed}/${progress.componentsTotal}`);
    if (progress.componentsTotal > 0) {
      lines.push(
        ProgressReporter.createProgressBar({
          total: progress.componentsTotal,
          current: progress.componentsDeployed,
          width: 40,
          label: '',
        })
      );
    }
    lines.push('');

    // Test progress
    if (progress.testsTotal > 0) {
      lines.push(
        `🧪 Tests: ${progress.testsPassed}/${progress.testsCompleted} passed (${progress.testsFailed} failed)`
      );
      lines.push(
        ProgressReporter.createProgressBar({
          total: progress.testsTotal,
          current: progress.testsCompleted,
          width: 40,
          label: '',
        })
      );

      if (progress.codeCoverage !== undefined) {
        lines.push(`   Code Coverage: ${progress.codeCoverage}%`);
      }
      lines.push('');
    }

    // Time elapsed
    const elapsed = ProgressReporter.formatDuration(Date.now() - this.startTime);
    lines.push(`⏱️  Time Elapsed: ${elapsed}`);

    // ETA (if in progress)
    if (progress.status === 'InProgress' && progress.progress > 5) {
      const eta = this.calculateETA(progress.progress);
      lines.push(`   Estimated Completion: ${eta}`);
    }

    lines.push('');

    // Show recent errors/warnings
    if (progress.errors.length > 0) {
      lines.push(`❌ Errors: ${progress.errors.length}`);
      progress.errors.slice(0, 3).forEach((error) => {
        lines.push(`   • ${error.file}${error.line ? `:${error.line}` : ''}`);
        lines.push(`     ${error.message}`);
      });
      if (progress.errors.length > 3) {
        lines.push(`   ... and ${progress.errors.length - 3} more errors`);
      }
      lines.push('');
    }

    if (progress.warnings.length > 0) {
      lines.push(`⚠️  Warnings: ${progress.warnings.length}`);
      progress.warnings.slice(0, 2).forEach((warning) => {
        lines.push(`   • ${warning.file}${warning.line ? `:${warning.line}` : ''}`);
      });
      if (progress.warnings.length > 2) {
        lines.push(`   ... and ${progress.warnings.length - 2} more warnings`);
      }
      lines.push('');
    }

    lines.push('═══════════════════════════════════════════════════════════');

    return lines.join('\n');
  }

  /**
   * Calculates estimated time to completion.
   */
  private calculateETA(progress: number): string {
    const elapsed = Date.now() - this.startTime;
    const total = (elapsed / progress) * 100;
    const remaining = total - elapsed;

    if (remaining <= 0) {
      return 'Soon';
    }

    return ProgressReporter.formatDuration(remaining);
  }
}
