import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError, configWarnings, defaultConfigPath, loadConfig, type RelayConfig } from './config.js';
import { EXAMPLE_CONFIG } from './example-config.js';
import { resolveExecutable } from './executable.js';
import { permissionWarnings, resolveKey } from './key.js';
import { Relay, type RelayExit } from './relay.js';
import { RELAY_VERSION } from './version.js';

const HELP = `opafex-relay ${RELAY_VERSION}

Lets a hosted opafex agent use the commands and local MCP servers you allow on this machine.
Outbound only (no ports opened), never a shell, nothing that is not on your list.

Usage:
  opafex-relay init    [--config <file>]   write an example config (nothing enabled)
  opafex-relay check   [--config <file>]   validate the config and show what would be offered
  opafex-relay run     [--config <file>]   connect and serve requests until stopped (Ctrl+C)
  opafex-relay --version | --help

The config file defaults to ~/.opafex/relay.json (or OPAFEX_RELAY_CONFIG).
The relay key comes from OPAFEX_RELAY_KEY, or the file named by "keyFile" in the config.
`;

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
}

const defaultIo: CliIo = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  env: process.env,
  platform: process.platform,
};

function parseArgs(argv: string[]): { command?: string; config?: string; error?: string } {
  let command: string | undefined;
  let config: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config' || a === '-c') {
      const v = argv[++i];
      if (!v) return { error: '--config needs a file path' };
      config = v;
    } else if (a.startsWith('--config=')) {
      config = a.slice('--config='.length);
    } else if (a === '--help' || a === '-h') {
      command = 'help';
    } else if (a === '--version' || a === '-v') {
      command = 'version';
    } else if (!a.startsWith('-') && !command) {
      command = a;
    } else {
      return { error: `unknown option "${a}"` };
    }
  }
  return { command, config };
}

function stopMessage(exit: RelayExit): string {
  switch (exit.reason) {
    case 'stopped':
      return 'Relay stopped.';
    case 'unauthorized':
      return 'The platform did not accept the relay key: it has been revoked or never existed. Make a new key in opafex Settings and start the relay again.';
    case 'not_entitled':
      return "This opafex account's plan does not include the relay, so the platform refused it. Nothing was run.";
    case 'forbidden':
      return `The platform refused the relay (HTTP 403: ${exit.message}). Nothing was run.`;
    case 'hello_loop':
      return 'The platform asked this machine to say hello again twice within a minute, so the relay stopped rather than loop. Check the machine in opafex Settings, then start the relay again.';
    case 'refused':
      return `The platform refused the relay's request (HTTP ${exit.httpStatus ?? '?'}: ${exit.message}). This relay is version ${RELAY_VERSION}; an update may be needed.`;
  }
}

function load(configPath: string, io: CliIo): RelayConfig | undefined {
  try {
    return loadConfig(configPath);
  } catch (e) {
    if (e instanceof ConfigError && e.problems.length === 1) {
      io.err(e.problems[0]);
    } else if (e instanceof ConfigError) {
      io.err(`The config at ${configPath} has problems:`);
      for (const p of e.problems) io.err(`  - ${p}`);
    } else {
      io.err((e as Error).message);
    }
    return undefined;
  }
}

function init(configPath: string, io: CliIo): number {
  if (existsSync(configPath)) {
    io.err(`${configPath} already exists; not overwriting it.`);
    return 1;
  }
  mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, EXAMPLE_CONFIG, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  io.out(`Wrote ${configPath}`);
  io.out('Nothing is enabled yet. Edit it to allow commands or MCP servers, then run "opafex-relay check".');
  return 0;
}

function check(configPath: string, io: CliIo): number {
  const config = load(configPath, io);
  if (!config) return 1;
  io.out(`Config: ${configPath} (valid)`);
  io.out(`Platform: ${config.platformUrl}`);
  io.out(`Machine name: ${config.machineName}`);
  const key = resolveKey(config, io.env);
  io.out(key.status === 'ok' ? `Relay key: found in the ${key.source} (not shown)` : `Relay key: ${key.message}`);

  const problems: string[] = [];
  io.out('');
  io.out(config.commands.length ? `Commands (${config.commands.length}):` : 'Commands: none');
  for (const c of config.commands) {
    const exe = resolveExecutable(c.executable, { platform: io.platform, env: io.env });
    io.out(`  ${c.id}: ${c.description}`);
    if (exe.status === 'ok') {
      io.out(`    runs ${exe.file} ${c.args.map((a) => JSON.stringify(a)).join(' ')}`.trimEnd());
    } else {
      io.out(`    CANNOT RUN: ${exe.message}`);
      problems.push(`${c.id}: ${exe.message}`);
    }
    io.out(`    ${c.cwd ? `in ${c.cwd}, ` : ''}stopped after ${c.timeoutSeconds}s`);
    if (c.cwd && !existsSync(c.cwd)) problems.push(`${c.id}: the folder ${c.cwd} does not exist`);
    for (const p of c.params) io.out(`    param ${p.name}: whole value must match /${p.pattern}/`);
    if (c.env.length) io.out(`    also passes: ${c.env.join(', ')}`);
  }
  io.out('');
  io.out(config.mcpServers.length ? `MCP servers (${config.mcpServers.length}):` : 'MCP servers: none');
  for (const s of config.mcpServers) {
    const exe = resolveExecutable(s.command, { platform: io.platform, env: io.env });
    io.out(`  ${s.id}${s.description ? `: ${s.description}` : ''}`);
    if (exe.status === 'ok') io.out(`    starts ${exe.file} ${s.args.map((a) => JSON.stringify(a)).join(' ')}`.trimEnd());
    else {
      io.out(`    CANNOT START: ${exe.message}`);
      problems.push(`${s.id}: ${exe.message}`);
    }
    io.out(s.tools ? `    offers only: ${s.tools.join(', ')}` : '    offers every tool it lists (its tools are read when "run" starts it)');
  }

  const warnings = [...configWarnings(config), ...permissionWarnings(configPath, config, io.platform), ...problems];
  if (warnings.length) {
    io.out('');
    io.out('Warnings:');
    for (const w of warnings) io.out(`  - ${w}`);
  }
  io.out('');
  io.out('Nothing was contacted and nothing was run.');
  return 0;
}

async function run(configPath: string, io: CliIo): Promise<number> {
  const config = load(configPath, io);
  if (!config) return 1;
  const key = resolveKey(config, io.env);
  if (key.status !== 'ok') {
    io.err(key.message);
    return 1;
  }
  for (const w of permissionWarnings(configPath, config, io.platform)) io.err(`warning: ${w}`);
  const relay = new Relay({ configPath, key: key.key, config, log: io.out, env: io.env, platform: io.platform });
  const onSignal = () => {
    io.out('Stopping…');
    relay.stop();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  io.out(`opafex relay ${RELAY_VERSION} starting (${config.commands.length} command(s), ${config.mcpServers.length} MCP server(s))`);
  try {
    const exit = await relay.run();
    const msg = stopMessage(exit);
    if (exit.reason === 'stopped') {
      io.out(msg);
      return 0;
    }
    io.err(msg);
    return 2;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

export async function main(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    io.err(parsed.error);
    io.err(HELP);
    return 1;
  }
  const configPath = parsed.config ? path.resolve(parsed.config) : defaultConfigPath(io.env);
  switch (parsed.command) {
    case 'init':
      return init(configPath, io);
    case 'check':
      return check(configPath, io);
    case 'run':
      return run(configPath, io);
    case 'version':
      io.out(RELAY_VERSION);
      return 0;
    case 'help':
    case undefined:
      io.out(HELP);
      return 0;
    default:
      io.err(`unknown command "${parsed.command}"`);
      io.err(HELP);
      return 1;
  }
}
