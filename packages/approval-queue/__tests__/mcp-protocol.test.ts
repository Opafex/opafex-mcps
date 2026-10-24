/**
 * The whole loop over the real MCP protocol: a client (playing the agent's
 * host) connected in memory to the server, with and without elicitation.
 */
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { buildMCPServer } from '@opafex/mcp-shared';
import { approvalQueueTools } from '../src/tools.js';
import type { ApprovalQueueService } from '../src/approval-service.js';
import { makeService } from './helpers.js';

interface Harness {
  client: Client;
  service: ApprovalQueueService;
  asked: string[];
}

async function connect(answer?: (message: string) => ElicitResult | Promise<ElicitResult>): Promise<Harness> {
  const service = makeService();
  const server = buildMCPServer({
    name: 'test-approval-queue',
    version: '0.0.0',
    tools: approvalQueueTools(service),
    includeHealthTool: false,
  });
  const client = new Client(
    { name: 'test-client', version: '0.0.0' },
    { capabilities: answer ? { elicitation: {} } : {} }
  );
  const asked: string[] = [];
  if (answer) {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      const message = String(request.params.message);
      asked.push(message);
      return answer(message);
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, service, asked };
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text) as Record<string, unknown>;
}

describe('the agent cannot decide', () => {
  it('exposes no tool that approves, rejects or creates a rule', async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(['check_status', 'list_pending', 'list_rules', 'request_approval']);
  });

  it('calling an approve tool by name fails', async () => {
    const { client, service } = await connect();
    const pending = await call(client, 'request_approval', { action: 'send_email' });
    const result = await client.callTool({ name: 'approve', arguments: { id: pending.id } });
    expect(result.isError).toBe(true);
    expect((await service.getRequest(String(pending.id)))?.status).toBe('pending');
  });
});

describe('with elicitation', () => {
  it('asks the human in the client and returns their approval', async () => {
    const { client, asked } = await connect(() => ({ action: 'accept', content: { decision: 'approve' } }));
    const result = await call(client, 'request_approval', {
      action: 'send_email',
      params: { to: 'board@example.com' },
      context: 'Monthly report',
    });
    expect(result).toMatchObject({ status: 'approved', proceed: true, decidedBy: 'human:elicitation' });
    expect(asked[0]).toContain('send_email');
    expect(asked[0]).toContain('board@example.com');
    expect(asked[0]).toContain('The agent says: Monthly report');
  });

  it('a decline is a rejection', async () => {
    const { client } = await connect(() => ({ action: 'decline' }));
    const result = await call(client, 'request_approval', { action: 'send_email' });
    expect(result).toMatchObject({ status: 'rejected', proceed: false });
  });

  it('a cancel leaves the request pending for the CLI', async () => {
    const { client } = await connect(() => ({ action: 'cancel' }));
    const result = await call(client, 'request_approval', { action: 'send_email' });
    expect(result).toMatchObject({ status: 'pending', proceed: false });
    expect(String(result.next)).toContain(`approve ${result.id}`);
  });

  it('"always approve" from the form creates a rule', async () => {
    const { client } = await connect(() => ({
      action: 'accept',
      content: { decision: 'approve', always_approve: true },
    }));
    await call(client, 'request_approval', { action: 'send_email' });
    const second = await call(client, 'request_approval', { action: 'send_email' });
    expect(second).toMatchObject({ status: 'auto_approved', proceed: true });
  });

  it('wait=false does not ask', async () => {
    const { client, asked } = await connect(() => ({ action: 'accept', content: { decision: 'approve' } }));
    const result = await call(client, 'request_approval', { action: 'send_email', wait: false });
    expect(result.status).toBe('pending');
    expect(asked).toHaveLength(0);
  });

  it('an auto-approved request does not ask', async () => {
    const { client, service, asked } = await connect(() => ({ action: 'decline' }));
    await service.addRule({ actionPattern: 'list_*', maxRisk: 'low' });
    const result = await call(client, 'request_approval', { action: 'list_users' });
    expect(result.status).toBe('auto_approved');
    expect(asked).toHaveLength(0);
  });
});

describe('without elicitation', () => {
  it('holds the request and tells the agent a human must use the CLI', async () => {
    const { client, service } = await connect();
    const pending = await call(client, 'request_approval', { action: 'deploy_production' });
    expect(pending).toMatchObject({ status: 'pending', proceed: false });
    expect(String(pending.next)).toContain('npx @opafex/mcp-approval-queue approve');

    await service.decide({ id: String(pending.id), decision: 'approve', channel: 'cli' });
    const status = await call(client, 'check_status', { id: pending.id });
    expect(status).toMatchObject({ status: 'approved', proceed: true });
  });
});
