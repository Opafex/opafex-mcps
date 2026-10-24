import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalQueueService, SUGGESTION_THRESHOLD, globMatch } from '../src/approval-service.js';
import { StateStore } from '../src/store.js';
import { makeService, tempDir } from './helpers.js';

async function approveOnce(service: ApprovalQueueService, action: string) {
  const { request } = await service.requestApproval({ action });
  await service.decide({ id: request.id, decision: 'approve', channel: 'cli' });
}

describe('requestApproval', () => {
  it('holds an action with no matching rule as pending', async () => {
    const service = makeService();
    const { request } = await service.requestApproval({ action: 'send_email', context: 'weekly report' });
    expect(request.status).toBe('pending');
    expect(request.id).toMatch(/^appr_[0-9a-f]{12}$/);
    expect((await service.listPending()).total).toBe(1);
  });

  it('auto-approves when a rule covers the action and risk', async () => {
    const service = makeService();
    await service.addRule({ actionPattern: 'send_*', maxRisk: 'medium' });
    const { request } = await service.requestApproval({ action: 'send_email' });
    expect(request.status).toBe('auto_approved');
    expect(request.decidedBy).toMatch(/^rule:/);
    expect((await service.listRules())[0].useCount).toBe(1);
  });

  it('never auto-approves high risk, even under a catch-all rule', async () => {
    const service = makeService();
    await service.addRule({ actionPattern: '*', maxRisk: 'medium' });
    const { request } = await service.requestApproval({ action: 'delete_user' });
    expect(request.riskLevel).toBe('high');
    expect(request.status).toBe('pending');
  });

  it('never auto-approves high risk, even from a hand-edited rule with a high ceiling', async () => {
    const dir = tempDir();
    const service = makeService({}, dir);
    await service.store.update((state) => {
      state.rules.push({
        id: 'rule_forged',
        actionPattern: '*',
        maxRisk: 'high' as 'medium',
        description: 'edited in by hand',
        source: 'manual',
        useCount: 0,
        createdAt: new Date().toISOString(),
        active: true,
      });
    });
    const { request } = await service.requestApproval({ action: 'delete_user' });
    expect(request.status).toBe('pending');
  });

  it('does not let a rule with a low ceiling cover a medium action', async () => {
    const service = makeService();
    await service.addRule({ actionPattern: 'send_email', maxRisk: 'low' });
    const { request } = await service.requestApproval({ action: 'send_email' });
    expect(request.status).toBe('pending');
  });

  it('refuses an empty action', async () => {
    await expect(makeService().requestApproval({ action: '  ' })).rejects.toThrow('action is required');
  });
});

describe('decide (human only)', () => {
  it('approves and rejects once, then refuses a second decision', async () => {
    const service = makeService();
    const { request } = await service.requestApproval({ action: 'send_email' });
    const first = await service.decide({ id: request.id, decision: 'reject', reason: 'no', channel: 'cli' });
    expect(first.status).toBe('ok');
    const second = await service.decide({ id: request.id, decision: 'approve', channel: 'cli' });
    expect(second).toMatchObject({ status: 'refused', error: 'Request already rejected' });
    expect((await service.getRequest(request.id))?.decidedBy).toBe('human:cli');
  });

  it('alwaysApprove creates a rule that auto-approves the next request', async () => {
    const service = makeService();
    const { request } = await service.requestApproval({ action: 'send_email' });
    const result = await service.decide({ id: request.id, decision: 'approve', alwaysApprove: true, channel: 'elicitation' });
    expect(result.status === 'ok' && result.rule?.source).toBe('always_approve');
    const next = await service.requestApproval({ action: 'send_email' });
    expect(next.request.status).toBe('auto_approved');
  });

  it('refuses alwaysApprove on a high risk action, and leaves it pending', async () => {
    const service = makeService();
    const { request } = await service.requestApproval({ action: 'delete_user' });
    const result = await service.decide({ id: request.id, decision: 'approve', alwaysApprove: true, channel: 'cli' });
    expect(result.status).toBe('refused');
    expect((await service.listRules()).length).toBe(0);
    expect((await service.getRequest(request.id))?.status).toBe('pending');
  });

  it('reports an unknown id', async () => {
    const result = await makeService().decide({ id: 'appr_nope', decision: 'approve', channel: 'cli' });
    expect(result).toMatchObject({ status: 'refused' });
  });
});

describe('expiry', () => {
  it('a pending request expires after its TTL and can no longer be approved', async () => {
    let now = new Date('2026-01-01T00:00:00Z');
    const service = makeService({ ttlHours: 1, now: () => now });
    const { request } = await service.requestApproval({ action: 'send_email' });
    now = new Date('2026-01-01T02:00:00Z');
    expect((await service.getRequest(request.id))?.status).toBe('expired');
    expect((await service.listPending()).total).toBe(0);
    const result = await service.decide({ id: request.id, decision: 'approve', channel: 'cli' });
    expect(result).toMatchObject({ status: 'refused', error: 'Request already expired' });
  });
});

describe('rule suggestion', () => {
  it(`suggests a rule after ${SUGGESTION_THRESHOLD} human approvals and no rejection`, async () => {
    const service = makeService();
    for (let i = 0; i < SUGGESTION_THRESHOLD; i++) await approveOnce(service, 'send_email');
    const { suggestion } = await service.requestApproval({ action: 'send_email' });
    expect(suggestion).toEqual({ actionPattern: 'send_email', maxRisk: 'medium', humanApprovals: SUGGESTION_THRESHOLD });
  });

  it('one human rejection cancels the suggestion', async () => {
    const service = makeService();
    for (let i = 0; i < SUGGESTION_THRESHOLD; i++) await approveOnce(service, 'send_email');
    const { request } = await service.requestApproval({ action: 'send_email' });
    await service.decide({ id: request.id, decision: 'reject', channel: 'cli' });
    expect((await service.requestApproval({ action: 'send_email' })).suggestion).toBeNull();
  });

  it('auto-approvals do not count towards a suggestion', async () => {
    const service = makeService();
    const rule = await service.addRule({ actionPattern: 'send_email', maxRisk: 'medium' });
    for (let i = 0; i < SUGGESTION_THRESHOLD + 2; i++) await service.requestApproval({ action: 'send_email' });
    await service.removeRule(rule.id);
    expect((await service.requestApproval({ action: 'send_email' })).suggestion).toBeNull();
  });
});

describe('persistence', () => {
  it('a second service on the same directory sees rules, pending requests and decisions', async () => {
    const dir = tempDir();
    const server = makeService({}, dir);
    const cli = makeService({}, dir);

    await cli.addRule({ actionPattern: 'read_*', maxRisk: 'low' });
    const { request } = await server.requestApproval({ action: 'send_email' });
    expect((await cli.listPending()).items.map((r) => r.id)).toEqual([request.id]);

    await cli.decide({ id: request.id, decision: 'approve', channel: 'cli' });
    expect((await server.getRequest(request.id))?.status).toBe('approved');
    expect((await server.listRules()).map((r) => r.actionPattern)).toEqual(['read_*']);
  });

  it('concurrent writers do not lose requests', async () => {
    const dir = tempDir();
    const a = makeService({}, dir);
    const b = makeService({}, dir);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).requestApproval({ action: `send_${i}` }))
    );
    expect((await a.listPending(undefined, 100)).total).toBe(20);
  });

  it('refuses to treat a corrupt state file as an empty queue', async () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'state.json'), '{not json');
    const service = new ApprovalQueueService(new StateStore(dir));
    await expect(service.listPending()).rejects.toThrow('not valid JSON');
  });
});

describe('globMatch', () => {
  it.each([
    ['send_*', 'send_email', true],
    ['send_?mail', 'send_email', true],
    ['SEND_EMAIL', 'send_email', true],
    ['read_*', 'delete_all', false],
    ['a.b', 'axb', false],
  ])('%s vs %s → %s', (pattern, value, expected) => {
    expect(globMatch(pattern, value)).toBe(expected);
  });
});
