import { unwatchFile, watchFile, type Stats } from 'node:fs';
import { planCommand, type RefusalCode } from './allowlist.js';
import { ConfigError, configWarnings, loadConfig, type RelayConfig } from './config.js';
import { scrubEnv } from './env.js';
import { resolveExecutable } from './executable.js';
import { fitHello, fitResult } from './fit.js';
import { buildHello } from './hello.js';
import { McpFleet } from './mcp.js';
import { PlatformClient, type StopReason } from './platform-client.js';
import { runCommand } from './run-command.js';

/** Request ids go into a URL path; anything else is ignored. */
const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The platform's own default, used when a request carries no readable deadline. */
const DEFAULT_DEADLINE_MS = 60_000;
/** No request is given longer than this, whatever deadline it claims. */
const MAX_DEADLINE_MS = 15 * 60_000;
const MAX_POLL_WAIT_SECONDS = 25;
/** A poll that comes back empty faster than this is followed by a pause, so a platform that does not hold the poll is not hammered. */
const MIN_EMPTY_POLL_MS = 1000;
/** The platform may ask for hello again (409 hello_required) once in this window; twice means something is broken. */
const REHELLO_WINDOW_MS = 60_000;

export type ResultBody =
  | { status: 'ok'; result: Record<string, unknown> }
  | { status: 'refused'; refusal: { code: RefusalCode; message: string } }
  | { status: 'error'; error: { message: string } };

export type RelayExit =
  | { reason: 'stopped' }
  | { reason: StopReason; message: string; httpStatus?: number };

export interface RelayOptions {
  configPath: string;
  key: string;
  /** Already loaded and validated by the caller; read from `configPath` when omitted. */
  config?: RelayConfig;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  watchIntervalMs?: number;
  mcpRestartBaseMs?: number;
  minEmptyPollMs?: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function refused(code: RefusalCode, message: string): ResultBody {
  return { status: 'refused', refusal: { code, message } };
}

/**
 * The running relay: says hello, long-polls for work, judges each request against THIS
 * machine's config, runs it with no shell, and posts the result. Outbound only.
 */
export class Relay {
  private config: RelayConfig;
  private readonly configPath: string;
  private readonly client: PlatformClient;
  private readonly fleet: McpFleet;
  private readonly log: (line: string) => void;
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly watchIntervalMs: number;
  private readonly minEmptyPollMs: number;
  private readonly stopCtl = new AbortController();
  private readonly inflight = new Set<Promise<void>>();
  private exit?: RelayExit;
  private pollWaitSeconds = MAX_POLL_WAIT_SECONDS;
  private skewMs = 0;
  private helloDirty = true;
  private helloLoop?: Promise<void>;
  private lastHello = '';
  private reloadChain: Promise<void> = Promise.resolve();
  private lastRehelloAt?: number;
  private lastDropped = '';
  /** Counts accepted hellos; tests read it. */
  hellosSent = 0;

  constructor(opts: RelayOptions) {
    this.configPath = opts.configPath;
    this.config = opts.config ?? loadConfig(opts.configPath);
    this.log = opts.log ?? ((line) => console.log(line));
    this.env = opts.env ?? process.env;
    this.platform = opts.platform ?? process.platform;
    this.backoffBaseMs = opts.backoffBaseMs ?? 1000;
    this.backoffCapMs = opts.backoffCapMs ?? 60_000;
    this.watchIntervalMs = opts.watchIntervalMs ?? 2000;
    this.minEmptyPollMs = opts.minEmptyPollMs ?? MIN_EMPTY_POLL_MS;
    this.client = new PlatformClient({ baseUrl: this.config.platformUrl, key: opts.key, fetchImpl: opts.fetchImpl });
    this.fleet = new McpFleet({
      env: this.env,
      platform: this.platform,
      log: this.log,
      ...(opts.mcpRestartBaseMs !== undefined ? { restartBaseMs: opts.mcpRestartBaseMs } : {}),
    });
  }

  /** Runs until stopped or until the platform says stop. Resolves with why. */
  async run(): Promise<RelayExit> {
    for (const w of configWarnings(this.config)) this.log(`warning: ${w}`);
    // Servers get their first try before the first hello, so it carries their tools.
    await this.fleet.reconcile(this.config.mcpServers);
    this.fleet.on('changed', () => this.markHelloDirty());
    watchFile(this.configPath, { interval: this.watchIntervalMs, persistent: true }, this.onConfigFile);
    try {
      this.markHelloDirty();
      await this.helloLoop;
      if (!this.exit) {
        this.log(`connected to ${this.config.platformUrl} as "${this.config.machineName}": ${this.config.commands.length} command(s), ${this.fleet.list().length} MCP server(s)`);
        await this.pollLoop();
      }
    } finally {
      unwatchFile(this.configPath, this.onConfigFile);
      this.stopCtl.abort();
      await Promise.allSettled([...this.inflight]);
      await this.fleet.stopAll();
    }
    return this.exit ?? { reason: 'stopped' };
  }

  stop(): void {
    this.finish({ reason: 'stopped' });
  }

  private finish(exit: RelayExit): void {
    if (this.exit) return;
    this.exit = exit;
    this.stopCtl.abort();
  }

  private backoff(attempt: number): number {
    return Math.min(this.backoffCapMs, this.backoffBaseMs * 2 ** attempt);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.stopCtl.signal.aborted) return resolve();
      const t = setTimeout(done, ms);
      const signal = this.stopCtl.signal;
      function done() {
        clearTimeout(t);
        signal.removeEventListener('abort', done);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
  }

  // ── hello ──────────────────────────────────────────────────────────────────

  private markHelloDirty(): void {
    this.helloDirty = true;
    if (!this.helloLoop) {
      this.helloLoop = this.flushHello().finally(() => {
        this.helloLoop = undefined;
      });
    }
  }

  private async flushHello(): Promise<void> {
    let attempt = 0;
    while (this.helloDirty && !this.exit) {
      this.helloDirty = false;
      const fitted = fitHello(buildHello(this.config, this.fleet.offer(), this.platform));
      const payload = fitted.hello;
      const droppedKey = fitted.dropped.join(',');
      if (fitted.dropped.length && droppedKey !== this.lastDropped) {
        this.log(`hello would be over the platform's 2 MB, so ${fitted.dropped.length} MCP tool(s) were left out: ${fitted.dropped.slice(0, 10).join(', ')}${fitted.dropped.length > 10 ? ', …' : ''}`);
      }
      this.lastDropped = droppedKey;
      const json = JSON.stringify(payload);
      if (json === this.lastHello) continue;
      for (;;) {
        const out = await this.client.hello<{ relayId?: unknown; pollWaitSeconds?: unknown }>(payload);
        if (this.exit) return;
        if (out.status === 'stop') {
          this.finish({ reason: out.reason, message: out.message, httpStatus: out.httpStatus });
          return;
        }
        if (out.status === 'retry') {
          const wait = this.backoff(attempt++);
          this.log(`hello not sent (${out.message}); trying again in ${Math.round(wait / 1000)}s`);
          await this.sleep(wait);
          if (this.exit) return;
          if (this.helloDirty) break; // the offer moved meanwhile: rebuild it
          continue;
        }
        attempt = 0;
        this.lastHello = json;
        this.hellosSent++;
        const wait = out.body && typeof out.body.pollWaitSeconds === 'number' ? out.body.pollWaitSeconds : MAX_POLL_WAIT_SECONDS;
        this.pollWaitSeconds = Math.max(1, Math.min(MAX_POLL_WAIT_SECONDS, Math.floor(wait)));
        if (this.hellosSent > 1) this.log('offer updated');
        break;
      }
    }
  }

  // ── config changes ─────────────────────────────────────────────────────────

  private readonly onConfigFile = (curr: Stats, prev: Stats): void => {
    if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return;
    this.reloadChain = this.reloadChain.then(() => this.reload()).catch(() => {});
  };

  private async reload(): Promise<void> {
    if (this.exit) return;
    let next: RelayConfig;
    try {
      next = loadConfig(this.configPath);
    } catch (e) {
      const problems = e instanceof ConfigError ? e.problems : [(e as Error).message];
      this.log(`config changed but was not loaded; keeping the previous one:\n  ${problems.join('\n  ')}`);
      return;
    }
    if (next.platformUrl !== this.config.platformUrl) {
      this.log('platformUrl changed; restart the relay to use it');
      next = { ...next, platformUrl: this.config.platformUrl };
    }
    if (next.keyFile !== this.config.keyFile || next.key !== this.config.key) {
      this.log('the key setting changed; restart the relay to use it');
    }
    this.config = next;
    this.log(`config reloaded: ${next.commands.length} command(s), ${next.mcpServers.length} MCP server(s)`);
    for (const w of configWarnings(next)) this.log(`warning: ${w}`);
    await this.fleet.reconcile(next.mcpServers);
    this.markHelloDirty();
  }

  // ── polling ────────────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    let attempt = 0;
    while (!this.exit) {
      while (this.inflight.size >= this.config.maxConcurrent && !this.exit) {
        await Promise.race([...this.inflight]);
      }
      if (this.exit) return;
      const started = Date.now();
      const out = await this.client.next<{ request?: unknown }>(this.pollWaitSeconds, this.stopCtl.signal);
      if (this.exit) return;
      if (out.status === 'stop' && out.httpStatus === 409 && out.code === 'hello_required') {
        // The platform has no current offer from this machine (a reset row, or a poll that beat
        // the hello). Say hello again and carry on, but only once a minute: a platform that keeps
        // asking would otherwise spin the relay.
        const now = Date.now();
        if (this.lastRehelloAt !== undefined && now - this.lastRehelloAt < REHELLO_WINDOW_MS) {
          this.finish({ reason: 'hello_loop', message: out.message, httpStatus: 409 });
          return;
        }
        this.lastRehelloAt = now;
        this.log("the platform asked for this machine's offer again; sending hello");
        this.lastHello = '';
        this.markHelloDirty();
        await this.helloLoop;
        continue;
      }
      if (out.status === 'stop') {
        this.finish({ reason: out.reason, message: out.message, httpStatus: out.httpStatus });
        return;
      }
      if (out.status === 'retry') {
        const wait = this.backoff(attempt++);
        this.log(`poll failed (${out.message}); trying again in ${Math.round(wait / 1000)}s`);
        await this.sleep(wait);
        continue;
      }
      attempt = 0;
      if (out.serverDate !== undefined) {
        const skew = out.serverDate - Date.now();
        this.skewMs = Math.abs(skew) > 2000 ? skew : 0;
      }
      const request = out.body && isObj(out.body) ? out.body.request : undefined;
      if (out.httpStatus === 204 || request === undefined) {
        const took = Date.now() - started;
        if (took < this.minEmptyPollMs) await this.sleep(this.minEmptyPollMs - took);
        continue;
      }
      const task = this.handle(request).catch((e) => this.log(`request failed inside the relay: ${(e as Error).message}`));
      this.inflight.add(task);
      void task.finally(() => this.inflight.delete(task));
    }
  }

  /** The platform's deadline in this machine's clock. */
  private deadlineOf(raw: unknown): number {
    const now = Date.now();
    const parsed = typeof raw === 'string' ? Date.parse(raw) : NaN;
    const local = Number.isFinite(parsed) ? parsed - this.skewMs : now + DEFAULT_DEADLINE_MS;
    return Math.min(local, now + MAX_DEADLINE_MS);
  }

  /** Exported through the class for tests: judge and run one request, then post its result. */
  async handle(raw: unknown): Promise<void> {
    if (!isObj(raw) || typeof raw.id !== 'string' || !REQUEST_ID.test(raw.id)) {
      this.log('ignored a request without a usable id');
      return;
    }
    const id = raw.id;
    const deadline = this.deadlineOf(raw.deadline);
    if (deadline <= Date.now()) {
      this.log(`request ${id.slice(0, 8)}: its deadline had passed; nothing run`);
      return;
    }
    let body: ResultBody | null;
    if (raw.kind === 'command') body = await this.commandRequest(raw.command, deadline);
    else if (raw.kind === 'mcp_call') body = await this.mcpCall(raw.mcp, deadline);
    else if (raw.kind === 'mcp_list') body = await this.mcpList(raw.mcp ?? raw);
    else body = refused('not_on_list', 'the relay does not know this kind of request');
    if (!body || this.stopCtl.signal.aborted) return;
    await this.post(id, body, deadline);
  }

  private async commandRequest(cmd: unknown, deadline: number): Promise<ResultBody | null> {
    const plan = planCommand(this.config, cmd);
    const label = isObj(cmd) && typeof cmd.id === 'string' ? cmd.id.slice(0, 48) : '?';
    if (plan.status === 'refused') {
      this.log(`refused command ${label}: ${plan.message}`);
      return refused(plan.code, plan.message);
    }
    const exe = resolveExecutable(plan.command.executable, { platform: this.platform, env: this.env });
    if (exe.status === 'refused') {
      this.log(`command ${label}: ${exe.message}`);
      return { status: 'error', error: { message: exe.message } };
    }
    const entryMs = plan.command.timeoutSeconds * 1000;
    const remaining = deadline - Date.now();
    const deadlineFirst = remaining <= entryMs;
    const outcome = await runCommand({
      file: exe.file,
      argv: plan.argv,
      ...(plan.command.cwd ? { cwd: plan.command.cwd } : {}),
      env: scrubEnv(this.env, plan.command.env),
      timeoutMs: Math.min(entryMs, remaining),
      signal: this.stopCtl.signal,
      platform: this.platform,
    });
    switch (outcome.status) {
      case 'ok':
        this.log(`command ${label}: exit ${outcome.exitCode} in ${outcome.durationMs} ms${outcome.truncated ? ' (output cut at 256 KB)' : ''}`);
        return {
          status: 'ok',
          result: {
            exitCode: outcome.exitCode,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
            truncated: outcome.truncated,
            durationMs: outcome.durationMs,
          },
        };
      case 'timed_out':
        if (deadlineFirst) {
          this.log(`command ${label}: still running at the platform's deadline; stopped, nothing posted`);
          return null;
        }
        this.log(`command ${label}: timed out after ${plan.command.timeoutSeconds}s and was stopped`);
        return { status: 'error', error: { message: `timed out after ${plan.command.timeoutSeconds}s and was stopped` } };
      case 'aborted':
        return null;
      case 'spawn_failed':
        this.log(`command ${label}: could not start (${outcome.message})`);
        return { status: 'error', error: { message: `could not start: ${outcome.message}` } };
    }
  }

  private serverFor(mcp: unknown): { status: 'ok'; id: string } | { status: 'refused'; body: ResultBody } {
    if (!isObj(mcp) || typeof mcp.serverId !== 'string') {
      return { status: 'refused', body: refused('not_on_list', 'the request names no MCP server') };
    }
    if (!this.config.mcpServers.some((s) => s.id === mcp.serverId) || !this.fleet.get(mcp.serverId)) {
      return { status: 'refused', body: refused('not_on_list', `"${mcp.serverId.slice(0, 48)}" is not an MCP server on this machine's list`) };
    }
    return { status: 'ok', id: mcp.serverId };
  }

  private async mcpCall(mcp: unknown, deadline: number): Promise<ResultBody | null> {
    const which = this.serverFor(mcp);
    if (which.status === 'refused') return which.body;
    const m = mcp as Record<string, unknown>;
    const server = this.fleet.get(which.id)!;
    const outcome = await server.callTool(m.tool, m.arguments, deadline - Date.now(), this.stopCtl.signal);
    const label = `${which.id}.${typeof m.tool === 'string' ? m.tool.slice(0, 64) : '?'}`;
    switch (outcome.status) {
      case 'ok':
        this.log(`mcp ${label}: done${outcome.truncated ? ' (result cut at 256 KB)' : ''}`);
        return { status: 'ok', result: outcome.result };
      case 'refused':
        this.log(`refused mcp ${label}: ${outcome.message}`);
        return refused(outcome.code, outcome.message);
      case 'error':
        this.log(`mcp ${label}: ${outcome.message}`);
        return { status: 'error', error: { message: outcome.message } };
      case 'deadline':
        this.log(`mcp ${label}: still running at the platform's deadline; cancelled, nothing posted`);
        return null;
    }
  }

  private async mcpList(mcp: unknown): Promise<ResultBody | null> {
    const which = this.serverFor(mcp);
    if (which.status === 'refused') return which.body;
    const outcome = await this.fleet.get(which.id)!.listTools();
    if (outcome.status === 'ok') return { status: 'ok', result: outcome.result };
    if (outcome.status === 'refused') return refused(outcome.code, outcome.message);
    if (outcome.status === 'error') return { status: 'error', error: { message: outcome.message } };
    return null;
  }

  private async post(id: string, unfitted: ResultBody, deadline: number): Promise<void> {
    const body = fitResult(unfitted);
    let attempt = 0;
    for (;;) {
      const out = await this.client.postResult(id, body);
      switch (out.status) {
        case 'stored':
          return;
        case 'settled':
          this.log(`request ${id.slice(0, 8)}: already settled on the platform`);
          return;
        case 'expired':
          this.log(`request ${id.slice(0, 8)}: expired on the platform before the result arrived`);
          return;
        case 'not_ours':
          this.log(`request ${id.slice(0, 8)}: the platform says another relay holds it`);
          return;
        case 'rejected':
          this.log(`request ${id.slice(0, 8)}: the platform would not take the result (${out.message})`);
          return;
        case 'stop':
          this.finish({ reason: out.reason, message: out.message });
          return;
        case 'retry': {
          const wait = this.backoff(attempt++);
          if (this.exit || Date.now() + wait > deadline) {
            this.log(`request ${id.slice(0, 8)}: result not delivered (${out.message})`);
            return;
          }
          await this.sleep(wait);
        }
      }
    }
  }
}
