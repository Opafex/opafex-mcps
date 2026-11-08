import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { planCommand } from '../src/allowlist.js';
import { resolveExecutable } from '../src/executable.js';
import { runCommand, spawnOptions } from '../src/run-command.js';
import { config, NODE, tempDir } from './helpers.js';

const winFs = (files: string[]) => (f: string) => files.map((x) => x.toLowerCase()).includes(f.toLowerCase());

describe('Windows: nothing that needs cmd.exe', () => {
  const env = { Path: 'C:\\Git\\cmd;C:\\nodejs;relative\\dir' };
  const files = ['C:\\Git\\cmd\\git.exe', 'C:\\nodejs\\npx.cmd', 'C:\\nodejs\\node.exe', 'C:\\tools\\build.cmd', 'C:\\tools\\deploy.bat'];
  const resolve = (exe: string) => resolveExecutable(exe, { platform: 'win32', env, isRunnableFile: winFs(files) });

  it('refuses .bat, .cmd, .ps1 and other host-run files by path', () => {
    for (const exe of ['C:\\tools\\build.cmd', 'C:\\tools\\deploy.bat', 'C:\\tools\\x.ps1', 'C:\\tools\\x.vbs', 'build.CMD']) {
      const v = resolve(exe);
      expect(v.status, exe).toBe('refused');
      if (v.status === 'refused') expect(v.message).toMatch(/cmd\.exe/);
    }
  });

  it('refuses a bare name that is only a batch file on PATH (npx is npx.cmd)', () => {
    const v = resolve('npx');
    expect(v).toMatchObject({ status: 'refused' });
    if (v.status === 'refused') expect(v.message).toMatch(/\.cmd file/);
  });

  it('refuses shells by name, with or without .exe', () => {
    for (const exe of ['cmd', 'cmd.exe', 'C:\\Windows\\System32\\cmd.exe', 'powershell.exe', 'pwsh', 'bash.exe', 'wsl', 'wscript.exe']) {
      expect(resolve(exe).status, exe).toBe('refused');
    }
  });

  it('resolves a bare name to the .exe on an absolute PATH entry', () => {
    expect(resolve('git')).toEqual({ status: 'ok', file: 'C:\\Git\\cmd\\git.exe' });
    expect(resolve('node.exe')).toEqual({ status: 'ok', file: 'C:\\nodejs\\node.exe' });
  });

  it('refuses relative paths', () => {
    expect(resolve('tools\\x.exe').status).toBe('refused');
  });
});

describe('POSIX: no shells either', () => {
  const resolve = (exe: string) =>
    resolveExecutable(exe, { platform: 'linux', env: { PATH: '/usr/bin:/bin' }, isRunnableFile: (f) => ['/bin/ls', '/bin/sh', '/usr/bin/bash'].includes(f) });

  it('refuses sh, bash, env and xargs', () => {
    for (const exe of ['sh', '/bin/sh', 'bash', 'env', 'xargs', 'zsh']) expect(resolve(exe).status, exe).toBe('refused');
  });

  it('resolves a bare name on PATH', () => {
    expect(resolve('ls')).toEqual({ status: 'ok', file: '/bin/ls' });
    expect(resolve('nope').status).toBe('refused');
  });
});

describe('spawn options', () => {
  it('never uses a shell, on any platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      const o = spawnOptions({ env: {}, platform });
      expect(o.shell).toBe(false);
      expect(o.windowsVerbatimArguments).toBe(false);
    }
  });
});

describe('shell metacharacters stay one literal argument', () => {
  const { dir, cleanup } = tempDir();
  afterAll(cleanup);

  it('passes the value to the program exactly as sent', async () => {
    const value = `a; echo PWNED > pwned.txt && $(whoami) | "q" 'x' \`y\` %PATH% ^& ! \\" \\\\ & del *`;
    const c = config({
      commands: [
        {
          id: 'echo_args',
          description: 'print argv',
          executable: NODE,
          args: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', '{v}'],
          cwd: dir,
          params: [{ name: 'v', pattern: '.{1,500}' }],
        },
      ],
    });
    const plan = planCommand(c, { id: 'echo_args', params: { v: value } });
    expect(plan.status).toBe('ok');
    if (plan.status !== 'ok') return;
    const exe = resolveExecutable(plan.command.executable, { platform: process.platform, env: process.env });
    expect(exe.status).toBe('ok');
    if (exe.status !== 'ok') return;
    const out = await runCommand({ file: exe.file, argv: plan.argv, cwd: dir, env: { ...process.env } as Record<string, string>, timeoutMs: 10_000 });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(JSON.parse(out.stdout)).toEqual([value]);
    expect(existsSync(path.join(dir, 'pwned.txt'))).toBe(false);
  });
});
