import type { CommandConfig, RelayConfig } from './config.js';

export type RefusalCode = 'not_on_list' | 'param_mismatch' | 'server_not_running';

export type CommandPlan =
  | { status: 'ok'; command: CommandConfig; argv: string[] }
  | { status: 'refused'; code: RefusalCode; message: string };

/**
 * A value longer than this is refused before its pattern is tried, so a hostile request
 * cannot make a careless pattern backtrack for minutes.
 */
export const MAX_PARAM_LENGTH = 8192;

function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * The machine's answer to "may I run this?". Only THIS machine's config decides: the request
 * names a command id and parameter values, nothing more. The executable, the arguments and the
 * folder come from the config; each value fills exactly one argv element, never a shell line.
 */
export function planCommand(config: RelayConfig, request: unknown): CommandPlan {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { status: 'refused', code: 'not_on_list', message: 'the request names no command' };
  }
  const req = request as Record<string, unknown>;
  const id = req.id;
  if (typeof id !== 'string') {
    return { status: 'refused', code: 'not_on_list', message: 'the request names no command' };
  }
  const command = config.commands.find((c) => c.id === id);
  if (!command) {
    return { status: 'refused', code: 'not_on_list', message: `"${clip(id)}" is not on this machine's list` };
  }

  const rawParams = req.params === undefined || req.params === null ? {} : req.params;
  if (typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return { status: 'refused', code: 'param_mismatch', message: 'params must be an object' };
  }
  const params = rawParams as Record<string, unknown>;

  for (const name of Object.keys(params)) {
    if (!command.params.some((p) => p.name === name)) {
      return { status: 'refused', code: 'param_mismatch', message: `${command.id} does not take a param "${clip(name)}"` };
    }
  }

  const values = new Map<string, string>();
  for (const p of command.params) {
    if (!hasOwn(params, p.name)) {
      return { status: 'refused', code: 'param_mismatch', message: `${command.id} needs the param "${p.name}"` };
    }
    const v = params[p.name];
    if (typeof v !== 'string') {
      return { status: 'refused', code: 'param_mismatch', message: `param "${p.name}" must be a string` };
    }
    if (v.length > MAX_PARAM_LENGTH || v.includes('\0')) {
      return { status: 'refused', code: 'param_mismatch', message: `param "${p.name}" does not match its pattern` };
    }
    p.matcher.lastIndex = 0;
    if (!p.matcher.test(v)) {
      return { status: 'refused', code: 'param_mismatch', message: `param "${p.name}" does not match its pattern` };
    }
    values.set(p.name, v);
  }

  // One pass over the parsed template: a value that itself looks like "{other}" stays text.
  const argv = command.template.map((parts) =>
    parts.map((part) => (part.kind === 'text' ? part.text : (values.get(part.name) as string))).join(''),
  );
  return { status: 'ok', command, argv };
}

function clip(s: string): string {
  const flat = s.replace(/[\u0000-\u001f\u007f]/g, ' ');
  return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}
