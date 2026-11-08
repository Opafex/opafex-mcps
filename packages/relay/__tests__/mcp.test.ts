import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { OUTPUT_CAP_BYTES } from '../src/cap.js';
import { McpServer } from '../src/mcp.js';
import { config, NODE, tempDir, waitFor, writeFakeServer } from './helpers.js';

const { dir, cleanup } = tempDir();
const script = writeFakeServer(dir);
afterAll(cleanup);

let servers: McpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()));
  servers = [];
});

function server(extra: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env): McpServer {
  const c = config({ mcpServers: [{ id: 'fake', command: NODE, args: [script], ...extra }] });
  const s = new McpServer(c.mcpServers[0], { env, restartBaseMs: 100 });
  servers.push(s);
  return s;
}

describe('local MCP server passthrough', () => {
  it('initialises with 2025-06-18 and lists every page of tools', async () => {
    const s = server();
    await s.start();
    expect(s.state).toBe('running');
    expect(s.tools.map((t) => t.name)).toEqual(['tool_0', 'tool_1', 'tool_2', 'tool_3', 'tool_4', 'echo', 'crash', 'big', 'slow']);
    const out = await s.callTool('echo', { a: 1 }, 5000);
    expect(out.status).toBe('ok');
    if (out.status === 'ok') expect((out.result.structuredContent as any).protocolVersion).toBe('2025-06-18');
  });

  it('passes tools/call through and returns the result as the server sent it', async () => {
    const s = server();
    await s.start();
    const out = await s.callTool('echo', { path: 'a; rm -rf /', n: 2 }, 5000);
    expect(out).toEqual({
      status: 'ok',
      truncated: false,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ path: 'a; rm -rf /', n: 2 }) }],
        structuredContent: { args: { path: 'a; rm -rf /', n: 2 }, protocolVersion: '2025-06-18', secret: 'absent', relayKey: 'absent' },
        isError: false,
      },
    });
  });

  it('scrubs secrets from the server environment unless listed', async () => {
    const env = { ...process.env, FAKE_SERVER_TOKEN: 'tok', OPAFEX_RELAY_KEY: 'opr_secret_value' };
    const plain = server({}, env);
    await plain.start();
    const a = await plain.callTool('echo', {}, 5000);
    if (a.status === 'ok') expect(a.result.structuredContent).toMatchObject({ secret: 'absent', relayKey: 'absent' });
    const listed = server({ env: ['FAKE_SERVER_TOKEN'] }, env);
    await listed.start();
    const b = await listed.callTool('echo', {}, 5000);
    if (b.status === 'ok') expect(b.result.structuredContent).toMatchObject({ secret: 'tok', relayKey: 'absent' });
    expect([a.status, b.status]).toEqual(['ok', 'ok']);
  });

  it('offers and calls only the tools the config allows', async () => {
    const s = server({ tools: ['echo'] });
    await s.start();
    expect(s.tools.map((t) => t.name)).toEqual(['echo']);
    expect(await s.callTool('tool_0', {}, 5000)).toMatchObject({ status: 'refused', code: 'not_on_list' });
    expect(await s.callTool('echo', [1], 5000)).toMatchObject({ status: 'refused', code: 'param_mismatch' });
  });

  it('caps a large result at 256 KB and says it was cut', async () => {
    const s = server();
    await s.start();
    const out = await s.callTool('big', {}, 5000);
    expect(out.status).toBe('ok');
    if (out.status !== 'ok') return;
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(out.result))).toBeLessThanOrEqual(OUTPUT_CAP_BYTES);
    expect(out.result.structuredContent).toBeUndefined();
    const content = out.result.content as { text: string }[];
    expect(content[content.length - 1].text).toMatch(/cut by the opafex relay/);
    expect(content[0].text.length).toBeGreaterThan(200_000);
  });

  it('refuses with server_not_running while a crashed server restarts, then serves again', async () => {
    const s = server();
    await s.start();
    const crash = await s.callTool('crash', {}, 5000);
    expect(crash.status).toBe('error');
    expect(await s.callTool('echo', {}, 5000)).toMatchObject({ status: 'refused', code: 'server_not_running' });
    expect(s.tools.length).toBe(9); // last-known tools stay on offer
    await waitFor(() => s.state === 'running', 10_000, 'restart');
    expect((await s.callTool('echo', {}, 5000)).status).toBe('ok');
  });

  it('a call still running at the deadline is cancelled and posts nothing', async () => {
    const s = server();
    await s.start();
    expect(await s.callTool('slow', {}, 300)).toEqual({ status: 'deadline' });
  });

  it('refuses to start a server through a shell', async () => {
    const c = config({ mcpServers: [{ id: 'sh', command: process.platform === 'win32' ? 'cmd.exe' : 'sh', args: ['-c', 'echo hi'] }] });
    const s = new McpServer(c.mcpServers[0]);
    servers.push(s);
    await s.start();
    expect(s.state).toBe('failed');
    expect(s.lastError).toMatch(/shell/);
  });
});
