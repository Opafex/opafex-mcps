/**
 * Library entry: use the queue in-process without the MCP server.
 */

export { ApprovalQueueService, findMatchingRule, globMatch, SUGGESTION_THRESHOLD } from './approval-service.js';
export type { ApprovalRequest, AutoApprovalRule, Decision, DecideResult, RuleSuggestion } from './approval-service.js';
export { StateStore, defaultStateDir } from './store.js';
export { assessRisk, inferCategory } from './risk-assessor.js';
export type { RiskLevel, RiskAssessmentResult } from './risk-assessor.js';
export { approvalQueueTools } from './tools.js';
