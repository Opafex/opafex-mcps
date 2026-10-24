/**
 * Approval Queue Service
 *
 * Two kinds of caller, and they get different methods:
 *
 *   - The AGENT may request approval and read state. Nothing it can call
 *     approves, rejects or creates a rule — an approval gate the gated party
 *     can open is not a gate.
 *   - A HUMAN decides, through MCP elicitation (the question goes to the
 *     client's UI, not the model) or through the CLI. Only a human can make a
 *     rule, and only a human decision counts towards a rule suggestion: an
 *     auto-approval is the system agreeing with itself.
 *
 * High and critical risk actions are never auto-approved, whatever the rules say.
 */

import { randomBytes } from 'node:crypto';
import { assessRisk, RISK_ORDER, type RiskLevel } from './risk-assessor.js';
import {
  StateStore,
  type ApprovalRequest,
  type AutoApprovalRule,
  type Decision,
  type QueueState,
} from './store.js';

export type { ApprovalRequest, AutoApprovalRule, Decision } from './store.js';

/** Human approvals, with no rejection, before a rule is suggested. */
export const SUGGESTION_THRESHOLD = 5;
const DEFAULT_TTL_HOURS = 24;

export interface RuleSuggestion {
  actionPattern: string;
  maxRisk: 'low' | 'medium';
  humanApprovals: number;
}

export type DecideResult =
  | { status: 'ok'; request: ApprovalRequest; rule?: AutoApprovalRule }
  | { status: 'refused'; error: string; request?: ApprovalRequest };

export interface ServiceOptions {
  /** Hours a pending request waits before it expires. */
  ttlHours?: number;
  now?: () => Date;
}

export class ApprovalQueueService {
  readonly store: StateStore;
  private readonly ttlMs: number;
  private readonly now: () => Date;

  constructor(store: StateStore, options: ServiceOptions = {}) {
    this.store = store;
    this.ttlMs = (options.ttlHours ?? DEFAULT_TTL_HOURS) * 3600 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  // --------------------------------------------------------------------------
  // Agent-facing
  // --------------------------------------------------------------------------

  /**
   * Submit an action for approval. Auto-approved when an active rule matches
   * and the risk is within the rule's ceiling; otherwise held as pending.
   */
  async requestApproval(input: {
    action: string;
    params?: Record<string, unknown>;
    context?: string;
    category?: string;
  }): Promise<{ request: ApprovalRequest; suggestion: RuleSuggestion | null }> {
    const action = input.action.trim();
    if (!action) throw new Error('action is required');

    const risk = assessRisk({ action, category: input.category, params: input.params });
    const now = this.now();

    return this.store.update((state) => {
      this.expire(state);
      const request: ApprovalRequest = {
        id: `appr_${randomBytes(6).toString('hex')}`,
        action,
        params: input.params,
        context: input.context,
        category: risk.category,
        status: 'pending',
        riskLevel: risk.riskLevel,
        riskScore: risk.score,
        requestedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      };

      const rule = findMatchingRule(state.rules, action, risk.riskLevel);
      if (rule) {
        rule.useCount++;
        request.status = 'auto_approved';
        request.decidedAt = request.requestedAt;
        request.decidedBy = `rule:${rule.id}`;
        request.reason = `Auto-approved by rule: ${rule.description}`;
        recordDecision(state, request);
      }

      state.requests.push(request);
      const suggestion = request.status === 'pending' ? suggestRule(state, action, risk.riskLevel) : null;
      return { request, suggestion };
    });
  }

  async getRequest(id: string): Promise<ApprovalRequest | null> {
    const state = await this.store.read();
    const request = state.requests.find((r) => r.id === id) ?? null;
    if (request && request.status === 'pending' && this.isExpired(request)) {
      return { ...request, status: 'expired' };
    }
    return request;
  }

  async listPending(riskLevel?: string, limit = 20): Promise<{ items: ApprovalRequest[]; total: number }> {
    const state = await this.store.read();
    const pending = state.requests
      .filter((r) => r.status === 'pending' && !this.isExpired(r))
      .filter((r) => !riskLevel || r.riskLevel === riskLevel)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
    return { items: pending.slice(0, Math.max(1, limit)), total: pending.length };
  }

  async listRules(): Promise<AutoApprovalRule[]> {
    return (await this.store.read()).rules;
  }

  async suggestionFor(request: ApprovalRequest): Promise<RuleSuggestion | null> {
    return suggestRule(await this.store.read(), request.action, request.riskLevel);
  }

  // --------------------------------------------------------------------------
  // Human-only. Never reachable from an MCP tool.
  // --------------------------------------------------------------------------

  /**
   * Record a human decision. `alwaysApprove` also creates a rule, refused for
   * high/critical risk because such a rule could never fire.
   */
  async decide(input: {
    id: string;
    decision: 'approve' | 'reject';
    reason?: string;
    alwaysApprove?: boolean;
    channel: 'elicitation' | 'cli';
  }): Promise<DecideResult> {
    const now = this.now().toISOString();
    return this.store.update<DecideResult>((state) => {
      this.expire(state);
      const request = state.requests.find((r) => r.id === input.id);
      if (!request) return { status: 'refused', error: `Approval request ${input.id} not found` };
      if (request.status !== 'pending') {
        return { status: 'refused', error: `Request already ${request.status}`, request };
      }
      if (input.alwaysApprove && input.decision !== 'approve') {
        return { status: 'refused', error: 'alwaysApprove only applies to an approval', request };
      }
      if (input.alwaysApprove && RISK_ORDER[request.riskLevel] > RISK_ORDER.medium) {
        return {
          status: 'refused',
          error: `${request.riskLevel} risk actions are never auto-approved, so no rule was created`,
          request,
        };
      }

      request.status = input.decision === 'approve' ? 'approved' : 'rejected';
      request.decidedAt = now;
      request.decidedBy = `human:${input.channel}`;
      request.reason = input.reason || (input.decision === 'approve' ? 'Approved' : 'Rejected');
      recordDecision(state, request);

      let rule: AutoApprovalRule | undefined;
      if (input.alwaysApprove) {
        rule = makeRule({
          actionPattern: request.action,
          maxRisk: request.riskLevel as 'low' | 'medium',
          description: `Always approve "${request.action}"`,
          source: 'always_approve',
        });
        state.rules.push(rule);
      }
      return { status: 'ok', request, rule };
    });
  }

  async addRule(input: {
    actionPattern: string;
    maxRisk: 'low' | 'medium';
    description?: string;
  }): Promise<AutoApprovalRule> {
    if (!input.actionPattern.trim()) throw new Error('actionPattern is required');
    if (input.maxRisk !== 'low' && input.maxRisk !== 'medium') {
      throw new Error('maxRisk must be "low" or "medium"');
    }
    const rule = makeRule({ ...input, source: 'manual' });
    await this.store.update((state) => {
      state.rules.push(rule);
    });
    return rule;
  }

  async removeRule(id: string): Promise<boolean> {
    return this.store.update((state) => {
      const before = state.rules.length;
      state.rules = state.rules.filter((r) => r.id !== id);
      return state.rules.length < before;
    });
  }

  // --------------------------------------------------------------------------
  // Read models (resources)
  // --------------------------------------------------------------------------

  async getStats(): Promise<Record<string, number>> {
    const state = await this.store.read();
    const counts = { pending: 0, approved: 0, rejected: 0, autoApproved: 0, expired: 0 };
    let totalWaitMs = 0;
    let humanDecided = 0;
    for (const r of state.requests) {
      if (r.status === 'pending' && this.isExpired(r)) counts.expired++;
      else if (r.status === 'auto_approved') counts.autoApproved++;
      else counts[r.status]++;
      if (r.decidedAt && r.decidedBy?.startsWith('human:')) {
        totalWaitMs += Date.parse(r.decidedAt) - Date.parse(r.requestedAt);
        humanDecided++;
      }
    }
    return {
      ...counts,
      total: state.requests.length,
      averageHumanWaitMs: humanDecided ? Math.round(totalWaitMs / humanDecided) : 0,
      rulesCount: state.rules.length,
    };
  }

  async getHistory(limit = 50): Promise<Decision[]> {
    return (await this.store.read()).history.slice(-limit).reverse();
  }

  // --------------------------------------------------------------------------
  // Internal
  // --------------------------------------------------------------------------

  private isExpired(request: ApprovalRequest): boolean {
    return Date.parse(request.expiresAt) <= this.now().getTime();
  }

  private expire(state: QueueState): void {
    for (const r of state.requests) {
      if (r.status === 'pending' && this.isExpired(r)) {
        r.status = 'expired';
        r.decidedAt = this.now().toISOString();
        r.decidedBy = 'system';
        r.reason = 'Nobody decided before it expired';
        recordDecision(state, r);
      }
    }
  }
}

// ============================================================================
// Pure helpers
// ============================================================================

function makeRule(input: {
  actionPattern: string;
  maxRisk: 'low' | 'medium';
  description?: string;
  source: AutoApprovalRule['source'];
}): AutoApprovalRule {
  return {
    id: `rule_${randomBytes(4).toString('hex')}`,
    actionPattern: input.actionPattern.trim(),
    maxRisk: input.maxRisk,
    description: input.description || `Auto-approve actions matching "${input.actionPattern.trim()}"`,
    source: input.source,
    useCount: 0,
    createdAt: new Date().toISOString(),
    active: true,
  };
}

/** The first active rule that covers this action at this risk, if any. */
export function findMatchingRule(
  rules: AutoApprovalRule[],
  action: string,
  riskLevel: RiskLevel
): AutoApprovalRule | null {
  if (RISK_ORDER[riskLevel] > RISK_ORDER.medium) return null;
  for (const rule of rules) {
    if (!rule.active) continue;
    if (RISK_ORDER[riskLevel] > RISK_ORDER[rule.maxRisk]) continue;
    if (globMatch(rule.actionPattern, action)) return rule;
  }
  return null;
}

/**
 * Glob matching — `*` (any chars) and `?` (single char), case-insensitive.
 */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[\\s\\S]*')
    .replace(/\?/g, '[\\s\\S]');
  return new RegExp('^' + regexStr + '$', 'i').test(value);
}

/**
 * Suggest a rule after SUGGESTION_THRESHOLD human approvals of this exact
 * action with no human rejection. Auto-approvals do not count.
 */
function suggestRule(state: QueueState, action: string, riskLevel: RiskLevel): RuleSuggestion | null {
  if (RISK_ORDER[riskLevel] > RISK_ORDER.medium) return null;
  if (state.rules.some((r) => r.active && globMatch(r.actionPattern, action))) return null;

  let approvals = 0;
  for (const d of state.history) {
    if (d.action !== action || !d.decidedBy.startsWith('human:')) continue;
    if (d.status === 'rejected') return null;
    if (d.status === 'approved') approvals++;
  }
  if (approvals < SUGGESTION_THRESHOLD) return null;
  return { actionPattern: action, maxRisk: riskLevel as 'low' | 'medium', humanApprovals: approvals };
}

function recordDecision(state: QueueState, request: ApprovalRequest): void {
  if (request.status === 'pending') return;
  state.history.push({
    id: request.id,
    action: request.action,
    category: request.category,
    status: request.status,
    riskLevel: request.riskLevel,
    reason: request.reason,
    decidedAt: request.decidedAt ?? new Date().toISOString(),
    decidedBy: request.decidedBy ?? 'system',
  });
}
