# Relay wire protocol v1

The contract between `@opafex/relay` (this package) and the opafex platform routes under
`/api/relay/v1/`. The design rules behind it: the machine decides what may run, the relay connects
out and opens no port, it has its own revocable key, and nothing runs through a shell.

## Transport and auth
- HTTPS only, outbound from the relay. Base URL from the relay's config (default `https://app.opafex.com`).
  The relay refuses a non-https base URL except `http://localhost` / `http://127.0.0.1` (for development).
- Every request: `Authorization: Bearer opr_<secret>`. The key is a RELAY key (prefix `opr_`), made in
  Settings, one account, stored hashed, revocable. Not an account API key. It reaches only `/api/relay/v1/*`.
- JSON bodies, `Content-Type: application/json`. Header `X-Relay-Version: <package version>`.
- Success bodies are bare JSON. Errors are `{ success: false, error, code }`.
- 401 = key revoked or unknown: the relay stops and says so, never retries.
- Any 403 on hello or poll: the relay stops and says so. Codes include `relay_not_entitled` (the account's
  product has no relay), `relay_account_paused` (the account's subscription ended or it is on hold:
  nothing on it runs until it is restarted) and `relay_private_mode_unsupported` (a Private Mode account
  with its own database). On a result post, `relay_not_entitled` and `relay_account_paused` stop the
  relay too; any other 403 there means another relay claimed the request.
- 409 `hello_required` on a poll: the platform holds no current offer from this machine. The relay sends
  hello again and resumes; a second one within a minute stops it.
- 413: a hello body over 2 MB or a result over 1 MB. The relay trims to fit before sending.
- 408/429/5xx/network = back off (1s, 2s, 4s … cap 60s) and retry. Redirects are refused, never followed.
- One machine per key: two relays sharing a key overwrite each other's offers.

## 1. Hello: `POST /api/relay/v1/hello`
Sent on start and whenever the local config file changes. Replaces everything the machine offered before.
```json
{
  "machine": { "name": "harry-laptop", "os": "win32", "relayVersion": "0.1.0" },
  "commands": [
    { "id": "git_status", "description": "git status in the repo",
      "params": [ { "name": "repo", "description": "repo folder", "pattern": "^[A-Za-z0-9_./-]{1,200}$" } ] }
  ],
  "mcpServers": [
    { "id": "files", "tools": [ { "name": "read_file", "description": "…", "inputSchema": { } } ] }
  ]
}
```
- `commands[].id` and `mcpServers[].id`: `^[a-z][a-z0-9_]{0,47}$`. `params[].name` likewise.
- The executable, the argument template and the working folder are NEVER sent. The platform knows only
  the id, the description and the parameter names/patterns.
- Nothing in hello says a command is read-only. Read-only is the account OWNER's mark on the platform.
- Response `200 { "relayId": "<id>", "pollWaitSeconds": 25 }`.
- Limits the platform enforces (and the relay pre-trims to): 100 commands, 20 servers, 200 tools per
  server, description 500 chars, schema 16 KB per tool. Platform treats every string as untrusted text
  (`lib/security/untrusted-text.ts`).

## 2. Next request (long poll): `GET /api/relay/v1/next?wait=25`
- Holds up to `wait` seconds (max 25). Also the heartbeat: every call stamps the machine's last-seen time.
- `204` = nothing to do; poll again straight away.
- `200` = one request, already CLAIMED for this relay (atomic CAS pending → claimed):
```json
{ "request": {
    "id": "<uuid>", "kind": "command",
    "command": { "id": "git_status", "params": { "repo": "projects/site" } },
    "deadline": "2026-11-09T10:00:30.000Z" } }
```
```json
{ "request": { "id": "<uuid>", "kind": "mcp_call",
    "mcp": { "serverId": "files", "tool": "read_file", "arguments": { } },
    "deadline": "…" } }
```
- `kind` is `command` | `mcp_call` | `mcp_list`. An `mcp_list` carries `mcp: { serverId }` and re-reads one
  server's tools; answer with `{ "tools": [...] }` in `result`, and the platform updates that server's offer.
- A parameter value must match its pattern in full (`^(?:pattern)$`) and be at most 8 KB. The relay checks;
  the platform never compiles a machine's pattern.

## 3. Result: `POST /api/relay/v1/requests/<id>/result`
```json
{ "status": "ok", "result": {
    "exitCode": 0, "stdout": "…", "stderr": "…", "truncated": false, "durationMs": 120 } }
```
- For `mcp_call`, `result` is the MCP `tools/call` result object as the server returned it (`content`,
  `isError`, `structuredContent`), trimmed by the relay to 256 KB.
- `status: "refused"` with `{ "refusal": { "code": "not_on_list" | "param_mismatch" | "server_not_running", "message": "…" } }`
  is the relay saying no. `status: "error"` with `{ "error": { "message": "…" } }` = it tried and failed
  (spawn failed, timed out, server crashed).
- stdout and stderr capped at 256 KB each by the relay, and the whole result trimmed to fit 1 MB as JSON
  (`truncated: true` when cut). An MCP result over the limit loses `structuredContent` and gains a text note.
- A process killed by a signal reports `exitCode` 128 + the signal number.
- The relay refuses an MCP tool it did not offer with `not_on_list`.
- Idempotent: a second post for the same id answers `409 already_settled` and changes nothing. A post
  after the deadline answers `410 expired` and is not stored.
- Only the relay that claimed the request may settle it (`403` otherwise).

## Command execution on the machine (the package's job; the platform never sees this)
Config entry: `{ "id", "description", "executable": "<absolute path or bare name on PATH>",
"args": ["status", "--short"] | with placeholders "{repo}", "cwd"?: "...", "timeoutSeconds"?: 30,
"params": [{ "name", "pattern" }] }`.
A placeholder is replaced by the parameter value as ONE argv element, never split, never through a
shell (`execFile`, `shell: false`, and on Windows refuse `.bat`/`.cmd` executables, which Node can only
run through cmd.exe). Each value must fully match its pattern; a param the request sends that the entry
does not declare is refused; a missing one is refused. Env: the relay's own env minus anything whose name
contains KEY, TOKEN, SECRET or PASSWORD unless the entry lists it in `env`.

## Platform side timings
- A request row: `pending` → `claimed` → `ok|refused|error`, or `expired` (deadline passed unclaimed or
  unsettled). The deadline is the platform's: 60 s from creation by default (the platform
  does not know an entry's own timeout), and the caller waits the same. The relay kills a command still
  running at the deadline and posts nothing.
- Machine status: last-seen within 90 s = connected; otherwise `disconnected`, reason `relay_offline`,
  through `ConnectionLifecycle` (one writer). A new hello or poll moves it back up.
