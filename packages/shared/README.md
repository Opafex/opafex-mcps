# @opafex/mcp-shared

Small toolkit for building [Model Context Protocol](https://modelcontextprotocol.io/) servers: a server bootstrap, caching, config, logging and validation helpers. Every server in [opafex-mcps](https://github.com/Opafex/opafex-mcps) is built on it.

Requires **Node.js 20+**.

```bash
npm install @opafex/mcp-shared @modelcontextprotocol/sdk
```

Starting a new server? `npm create @opafex/mcp my-server` scaffolds one on this package.

## Server bootstrap

```ts
import { createMCPServer } from '@opafex/mcp-shared';

await createMCPServer({
  name: 'my-server',
  version: '1.0.0',
  tools: [
    {
      name: 'hello',
      description: 'Say hello',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      handler: async (args) => ({ message: `Hello, ${args.name}!` }),
    },
  ],
});
```

`createMCPServer` registers your tools and resources, adds a `server_info` introspection tool (turn off with `includeHealthTool: false`), and connects over stdio. A handler's return value is sent as JSON text; a thrown error becomes an `isError` result.

`buildMCPServer(config)` does the same without connecting, so you can attach your own transport — or an in-memory one in tests.

### Asking the human (elicitation)

A handler's second argument is a `ToolContext`. When the client supports [elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation), `context.elicit` puts a form in front of the user and returns their answer to the server — the model never sees or fills it.

```ts
handler: async (args, context) => {
  if (!context.elicit) return { error: 'This client cannot ask the user' };
  const answer = await context.elicit({
    message: `Delete ${args.path}?`,
    requestedSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', title: 'Delete it' } },
      required: ['confirm'],
    },
  });
  return answer.action === 'accept' && answer.content?.confirm ? doDelete(args.path) : { cancelled: true };
};
```

`context.elicit` is `undefined` when the client did not declare the capability. A form waits up to ten minutes. `context.signal` aborts when the client cancels the call.

## Utilities

| Export | Purpose |
|--------|---------|
| `InMemoryCacheProvider`, `NoOpCacheProvider`, `CacheProvider` | TTL cache with a swappable interface |
| `readConfig`, `readConfigSafe` | Typed environment-variable config with defaults |
| `ConsoleLogger`, `SilentLogger` | Leveled logging to **stderr** (stdout belongs to the protocol) |
| `formatToolError`, `validationError`, `withErrorHandling` | Consistent tool error shapes |
| `isValidEmail`, `isValidDomain`, `isValidPhone`, `formatPhoneE164` | Input validation |

## License

MIT — see [LICENSE](./LICENSE).
