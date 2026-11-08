import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { McpServerConfig } from './config.js';
import { scrubEnv } from './env.js';
import { resolveExecutable } from './executable.js';
import { killTree, spawnOptions } from './run-command.js';
import { trimMcpResult, trimTools, type OfferedTool } from './trim.js';
import { MCP_PROTOCOL_VERSION, RELAY_VERSION } from './version.js';

/** A single JSON-RPC line from a server larger than this is treated as the server failing. */
const MAX_LINE_BYTES = 16 * 1024 * 1024;
const INIT_TIMEOUT_MS = 30_000;
const LIST_TIMEOUT_MS = 30_000;
const MAX_LIST_PAGES = 20;
const MAX_LISTED_TOOLS = 1000;
/** A server that stayed up this long has its restart backoff reset. */
const STABLE_AFTER_MS = 60_000;

export type ServerState = 'starting' | 'running' | 'restarting' | 'stopped' | 'failed';

export type McpCallOutcome =
  | { status: 'ok'; result: Record<string, unknown>; truncated: boolean }
  | { status: 'refused'; code: 'not_on_list' | 'param_mismatch' | 'server_not_running'; message: string }
  | { status: 'error'; message: string }
  | { status: 'deadline' };

export interface McpServerOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  log?: (line: string) => void;
  restartBaseMs?: number;
  restartCapMs?: number;
}

interface Pending {
  resolve: (v: { result?: unknown; error?: { code?: number; message?: string } }) => void;
  timer?: NodeJS.Timeout;
}

/**
 * One local stdio MCP server: started with no shell, initialised, its tools listed, calls
 * passed through. If it exits it is restarted with backoff; while it is down calls are refused
 * with `server_not_running`. The tools it last reported stay on offer meanwhile, so a crash
 * does not make them flicker on the platform.
 */
export class McpServer extends EventEmitter {
  readonly config: McpServerConfig;
  state: ServerState = 'stopped';
  tools: OfferedTool[] = [];
  lastError?: string;

  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf: Buffer = Buffer.alloc(0);
  private restartAttempt = 0;
  private restartTimer?: NodeJS.Timeout;
  private startedAt = 0;
  private stopping = false;
  private firstStart?: Promise<void>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly log: (line: string) => void;
  private readonly restartBaseMs: number;
  private readonly restartCapMs: number;

  constructor(config: McpServerConfig, opts: McpServerOptions = {}) {
    super();
    this.config = config;
    this.env = opts.env ?? process.env;
    this.platform = opts.platform ?? process.platform;
    this.log = opts.log ?? (() => {});
    this.restartBaseMs = opts.restartBaseMs ?? 1000;
    this.restartCapMs = opts.restartCapMs ?? 60_000;
  }

  /** Starts the server; resolves once the first attempt has come up or failed. */
  start(): Promise<void> {
    this.stopping = false;
    if (!this.firstStart) this.firstStart = this.launch();
    return this.firstStart;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.state = 'stopped';
    const child = this.child;
    this.child = undefined;
    this.failPending('the server was stopped');
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 2000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        killTree(child, this.platform);
      });
    }
  }

  private async launch(): Promise<void> {
    if (this.stopping) return;
    this.state = this.restartAttempt === 0 ? 'starting' : 'restarting';
    const verdict = resolveExecutable(this.config.command, { platform: this.platform, env: this.env });
    if (verdict.status === 'refused') {
      // A config problem, not a crash: restarting would refuse the same way every time.
      this.state = 'failed';
      this.lastError = verdict.message;
      this.log(`mcp server ${this.config.id}: ${verdict.message}`);
      this.emit('state');
      return;
    }
    let child: ChildProcess;
    try {
      const opts = spawnOptions({ cwd: this.config.cwd, env: scrubEnv(this.env, this.config.env), platform: this.platform });
      child = spawn(verdict.file, this.config.args, { ...opts, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      this.onDown(`could not start: ${(e as Error).message}`);
      return;
    }
    this.child = child;
    this.buf = Buffer.alloc(0);
    this.startedAt = Date.now();
    child.stdout?.on('data', (c: Buffer) => this.onData(child, c));
    child.stderr?.on('data', () => {}); // drained, not logged: a server's stderr can hold anything
    child.stdin?.on('error', () => {});
    child.on('error', (e) => this.onExit(child, `could not start: ${e.message}`));
    child.on('exit', (code, signal) => this.onExit(child, `exited (${signal ?? `code ${code}`})`));

    try {
      const init = await this.request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'opafex-relay', version: RELAY_VERSION },
      }, INIT_TIMEOUT_MS);
      if (init.error) throw new Error(`initialize failed: ${init.error.message ?? 'unknown error'}`);
      this.notify('notifications/initialized', {});
      await this.refreshTools();
      if (this.child !== child) return;
      this.state = 'running';
      this.lastError = undefined;
      this.log(`mcp server ${this.config.id}: running, ${this.tools.length} tool(s)`);
      this.emit('state');
    } catch (e) {
      if (this.child === child) {
        killTree(child, this.platform);
        this.onExit(child, (e as Error).message);
      }
    }
  }

  private onExit(child: ChildProcess, why: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.failPending(`the server ${why}`);
    if (this.stopping) return;
    this.onDown(why);
  }

  private onDown(why: string): void {
    if (Date.now() - this.startedAt >= STABLE_AFTER_MS) this.restartAttempt = 0;
    const delay = Math.min(this.restartCapMs, this.restartBaseMs * 2 ** this.restartAttempt);
    this.restartAttempt++;
    this.state = 'restarting';
    this.lastError = why;
    this.log(`mcp server ${this.config.id}: ${why}; restarting in ${Math.round(delay / 100) / 10}s`);
    this.emit('state');
    this.restartTimer = setTimeout(() => {
      void this.launch();
    }, delay);
  }

  private failPending(message: string): void {
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.resolve({ error: { message } });
    }
    this.pending.clear();
  }

  private onData(child: ChildProcess, chunk: Buffer): void {
    if (this.child !== child) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let nl: number;
    while ((nl = this.buf.indexOf(0x0a)) !== -1) {
      const line = this.buf.subarray(0, nl).toString('utf8').trim();
      this.buf = this.buf.subarray(nl + 1);
      if (line) this.onMessage(line);
      if (this.child !== child) return;
    }
    if (this.buf.length > MAX_LINE_BYTES) {
      killTree(child, this.platform);
      this.onExit(child, 'sent a message over 16 MB');
    }
  }

  private onMessage(line: string): void {
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return;
      msg = parsed as Record<string, unknown>;
    } catch {
      return; // not JSON-RPC (some servers print banners); ignored
    }
    const method = msg.method;
    const id = msg.id;
    if (typeof method === 'string') {
      if (id !== undefined && id !== null) {
        // A request from the server. The relay offers no client capabilities (no sampling,
        // no roots, no elicitation), so only ping is answered.
        if (method === 'ping') this.send({ jsonrpc: '2.0', id, result: {} });
        else this.send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
        return;
      }
      if (method === 'notifications/tools/list_changed' && this.state === 'running') {
        void this.refreshTools().catch(() => {});
      }
      return;
    }
    if (typeof id === 'number') {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      const error = msg.error as { code?: number; message?: string } | undefined;
      p.resolve(error ? { error } : { result: msg.result });
    }
  }

  private send(msg: unknown): void {
    this.child?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<{ result?: unknown; error?: { code?: number; message?: string }; deadline?: boolean }> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      const entry: Pending = { resolve };
      const onAbort = () => {
        if (!this.pending.delete(id)) return;
        if (entry.timer) clearTimeout(entry.timer);
        this.notify('notifications/cancelled', { requestId: id, reason: 'deadline passed' });
        resolve({ deadline: true });
      };
      entry.resolve = (v) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };
      entry.timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener('abort', onAbort);
        this.notify('notifications/cancelled', { requestId: id, reason: 'timed out' });
        resolve({ error: { message: `${method} timed out` }, deadline: true });
      }, Math.max(1, timeoutMs));
      this.pending.set(id, entry);
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** Reads the whole tool list again, following `nextCursor` up to a cap. */
  async refreshTools(): Promise<OfferedTool[]> {
    const raw: unknown[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, LIST_TIMEOUT_MS);
      if (r.error || r.deadline) throw new Error(`tools/list failed: ${r.error?.message ?? 'timed out'}`);
      const res = (r.result ?? {}) as { tools?: unknown; nextCursor?: unknown };
      if (Array.isArray(res.tools)) raw.push(...res.tools);
      if (raw.length >= MAX_LISTED_TOOLS) break;
      if (typeof res.nextCursor !== 'string' || !res.nextCursor || res.nextCursor === cursor) break;
      cursor = res.nextCursor;
    }
    const { tools, warnings } = trimTools(raw, this.config.tools);
    for (const w of warnings) this.log(`mcp server ${this.config.id}: ${w}`);
    const changed = JSON.stringify(tools) !== JSON.stringify(this.tools);
    this.tools = tools;
    if (changed) this.emit('tools');
    return tools;
  }

  /** Passes one `tools/call` through, if the tool is one this server offered. */
  async callTool(name: unknown, args: unknown, timeoutMs: number, signal?: AbortSignal): Promise<McpCallOutcome> {
    if (typeof name !== 'string' || !this.tools.some((t) => t.name === name)) {
      return { status: 'refused', code: 'not_on_list', message: `"${String(name).slice(0, 60)}" is not a tool ${this.config.id} offers` };
    }
    const callArgs = args === undefined || args === null ? {} : args;
    if (typeof callArgs !== 'object' || Array.isArray(callArgs)) {
      return { status: 'refused', code: 'param_mismatch', message: 'arguments must be an object' };
    }
    if (this.state !== 'running' || !this.child) {
      return { status: 'refused', code: 'server_not_running', message: `${this.config.id} is not running${this.lastError ? ` (${this.lastError})` : ''}` };
    }
    const r = await this.request('tools/call', { name, arguments: callArgs }, timeoutMs, signal);
    // The call's budget is the platform's deadline, so running out of it means: post nothing.
    if (r.deadline) return { status: 'deadline' };
    if (r.error) return { status: 'error', message: r.error.message ?? 'the server returned an error' };
    const { result, truncated } = trimMcpResult(r.result);
    return { status: 'ok', result, truncated };
  }

  /** For `mcp_list`: refused while down, otherwise a fresh read. */
  async listTools(): Promise<McpCallOutcome> {
    if (this.state !== 'running' || !this.child) {
      return { status: 'refused', code: 'server_not_running', message: `${this.config.id} is not running` };
    }
    try {
      const tools = await this.refreshTools();
      return { status: 'ok', result: { tools }, truncated: false };
    } catch (e) {
      return { status: 'error', message: (e as Error).message };
    }
  }
}

/** All the configured servers, kept in step with the config. Emits `changed` when the offer moves. */
export class McpFleet extends EventEmitter {
  private servers = new Map<string, McpServer>();
  constructor(private readonly opts: McpServerOptions = {}) {
    super();
  }

  get(id: string): McpServer | undefined {
    return this.servers.get(id);
  }

  list(): McpServer[] {
    return [...this.servers.values()];
  }

  /** Stops servers that were removed or changed, starts new ones; resolves once each new one has had its first try. */
  async reconcile(configs: McpServerConfig[]): Promise<void> {
    const wanted = new Map(configs.map((c) => [c.id, c]));
    const stops: Promise<void>[] = [];
    for (const [id, srv] of this.servers) {
      const next = wanted.get(id);
      if (!next || JSON.stringify(next) !== JSON.stringify(srv.config)) {
        this.servers.delete(id);
        srv.removeAllListeners();
        stops.push(srv.stop());
      }
    }
    await Promise.all(stops);
    const starts: Promise<void>[] = [];
    for (const c of configs) {
      if (this.servers.has(c.id)) continue;
      const srv = new McpServer(c, this.opts);
      srv.on('tools', () => this.emit('changed'));
      this.servers.set(c.id, srv);
      starts.push(srv.start());
    }
    if (stops.length || starts.length) this.emit('changed');
    await Promise.all(starts);
  }

  /** What hello reports for servers: each configured server and the tools it last listed. */
  offer(): { id: string; tools: OfferedTool[] }[] {
    return [...this.servers.values()].map((s) => ({ id: s.config.id, tools: s.tools }));
  }

  async stopAll(): Promise<void> {
    const all = [...this.servers.values()];
    this.servers.clear();
    await Promise.all(all.map((s) => s.stop()));
  }
}
