import { spawn, spawnSync } from 'node:child_process';
import { extname } from 'node:path';

export const SUPPORTED_SCRIPT_EXTENSIONS = ['.sh', '.js', '.mjs', '.cjs', '.ts', '.py', '.apex'];

export type ScriptCommand = { cmd: string; args: string[] };

export type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

/**
 * Maps a script file to the command that runs it. Anonymous Apex (.apex) runs
 * against the target org with `sf apex run`.
 */
export function commandForScript(scriptPath: string, targetOrg?: string): ScriptCommand {
  switch (extname(scriptPath)) {
    case '.apex':
      return {
        cmd: 'sf',
        args: ['apex', 'run', '--file', scriptPath, ...(targetOrg ? ['--target-org', targetOrg] : [])],
      };
    case '.js':
    case '.mjs':
    case '.cjs':
      return { cmd: process.execPath, args: [scriptPath] };
    case '.ts':
      return { cmd: 'npx', args: ['--yes', 'tsx', scriptPath] };
    case '.py':
      return { cmd: 'python3', args: [scriptPath] };
    case '.sh':
      return { cmd: 'bash', args: [scriptPath] };
    default:
      // Unknown extension: run directly and let the shebang decide
      return { cmd: scriptPath, args: [] };
  }
}

/**
 * Runs a script synchronously and captures its output.
 */
export function runScriptSync(
  scriptPath: string,
  options: { env: NodeJS.ProcessEnv; targetOrg?: string; timeoutMs?: number }
): ProcessResult {
  const start = Date.now();
  const { cmd, args } = commandForScript(scriptPath, options.targetOrg);
  const res = spawnSync(cmd, args, {
    env: options.env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: options.timeoutMs ?? 15 * 60 * 1000,
  });
  return {
    exitCode: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? res.error?.message ?? '',
    durationMs: Date.now() - start,
  };
}

/**
 * Runs a process asynchronously, streaming output to `onOutput` as it arrives.
 * Pass `shell: true` to run `cmd` as a shell command line.
 */
export function runProcess(
  cmd: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    shell?: boolean;
    onOutput?: (chunk: string) => void;
  }
): Promise<ProcessResult> {
  const start = Date.now();
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd: options.cwd, env: options.env, shell: options.shell ?? false });
    let stdout = '';
    let stderr = '';
    const timer = options.timeoutMs
      ? setTimeout(() => {
          stderr += `\nTimed out after ${Math.round(options.timeoutMs! / 1000)}s`;
          child.kill('SIGTERM');
        }, options.timeoutMs)
      : undefined;

    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
      options.onOutput?.(data.toString());
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
      options.onOutput?.(data.toString());
    });
    child.on('error', (error) => {
      stderr += error.message;
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ exitCode: code ?? 1, stdout, stderr, durationMs: Date.now() - start });
    });
  });
}
