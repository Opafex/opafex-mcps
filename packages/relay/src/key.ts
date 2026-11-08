import { readFileSync, statSync } from 'node:fs';
import type { RelayConfig } from './config.js';
import { RELAY_KEY_ENV } from './config.js';

export type KeySource = 'environment' | 'key file' | 'config file';

export type KeyVerdict =
  | { status: 'ok'; key: string; source: KeySource }
  | { status: 'missing'; message: string }
  | { status: 'invalid'; message: string };

const KEY_SHAPE = /^opr_[A-Za-z0-9_\-]{8,500}$/;

function check(value: string, source: KeySource): KeyVerdict {
  const key = value.trim();
  if (!KEY_SHAPE.test(key)) {
    // Never echo the value: a mistyped key is still most of a key.
    return { status: 'invalid', message: `The relay key from the ${source} is not a relay key (they start "opr_"). Make one in opafex Settings.` };
  }
  return { status: 'ok', key, source };
}

/** Where the key comes from, in order: OPAFEX_RELAY_KEY, then the config's keyFile, then a key written in the config. */
export function resolveKey(config: RelayConfig, env: NodeJS.ProcessEnv = process.env): KeyVerdict {
  const fromEnv = env[RELAY_KEY_ENV];
  if (fromEnv && fromEnv.trim()) return check(fromEnv, 'environment');
  if (config.keyFile) {
    let text: string;
    try {
      text = readFileSync(config.keyFile, 'utf8');
    } catch (e) {
      return { status: 'missing', message: `Could not read the key file ${config.keyFile}: ${(e as NodeJS.ErrnoException).code ?? 'error'}` };
    }
    return check(text, 'key file');
  }
  if (config.key) return check(config.key, 'config file');
  return {
    status: 'missing',
    message: `No relay key. Make one in opafex Settings, then set ${RELAY_KEY_ENV} or name a key file in the config ("keyFile").`,
  };
}

/** POSIX only: say so when a file holding the key, or the config, can be read by other users. */
export function permissionWarnings(configPath: string, config: RelayConfig, platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') return [];
  const out: string[] = [];
  const mode = (p: string): number | undefined => {
    try {
      return statSync(p).mode & 0o777;
    } catch {
      return undefined;
    }
  };
  const cm = mode(configPath);
  if (cm !== undefined) {
    if (config.key && cm & 0o044) {
      out.push(`${configPath} holds the relay key and other users can read it. Run: chmod 600 "${configPath}"`);
    } else if (cm & 0o004) {
      out.push(`${configPath} can be read by every user on this machine. Run: chmod 600 "${configPath}"`);
    }
  }
  if (config.keyFile) {
    const km = mode(config.keyFile);
    if (km !== undefined && km & 0o077) {
      out.push(`The key file ${config.keyFile} can be read by other users. Run: chmod 600 "${config.keyFile}"`);
    }
  }
  return out;
}
