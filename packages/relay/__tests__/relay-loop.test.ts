import { writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Relay, type RelayExit } from '../src/relay.js';
import { RELAY_VERSION } from '../src/version.js';
import { claim, FakePlatform, NODE, nodeCommand, sleep, tempDir, waitFor, writeConfig, writeFakeServer } from './helpers.js';

const KEY = 'opr_test_key_0123456789';

let platform: FakePlatform;
let tmp: { dir: string; cleanup: () => void };
let relay: Relay | undefined;
let running: Promise<RelayExit> | undefined;
let logs: string[];

beforeEach(async () => {
  platform = new FakePlatform();
  await platform.start();
  tmp = tempDir();
  logs = [];
});

afterEach(async () => {
  relay?.stop();
  if (running) await running;
  relay = undefined;
  running = undefined;
  await platform.close();
  tmp.cleanup();
});

function start(raw: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
  const configPath = writeConfig(tmp.dir, { platformUrl: platform.url, ...raw });
  relay = new Relay({
    configPath,
    key: KEY,
    log: (l) => logs.push(l),
    backoffBaseMs: 50,
    backoffCapMs: 400,
    watchIntervalMs: 50,
    minEmptyPollMs: 0,
    mcpRestartBaseMs: 100,
    ...extra,
  });
  running = relay.run();
  return configPath;
}

const echoCmd = nodeCommand('say', "process.stdout.write('said ' + process.argv[1])", {
  args: ['-e', "process.stdout.write('said ' + process.argv[1])", '{word}'],
  params: [{ name: 'word', description: 'one word', pattern: '[a-z]{1,20}' }],
});

describe('hello', () => {
  it('sends the offer with the key and version headers, and never the executable or args', async () => {
    start({ commands: [echoCmd] });
    await waitFor(() => platform.hellos.length === 1, 10_000, 'hello');
    const h = platform.headers[0];
    expect(h.authorization).toBe(`Bearer ${KEY}`);
    expect(h['x-relay-version']).toBe(RELAY_VERSION);
    expect(h['content-type']).toBe('application/json');
    expect(platform.hellos[0]).toEqual({
      machine: { name: 'test-machine', os: process.platform, relayVersion: RELAY_VERSION },
      commands: [{ id: 'say', description: 'test say', params: [{ name: 'word', description: 'one word', pattern: '[a-z]{1,20}' }] }],
      mcpServers: [],
    });
    const text = JSON.stringify(platform.hellos[0]);
    expect(text).not.toContain(NODE.replace(/\\/g, '\\\\'));
    expect(text).not.toContain('process.stdout');
  });

  it('says hello again when the config file changes, with the new offer', async () => {
    const configPath = start({ commands: [echoCmd] });
    await waitFor(() => platform.hellos.length === 1 && platform.polls > 0, 10_000, 'first hello');
    await sleep(100);
    writeFileSync(configPath, JSON.stringify({ platformUrl: platform.url, machineName: 'test-machine', commands: [echoCmd, nodeCommand('second', '1')] }));
    await waitFor(() => platform.hellos.length === 2, 10_000, 'second hello');
    expect((platform.hellos[1] as any).commands.map((c: any) => c.id)).toEqual(['say', 'second']);
  });

  it('keeps the previous offer when an edit breaks the config', async () => {
    const configPath = start({ commands: [echoCmd] });
    await waitFor(() => platform.hellos.length === 1 && platform.polls > 0, 10_000, 'first hello');
    await sleep(100);
    writeFileSync(configPath, '{ "commands": [ broken');
    await waitFor(() => logs.some((l) => l.includes('keeping the previous one')), 10_000, 'reload refusal');
    expect(platform.hellos.length).toBe(1);
  });

  it('retries a hello that hit a 503', async () => {
    platform.helloReplies.push({ status: 503, body: { error: 'down', code: 'SERVICE_UNAVAILABLE' } });
    start({ commands: [echoCmd] });
    await waitFor(() => platform.hellos.length === 2 && platform.polls > 0, 10_000, 'retried hello');
  });
});

describe('the poll loop', () => {
  it('204 means poll again; a claimed command runs and its result is posted', async () => {
    platform.nextReplies.push({ status: 204 }, claim({ id: 'req-1', kind: 'command', command: { id: 'say', params: { word: 'hello' } } }));
    start({ commands: [echoCmd] });
    await waitFor(() => platform.results.length === 1, 15_000, 'result');
    const r = platform.results[0];
    expect(r.id).toBe('req-1');
    expect(r.body).toMatchObject({ status: 'ok', result: { exitCode: 0, stdout: 'said hello', stderr: '', truncated: false } });
    expect(typeof r.body.result.durationMs).toBe('number');
    expect(platform.polls).toBeGreaterThanOrEqual(3);
  });

  it('refuses what is not on the list and posts the refusal', async () => {
    platform.nextReplies.push(
      claim({ id: 'req-off', kind: 'command', command: { id: 'format_disk', params: {} } }),
      claim({ id: 'req-bad', kind: 'command', command: { id: 'say', params: { word: 'hello; rm -rf ~' } } }),
      claim({ id: 'req-extra', kind: 'command', command: { id: 'say', params: { word: 'hi', cwd: '/' } } }),
      claim({ id: 'req-kind', kind: 'shell', command: { id: 'say' } }),
      claim({ id: 'req-mcp', kind: 'mcp_call', mcp: { serverId: 'nope', tool: 'x', arguments: {} } }),
    );
    start({ commands: [echoCmd] });
    await waitFor(() => platform.results.length === 5, 15_000, 'five refusals');
    const byId = Object.fromEntries(platform.results.map((r) => [r.id, r.body]));
    expect(byId['req-off']).toMatchObject({ status: 'refused', refusal: { code: 'not_on_list' } });
    expect(byId['req-bad']).toMatchObject({ status: 'refused', refusal: { code: 'param_mismatch' } });
    expect(byId['req-extra']).toMatchObject({ status: 'refused', refusal: { code: 'param_mismatch' } });
    expect(byId['req-kind']).toMatchObject({ status: 'refused', refusal: { code: 'not_on_list' } });
    expect(byId['req-mcp']).toMatchObject({ status: 'refused', refusal: { code: 'not_on_list' } });
  });

  it('a 401 stops the relay with a clear reason and no more polling', async () => {
    platform.nextReplies.push({ status: 401, body: { error: 'Relay key revoked', code: 'UNAUTHORIZED' } });
    start({ commands: [echoCmd] });
    const exit = await running!;
    expect(exit).toMatchObject({ reason: 'unauthorized' });
    const polls = platform.polls;
    await sleep(300);
    expect(platform.polls).toBe(polls);
  });

  it('409 hello_required sends hello again and carries on polling', async () => {
    platform.nextReplies.push(
      { status: 409, body: { error: 'This machine has no current offer', code: 'hello_required' } },
      claim({ id: 'req-after-hello', kind: 'command', command: { id: 'say', params: { word: 'again' } } }),
    );
    start({ commands: [echoCmd] });
    await waitFor(() => platform.results.length === 1, 15_000, 'result after re-hello');
    expect(platform.hellos.length).toBe(2);
    expect(platform.hellos[1]).toEqual(platform.hellos[0]); // the same offer, sent again
    expect(platform.results[0].body).toMatchObject({ status: 'ok', result: { stdout: 'said again' } });
  });

  it('a second 409 hello_required inside a minute stops the relay instead of looping', async () => {
    platform.nextReplies.push(
      { status: 409, body: { error: 'no offer', code: 'hello_required' } },
      { status: 409, body: { error: 'no offer', code: 'hello_required' } },
    );
    start({ commands: [echoCmd] });
    expect(await running!).toMatchObject({ reason: 'hello_loop' });
    expect(platform.hellos.length).toBe(2);
  });

  it('any other 409 on a poll still stops', async () => {
    platform.nextReplies.push({ status: 409, body: { error: 'conflict', code: 'something_else' } });
    start({ commands: [echoCmd] });
    expect(await running!).toMatchObject({ reason: 'refused', httpStatus: 409 });
    expect(platform.hellos.length).toBe(1);
  });

  it('a result whose JSON would be over 1 MB is cut to fit before it is posted', async () => {
    const noisy = nodeCommand('noisy', "const s = '\\u0001'.repeat(256 * 1024); process.stdout.write(s); process.stderr.write(s)");
    platform.nextReplies.push(claim({ id: 'req-noisy', kind: 'command', command: { id: 'noisy', params: {} } }));
    start({ commands: [noisy] });
    await waitFor(() => platform.results.length === 1, 15_000, 'noisy result');
    const body = platform.results[0].body;
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThanOrEqual(1024 * 1024);
    expect(body).toMatchObject({ status: 'ok', result: { exitCode: 0, truncated: true } });
  });

  it('a 401 on hello stops before any poll', async () => {
    platform.helloReplies.push({ status: 401, body: { error: 'unknown key' } });
    start({});
    expect(await running!).toMatchObject({ reason: 'unauthorized' });
    expect(platform.polls).toBe(0);
  });

  it('a 403 relay_not_entitled stops the relay', async () => {
    platform.nextReplies.push({ status: 403, body: { error: 'The relay is not part of this plan', code: 'relay_not_entitled' } });
    start({});
    expect(await running!).toMatchObject({ reason: 'not_entitled' });
  });

  it('5xx backs off (doubling) and then carries on', async () => {
    platform.nextReplies.push(
      { status: 503 },
      { status: 502 },
      claim({ id: 'req-after', kind: 'command', command: { id: 'say', params: { word: 'back' } } }),
    );
    start({ commands: [echoCmd] });
    await waitFor(() => platform.results.length === 1, 15_000, 'result after backoff');
    const [t1, t2, t3] = platform.pollTimes;
    expect(t2 - t1).toBeGreaterThanOrEqual(45);
    expect(t3 - t2).toBeGreaterThanOrEqual(95);
    expect(platform.results[0].body).toMatchObject({ status: 'ok', result: { stdout: 'said back' } });
  });

  it('a request whose deadline has passed is not run and nothing is posted', async () => {
    platform.nextReplies.push({
      status: 200,
      body: { request: { id: 'req-late', kind: 'command', command: { id: 'say', params: { word: 'late' } }, deadline: new Date(Date.now() - 1000).toISOString() } },
    });
    start({ commands: [echoCmd] });
    await waitFor(() => logs.some((l) => l.includes('deadline had passed')), 10_000, 'late log');
    await sleep(200);
    expect(platform.results).toEqual([]);
  });

  it("kills a command still running at the platform's deadline and posts nothing", async () => {
    const sleeper = nodeCommand('sleep_long', 'setTimeout(() => {}, 60000)', { timeoutSeconds: 120 });
    platform.nextReplies.push({
      status: 200,
      body: { request: { id: 'req-slow', kind: 'command', command: { id: 'sleep_long', params: {} }, deadline: new Date(Date.now() + 1200).toISOString() } },
    });
    start({ commands: [sleeper] });
    await waitFor(() => logs.some((l) => l.includes("platform's deadline")), 10_000, 'deadline kill');
    await sleep(200);
    expect(platform.results).toEqual([]);
  });

  it('an entry timeout shorter than the deadline posts an error', async () => {
    const sleeper = nodeCommand('sleep_short', 'setTimeout(() => {}, 60000)', { timeoutSeconds: 1 });
    platform.nextReplies.push(claim({ id: 'req-to', kind: 'command', command: { id: 'sleep_short', params: {} } }));
    start({ commands: [sleeper] });
    await waitFor(() => platform.results.length === 1, 10_000, 'timeout result');
    expect(platform.results[0].body).toMatchObject({ status: 'error', error: { message: expect.stringMatching(/timed out/) } });
  });

  it('a 409 on the result is final, not retried', async () => {
    platform.resultReplies.push({ status: 409, body: { error: 'already settled', code: 'already_settled' } });
    platform.nextReplies.push(claim({ id: 'req-dup', kind: 'command', command: { id: 'say', params: { word: 'x' } } }));
    start({ commands: [echoCmd] });
    await waitFor(() => logs.some((l) => l.includes('already settled')), 10_000, 'settled log');
    await sleep(200);
    expect(platform.results.length).toBe(1);
  });

  it('passes an mcp_call through to a local server and lists tools in hello', async () => {
    const script = writeFakeServer(tmp.dir);
    platform.nextReplies.push(claim({ id: 'req-mcp', kind: 'mcp_call', mcp: { serverId: 'fake', tool: 'echo', arguments: { q: 'x' } } }));
    start({ mcpServers: [{ id: 'fake', command: NODE, args: [script], tools: ['echo', 'tool_0'] }] });
    await waitFor(() => platform.results.length === 1, 15_000, 'mcp result');
    expect((platform.hellos[0] as any).mcpServers).toEqual([
      { id: 'fake', tools: [{ name: 'tool_0', description: 'Tool 0', inputSchema: { type: 'object' } }, { name: 'echo', description: 'Echo the arguments', inputSchema: { type: 'object' } }] },
    ]);
    expect(platform.results[0].body).toMatchObject({ status: 'ok', result: { content: [{ type: 'text', text: '{"q":"x"}' }], isError: false } });
  });
});
