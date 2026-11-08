import { OUTPUT_CAP_BYTES } from './cap.js';
import { LIMITS } from './config.js';

export interface OfferedTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const TOOL_NAME = /^[A-Za-z0-9_.\-/]{1,128}$/;

function byteLength(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');
}

/**
 * A local server's tools as the platform will accept them: at most 200, descriptions cut to
 * 500 characters, a tool whose input schema is over 16 KB left out (a cut schema would describe
 * a different tool). `allow`, from the config, narrows the list further.
 */
export function trimTools(raw: unknown[], allow?: readonly string[]): { tools: OfferedTool[]; warnings: string[] } {
  const warnings: string[] = [];
  const tools: OfferedTool[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (typeof t !== 'object' || t === null) continue;
    const rec = t as Record<string, unknown>;
    const name = rec.name;
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) {
      warnings.push(`a tool with an unusable name was left out`);
      continue;
    }
    if (seen.has(name)) continue;
    if (allow && !allow.includes(name)) continue;
    const schema = rec.inputSchema;
    const inputSchema: Record<string, unknown> =
      typeof schema === 'object' && schema !== null && !Array.isArray(schema) ? (schema as Record<string, unknown>) : { type: 'object' };
    if (byteLength(inputSchema) > LIMITS.schemaBytes) {
      warnings.push(`tool "${name}" was left out: its input schema is over ${LIMITS.schemaBytes / 1024} KB`);
      continue;
    }
    if (tools.length >= LIMITS.toolsPerServer) {
      warnings.push(`only the first ${LIMITS.toolsPerServer} tools are offered`);
      break;
    }
    seen.add(name);
    const description = typeof rec.description === 'string' ? rec.description.slice(0, LIMITS.description) : undefined;
    tools.push({ name, ...(description ? { description } : {}), inputSchema });
  }
  return { tools, warnings };
}

const NOTICE = '[output cut by the opafex relay: the result was over 256 KB]';

/**
 * Trims a `tools/call` result to the cap. Text is cut from the end, other content (images,
 * embedded resources) is dropped once it no longer fits, and `structuredContent` goes first
 * because `content` carries the same answer as text. A note says it was cut.
 */
export function trimMcpResult(result: unknown, cap: number = OUTPUT_CAP_BYTES): { result: Record<string, unknown>; truncated: boolean } {
  const base: Record<string, unknown> =
    typeof result === 'object' && result !== null && !Array.isArray(result) ? { ...(result as Record<string, unknown>) } : { content: [] };
  if (byteLength(base) <= cap) return { result: base, truncated: false };

  delete base.structuredContent;
  delete base._meta;
  const content = Array.isArray(base.content) ? (base.content as unknown[]) : [];
  const kept: unknown[] = [];
  const notice = { type: 'text', text: NOTICE };
  let used = byteLength({ ...base, content: [notice] });
  for (const item of content) {
    const size = byteLength(item) + 1;
    if (used + size <= cap) {
      kept.push(item);
      used += size;
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (rec && rec.type === 'text' && typeof rec.text === 'string') {
      const room = cap - used - byteLength({ ...rec, text: '' }) - 16;
      if (room > 0) {
        let text = rec.text.slice(0, room);
        while (text && byteLength({ ...rec, text }) + used > cap - 8) text = text.slice(0, Math.floor(text.length * 0.9));
        if (text) kept.push({ ...rec, text });
      }
    }
    break;
  }
  kept.push(notice);
  return { result: { ...base, content: kept }, truncated: true };
}
