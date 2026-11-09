import type { HelloPayload } from './hello.js';

/** The platform answers 413 above these. The relay stays a margin under them. */
export const HELLO_MAX_BYTES = 2 * 1024 * 1024;
export const RESULT_MAX_BYTES = 1024 * 1024;
const MARGIN = 16 * 1024;
/** The commands' part of hello may use at most this; config validation enforces it. */
export const COMMANDS_HELLO_BUDGET = 1024 * 1024;
const MAX_MESSAGE_CHARS = 2000;

export function jsonBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
}

/**
 * Fits hello under the platform's limit. Commands are kept whole (their size is bounded by
 * config validation); MCP tools are added round-robin across servers while they fit, so one
 * large server cannot crowd out the rest. Returns the names left out.
 */
export function fitHello(hello: HelloPayload, max: number = HELLO_MAX_BYTES - MARGIN): { hello: HelloPayload; dropped: string[] } {
  if (jsonBytes(hello) <= max) return { hello, dropped: [] };
  const servers = hello.mcpServers.map((s) => ({ id: s.id, tools: [] as typeof s.tools }));
  let size = jsonBytes({ ...hello, mcpServers: servers });
  const dropped: string[] = [];
  const longest = Math.max(0, ...hello.mcpServers.map((s) => s.tools.length));
  for (let i = 0; i < longest; i++) {
    hello.mcpServers.forEach((s, si) => {
      const tool = s.tools[i];
      if (!tool) return;
      const add = jsonBytes(tool) + 1;
      if (size + add <= max) {
        servers[si].tools.push(tool);
        size += add;
      } else {
        dropped.push(`${s.id}.${tool.name}`);
      }
    });
  }
  return { hello: { ...hello, mcpServers: servers }, dropped };
}

function cutChars(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = Buffer.from(s, 'utf8').subarray(0, Math.max(0, maxBytes)).toString('utf8');
  if (out.endsWith('�')) out = out.slice(0, -1);
  return out;
}

type Body = { status: string; [k: string]: unknown };

/**
 * Fits a result body under the platform's 1 MB. The 256 KB caps are on raw bytes, and JSON can
 * escape a control character into six, so output is cut further when it must be (flagged
 * `truncated`). A tool list is shortened from the end. Messages are capped.
 */
export function fitResult(body: Body, max: number = RESULT_MAX_BYTES - MARGIN): Body {
  const out: Body = JSON.parse(JSON.stringify(body));
  for (const k of ['refusal', 'error'] as const) {
    const m = out[k] as { message?: unknown } | undefined;
    if (m && typeof m.message === 'string' && m.message.length > MAX_MESSAGE_CHARS) m.message = `${m.message.slice(0, MAX_MESSAGE_CHARS)}…`;
  }
  if (jsonBytes(out) <= max) return out;
  const result = out.result as Record<string, unknown> | undefined;
  if (result && typeof result.stdout === 'string' && typeof result.stderr === 'string') {
    while (jsonBytes(out) > max) {
      const key = jsonBytes(result.stdout) >= jsonBytes(result.stderr) ? 'stdout' : 'stderr';
      const s = result[key] as string;
      if (!s) break;
      result[key] = cutChars(s, Math.floor(Buffer.byteLength(s, 'utf8') * 0.75));
      result.truncated = true;
    }
  } else if (result && Array.isArray(result.tools)) {
    while (jsonBytes(out) > max && result.tools.length) result.tools.pop();
  }
  if (jsonBytes(out) <= max) return out;
  return { status: 'error', error: { message: 'the result was too large to send' } };
}
