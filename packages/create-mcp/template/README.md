# my-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io/) server built with [@opafex/mcp-shared](https://github.com/Opafex/opafex-mcps).

## Quick Start

```bash
npm install
npm run build
npm start
```

## Add to Claude Code

Create `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "my-mcp-server": {
      "command": "node",
      "args": ["path/to/dist/index.js"]
    }
  }
}
```

## Tools

| Tool | Description |
|------|-------------|
| `reverse_string` | Reverse a string |
| `word_count` | Count words and characters |
| `server_info` | Server metadata and health check |

## Development

```bash
npm run dev       # Run with tsx (no build needed)
npm run build     # Compile TypeScript
npm test          # Run tests
npm run test:watch # Watch mode
```

## Adding a New Tool

1. Define types in `src/types.ts`
2. Add business logic to a service in `src/services/`
3. Define the tool in `src/tools/` using the `ToolDefinition` interface
4. Wire it up in `src/index.ts`
5. Add tests in `tests/`

See the [enrichment MCP](https://github.com/Opafex/opafex-mcps/tree/main/packages/enrichment) for a full production example.

## License

MIT
