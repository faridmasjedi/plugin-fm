/**
 * Logger interface for consistent logging across the application.
 */
export type Logger = {
  log: (message: string) => void;
  warn: (message: string) => void;
};

/**
 * Logger with error method for commands that need error handling.
 */
export type LoggerWithError = Logger & {
  error: (message: string) => never;
};
