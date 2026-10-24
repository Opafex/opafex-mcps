# Opafex MCPs

Open-source [Model Context Protocol](https://modelcontextprotocol.io/) servers by [Opafex](https://opafex.com). Each server is a standalone npm package usable with Claude Code, Claude Desktop, Cursor, and any MCP-compatible client.

## Servers

| Package | Description | Status |
|---------|-------------|--------|
| [`@opafex/mcp-enrichment`](./packages/enrichment) | Company, contact, email & phone enrichment via Clearbit, Hunter.io, Twilio | Available |
| [`@opafex/mcp-file-processor`](./packages/file-processor) | Document text extraction, keyword detection, chunking | Available |
| [`@opafex/mcp-web-research`](./packages/web-research) | Web search (Brave API), SSRF-guarded page fetch, research synthesis | Available |
| [`@opafex/mcp-approval-queue`](./packages/approval-queue) | Human-in-the-loop approval gate — the agent asks, only a person approves (elicitation or CLI) | Available |
| [`@opafex/knowledge-grid`](https://github.com/Opafex/knowledge-grid) | Layered context for agents (a library, in its own repo) | Available |

## Quick Start

```bash
# Clone and install
git clone https://github.com/opafex/opafex-mcps.git
cd opafex-mcps
npm install
npm run build

# Run the enrichment server (mock mode — no API keys needed)
node packages/enrichment/dist/index.js
```

### Add to Claude Code

Create or edit `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "enrichment": {
      "command": "node",
      "args": ["/path/to/opafex-mcps/packages/enrichment/dist/index.js"],
      "env": {
        "CLEARBIT_API_KEY": "sk-...",
        "HUNTER_API_KEY": "...",
        "TWILIO_ACCOUNT_SID": "...",
        "TWILIO_AUTH_TOKEN": "..."
      }
    }
  }
}
```

All servers work in **mock mode** when API keys are omitted — great for development and testing.

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm test             # Run all tests
```

### Adding a New Server

1. Create `packages/<server-name>/` with `package.json`, `tsconfig.json`, and `src/`
2. Use `@opafex/mcp-shared` for the server bootstrap (`createMCPServer`)
3. Define tools in `tools.ts`, wire up in `index.ts`
4. Add tests in `__tests__/`

See [`packages/enrichment`](./packages/enrichment) as a reference implementation.

## Shared Utilities

[`@opafex/mcp-shared`](./packages/shared) provides:

- **`createMCPServer()` / `buildMCPServer()`** — Reusable MCP server bootstrap with tool/resource registration and stdio transport
- **`ToolContext.elicit`** — ask the user a question through the client's UI (MCP elicitation), out of the model's reach
- **Validation helpers** — Email, domain, phone format validation

## License

MIT
