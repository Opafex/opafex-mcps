# @opafex/mcp-approval-queue

A human-in-the-loop approval gate for AI agents, as an MCP server.

The agent calls `request_approval` before doing something risky. The action is risk-scored, and unless a rule you set covers it, **you** decide — in a form your MCP client shows you (MCP elicitation), or from a terminal. The agent gets a `proceed: true|false` it can act on.

**The agent can ask; only a human can approve.** There is no approve, reject or add-rule tool for the model to call. An approval gate the gated agent can open is not a gate.

Requires **Node.js 20+**.

## Quick start

Add to your client's MCP config (for Claude Code, `.mcp.json` in your project root):

```json
{
  "mcpServers": {
    "approval-queue": {
      "command": "npx",
      "args": ["-y", "@opafex/mcp-approval-queue"]
    }
  }
}
```

Then tell the agent when to use it, for example in your project instructions:

> Before deleting data, sending email, spending money or deploying, call `request_approval` and only continue if `proceed` is true.

## How a request is decided

1. **Risk is scored** from the action name — `bulk_delete_users` is a delete wherever the word sits — plus `params.estimatedCost`. The agent may pass a `category`, but it can only **raise** the score, never lower it.
2. **A rule may auto-approve it** — only low or medium risk, only rules a human created. High and critical risk always go to a person.
3. **Otherwise a person decides:**
   - **In the client** — if the client supports [elicitation](https://modelcontextprotocol.io/specification/2025-06-18/client/elicitation), the server asks you directly with the action, risk, parameters and the agent's reason, and waits for your answer. The answer goes to the server, not to the model. Approve, reject, or tick *Always approve* (low/medium risk only) to create a rule. Dismissing the form leaves the request pending.
   - **In a terminal** — otherwise the request waits, and the agent is told to poll `check_status`:

     ```bash
     npx @opafex/mcp-approval-queue pending
     npx @opafex/mcp-approval-queue approve appr_3f9c1a2b4d5e --reason "checked the recipient list"
     npx @opafex/mcp-approval-queue reject  appr_3f9c1a2b4d5e
     ```

4. **Unanswered requests expire** after 24 hours (`APPROVAL_QUEUE_TTL_HOURS`) and can no longer be approved.

After five human approvals of the same action with no rejection, the next form suggests *always approve*. Auto-approvals do not count towards that — the system agreeing with itself is not evidence.

## Tools (what the agent sees)

| Tool | Description |
|------|-------------|
| `request_approval` | Submit an action (`action`, optional `params`, `context`, `category`, `wait`). Returns `status`, `proceed`, risk, and what to do next. |
| `check_status` | Re-read a request by `id`. |
| `list_pending` | Requests still waiting for a human, newest first. |
| `list_rules` | The auto-approval rules a human has set (read-only). |

`status` is one of `pending`, `approved`, `rejected`, `auto_approved`, `expired`. Proceed only when `proceed` is `true`.

## Resources

| URI | Contents |
|-----|----------|
| `approval://stats` | Counts by status and the average time a human took to decide |
| `approval://rules` | Current auto-approval rules |
| `approval://history` | Last 50 decisions |

## CLI

```
mcp-approval-queue                       start the MCP server (stdio)
mcp-approval-queue pending               list requests waiting for a decision
mcp-approval-queue show <id>             one request in full
mcp-approval-queue approve <id> [--always] [--reason <text>]
mcp-approval-queue reject <id> [--reason <text>]
mcp-approval-queue rules                 list rules
mcp-approval-queue rules add <pattern> --max-risk <low|medium> [--description <text>]
mcp-approval-queue rules remove <id>
mcp-approval-queue history [limit]
```

Patterns are globs: `*` matches anything, `?` one character, case-insensitive. A rule can never cover high or critical risk.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `APPROVAL_QUEUE_STATE_DIR` | `~/.opafex/approval-queue` | Where `state.json` (requests, rules, history) lives. The server and the CLI must point at the same directory. |
| `APPROVAL_QUEUE_TTL_HOURS` | `24` | Hours before an undecided request expires |

State is one JSON file, written atomically under a lock file, so the server and the CLI can run at the same time.

## What it does not protect against

Be clear about this before relying on it:

- **An agent with a shell or file access can reach the terminal channel.** The CLI and `state.json` are a human channel only if the agent cannot run the command or write the file. Coding agents such as Claude Code usually can. In that setup rely on the elicitation channel, and deny the agent the CLI and the state directory in your client's permission settings — for Claude Code, deny `Bash(npx @opafex/mcp-approval-queue approve:*)`, `Bash(npx @opafex/mcp-approval-queue rules:*)`, and edits under `~/.opafex/`.
- **It only gates what the agent asks about.** The agent has to call `request_approval`, and has to honour `proceed: false`. This is a protocol for a cooperative agent and a record of what was allowed, not a sandbox. Pair it with your client's own tool permissions for anything that must be enforced.
- **Elicitation is shown by the client.** The guarantee that the answer came from a person is only as good as the client's rendering of the form.

## Library use

```ts
import { ApprovalQueueService, StateStore, assessRisk } from '@opafex/mcp-approval-queue';

const queue = new ApprovalQueueService(new StateStore('/var/lib/my-app/approvals'));
const { request } = await queue.requestApproval({ action: 'refund_order', params: { estimatedCost: 40 } });
```

## Development

```bash
npm install
npm run build
npm test
```

## License

MIT — see [LICENSE](./LICENSE).
