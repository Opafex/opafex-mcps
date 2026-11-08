import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { CappedBuffer, OUTPUT_CAP_BYTES } from './cap.js';

export interface RunInput {
  /** Absolute path from `resolveExecutable`. */
  file: string;
  argv: string[];
  cwd?: string;
  env: Record<string, string>;
  timeoutMs: number;
  /** Aborting kills the process tree (relay shutting down, or the platform's deadline). */
  signal?: AbortSignal;
  platform?: NodeJS.Platform;
  capBytes?: number;
}

export type RunOutcome =
  | { status: 'ok'; exitCode: number; stdout: string; stderr: string; truncated: boolean; durationMs: number }
  | { status: 'timed_out'; durationMs: number }
  | { status: 'aborted'; durationMs: number }
  | { status: 'spawn_failed'; message: string };

/**
 * The options every child is started with. `shell: false` is the point: arguments go to the
 * program as an array, so `;`, `|`, `&&`, `$(...)` and quotes are just characters in one
 * argument. Exported so a test can pin it.
 */
export function spawnOptions(input: { cwd?: string; env: Record<string, string>; platform: NodeJS.Platform }): SpawnOptions {
  return {
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments: false,
    // POSIX: its own process group, so a timeout kills the children it started too.
    detached: input.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(input.cwd ? { cwd: input.cwd } : {}),
    env: input.env,
  };
}

/** Kills a child and everything it started: `taskkill /T` on Windows, the process group elsewhere. */
export function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (platform === 'win32') {
    const taskkill = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    try {
      const k = spawn(taskkill, ['/pid', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
      k.on('error', () => child.kill('SIGKILL'));
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

function exitCodeOf(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) {
    const n = (osConstants.signals as Record<string, number>)[signal];
    return typeof n === 'number' ? 128 + n : -1;
  }
  return -1;
}

/** Runs one program with no shell, caps what it prints, and kills it (and its children) on expiry. */
export function runCommand(input: RunInput): Promise<RunOutcome> {
  const platform = input.platform ?? process.platform;
  const cap = input.capBytes ?? OUTPUT_CAP_BYTES;
  const started = Date.now();

  return new Promise((resolve) => {
    if (input.signal?.aborted) {
      resolve({ status: 'aborted', durationMs: 0 });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(input.file, input.argv, spawnOptions({ cwd: input.cwd, env: input.env, platform }));
    } catch (e) {
      resolve({ status: 'spawn_failed', message: (e as Error).message });
      return;
    }

    const stdout = new CappedBuffer(cap);
    const stderr = new CappedBuffer(cap);
    child.stdout?.on('data', (c: Buffer) => stdout.push(c));
    child.stderr?.on('data', (c: Buffer) => stderr.push(c));

    let settled = false;
    let ended: 'timed_out' | 'aborted' | null = null;
    let exitCode: number | null = null;
    let closeGrace: NodeJS.Timeout | undefined;

    const finish = (outcome: RunOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (closeGrace) clearTimeout(closeGrace);
      input.signal?.removeEventListener('abort', onAbort);
      resolve(outcome);
    };

    const settleAfterExit = () => {
      const durationMs = Date.now() - started;
      if (ended) {
        finish({ status: ended, durationMs });
        return;
      }
      finish({
        status: 'ok',
        exitCode: exitCode ?? -1,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        truncated: stdout.truncated || stderr.truncated,
        durationMs,
      });
    };

    const stop = (why: 'timed_out' | 'aborted') => {
      if (settled || ended) return;
      ended = why;
      killTree(child, platform);
    };
    const onAbort = () => stop('aborted');
    input.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timed_out'), Math.max(1, input.timeoutMs));

    child.on('error', (e) => {
      if (exitCode === null && !ended) finish({ status: 'spawn_failed', message: e.message });
    });
    child.on('exit', (code, signal) => {
      exitCode = exitCodeOf(code, signal);
      // A program that leaves a background child holding its output open would never "close";
      // give the pipes a moment to drain, then stop waiting for them.
      closeGrace = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settleAfterExit();
      }, 500);
    });
    child.on('close', () => {
      if (exitCode === null) exitCode = -1;
      settleAfterExit();
    });
  });
}
