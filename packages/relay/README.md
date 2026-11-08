# @opafex/relay

Lets a hosted opafex agent use the commands and local MCP servers **you allow** on your own laptop or server.

You list what the agent may run in a config file on your machine. The relay connects out to opafex, tells it what this machine offers, and waits for requests. Each request is checked against your list, run, and the result sent back. Anything not on your list is refused, whatever opafex asks for.

**Commands you allow run on your machine, as you, under your authority.** Allow only what you would be happy for the agent to run unsupervised, and make the parameter patterns as narrow as you can.

Requires **Node.js 20+**. No runtime dependencies.

## What it will never do

- **Run a shell.** Every command is a program plus a fixed argument list, started with no shell. A parameter fills exactly one argument, so `;`, `|`, `&&`, `$(...)` and quotes are just characters. Shells and command runners (`cmd`, `powershell`, `bash`, `sh` and the like) are refused as commands. On Windows only `.exe` and `.com` programs run: `.bat`, `.cmd` and `.ps1` files need `cmd.exe` or another host, so they are refused.
- **Open a port.** The relay only connects out, over HTTPS (plain http only to `localhost`, for development). Nothing can connect in to it.
- **Run anything off your list.** opafex is told only each command's id, description and parameter names and patterns. The program, its arguments and its folder never leave your machine. A request for anything else, a parameter you did not declare, a missing one, or a value that does not match its pattern in full is refused.
- **Hand over secrets by accident.** Environment variables whose names contain `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD` or `CREDENTIAL` are removed before a command or server starts, unless that entry lists them in `env`. The relay's own key is never passed on.

Output is capped at 256 KB per stream (and per MCP result), and every command has a timeout after which it and anything it started are stopped.

## Quick start

1. **Make a relay key** in opafex Settings. It starts `opr_`, belongs to your account, and can be revoked there at any time. It is a key for this machine, not your account API key.
2. **Write a config** (nothing is enabled until you edit it):

   ```bash
   npx @opafex/relay init
   ```

   This writes `~/.opafex/relay.json`. Use `--config <file>` (or `OPAFEX_RELAY_CONFIG`) for another location.
3. **Allow something**, then check what the relay would offer. `check` contacts nothing and runs nothing:

   ```bash
   npx @opafex/relay check
   ```

4. **Run it**, with the key in the environment (or in a key file named in the config):

   ```bash
   OPAFEX_RELAY_KEY=opr_... npx @opafex/relay run
   ```

   In PowerShell: `$env:OPAFEX_RELAY_KEY = "opr_..."; npx @opafex/relay run`.

The machine shows in opafex while the relay runs. Stop it with Ctrl+C; opafex shows the machine as offline shortly after. Edits to the config file are picked up while it runs.

## Config

JSON, with `//` comments allowed.

```jsonc
{
  "platformUrl": "https://app.opafex.com",
  "machineName": "build-server",
  "keyFile": "~/.opafex/relay.key",

  "commands": [
    {
      "id": "git_status",
      "description": "Show git status for a project folder",
      "executable": "git",
      "args": ["-C", "{repo}", "status", "--short"],
      "cwd": "~/projects",
      "timeoutSeconds": 30,
      "params": [
        { "name": "repo", "description": "a folder name under ~/projects",
          "pattern": "[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}" }
      ]
    }
  ],

  "mcpServers": [
    {
      "id": "files",
      "command": "node",
      "args": ["/opt/mcp/filesystem/dist/index.js", "/srv/shared"],
      "tools": ["read_file", "list_directory"]
    }
  ]
}
```

**Commands**

| Setting | |
|---|---|
| `id` | Lowercase letters, digits and `_`, starting with a letter. What the agent asks for. |
| `description` | What it does, in a sentence (up to 500 characters). The agent sees this. |
| `executable` | An absolute path, or a bare name found on `PATH`. |
| `args` | The argument list. `{name}` is filled with that parameter's value as one argument; it can sit inside a longer argument (`--branch={branch}`). Write `{{` and `}}` for literal braces. |
| `params` | Each parameter's `name`, `pattern` and an optional `description`. The **whole** value must match the pattern (`main\|dev` means exactly `main` or exactly `dev`). Every declared parameter is required. |
| `cwd` | The folder it runs in (absolute, or starting `~`). Optional. |
| `timeoutSeconds` | Stopped after this long (default 30). |
| `env` | Names of secret-looking environment variables this entry may see. |

**MCP servers** are local stdio servers. The relay starts each one (no shell, same environment rule), lists its tools and passes calls through. `tools` narrows what is offered; leave it out to offer every tool the server lists. A server that crashes is restarted with backoff, and calls are refused as not running meanwhile. On Windows, `npx` is a batch file, so give `node` and the path to the package's script instead.

**The key** comes from `OPAFEX_RELAY_KEY`, else from the file named in `keyFile`. A `key` written in the config works too but is plain text on disk; `check` warns about it. On macOS and Linux the relay warns when the config or key file can be read by other users.

## How it talks to opafex

Outbound HTTPS only, to `platformUrl`, authenticated with the relay key:

- `POST /api/relay/v1/hello` on start and whenever the offer changes.
- `GET /api/relay/v1/next` long-polls for the next request (also how opafex knows the machine is online).
- `POST /api/relay/v1/requests/<id>/result` returns each result.

If the key is revoked or unknown, or the account's plan does not include the relay, the relay stops and says so rather than retrying. Network errors and server errors are retried with backoff (1s, 2s, 4s, up to 60s).

## License

MIT, see [LICENSE](./LICENSE).
