import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CappedBuffer, OUTPUT_CAP_BYTES } from '../src/cap.js';
import { scrubEnv } from '../src/env.js';
import { runCommand } from '../src/run-command.js';
import { NODE, sleep, tempDir } from './helpers.js';

describe('env scrubbing', () => {
  const source = {
    PATH: '/bin',
    HOME: '/home/me',
    OPENAI_API_KEY: 'sk-1',
    GITHUB_TOKEN: 'ghp-1',
    db_password: 'p',
    AWS_SECRET_ACCESS_KEY: 's',
    MY_PASSWD: 'p',
    GOOGLE_APPLICATION_CREDENTIALS: '/x.json',
    OPAFEX_RELAY_KEY: 'opr_abc',
    Opafex_Relay_Key: 'opr_abc',
    EDITOR: 'vim',
  };

  it('drops anything that looks like a secret, and always the relay key', () => {
    expect(scrubEnv(source, [])).toEqual({ PATH: '/bin', HOME: '/home/me', EDITOR: 'vim' });
  });

  it('keeps a secret-looking name only when the entry lists it', () => {
    const out = scrubEnv(source, ['GITHUB_TOKEN', 'opafex_relay_key']);
    expect(out.GITHUB_TOKEN).toBe('ghp-1');
    expect(out.OPAFEX_RELAY_KEY).toBeUndefined();
    expect(out.Opafex_Relay_Key).toBeUndefined();
    expect(out.OPENAI_API_KEY).toBeUndefined();
  });

  it('reaches the child process that way', async () => {
    const env = scrubEnv({ ...process.env, RELAY_TEST_TOKEN: 'secret', RELAY_TEST_PLAIN: 'plain', OPAFEX_RELAY_KEY: 'opr_x' } as NodeJS.ProcessEnv, []);
    const out = await runCommand({
      file: NODE,
      argv: ['-e', 'process.stdout.write(JSON.stringify([process.env.RELAY_TEST_TOKEN ?? null, process.env.RELAY_TEST_PLAIN ?? null, process.env.OPAFEX_RELAY_KEY ?? null]))'],
      env,
      timeoutMs: 10_000,
    });
    expect(out.status).toBe('ok');
    if (out.status === 'ok') expect(JSON.parse(out.stdout)).toEqual([null, 'plain', null]);
  });
});

describe('output capping', () => {
  it('caps stdout and stderr at 256 KB each and says so', async () => {
    const out = await runCommand({
      file: NODE,
      argv: ['-e', "process.stdout.write('a' + 'é'.repeat(200000)); process.stderr.write('e'.repeat(300000))"],
      env: process.env as Record<string, string>,
      timeoutMs: 20_000,
    });
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.stdout)).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
    expect(Buffer.byteLength(out.stdout)).toBeGreaterThan(OUTPUT_CAP_BYTES - 4);
    expect(out.stdout).not.toContain('�'); // no character cut in half
    expect(Buffer.byteLength(out.stderr)).toBe(OUTPUT_CAP_BYTES);
  });

  it('does not flag output under the cap', async () => {
    const out = await runCommand({ file: NODE, argv: ['-e', "process.stdout.write('ok')"], env: process.env as Record<string, string>, timeoutMs: 10_000 });
    expect(out).toMatchObject({ status: 'ok', stdout: 'ok', truncated: false, exitCode: 0 });
  });

  it('CappedBuffer keeps exactly the cap', () => {
    const b = new CappedBuffer(10);
    b.push(Buffer.from('12345678'));
    b.push(Buffer.from('abcdef'));
    expect(b.toString()).toBe('12345678ab');
    expect(b.truncated).toBe(true);
  });
});

describe('timeouts', () => {
  const { dir, cleanup } = tempDir();
  afterAll(cleanup);

  it('kills the command and the processes it started', async () => {
    const marker = path.join(dir, 'grandchild-survived.txt');
    // On Windows, Node puts a non-detached child in a kill-on-close job, so a node grandchild
    // would die with its parent anyway and the test would prove nothing. Detached there, it
    // survives anything but a real tree kill. (On POSIX detached would leave the process group,
    // which no program needs to do to outlive a careless kill.)
    const script = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 2500)`)}], { stdio: 'ignore', detached: process.platform === 'win32' });`,
      'setTimeout(() => {}, 60000);',
    ].join('\n');
    const started = Date.now();
    const out = await runCommand({ file: NODE, argv: ['-e', script], env: process.env as Record<string, string>, timeoutMs: 1000 });
    expect(out.status).toBe('timed_out');
    expect(Date.now() - started).toBeLessThan(8000);
    await sleep(3500);
    expect(existsSync(marker)).toBe(false);
  });

  it('kills on abort (the platform deadline, or the relay stopping)', async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 300);
    const out = await runCommand({ file: NODE, argv: ['-e', 'setTimeout(() => {}, 60000)'], env: process.env as Record<string, string>, timeoutMs: 30_000, signal: ctl.signal });
    expect(out.status).toBe('aborted');
  });

  it('reports a program that cannot start', async () => {
    const out = await runCommand({ file: path.join(dir, 'no-such-program.exe'), argv: [], env: {}, timeoutMs: 5000 });
    expect(out.status).toBe('spawn_failed');
  });
});
