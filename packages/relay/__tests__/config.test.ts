import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { configWarnings, parseConfig } from '../src/config.js';
import { EXAMPLE_CONFIG } from '../src/example-config.js';
import { stripJsonComments } from '../src/jsonc.js';
import { resolveKey } from '../src/key.js';
import { checkBaseUrl } from '../src/url.js';
import { RELAY_VERSION } from '../src/version.js';
import { config, NODE, tempDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const { dir, cleanup } = tempDir();
afterAll(cleanup);

describe('the config file', () => {
  it('allows comments outside strings only', () => {
    expect(JSON.parse(stripJsonComments('{ // c\n "a": "http://x//y", /* b */ "b": "/* not */" }'))).toEqual({ a: 'http://x//y', b: '/* not */' });
  });

  it('the example from init parses and enables nothing', () => {
    const c = parseConfig(EXAMPLE_CONFIG, path.join(dir, 'relay.json'));
    expect(c.commands).toEqual([]);
    expect(c.mcpServers).toEqual([]);
    expect(c.platformUrl).toBe('https://app.opafex.com');
  });

  it('the version constant matches package.json', () => {
    const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    expect(RELAY_VERSION).toBe(pkg.version);
  });
});

describe('platform URL', () => {
  it('https only, except this machine', () => {
    expect(checkBaseUrl('https://app.opafex.com/')).toEqual({ status: 'ok', url: 'https://app.opafex.com' });
    expect(checkBaseUrl('http://localhost:3002').status).toBe('ok');
    expect(checkBaseUrl('http://127.0.0.1:3002').status).toBe('ok');
    expect(checkBaseUrl('http://app.opafex.com').status).toBe('refused');
    expect(checkBaseUrl('http://localhost.evil.com').status).toBe('refused');
    expect(checkBaseUrl('ftp://app.opafex.com').status).toBe('refused');
    expect(checkBaseUrl('https://user:pw@app.opafex.com').status).toBe('refused');
  });
});

describe('warnings worth saying', () => {
  it('flags a param passed as code, and a pattern that allows options', () => {
    const c = config({
      key: 'opr_abcdefgh12345678',
      commands: [
        { id: 'py', description: 'x', executable: NODE, args: ['-e', '{code}'], params: [{ name: 'code', pattern: '.*' }] },
        { id: 'ls', description: 'x', executable: NODE, args: ['{dir}'], params: [{ name: 'dir', pattern: '[a-z-]+' }] },
      ],
    });
    const w = configWarnings(c).join('\n');
    expect(w).toMatch(/run as code/);
    expect(w).toMatch(/starting with "-"/);
    expect(w).toMatch(/plain text/);
  });
});

describe('the relay key', () => {
  const base = config({});
  it('comes from the environment first and is checked for shape', () => {
    expect(resolveKey(base, { OPAFEX_RELAY_KEY: 'opr_abcdefgh1234' })).toMatchObject({ status: 'ok', source: 'environment' });
    const bad = resolveKey(base, { OPAFEX_RELAY_KEY: 'sk_live_notarelaykey' });
    expect(bad.status).toBe('invalid');
    if (bad.status === 'invalid') expect(bad.message).not.toContain('sk_live');
    expect(resolveKey(base, {}).status).toBe('missing');
  });

  it('reads a key file', () => {
    const keyFile = path.join(dir, 'relay.key');
    writeFileSync(keyFile, 'opr_fromfile12345678\n');
    expect(resolveKey(config({ keyFile }), {})).toEqual({ status: 'ok', key: 'opr_fromfile12345678', source: 'key file' });
  });
});

describe('cli', () => {
  const run = async (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l), env: { ...process.env, ...env }, platform: process.platform });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('init writes the example once and never overwrites', async () => {
    const file = path.join(dir, 'cli', 'relay.json');
    expect((await run(['init', '--config', file])).code).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(EXAMPLE_CONFIG);
    const again = await run(['init', '--config', file]);
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/not overwriting/);
  });

  it('check validates, prints the offer, contacts nothing and never prints the key', async () => {
    const file = path.join(dir, 'check.json');
    writeFileSync(file, JSON.stringify({ platformUrl: 'https://app.opafex.com', commands: [{ id: 'v', description: 'node version', executable: NODE, args: ['--version'] }] }));
    const r = await run(['check', '--config', file], { OPAFEX_RELAY_KEY: 'opr_supersecret_value_1' });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/v: node version/);
    expect(r.out).toMatch(/Nothing was contacted and nothing was run/);
    expect(r.out + r.err).not.toContain('opr_supersecret_value_1');
  });

  it('check fails on an invalid config and names the problem', async () => {
    const file = path.join(dir, 'bad.json');
    writeFileSync(file, JSON.stringify({ platformUrl: 'http://example.com' }));
    const r = await run(['check', '--config', file]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/must use https/);
  });
});
