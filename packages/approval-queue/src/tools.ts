import type { ToolDefinition, ToolContext, ElicitationRequest } from '@opafex/mcp-shared';
import { RISK_ORDER } from './risk-assessor.js';
import type { ApprovalQueueService, ApprovalRequest, RuleSuggestion } from './approval-service.js';

/**
 * The tools the AGENT sees. Deliberately read-and-request only: there is no
 * approve, reject or add_rule here. A human decides through the elicitation
 * form this server sends to the client, or with the CLI.
 */
export function approvalQueueTools(service: ApprovalQueueService): ToolDefinition[] {
  return [
    {
      name: 'request_approval',
      description:
        'Ask a human for permission before doing something risky. Call this BEFORE the action, and only proceed when the result has proceed=true. ' +
        'The risk is scored from the action name (and your category, if it is riskier). A matching rule auto-approves low/medium risk actions; ' +
        'otherwise the human is asked directly in their client, or the request waits for them to decide with the CLI — then poll check_status.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'The action you want to take, as a short verb_noun name (e.g. "delete_user", "send_email", "deploy_production")',
          },
          params: {
            type: 'object',
            description: 'The parameters you would act with, shown to the human (e.g. { "userId": "123", "estimatedCost": 50 }). estimatedCost raises the risk score.',
          },
          context: {
            type: 'string',
            description: 'Why the action is needed, in one or two sentences, for the human deciding',
          },
          category: {
            type: 'string',
            enum: ['read', 'compute', 'file_write', 'file_system', 'data_mutation', 'external_api', 'payment', 'delete'],
            description: 'Optional category. It can only RAISE the risk inferred from the action name, never lower it.',
          },
          wait: {
            type: 'boolean',
            description: 'Ask the human now and wait for the answer, when the client supports it (default true). False returns at once with a pending request.',
          },
        },
        required: ['action'],
      },
      handler: async (args, context) => {
        const { request, suggestion } = await service.requestApproval({
          action: String(args.action ?? ''),
          params: isRecord(args.params) ? args.params : undefined,
          context: typeof args.context === 'string' ? args.context : undefined,
          category: typeof args.category === 'string' ? args.category : undefined,
        });
        if (request.status !== 'pending' || args.wait === false || !context.elicit) {
          return describe(request, !!context.elicit);
        }
        return askHuman(service, request, suggestion, context);
      },
    },
    {
      name: 'check_status',
      description: 'Check whether an approval request has been decided. Proceed only when proceed=true.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'The approval request ID' },
        },
        required: ['id'],
      },
      handler: async (args, context) => {
        const request = await service.getRequest(String(args.id ?? ''));
        if (!request) return { error: `Approval request ${args.id} not found` };
        return describe(request, !!context.elicit);
      },
    },
    {
      name: 'list_pending',
      description: 'List approval requests still waiting for a human, newest first, optionally filtered by risk level.',
      inputSchema: {
        type: 'object',
        properties: {
          riskLevel: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
            description: 'Filter by risk level',
          },
          limit: { type: 'number', description: 'Maximum number of items to return (default 20)' },
        },
      },
      handler: async (args) =>
        service.listPending(
          typeof args.riskLevel === 'string' ? args.riskLevel : undefined,
          typeof args.limit === 'number' ? args.limit : undefined
        ),
    },
    {
      name: 'list_rules',
      description:
        'List the auto-approval rules a human has set. Read-only: rules are created by a human choosing "always approve" or with the CLI.',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({ rules: await service.listRules() }),
    },
  ];
}

/** Put the request in front of the human through the client's own UI. */
async function askHuman(
  service: ApprovalQueueService,
  request: ApprovalRequest,
  suggestion: RuleSuggestion | null,
  context: ToolContext
): Promise<Record<string, unknown>> {
  let answer;
  try {
    answer = await context.elicit!(buildForm(request, suggestion));
  } catch (err) {
    // The client could not show the form (or the human never answered):
    // the request stays pending, decidable from the CLI.
    const reason = err instanceof Error ? err.message : String(err);
    return { ...describe(request, false), note: `Could not ask in the client (${reason}).` };
  }

  if (answer.action === 'cancel') {
    return { ...describe(request, false), note: 'The human dismissed the question without deciding.' };
  }

  const content = (answer.content ?? {}) as Record<string, unknown>;
  const approve = answer.action === 'accept' && content.decision === 'approve';
  const result = await service.decide({
    id: request.id,
    decision: approve ? 'approve' : 'reject',
    reason: typeof content.reason === 'string' && content.reason ? content.reason : undefined,
    alwaysApprove: approve && content.always_approve === true,
    channel: 'elicitation',
  });
  if (result.status === 'refused') {
    return { ...describe(result.request ?? request, false), note: result.error };
  }
  return {
    ...describe(result.request, false),
    ...(result.rule ? { ruleCreated: { id: result.rule.id, actionPattern: result.rule.actionPattern } } : {}),
  };
}

export function buildForm(request: ApprovalRequest, suggestion: RuleSuggestion | null): ElicitationRequest {
  const lines = [
    `An AI agent is asking to run: ${request.action}`,
    `Risk: ${request.riskLevel.toUpperCase()} (${request.category}, score ${request.riskScore})`,
  ];
  if (request.params && Object.keys(request.params).length) {
    lines.push(`Parameters: ${truncate(JSON.stringify(request.params), 1500)}`);
  }
  if (request.context) lines.push(`The agent says: ${truncate(request.context, 1000)}`);
  if (suggestion) {
    lines.push(
      `You have approved "${suggestion.actionPattern}" ${suggestion.humanApprovals} times and never rejected it — consider always approving it.`
    );
  }

  const properties: Record<string, Record<string, unknown>> = {
    decision: {
      type: 'string',
      title: 'Decision',
      enum: ['approve', 'reject'],
      enumNames: ['Approve', 'Reject'],
    },
    reason: { type: 'string', title: 'Reason (optional)' },
  };
  if (RISK_ORDER[request.riskLevel] <= RISK_ORDER.medium) {
    properties.always_approve = {
      type: 'boolean',
      title: `Always approve "${request.action}" from now on`,
      default: false,
    };
  }
  return {
    message: lines.join('\n'),
    requestedSchema: { type: 'object', properties, required: ['decision'] },
  };
}

function describe(request: ApprovalRequest, canAsk: boolean): Record<string, unknown> {
  const proceed = request.status === 'approved' || request.status === 'auto_approved';
  const out: Record<string, unknown> = {
    id: request.id,
    action: request.action,
    status: request.status,
    proceed,
    riskLevel: request.riskLevel,
    riskScore: request.riskScore,
    category: request.category,
    reason: request.reason,
    decidedBy: request.decidedBy,
    expiresAt: request.expiresAt,
  };
  if (request.status === 'pending') {
    out.next = canAsk
      ? 'Waiting for a human. Call request_approval with wait=true to ask them now, or check_status later.'
      : `Waiting for a human to run: npx @opafex/mcp-approval-queue approve ${request.id} (or reject). Do not proceed; call check_status later.`;
  } else if (!proceed) {
    out.next = 'Do not perform this action.';
  }
  return out;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
