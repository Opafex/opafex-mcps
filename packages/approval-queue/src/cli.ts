/**
 * The human side of the queue. Reads and writes the same state file as the
 * MCP server, so a decision made here is what the agent sees on its next
 * check_status.
 */

import type { ApprovalQueueService } from './approval-service.js';

const USAGE = `Usage: mcp-approval-queue [command]

With no command, starts the MCP server on stdio.

Commands:
  pending                              List requests waiting for a decision
  show <id>                            Show one request in full
  approve <id> [--always] [--reason <text>]
                                       Approve; --always also auto-approves this action from now on
  reject <id> [--reason <text>]        Reject
  rules                                List auto-approval rules
  rules add <pattern> --max-risk <low|medium> [--description <text>]
                                       Add a rule (glob: * any chars, ? one char)
  rules remove <id>                    Remove a rule
  history [limit]                      Recent decisions

State: $APPROVAL_QUEUE_STATE_DIR (default ~/.opafex/approval-queue)`;

export interface CliIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

const consoleIO: CliIO = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Run one CLI command. Returns the process exit code. */
export async function runCli(
  argv: string[],
  service: ApprovalQueueService,
  io: CliIO = consoleIO
): Promise<number> {
  const { positional, flags } = parseArgs(argv);
  const [command, ...rest] = positional;

  switch (command) {
    case 'pending': {
      const { items, total } = await service.listPending(undefined, 100);
      if (!total) {
        io.out('Nothing is waiting for a decision.');
        return 0;
      }
      for (const r of items) {
        io.out(`${r.id}  ${r.riskLevel.toUpperCase().padEnd(8)} ${r.action}${r.context ? `  — ${r.context}` : ''}`);
      }
      return 0;
    }

    case 'show': {
      const request = rest[0] ? await service.getRequest(rest[0]) : null;
      if (!request) return fail(io, `No request ${rest[0] ?? ''}`.trim());
      io.out(JSON.stringify(request, null, 2));
      return 0;
    }

    case 'approve':
    case 'reject': {
      if (!rest[0]) return fail(io, `Usage: mcp-approval-queue ${command} <id>`);
      const result = await service.decide({
        id: rest[0],
        decision: command,
        reason: typeof flags.reason === 'string' ? flags.reason : undefined,
        alwaysApprove: flags.always === true,
        channel: 'cli',
      });
      if (result.status === 'refused') return fail(io, result.error);
      io.out(`${result.request.id} ${result.request.status}: ${result.request.action}`);
      if (result.rule) io.out(`Rule ${result.rule.id} created: always approve "${result.rule.actionPattern}"`);
      return 0;
    }

    case 'rules':
      return rules(rest, flags, service, io);

    case 'history': {
      const limit = Number(rest[0]) || 20;
      for (const d of await service.getHistory(limit)) {
        io.out(`${d.decidedAt}  ${d.status.padEnd(13)} ${d.riskLevel.padEnd(8)} ${d.action}  (${d.decidedBy})`);
      }
      return 0;
    }

    case 'help':
    case undefined:
      io.out(USAGE);
      return 0;

    default:
      io.err(`Unknown command: ${command}`);
      io.out(USAGE);
      return 2;
  }
}

async function rules(
  rest: string[],
  flags: Record<string, string | boolean>,
  service: ApprovalQueueService,
  io: CliIO
): Promise<number> {
  const [sub, arg] = rest;
  if (!sub) {
    const list = await service.listRules();
    if (!list.length) io.out('No auto-approval rules.');
    for (const r of list) {
      io.out(`${r.id}  ${r.actionPattern}  (≤ ${r.maxRisk}, used ${r.useCount}×)  ${r.description}`);
    }
    return 0;
  }
  if (sub === 'add') {
    const maxRisk = flags['max-risk'];
    if (!arg || (maxRisk !== 'low' && maxRisk !== 'medium')) {
      return fail(io, 'Usage: mcp-approval-queue rules add <pattern> --max-risk <low|medium>');
    }
    const rule = await service.addRule({
      actionPattern: arg,
      maxRisk,
      description: typeof flags.description === 'string' ? flags.description : undefined,
    });
    if (arg.trim() === '*') {
      io.err(`Warning: "*" auto-approves every ${maxRisk}-or-lower risk action.`);
    }
    io.out(`Rule ${rule.id} added.`);
    return 0;
  }
  if (sub === 'remove') {
    if (!arg) return fail(io, 'Usage: mcp-approval-queue rules remove <id>');
    return (await service.removeRule(arg)) ? (io.out(`Rule ${arg} removed.`), 0) : fail(io, `No rule ${arg}`);
  }
  return fail(io, `Unknown rules command: ${sub}`);
}

function fail(io: CliIO, message: string): number {
  io.err(message);
  return 1;
}

export function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (name === 'always' || next === undefined || next.startsWith('--')) {
      flags[name] = true;
    } else {
      flags[name] = next;
      i++;
    }
  }
  return { positional, flags };
}
