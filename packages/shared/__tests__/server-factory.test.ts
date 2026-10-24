import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildMCPServer, SilentLogger, type ToolContext } from '../src/index.js';

async function connect(withElicitation: boolean) {
  const seen: ToolContext[] = [];
  const server = buildMCPServer({
    name: 'test',
    version: '1.2.3',
    logger: new SilentLogger(),
    tools: [
      {
        name: 'echo',
        description: 'Echo the input',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
        handler: async (args, context) => {
          seen.push(context);
          return { text: args.text };
        },
      },
      {
        name: 'boom',
        description: 'Always fails',
        inputSchema: { type: 'object', properties: {} },
        handler: async () => {
          throw new Error('kaboom');
        },
      },
      {
        name: 'ask',
        description: 'Asks the user',
        inputSchema: { type: 'object', properties: {} },
        handler: async (_args, context) =>
          context.elicit!({
            message: 'Sure?',
            requestedSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          }),
      },
    ],
    resources: [{ uri: 'test://status', name: 'Status', handler: async () => '{"up":true}' }],
  });
  const client = new Client({ name: 'c', version: '0' }, { capabilities: withElicitation ? { elicitation: {} } : {} });
  if (withElicitation) {
    client.setRequestHandler(ElicitRequestSchema, async (req) => ({
      action: 'accept',
      content: { ok: req.params.message === 'Sure?' },
    }));
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return { client, seen };
}

function text(result: Awaited<ReturnType<Client['callTool']>>) {
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

describe('buildMCPServer', () => {
  it('lists tools plus server_info, and calls a tool', async () => {
    const { client } = await connect(false);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(['echo', 'boom', 'ask', 'server_info']);
    expect(text(await client.callTool({ name: 'echo', arguments: { text: 'hi' } }))).toEqual({ text: 'hi' });
  });

  it('turns a thrown error and an unknown tool into isError results', async () => {
    const { client } = await connect(false);
    const failed = await client.callTool({ name: 'boom', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toEqual({ error: 'kaboom' });
    expect((await client.callTool({ name: 'nope', arguments: {} })).isError).toBe(true);
  });

  it('serves resources', async () => {
    const { client } = await connect(false);
    const read = await client.readResource({ uri: 'test://status' });
    expect((read.contents[0] as { text: string }).text).toBe('{"up":true}');
  });

  it('server_info reports name and version', async () => {
    const { client } = await connect(false);
    expect(text(await client.callTool({ name: 'server_info', arguments: {} }))).toMatchObject({
      name: 'test',
      version: '1.2.3',
    });
  });
});

describe('ToolContext.elicit', () => {
  it('is absent when the client did not declare elicitation', async () => {
    const { client, seen } = await connect(false);
    await client.callTool({ name: 'echo', arguments: {} });
    expect(seen[0].elicit).toBeUndefined();
    expect(seen[0].signal).toBeDefined();
  });

  it('reaches the client and returns the user answer to the handler', async () => {
    const { client } = await connect(true);
    expect(text(await client.callTool({ name: 'ask', arguments: {} }))).toEqual({
      action: 'accept',
      content: { ok: true },
    });
  });
});
