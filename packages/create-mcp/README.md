# @opafex/create-mcp

Scaffold a new [Model Context Protocol](https://modelcontextprotocol.io/) server built on [`@opafex/mcp-shared`](https://www.npmjs.com/package/@opafex/mcp-shared).

Requires **Node.js 20+**.

```bash
npm create @opafex/mcp my-server
cd my-server
npm run dev
```

You get a TypeScript project with one example tool, its tests (vitest), a `.env.example`, and `build` / `dev` / `test` scripts. Replace the text tools in `src/` with your own.

## Options

```
npm create @opafex/mcp <directory> -- [options]

  --name <name>          Package name (defaults to directory name)
  --description <desc>   Package description
  --no-install           Skip npm install
  --no-git               Skip git init
  -h, --help             Show help
```

Note the `--` before the options: it passes them through `npm create` to this package.

## License

MIT — see [LICENSE](./LICENSE).
