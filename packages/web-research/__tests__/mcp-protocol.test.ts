/**
 * The tools through the real MCP protocol: a client and the server built by
 * @opafex/mcp-shared, linked in memory. No network — fetch is faked.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMCPServer } from '@opafex/mcp-shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WebResearchService } from '../src/web-research-service.js';
import { selectSearchProvider } from '../src/search-providers.js';
import { webResearchTools } from '../src/tools.js';
import { PACKAGE_NAME, VERSION, DEFAULT_USER_AGENT } from '../src/version.js';
import { fakeLookup, installFetch, htmlResponse, html } from './helpers.js';

let client: Client;

beforeEach(async () => {
  const service = new WebResearchService({
    lookup: fakeLookup({ 'example.com': ['93.184.216.34'] }),
    search: selectSearchProvider({}),
  });
  const server = buildMCPServer({ name: PACKAGE_NAME, version: VERSION, tools: webResearchTools(service) });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  vi.unstubAllGlobals();
});

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0].text;
}

describe('MCP protocol', () => {
  it('lists the five tools plus server_info', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['compare_pages', 'extract_structured_data', 'fetch_webpage', 'research_topic', 'server_info', 'web_search'].sort()
    );
  });

  it('server_info reports the package name and version', async () => {
    const result = await client.callTool({ name: 'server_info', arguments: {} });
    const info = JSON.parse(textOf(result));
    expect(info.name).toBe('@opafex/mcp-web-research');
    expect(info.version).toBe(VERSION);
  });

  it('web_search without a provider is a tool error naming the env var', async () => {
    const result = await client.callTool({ name: 'web_search', arguments: { query: 'x' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('BRAVE_SEARCH_API_KEY');
  });

  it('fetch_webpage works through the protocol', async () => {
    installFetch({ 'https://example.com/': () => htmlResponse(html('<p>Hello over MCP</p>', 'Hi')) });
    const result = await client.callTool({ name: 'fetch_webpage', arguments: { url: 'https://example.com/' } });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(textOf(result));
    expect(body.title).toBe('Hi');
    expect(body.text).toContain('Hello over MCP');
  });

  it('an SSRF refusal is a tool error, not a crash', async () => {
    const result = await client.callTool({
      name: 'fetch_webpage',
      arguments: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not allowed');
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    expect(VERSION).toBe(pkg.version);
    expect(PACKAGE_NAME).toBe(pkg.name);
    expect(DEFAULT_USER_AGENT).toBe(`opafex-mcp-web-research/${pkg.version} (+https://github.com/Opafex/opafex-mcps)`);
  });

  it('server.json agrees with package.json', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
    const server = JSON.parse(readFileSync(join(__dirname, '..', 'server.json'), 'utf-8'));
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].identifier).toBe(pkg.name);
    expect(server.packages[0].version).toBe(pkg.version);
  });
});
