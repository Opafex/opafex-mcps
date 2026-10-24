import { describe, it, expect } from 'vitest';
import { buildForm } from '../src/tools.js';
import { runCli, parseArgs } from '../src/cli.js';
import { makeService } from './helpers.js';

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) }, out, err };
}

describe('buildForm', () => {
  it('offers "always approve" for medium risk but not for high', async () => {
    const service = makeService();
    const medium = (await service.requestApproval({ action: 'send_email' })).request;
    const high = (await service.requestApproval({ action: 'delete_user' })).request;
    expect(buildForm(medium, null).requestedSchema.properties.always_approve).toBeDefined();
    expect(buildForm(high, null).requestedSchema.properties.always_approve).toBeUndefined();
    expect(buildForm(high, null).requestedSchema.required).toEqual(['decision']);
  });

  it('keeps a long agent-supplied context from swamping the form', async () => {
    const service = makeService();
    const { request } = await service.requestApproval({ action: 'send_email', context: 'x'.repeat(5000) });
    expect(buildForm(request, null).message.length).toBeLessThan(1300);
  });
});

describe('CLI', () => {
  it('lists, approves with --always, and shows the rule', async () => {
    const service = makeService();
    const { request } = await service.requestApproval({ action: 'send_email', context: 'report' });

    const pending = capture();
    expect(await runCli(['pending'], service, pending.io)).toBe(0);
    expect(pending.out[0]).toContain(request.id);

    const approve = capture();
    expect(await runCli(['approve', request.id, '--always', '--reason', 'fine'], service, approve.io)).toBe(0);
    expect(approve.out.join('\n')).toContain('approved');
    expect((await service.getRequest(request.id))?.reason).toBe('fine');

    const rules = capture();
    await runCli(['rules'], service, rules.io);
    expect(rules.out[0]).toContain('send_email');
  });

  it('rejects, and refuses a second decision with exit code 1', async () => {
    const service = makeService();
    const { request } = await service.requestApproval({ action: 'send_email' });
    expect(await runCli(['reject', request.id], service, capture().io)).toBe(0);
    const again = capture();
    expect(await runCli(['approve', request.id], service, again.io)).toBe(1);
    expect(again.err[0]).toContain('already rejected');
  });

  it('adds and removes rules, warning on a catch-all', async () => {
    const service = makeService();
    const add = capture();
    expect(await runCli(['rules', 'add', '*', '--max-risk', 'low'], service, add.io)).toBe(0);
    expect(add.err[0]).toContain('auto-approves every');
    const [rule] = await service.listRules();
    expect(await runCli(['rules', 'remove', rule.id], service, capture().io)).toBe(0);
    expect(await service.listRules()).toHaveLength(0);
  });

  it('refuses a rule above medium', async () => {
    const service = makeService();
    expect(await runCli(['rules', 'add', 'delete_*', '--max-risk', 'high'], service, capture().io)).toBe(1);
    expect(await service.listRules()).toHaveLength(0);
  });

  it('parses flags with and without values', () => {
    expect(parseArgs(['approve', 'x', '--always', '--reason', 'ok'])).toEqual({
      positional: ['approve', 'x'],
      flags: { always: true, reason: 'ok' },
    });
  });
});
