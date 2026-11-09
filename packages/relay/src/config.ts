import { readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import path from 'node:path';
import { COMMANDS_HELLO_BUDGET, jsonBytes } from './fit.js';
import { stripJsonComments } from './jsonc.js';
import { checkBaseUrl } from './url.js';

/** Command, server and param ids, as the protocol defines them. */
export const ID_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The platform's limits, which the relay checks or trims to before it says hello. */
export const LIMITS = {
  commands: 100,
  servers: 20,
  toolsPerServer: 200,
  description: 500,
  schemaBytes: 16 * 1024,
} as const;

export const DEFAULT_PLATFORM_URL = 'https://app.opafex.com';
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 3600;
export const DEFAULT_MAX_CONCURRENT = 4;
export const MAX_PARAMS_PER_COMMAND = 20;

/** The relay's own credential. Never passed to anything it runs, whatever a config says. */
export const RELAY_KEY_ENV = 'OPAFEX_RELAY_KEY';

export type ArgPart = { kind: 'text'; text: string } | { kind: 'param'; name: string };

export interface ParamConfig {
  name: string;
  pattern: string;
  description?: string;
  /** `pattern` compiled to match the WHOLE value, whatever anchors it was written with. */
  matcher: RegExp;
}

export interface CommandConfig {
  id: string;
  description: string;
  executable: string;
  args: string[];
  /** `args` parsed once: each element is text and `{param}` placeholders, and stays ONE argv element. */
  template: ArgPart[][];
  cwd?: string;
  timeoutSeconds: number;
  params: ParamConfig[];
  /** Env names to pass through even though they look like secrets. */
  env: string[];
}

export interface McpServerConfig {
  id: string;
  description?: string;
  command: string;
  args: string[];
  cwd?: string;
  env: string[];
  /** When set, only these tools are offered and callable. */
  tools?: string[];
}

export interface RelayConfig {
  platformUrl: string;
  machineName: string;
  keyFile?: string;
  key?: string;
  maxConcurrent: number;
  commands: CommandConfig[];
  mcpServers: McpServerConfig[];
}

export class ConfigError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join('\n'));
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.OPAFEX_RELAY_CONFIG;
  if (fromEnv && fromEnv.trim()) return path.resolve(expandHome(fromEnv.trim()));
  return path.join(homedir(), '.opafex', 'relay.json');
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2));
  return p;
}

/** Wraps a pattern so it must match the whole value: `a|b` means exactly "a" or exactly "b". */
export function compileFullMatch(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`);
}

export function loadConfig(configPath: string): RelayConfig {
  let text: string;
  try {
    text = readFileSync(configPath, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new ConfigError([`No config file at ${configPath}. Run "opafex-relay init" to write an example.`]);
    }
    throw new ConfigError([`Could not read ${configPath}: ${(e as Error).message}`]);
  }
  return parseConfig(text, configPath);
}

export function parseConfig(text: string, configPath: string): RelayConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonComments(text));
  } catch (e) {
    throw new ConfigError([`${configPath} is not valid JSON: ${(e as Error).message}`]);
  }
  return validateConfig(raw, path.dirname(configPath));
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function unknownKeys(o: Obj, allowed: readonly string[], where: string, problems: string[]): void {
  for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) problems.push(`${where}: unknown setting "${k}" (allowed: ${allowed.join(', ')})`);
  }
}

function optString(o: Obj, key: string, where: string, problems: string[], max = 4096): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v.trim()) {
    problems.push(`${where}.${key} must be a non-empty string`);
    return undefined;
  }
  if (v.length > max) {
    problems.push(`${where}.${key} is ${v.length} characters; the limit is ${max}`);
    return undefined;
  }
  return v;
}

function reqString(o: Obj, key: string, where: string, problems: string[], max = 4096): string | undefined {
  if (o[key] === undefined) {
    problems.push(`${where}.${key} is required`);
    return undefined;
  }
  return optString(o, key, where, problems, max);
}

function stringArray(o: Obj, key: string, where: string, problems: string[]): string[] {
  const v = o[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) {
    problems.push(`${where}.${key} must be a list of strings`);
    return [];
  }
  return v as string[];
}

function envList(o: Obj, where: string, problems: string[]): string[] {
  const names = stringArray(o, 'env', where, problems);
  for (const n of names) {
    if (!ENV_NAME.test(n)) problems.push(`${where}.env: "${n}" is not an environment variable name`);
    if (n.toUpperCase() === RELAY_KEY_ENV) {
      problems.push(`${where}.env: ${RELAY_KEY_ENV} is the relay's own key and is never passed to anything it runs`);
    }
  }
  return names;
}

/**
 * An executable is an absolute path or a bare name found on PATH. A relative path with a
 * folder in it would depend on where the relay was started, so it is refused.
 */
function checkExecutable(value: string, where: string, problems: string[]): string {
  const p = expandHome(value);
  if (/[{}]/.test(p)) problems.push(`${where}: the executable is fixed; placeholders belong in "args"`);
  const hasSeparator = p.includes('/') || p.includes('\\');
  if (hasSeparator && !path.isAbsolute(p) && !path.win32.isAbsolute(p)) {
    problems.push(`${where}: "${value}" must be an absolute path or a bare name on PATH`);
  }
  return p;
}

function checkCwd(value: string | undefined, where: string, problems: string[]): string | undefined {
  if (value === undefined) return undefined;
  const p = expandHome(value);
  if (/[{}]/.test(p)) problems.push(`${where}.cwd is fixed; placeholders belong in "args"`);
  if (!path.isAbsolute(p) && !path.win32.isAbsolute(p)) {
    problems.push(`${where}.cwd must be an absolute path (or start with ~)`);
  }
  return p;
}

/** Splits one argument into text and `{param}` placeholders. `{{` and `}}` are literal braces. */
export function parseArgTemplate(arg: string, declared: Set<string>, where: string, problems: string[]): ArgPart[] {
  const parts: ArgPart[] = [];
  let buf = '';
  let i = 0;
  while (i < arg.length) {
    const c = arg[i];
    if (c === '{' && arg[i + 1] === '{') {
      buf += '{';
      i += 2;
      continue;
    }
    if (c === '}' && arg[i + 1] === '}') {
      buf += '}';
      i += 2;
      continue;
    }
    if (c === '{') {
      const close = arg.indexOf('}', i + 1);
      if (close !== -1) {
        const name = arg.slice(i + 1, close);
        if (ID_PATTERN.test(name)) {
          if (!declared.has(name)) {
            problems.push(`${where} uses {${name}}, which is not a declared param (write {{${name}}} for literal braces)`);
          }
          if (buf) parts.push({ kind: 'text', text: buf });
          buf = '';
          parts.push({ kind: 'param', name });
          i = close + 1;
          continue;
        }
      }
    }
    buf += c;
    i++;
  }
  if (buf || parts.length === 0) parts.push({ kind: 'text', text: buf });
  return parts;
}

function validateParams(o: Obj, where: string, problems: string[]): ParamConfig[] {
  const v = o.params;
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    problems.push(`${where}.params must be a list`);
    return [];
  }
  if (v.length > MAX_PARAMS_PER_COMMAND) problems.push(`${where}.params lists ${v.length}; the limit is ${MAX_PARAMS_PER_COMMAND}`);
  const out: ParamConfig[] = [];
  const seen = new Set<string>();
  v.forEach((p, i) => {
    const pw = `${where}.params[${i}]`;
    if (!isObj(p)) {
      problems.push(`${pw} must be an object`);
      return;
    }
    unknownKeys(p, ['name', 'pattern', 'description'], pw, problems);
    const name = reqString(p, 'name', pw, problems, 48);
    const pattern = reqString(p, 'pattern', pw, problems, 1000);
    const description = optString(p, 'description', pw, problems, LIMITS.description);
    if (name === undefined || pattern === undefined) return;
    if (!ID_PATTERN.test(name)) problems.push(`${pw}.name "${name}" must match ${ID_PATTERN.source}`);
    if (seen.has(name)) problems.push(`${pw}.name "${name}" is declared twice`);
    seen.add(name);
    let matcher: RegExp;
    try {
      matcher = compileFullMatch(pattern);
    } catch (e) {
      problems.push(`${pw}.pattern does not compile: ${(e as Error).message}`);
      return;
    }
    out.push({ name, pattern, matcher, ...(description ? { description } : {}) });
  });
  return out;
}

function validateCommand(c: unknown, i: number, problems: string[]): CommandConfig | undefined {
  const where = `commands[${i}]`;
  if (!isObj(c)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  unknownKeys(c, ['id', 'description', 'executable', 'args', 'cwd', 'timeoutSeconds', 'params', 'env'], where, problems);
  const id = reqString(c, 'id', where, problems, 48);
  const description = reqString(c, 'description', where, problems, LIMITS.description);
  const executable = reqString(c, 'executable', where, problems);
  const args = stringArray(c, 'args', where, problems);
  const cwd = checkCwd(optString(c, 'cwd', where, problems), where, problems);
  const env = envList(c, where, problems);
  const params = validateParams(c, where, problems);
  let timeoutSeconds = DEFAULT_TIMEOUT_SECONDS;
  if (c.timeoutSeconds !== undefined) {
    const t = c.timeoutSeconds;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 1 || t > MAX_TIMEOUT_SECONDS) {
      problems.push(`${where}.timeoutSeconds must be a whole number from 1 to ${MAX_TIMEOUT_SECONDS}`);
    } else {
      timeoutSeconds = t;
    }
  }
  if (id !== undefined && !ID_PATTERN.test(id)) problems.push(`${where}.id "${id}" must match ${ID_PATTERN.source}`);
  const declared = new Set(params.map((p) => p.name));
  const template = args.map((a, ai) => parseArgTemplate(a, declared, `${where}.args[${ai}]`, problems));
  if (id === undefined || description === undefined || executable === undefined) return undefined;
  return {
    id,
    description,
    executable: checkExecutable(executable, `${where}.executable`, problems),
    args,
    template,
    ...(cwd ? { cwd } : {}),
    timeoutSeconds,
    params,
    env,
  };
}

function validateServer(s: unknown, i: number, problems: string[]): McpServerConfig | undefined {
  const where = `mcpServers[${i}]`;
  if (!isObj(s)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  unknownKeys(s, ['id', 'description', 'command', 'args', 'cwd', 'env', 'tools'], where, problems);
  const id = reqString(s, 'id', where, problems, 48);
  const description = optString(s, 'description', where, problems, LIMITS.description);
  const command = reqString(s, 'command', where, problems);
  const args = stringArray(s, 'args', where, problems);
  const cwd = checkCwd(optString(s, 'cwd', where, problems), where, problems);
  const env = envList(s, where, problems);
  let tools: string[] | undefined;
  if (s.tools !== undefined) {
    tools = stringArray(s, 'tools', where, problems);
  }
  if (id !== undefined && !ID_PATTERN.test(id)) problems.push(`${where}.id "${id}" must match ${ID_PATTERN.source}`);
  if (id === undefined || command === undefined) return undefined;
  return {
    id,
    ...(description ? { description } : {}),
    command: checkExecutable(command, `${where}.command`, problems),
    args: args.map(expandHome),
    ...(cwd ? { cwd } : {}),
    env,
    ...(tools ? { tools } : {}),
  };
}

export function validateConfig(raw: unknown, configDir: string): RelayConfig {
  const problems: string[] = [];
  if (!isObj(raw)) throw new ConfigError(['The config file must hold one JSON object']);
  unknownKeys(raw, ['platformUrl', 'machineName', 'keyFile', 'key', 'maxConcurrent', 'commands', 'mcpServers'], 'config', problems);

  let platformUrl = DEFAULT_PLATFORM_URL;
  const urlRaw = optString(raw, 'platformUrl', 'config', problems);
  if (urlRaw !== undefined) {
    const verdict = checkBaseUrl(urlRaw);
    if (verdict.status === 'refused') problems.push(verdict.message);
    else platformUrl = verdict.url;
  }

  const machineName = optString(raw, 'machineName', 'config', problems, 100) ?? hostname();
  const keyFileRaw = optString(raw, 'keyFile', 'config', problems);
  const key = optString(raw, 'key', 'config', problems, 1000);
  if (keyFileRaw && key) problems.push('config: set "keyFile" or "key", not both');
  const keyFile = keyFileRaw ? path.resolve(configDir, expandHome(keyFileRaw)) : undefined;

  let maxConcurrent = DEFAULT_MAX_CONCURRENT;
  if (raw.maxConcurrent !== undefined) {
    const m = raw.maxConcurrent;
    if (typeof m !== 'number' || !Number.isInteger(m) || m < 1 || m > 16) {
      problems.push('config.maxConcurrent must be a whole number from 1 to 16');
    } else {
      maxConcurrent = m;
    }
  }

  const commands: CommandConfig[] = [];
  if (raw.commands !== undefined && !Array.isArray(raw.commands)) problems.push('config.commands must be a list');
  const rawCommands = Array.isArray(raw.commands) ? raw.commands : [];
  if (rawCommands.length > LIMITS.commands) {
    problems.push(`config.commands lists ${rawCommands.length}; the limit is ${LIMITS.commands}`);
  }
  rawCommands.forEach((c, i) => {
    const cmd = validateCommand(c, i, problems);
    if (!cmd) return;
    if (commands.some((x) => x.id === cmd.id)) problems.push(`commands[${i}].id "${cmd.id}" is used twice`);
    commands.push(cmd);
  });

  const mcpServers: McpServerConfig[] = [];
  if (raw.mcpServers !== undefined && !Array.isArray(raw.mcpServers)) problems.push('config.mcpServers must be a list');
  const rawServers = Array.isArray(raw.mcpServers) ? raw.mcpServers : [];
  if (rawServers.length > LIMITS.servers) {
    problems.push(`config.mcpServers lists ${rawServers.length}; the limit is ${LIMITS.servers}`);
  }
  rawServers.forEach((s, i) => {
    const srv = validateServer(s, i, problems);
    if (!srv) return;
    if (mcpServers.some((x) => x.id === srv.id)) problems.push(`mcpServers[${i}].id "${srv.id}" is used twice`);
    mcpServers.push(srv);
  });

  // What hello carries for the commands must leave room under the platform's 2 MB for MCP tools.
  const commandsBytes = jsonBytes(
    commands.map((c) => ({ id: c.id, description: c.description, params: c.params.map((p) => ({ name: p.name, description: p.description, pattern: p.pattern })) })),
  );
  if (commandsBytes > COMMANDS_HELLO_BUDGET) {
    problems.push(`the commands' descriptions and patterns come to ${Math.ceil(commandsBytes / 1024)} KB; the limit is ${COMMANDS_HELLO_BUDGET / 1024} KB`);
  }
  if (problems.length) throw new ConfigError(problems);
  return {
    platformUrl,
    machineName,
    ...(keyFile ? { keyFile } : {}),
    ...(key ? { key } : {}),
    maxConcurrent,
    commands,
    mcpServers,
  };
}

/** Flags that make the next argument program code. A placeholder there is a shell by another name. */
const CODE_FLAGS = new Set(['-c', '-e', '--eval', '-command', '-encodedcommand', '/c', '/k']);
const OPTION_PROBES = ['-', '-x', '--x', '--x=y'];

/** Things that are allowed but worth saying out loud. `check` prints them; `run` logs them once. */
export function configWarnings(config: RelayConfig): string[] {
  const out: string[] = [];
  if (config.key) {
    out.push('The relay key is written in the config file in plain text. A key file or the OPAFEX_RELAY_KEY environment variable is safer.');
  }
  for (const cmd of config.commands) {
    const used = new Set<string>();
    cmd.template.forEach((parts, i) => {
      for (const part of parts) {
        if (part.kind !== 'param') continue;
        used.add(part.name);
        const prev = i > 0 ? cmd.args[i - 1].toLowerCase() : '';
        if (CODE_FLAGS.has(prev)) {
          out.push(`${cmd.id}: {${part.name}} follows "${cmd.args[i - 1]}", so the value is run as code. Allow fixed scripts instead.`);
        }
      }
    });
    for (const p of cmd.params) {
      if (!used.has(p.name)) out.push(`${cmd.id}: param "${p.name}" is declared but not used in args`);
      const standalone = cmd.template.some((parts) => parts.length === 1 && parts[0].kind === 'param' && parts[0].name === p.name);
      if (standalone && OPTION_PROBES.some((v) => p.matcher.test(v))) {
        out.push(`${cmd.id}: the pattern for "${p.name}" allows values starting with "-", which a program may read as an option.`);
      }
    }
  }
  return out;
}
