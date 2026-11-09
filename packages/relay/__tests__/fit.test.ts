import { describe, expect, it } from 'vitest';
import { fitHello, fitResult, HELLO_MAX_BYTES, jsonBytes, RESULT_MAX_BYTES } from '../src/fit.js';
import { buildHello } from '../src/hello.js';
import { LIMITS } from '../src/config.js';
import { config, NODE } from './helpers.js';

/** The biggest tool the relay will offer: a schema just under 16 KB, a 500-character description. */
function bigTool(i: number) {
  return { name: `tool_${i}`, description: 'd'.repeat(LIMITS.description), inputSchema: { type: 'object', description: 's'.repeat(LIMITS.schemaBytes - 60) } };
}

/** Commands as large as config validation allows (just under the 1 MB commands budget). */
function biggestCommands() {
  const commands = [];
  for (let i = 0; i < LIMITS.commands; i++) {
    commands.push({
      id: `c${i}`,
      description: 'x'.repeat(LIMITS.description),
      executable: NODE,
      args: ['{p0}'],
      params: Array.from({ length: 6 }, (_, j) => ({ name: `p${j}`, description: 'y'.repeat(500), pattern: `[a-z]{1,${'9'.repeat(3)}}`.padEnd(900, 'a') })),
    });
  }
  return commands;
}

describe('hello stays under the platform 2 MB', () => {
  it('a config whose commands alone would crowd out hello is refused', () => {
    const commands = biggestCommands().map((c) => ({ ...c, params: [...c.params, ...c.params.map((p) => ({ ...p, name: `${p.name}_b` }))] }));
    expect(() => config({ commands })).toThrow(/limit is 1024 KB/);
  });

  it('the maximum offer is trimmed to fit, fairly across servers', () => {
    const cfg = config({ commands: biggestCommands() });
    const servers = Array.from({ length: LIMITS.servers }, (_, s) => ({ id: `s${s}`, tools: Array.from({ length: LIMITS.toolsPerServer }, (_, i) => bigTool(i)) }));
    const raw = buildHello(cfg, servers);
    expect(jsonBytes(raw)).toBeGreaterThan(HELLO_MAX_BYTES); // ~67 MB untrimmed
    const { hello, dropped } = fitHello(raw);
    expect(jsonBytes(hello)).toBeLessThanOrEqual(HELLO_MAX_BYTES);
    expect(hello.commands).toHaveLength(LIMITS.commands);
    expect(dropped.length).toBeGreaterThan(0);
    const counts = hello.mcpServers.map((s) => s.tools.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });

  it('a hello that fits is sent unchanged', () => {
    const raw = buildHello(config({ commands: biggestCommands().slice(0, 2) }), [{ id: 's', tools: [bigTool(0)] }]);
    expect(fitHello(raw)).toEqual({ hello: raw, dropped: [] });
  });
});

describe('results stay under the platform 1 MB', () => {
  it('output that JSON-escapes six-fold is cut further and flagged', () => {
    const ctl = '\u0001'.repeat(256 * 1024);
    const raw = { status: 'ok', result: { exitCode: 0, stdout: ctl, stderr: ctl, truncated: false, durationMs: 1 } };
    expect(jsonBytes(raw)).toBeGreaterThan(RESULT_MAX_BYTES);
    const fitted = fitResult(raw);
    expect(jsonBytes(fitted)).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(fitted).toMatchObject({ status: 'ok', result: { exitCode: 0, truncated: true } });
  });

  it('an mcp_list answer is shortened from the end', () => {
    const raw = { status: 'ok', result: { tools: Array.from({ length: LIMITS.toolsPerServer }, (_, i) => bigTool(i)) } };
    const fitted = fitResult(raw) as any;
    expect(jsonBytes(fitted)).toBeLessThanOrEqual(RESULT_MAX_BYTES);
    expect(fitted.result.tools[0].name).toBe('tool_0');
    expect(fitted.result.tools.length).toBeLessThan(LIMITS.toolsPerServer);
  });

  it('a long refusal or error message is capped, and a small result is unchanged', () => {
    expect((fitResult({ status: 'error', error: { message: 'e'.repeat(10_000) } }) as any).error.message.length).toBeLessThanOrEqual(2001);
    const small = { status: 'ok', result: { exitCode: 0, stdout: 'hi', stderr: '', truncated: false, durationMs: 3 } };
    expect(fitResult(small)).toEqual(small);
  });
});
