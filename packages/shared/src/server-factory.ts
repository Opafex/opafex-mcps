import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from './logger.js';
import { ConsoleLogger } from './logger.js';

/** A form shown to the human through the MCP client, never to the model. */
export interface ElicitationRequest {
  /** What the human is being asked. */
  message: string;
  /** Flat JSON Schema object (primitive properties only, per the MCP spec). */
  requestedSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

/** Per-call context handed to a tool handler. */
export interface ToolContext {
  /**
   * Ask the human a question through the client's own UI (MCP elicitation).
   * The answer goes to the server, not the model. `undefined` when the
   * connected client did not declare the `elicitation` capability.
   */
  elicit?: (request: ElicitationRequest) => Promise<ElicitResult>;
  /** Aborted when the client cancels the call. */
  signal?: AbortSignal;
}

/** Definition of a single MCP tool. */
export interface ToolDefinition {
  /** Snake_case tool name (e.g. `enrich_company`). */
  name: string;
  /** What the tool does and when to use it. Shown to the LLM. */
  description: string;
  /** JSON Schema for the tool's input parameters. */
  inputSchema: Record<string, unknown>;
  /** Async handler that receives validated arguments and returns the result. */
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>;
}

/** How long a human has to answer an elicitation before the call fails. */
const ELICITATION_TIMEOUT_MS = 10 * 60 * 1000;

/** Definition of a single MCP resource. */
export interface ResourceDefinition {
  /** Resource URI (e.g. `myserver://status`). */
  uri: string;
  /** Human-readable name. */
  name: string;
  /** Description of what the resource provides. */
  description?: string;
  /** MIME type of the resource content. Defaults to `application/json`. */
  mimeType?: string;
  /** Async handler that returns the resource content as a string. */
  handler: () => Promise<string>;
}

/** Configuration for {@link createMCPServer}. */
export interface MCPServerConfig {
  /** Server name shown to MCP clients. */
  name: string;
  /** Semver version string. */
  version: string;
  /** Tools to register. */
  tools: ToolDefinition[];
  /** Resources to register. */
  resources?: ResourceDefinition[];
  /** Logger instance. Defaults to stderr ConsoleLogger at 'info' level. */
  logger?: Logger;
  /** Add a built-in `server_info` tool that returns server metadata. Defaults to `true`. */
  includeHealthTool?: boolean;
}

/**
 * Build an MCP server with every tool and resource registered, NOT connected
 * to a transport. Use this to connect your own transport (or an in-memory one
 * in tests); {@link createMCPServer} is this plus stdio.
 */
export function buildMCPServer(config: MCPServerConfig): Server {
  return registerAll(config).server;
}

/**
 * Create and start an MCP server with stdio transport.
 *
 * Registers all tools and resources, connects via stdio, and returns the server instance.
 * Includes a built-in `server_info` introspection tool unless disabled.
 *
 * @example
 * ```ts
 * import { createMCPServer } from '@opafex/mcp-shared';
 *
 * await createMCPServer({
 *   name: 'my-server',
 *   version: '1.0.0',
 *   tools: [
 *     {
 *       name: 'hello',
 *       description: 'Say hello',
 *       inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
 *       handler: async (args) => ({ message: `Hello, ${args.name}!` }),
 *     },
 *   ],
 * });
 * ```
 */
export async function createMCPServer(config: MCPServerConfig): Promise<Server> {
  const { server, logger, toolCount } = registerAll(config);

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info('Server started', {
    tools: toolCount,
    resources: config.resources?.length ?? 0,
  });

  return server;
}

function registerAll(config: MCPServerConfig): { server: Server; logger: Logger; toolCount: number } {
  const logger = config.logger ?? new ConsoleLogger('info', config.name);
  const includeHealth = config.includeHealthTool !== false;

  // Build the full tool list
  const tools: ToolDefinition[] = [...config.tools];

  if (includeHealth) {
    tools.push({
      name: 'server_info',
      description:
        'Returns server metadata: name, version, registered tools, and registered resources. Useful for introspection and health checks.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        name: config.name,
        version: config.version,
        tools: config.tools.map((t) => ({ name: t.name, description: t.description })),
        resources: (config.resources ?? []).map((r) => ({ uri: r.uri, name: r.name })),
      }),
    });
  }

  const server = new Server(
    { name: config.name, version: config.version },
    {
      capabilities: {
        tools: {},
        ...(config.resources?.length ? { resources: {} } : {}),
      },
    }
  );

  // Register tool listing
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  // Register tool execution
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) {
      logger.warn('Unknown tool requested', { tool: request.params.name });
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: `Unknown tool: ${request.params.name}` }),
          },
        ],
        isError: true,
      };
    }

    try {
      logger.debug('Executing tool', { tool: tool.name });
      const context: ToolContext = { signal: extra.signal };
      if (server.getClientCapabilities()?.elicitation) {
        context.elicit = (req) =>
          server.elicitInput(
            { message: req.message, requestedSchema: req.requestedSchema } as Parameters<
              typeof server.elicitInput
            >[0],
            { signal: extra.signal, timeout: ELICITATION_TIMEOUT_MS }
          );
      }
      const result = await tool.handler(
        (request.params.arguments as Record<string, unknown>) || {},
        context
      );
      logger.debug('Tool completed', { tool: tool.name });
      return {
        content: [
          {
            type: 'text' as const,
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Tool execution failed';
      logger.error('Tool failed', { tool: tool.name, error: message });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  // Register resources if provided
  if (config.resources?.length) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: config.resources!.map((r) => ({
        uri: r.uri,
        name: r.name,
        description: r.description,
        mimeType: r.mimeType || 'application/json',
      })),
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const resource = config.resources!.find((r) => r.uri === request.params.uri);
      if (!resource) {
        throw new Error(`Unknown resource: ${request.params.uri}`);
      }
      const content = await resource.handler();
      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType || 'application/json',
            text: content,
          },
        ],
      };
    });
  }

  return { server, logger, toolCount: tools.length };
}
