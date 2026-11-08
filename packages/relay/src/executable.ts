import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

export type ExecutableVerdict = { status: 'ok'; file: string } | { status: 'refused'; message: string };

/**
 * Programs whose job is to run a command line. Allowing one as a command would hand its
 * arguments to an interpreter, which is a shell by another name, so they are refused whatever
 * the config says.
 */
const SHELLS = new Set([
  'cmd', 'command', 'powershell', 'powershell_ise', 'pwsh', 'bash', 'sh', 'zsh', 'dash', 'fish', 'ksh', 'mksh',
  'csh', 'tcsh', 'ash', 'busybox', 'wsl', 'wscript', 'cscript', 'mshta', 'rundll32', 'conhost', 'env', 'xargs',
]);

/** On Windows only these run without cmd.exe or another host program. */
const WINDOWS_DIRECT = new Set(['.exe', '.com']);
const WINDOWS_NEEDS_A_HOST = ['.cmd', '.bat', '.ps1', '.vbs', '.js', '.wsf', '.msc', '.lnk'];

export interface ResolveOptions {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Seam for tests; defaults to the real file system. */
  isRunnableFile?: (file: string, platform: NodeJS.Platform) => boolean;
}

function defaultIsRunnable(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function envValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'win32') return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

/**
 * Turns the config's executable into an absolute path the relay runs directly, or says why not.
 * Resolving PATH here (rather than leaving it to the OS) means the program that runs is the one
 * `check` named, and on Windows a bare name can never land on a `.cmd`/`.bat` file.
 */
export function resolveExecutable(executable: string, opts: ResolveOptions): ExecutableVerdict {
  const { platform } = opts;
  const isRunnable = opts.isRunnableFile ?? defaultIsRunnable;
  const p = platform === 'win32' ? path.win32 : path.posix;
  const base = p.basename(executable);
  const ext = platform === 'win32' ? p.extname(base).toLowerCase() : '';
  const stem = (platform === 'win32' && ext ? base.slice(0, -ext.length) : base).toLowerCase();

  if (SHELLS.has(stem)) {
    return { status: 'refused', message: `"${base}" is a shell or a command runner; the relay never runs commands through one` };
  }
  if (platform === 'win32' && ext && !WINDOWS_DIRECT.has(ext)) {
    return {
      status: 'refused',
      message: `"${base}" is a ${ext} file, which Windows can only run through cmd.exe or another host; the relay runs .exe and .com programs only. Point the config at the real program (for npx, use node.exe and the package's script).`,
    };
  }

  const hasSeparator = executable.includes('/') || (platform === 'win32' && executable.includes('\\'));
  if (hasSeparator) {
    if (!p.isAbsolute(executable)) {
      return { status: 'refused', message: `"${executable}" must be an absolute path or a bare name on PATH` };
    }
    const candidates = platform === 'win32' && !ext ? [`${executable}.exe`, `${executable}.com`, executable] : [executable];
    for (const c of candidates) {
      if (platform === 'win32' && !WINDOWS_DIRECT.has(p.extname(c).toLowerCase())) continue;
      if (isRunnable(c, platform)) return { status: 'ok', file: c };
    }
    return { status: 'refused', message: `"${executable}" was not found or is not a runnable program` };
  }

  const dirs = (envValue(opts.env, 'PATH', platform) ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const names = platform === 'win32' && !ext ? [`${base}.exe`, `${base}.com`] : [base];
  for (const dir of dirs) {
    const clean = dir.replace(/^"(.*)"$/, '$1');
    if (!p.isAbsolute(clean)) continue; // a relative PATH entry depends on where the relay started
    for (const n of names) {
      const full = p.join(clean, n);
      if (isRunnable(full, platform)) return { status: 'ok', file: full };
    }
  }
  if (platform === 'win32' && !ext) {
    for (const dir of dirs) {
      const clean = dir.replace(/^"(.*)"$/, '$1');
      for (const hostExt of WINDOWS_NEEDS_A_HOST) {
        if (isRunnable(p.join(clean, `${base}${hostExt}`), platform)) {
          return {
            status: 'refused',
            message: `"${base}" on this PATH is a ${hostExt} file, which Windows can only run through cmd.exe or another host; the relay runs .exe and .com programs only. Point the config at the real program (for npx, use node.exe and the package's script).`,
          };
        }
      }
    }
  }
  return { status: 'refused', message: `"${base}" was not found on PATH` };
}
