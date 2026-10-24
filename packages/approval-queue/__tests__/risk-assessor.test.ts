import { describe, it, expect } from 'vitest';
import { assessRisk, inferCategory } from '../src/risk-assessor.js';

describe('inferCategory', () => {
  it.each([
    ['delete_user', 'delete'],
    ['bulk_delete_users', 'delete'],
    ['purgeCache', 'delete'],
    ['refund_order', 'payment'],
    ['update_record', 'data_mutation'],
    ['send_email', 'external_api'],
    ['deploy_production', 'external_api'],
    ['write_file', 'file_write'],
    ['run_tests', 'compute'],
    ['list_users', 'read'],
    ['frobnicate', 'external_api'],
  ])('%s → %s', (action, category) => {
    expect(inferCategory(action)).toBe(category);
  });

  it('takes the riskiest word when several match', () => {
    // "get" alone is a read; the delete makes it a delete.
    expect(inferCategory('get_and_delete_rows')).toBe('delete');
  });
});

describe('assessRisk', () => {
  it('scores reads low and deletes high', () => {
    expect(assessRisk({ action: 'list_users' }).riskLevel).toBe('low');
    expect(assessRisk({ action: 'delete_user' }).riskLevel).toBe('high');
  });

  it('a declared category cannot lower the risk', () => {
    const declared = assessRisk({ action: 'delete_user', category: 'read' });
    expect(declared.category).toBe('delete');
    expect(declared.riskLevel).toBe('high');
  });

  it('a declared category can raise the risk', () => {
    const declared = assessRisk({ action: 'list_users', category: 'payment' });
    expect(declared.category).toBe('payment');
    expect(declared.riskLevel).toBe('high');
  });

  it('an unknown declared category is ignored', () => {
    expect(assessRisk({ action: 'list_users', category: 'harmless' }).category).toBe('read');
  });

  it('cost raises the score and can make a delete critical', () => {
    expect(assessRisk({ action: 'delete_account', params: { estimatedCost: 500 } }).riskLevel).toBe('critical');
    expect(assessRisk({ action: 'list_users', params: { estimatedCost: 'abc' } }).score).toBe(
      assessRisk({ action: 'list_users' }).score
    );
  });
});
