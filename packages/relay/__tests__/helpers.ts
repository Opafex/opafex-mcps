import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateConfig, type RelayConfig } from '../src/config.js';

export const NODE = process.execPath;

export function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'opafex-relay-test-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function config(raw: Record<string, unknown>): RelayConfig {
  return validateConfig({ machineName: 'test-machine', ...raw }, tmpdir());
}

export function writeConfig(dir: string, raw: Record<string, unknown>): string {
  const file = path.join(dir, 'relay.json');
  writeFileSync(file, JSON.stringify({ machineName: 'test-machine', ...raw }, null, 2));
  return file;
}

export async function waitFor(check: () => boolean, timeoutMs = 10_000, what = 'condition'): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A command entry that runs node with a fixed script; `{x}`-style args follow the script. */
export function nodeCommand(id: string, script: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, description: `test ${id}`, executable: NODE, args: ['-e', script], ...extra };
}

export interface Reply {
  status: number;
  body?: unknown;
}

/** A stand-in for the platform's relay routes, on 127.0.0.1. */
export class FakePlatform {
  hellos: unknown[] = [];
  results: { id: string; body: any }[] = [];
  polls = 0;
  pollTimes: number[] = [];
  headers: http.IncomingHttpHeaders[] = [];
  helloReplies: Reply[] = [];
  nextReplies: Reply[] = [];
  resultReplies: Reply[] = [];
  private server = http.createServer((req, res) => this.route(req, res));
  url = '';

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', () => r()));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private send(res: http.ServerResponse, reply: Reply): void {
    if (reply.body === undefined) {
      res.writeHead(reply.status);
      res.end();
      return;
    }
    res.writeHead(reply.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      this.headers.push(req.headers);
      const text = Buffer.concat(chunks).toString('utf8');
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/api/relay/v1/hello') {
        this.hellos.push(JSON.parse(text));
        this.send(res, this.helloReplies.shift() ?? { status: 200, body: { success: true, data: { relayId: 'relay_1', pollWaitSeconds: 1 } } });
        return;
      }
      if (req.method === 'GET' && url.startsWith('/api/relay/v1/next')) {
        this.polls++;
        this.pollTimes.push(Date.now());
        const reply = this.nextReplies.shift();
        if (reply) this.send(res, reply);
        else setTimeout(() => this.send(res, { status: 204 }), 50);
        return;
      }
      const m = /^\/api\/relay\/v1\/requests\/([^/]+)\/result$/.exec(url);
      if (req.method === 'POST' && m) {
        this.results.push({ id: decodeURIComponent(m[1]), body: JSON.parse(text) });
        this.send(res, this.resultReplies.shift() ?? { status: 200, body: { success: true, data: {} } });
        return;
      }
      this.send(res, { status: 404, body: { error: 'not found', code: 'NOT_FOUND' } });
    });
  }
}

export function claim(request: Record<string, unknown>): Reply {
  return {
    status: 200,
    body: { success: true, data: { request: { deadline: new Date(Date.now() + 30_000).toISOString(), ...request } } },
  };
}

/** A tiny stdio MCP server, written for the tests. */
export const FAKE_MCP_SERVER = String.raw`
import readline from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
let initialized = false;
let protocolVersion = null;
const tools = [];
for (let i = 0; i < 5; i++) tools.push({ name: 'tool_' + i, description: 'Tool ' + i, inputSchema: { type: 'object' } });
tools.push({ name: 'echo', description: 'Echo the arguments', inputSchema: { type: 'object' } });
tools.push({ name: 'crash', description: 'Exit', inputSchema: { type: 'object' } });
tools.push({ name: 'big', description: 'A large result', inputSchema: { type: 'object' } });
tools.push({ name: 'slow', description: 'Never answers', inputSchema: { type: 'object' } });
process.stdout.write('a banner line that is not JSON\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    protocolVersion = msg.params.protocolVersion;
    send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: '1.0.0' } } });
    return;
  }
  if (msg.method === 'notifications/initialized') { initialized = true; return; }
  if (msg.method === 'tools/list') {
    if (!initialized) { send({ jsonrpc: '2.0', id: msg.id, error: { code: -32002, message: 'not initialized' } }); return; }
    const page = msg.params && msg.params.cursor === 'page2' ? 2 : msg.params && msg.params.cursor === 'page3' ? 3 : 1;
    const slice = page === 1 ? tools.slice(0, 3) : page === 2 ? tools.slice(3, 6) : tools.slice(6);
    const nextCursor = page === 1 ? 'page2' : page === 2 ? 'page3' : undefined;
    send({ jsonrpc: '2.0', id: msg.id, result: { tools: slice, ...(nextCursor ? { nextCursor } : {}) } });
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params.name;
    if (name === 'echo') {
      send({ jsonrpc: '2.0', id: msg.id, result: {
        content: [{ type: 'text', text: JSON.stringify(msg.params.arguments) }],
        structuredContent: { args: msg.params.arguments, protocolVersion, secret: process.env.FAKE_SERVER_TOKEN ?? 'absent', relayKey: process.env.OPAFEX_RELAY_KEY ?? 'absent' },
        isError: false,
      } });
      return;
    }
    if (name === 'crash') process.exit(3);
    if (name === 'big') { send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'x'.repeat(400000) }], structuredContent: { blob: 'y'.repeat(100000) } } }); return; }
    if (name === 'slow') return;
    send({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'called ' + name }] } });
  }
});
`;

export function writeFakeServer(dir: string): string {
  const file = path.join(dir, 'fake-mcp-server.mjs');
  writeFileSync(file, FAKE_MCP_SERVER);
  return file;
}
