/**
 * Risk Assessment Engine
 *
 * Scores proposed actions based on multiple risk factors and maps
 * the composite score to a risk level (low / medium / high / critical).
 *
 * Factors:
 *   - Action category (read, compute, file_write, data_mutation, external_api, payment, delete)
 *   - Reversibility (reversible, partially_reversible, irreversible)
 *   - Estimated cost
 *
 * Composite = weighted average of all applicable factors.
 * Risk levels: 0-0.25 low, 0.25-0.5 medium, 0.5-0.75 high, 0.75+ critical
 *
 * The caller is the agent asking for permission, so nothing it declares may
 * LOWER the score: a declared category only counts when it is riskier than
 * the one inferred from the action name.
 */

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface RiskAssessmentInput {
  action: string;
  category?: string;
  params?: Record<string, unknown>;
}

export interface RiskAssessmentResult {
  riskLevel: RiskLevel;
  score: number;
  category: string;
  factors: RiskFactorResult[];
}

export interface RiskFactorResult {
  name: string;
  value: number;
  weight: number;
  description: string;
}

export const CATEGORIES = [
  'read',
  'compute',
  'file_write',
  'file_system',
  'data_mutation',
  'external_api',
  'payment',
  'delete',
] as const;

export const RISK_ORDER: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };

// ---------------------------------------------------------------------------
// Category scores (0-1)
// ---------------------------------------------------------------------------
const CATEGORY_SCORES: Record<string, number> = {
  read: 0.1,
  compute: 0.2,
  file_write: 0.4,
  file_system: 0.4,
  data_mutation: 0.6,
  external_api: 0.5,
  payment: 0.8,
  delete: 0.9,
};

// ---------------------------------------------------------------------------
// Reversibility scores
// ---------------------------------------------------------------------------
const REVERSIBILITY_SCORES: Record<string, number> = {
  reversible: 0,
  partially_reversible: 0.3,
  irreversible: 0.8,
};

// ---------------------------------------------------------------------------
// Factor weights (how much each factor contributes to the composite)
// ---------------------------------------------------------------------------
const WEIGHT_CATEGORY = 0.5;
const WEIGHT_REVERSIBILITY = 0.3;
const WEIGHT_COST = 0.2;

// ---------------------------------------------------------------------------
// Words in an action name, checked riskiest category first. A word anywhere
// in the name counts — `bulk_delete_users` is a delete, not an unknown.
// ---------------------------------------------------------------------------
const CATEGORY_WORDS: Array<[string, string[]]> = [
  ['delete', ['delete', 'remove', 'drop', 'destroy', 'purge', 'truncate', 'wipe', 'erase', 'rm']],
  ['payment', ['pay', 'payment', 'charge', 'refund', 'transfer', 'invoice', 'payout', 'purchase']],
  ['data_mutation', ['update', 'insert', 'create', 'mutate', 'set', 'modify', 'edit', 'patch', 'migrate']],
  [
    'external_api',
    ['send', 'email', 'post', 'publish', 'deploy', 'push', 'api', 'fetch', 'request', 'external', 'notify', 'message'],
  ],
  ['file_write', ['write', 'save', 'upload', 'move', 'rename', 'copy']],
  ['compute', ['compute', 'calculate', 'test', 'tests', 'lint', 'build', 'format', 'typecheck']],
  ['read', ['read', 'get', 'list', 'query', 'search', 'view', 'show', 'describe', 'check']],
];

/** Split `bulkDelete-users_now` into `bulk delete users now`. */
function words(action: string): string[] {
  return action
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Infer a category from the action string. The riskiest matching category
 * wins. Unknown actions are treated as external_api (medium).
 */
export function inferCategory(action: string): string {
  const tokens = new Set(words(action));
  for (const [category, vocabulary] of CATEGORY_WORDS) {
    if (vocabulary.some((w) => tokens.has(w))) return category;
  }
  return 'external_api';
}

/**
 * Infer reversibility from category.
 */
function inferReversibility(category: string): string {
  switch (category) {
    case 'read':
    case 'compute':
      return 'reversible';
    case 'file_write':
    case 'file_system':
    case 'data_mutation':
    case 'external_api':
      return 'partially_reversible';
    case 'payment':
    case 'delete':
      return 'irreversible';
    default:
      return 'partially_reversible';
  }
}

/**
 * Score the estimated cost (0-1).
 */
function scoreCost(params?: Record<string, unknown>): number {
  const cost = Number(params?.estimatedCost);
  if (!Number.isFinite(cost) || cost <= 0) return 0;
  if (cost < 10) return 0.1;
  if (cost < 100) return 0.3;
  return 0.6;
}

/**
 * Map a composite score to a risk level.
 */
function scoreToLevel(score: number): RiskLevel {
  if (score < 0.25) return 'low';
  if (score < 0.5) return 'medium';
  if (score < 0.75) return 'high';
  return 'critical';
}

/**
 * The category to score: the inferred one, unless the caller declared a
 * known category that is riskier.
 */
function effectiveCategory(action: string, declared?: string): string {
  const inferred = inferCategory(action);
  if (!declared || !(declared in CATEGORY_SCORES)) return inferred;
  return CATEGORY_SCORES[declared] > CATEGORY_SCORES[inferred] ? declared : inferred;
}

/**
 * Assess risk for a proposed action.
 */
export function assessRisk(input: RiskAssessmentInput): RiskAssessmentResult {
  const category = effectiveCategory(input.action, input.category);
  const categoryScore = CATEGORY_SCORES[category];

  const reversibility = inferReversibility(category);
  const reversibilityScore = REVERSIBILITY_SCORES[reversibility];

  const costScore = scoreCost(input.params);

  const factors: RiskFactorResult[] = [
    {
      name: 'category',
      value: categoryScore,
      weight: WEIGHT_CATEGORY,
      description: `Action category: ${category} (score ${categoryScore})`,
    },
    {
      name: 'reversibility',
      value: reversibilityScore,
      weight: WEIGHT_REVERSIBILITY,
      description: `Reversibility: ${reversibility} (score ${reversibilityScore})`,
    },
    {
      name: 'cost',
      value: costScore,
      weight: WEIGHT_COST,
      description: `Estimated cost factor (score ${costScore})`,
    },
  ];

  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  const composite = factors.reduce((sum, f) => sum + f.value * f.weight, 0) / totalWeight;
  const score = Math.round(composite * 1000) / 1000;

  return {
    riskLevel: scoreToLevel(score),
    score,
    category,
    factors,
  };
}
