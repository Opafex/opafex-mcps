import { RELAY_KEY_ENV } from './config.js';

/**
 * Names that look like a credential. The protocol names KEY, TOKEN, SECRET and PASSWORD; the
 * relay also drops PASSWD and CREDENTIAL, which mean the same thing. Matching is on the name,
 * case-insensitive (Windows treats `Path` and `PATH` as one variable).
 */
const SECRET_LOOKING = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;

/**
 * The environment a command or local server gets: the relay's own, minus anything that looks
 * like a secret unless the config entry lists it by name in `env`. The relay's own key is
 * removed always; config validation refuses an entry that tries to list it.
 */
export function scrubEnv(source: NodeJS.ProcessEnv, keep: readonly string[]): Record<string, string> {
  const keepUpper = new Set(keep.map((k) => k.toUpperCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (upper === RELAY_KEY_ENV) continue;
    if (SECRET_LOOKING.test(name) && !keepUpper.has(upper)) continue;
    out[name] = value;
  }
  return out;
}
