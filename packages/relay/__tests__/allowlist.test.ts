import { describe, expect, it } from 'vitest';
import { MAX_PARAM_LENGTH, planCommand } from '../src/allowlist.js';
import { ConfigError } from '../src/config.js';
import { config, NODE } from './helpers.js';

const cfg = config({
  commands: [
    {
      id: 'git_status',
      description: 'git status',
      executable: 'git',
      args: ['-C', '{repo}', 'status', '--short', '--branch={branch}', '@{{u}}'],
      params: [
        { name: 'repo', pattern: '[a-z]+' },
        { name: 'branch', pattern: 'main|dev' },
      ],
    },
    { id: 'no_params', description: 'none', executable: NODE, args: ['-v'] },
  ],
});

describe('planCommand: only the machine list decides', () => {
  it('builds argv from the config, one element per placeholder', () => {
    const plan = planCommand(cfg, { id: 'git_status', params: { repo: 'site', branch: 'main' } });
    expect(plan).toEqual(
      expect.objectContaining({ status: 'ok', argv: ['-C', 'site', 'status', '--short', '--branch=main', '@{u}'] }),
    );
  });

  it('refuses a command that is not on the list', () => {
    const plan = planCommand(cfg, { id: 'rm_everything', params: {} });
    expect(plan).toMatchObject({ status: 'refused', code: 'not_on_list' });
  });

  it('refuses ids that only look like keys of an object', () => {
    for (const id of ['__proto__', 'constructor', 'toString', 'GIT_STATUS', 'git_status ']) {
      expect(planCommand(cfg, { id, params: { repo: 'a', branch: 'main' } })).toMatchObject({ status: 'refused', code: 'not_on_list' });
    }
  });

  it('refuses a request with no id or a non-object request', () => {
    expect(planCommand(cfg, null)).toMatchObject({ status: 'refused', code: 'not_on_list' });
    expect(planCommand(cfg, { params: {} })).toMatchObject({ status: 'refused', code: 'not_on_list' });
    expect(planCommand(cfg, 'git_status')).toMatchObject({ status: 'refused', code: 'not_on_list' });
  });

  it('refuses a param the entry does not declare', () => {
    const plan = planCommand(cfg, { id: 'git_status', params: { repo: 'a', branch: 'main', extra: 'x' } });
    expect(plan).toMatchObject({ status: 'refused', code: 'param_mismatch' });
  });

  it('refuses params on a command that takes none', () => {
    expect(planCommand(cfg, { id: 'no_params', params: { x: '1' } })).toMatchObject({ status: 'refused', code: 'param_mismatch' });
    expect(planCommand(cfg, { id: 'no_params' })).toMatchObject({ status: 'ok', argv: ['-v'] });
  });

  it('refuses a missing param', () => {
    expect(planCommand(cfg, { id: 'git_status', params: { repo: 'a' } })).toMatchObject({ status: 'refused', code: 'param_mismatch' });
  });

  it('refuses a value that matches only part of its pattern', () => {
    // An unanchored /main|dev/ would accept these; the whole value must match.
    for (const branch of ['main; rm -rf ~', 'xdev', 'main\n', 'devmain']) {
      expect(planCommand(cfg, { id: 'git_status', params: { repo: 'a', branch } })).toMatchObject({ status: 'refused', code: 'param_mismatch' });
    }
    expect(planCommand(cfg, { id: 'git_status', params: { repo: 'a b', branch: 'main' } })).toMatchObject({ status: 'refused', code: 'param_mismatch' });
  });

  it('refuses non-string values, NUL bytes and over-long values', () => {
    for (const repo of [1, true, ['a'], { a: 1 }, null, 'a\0b', 'a'.repeat(MAX_PARAM_LENGTH + 1)]) {
      expect(planCommand(cfg, { id: 'git_status', params: { repo, branch: 'main' } })).toMatchObject({ status: 'refused', code: 'param_mismatch' });
    }
  });

  it('refuses params that are not an object', () => {
    expect(planCommand(cfg, { id: 'git_status', params: ['site', 'main'] })).toMatchObject({ status: 'refused', code: 'param_mismatch' });
    expect(planCommand(cfg, { id: 'git_status', params: 'repo=site' })).toMatchObject({ status: 'refused', code: 'param_mismatch' });
  });

  it('does not substitute a value that itself looks like a placeholder', () => {
    const c = config({
      commands: [{ id: 'two', description: 'x', executable: NODE, args: ['{a}', '{b}'], params: [{ name: 'a', pattern: '.*' }, { name: 'b', pattern: '.*' }] }],
    });
    expect(planCommand(c, { id: 'two', params: { a: '{b}', b: 'B' } })).toMatchObject({ status: 'ok', argv: ['{b}', 'B'] });
  });
});

describe('config validation guards the list itself', () => {
  const bad = (raw: Record<string, unknown>) => () => config(raw);

  it('refuses a placeholder that is not a declared param', () => {
    expect(bad({ commands: [{ id: 'a', description: 'a', executable: 'git', args: ['{repo}'] }] })).toThrow(/not a declared param/);
  });

  it('refuses placeholders in the executable or the folder', () => {
    expect(bad({ commands: [{ id: 'a', description: 'a', executable: '{x}', params: [{ name: 'x', pattern: '.*' }] }] })).toThrow(/executable is fixed/);
    expect(bad({ commands: [{ id: 'a', description: 'a', executable: 'git', cwd: '/srv/{x}', params: [{ name: 'x', pattern: '.*' }] }] })).toThrow(/cwd is fixed/);
  });

  it('refuses a relative executable path, unknown settings, bad ids and patterns', () => {
    expect(bad({ commands: [{ id: 'a', description: 'a', executable: './run.sh' }] })).toThrow(/absolute path or a bare name/);
    expect(bad({ commands: [{ id: 'a', description: 'a', executable: 'git', arg: ['x'] }] })).toThrow(/unknown setting "arg"/);
    expect(bad({ commands: [{ id: 'Bad-Id', description: 'a', executable: 'git' }] })).toThrow(ConfigError);
    expect(bad({ commands: [{ id: 'a', description: 'a', executable: 'git', params: [{ name: 'x', pattern: '(' }] }] })).toThrow(/does not compile/);
    expect(bad({ commands: [{ id: 'a', description: 'a', executable: 'git', params: [{ name: 'x' }] }] })).toThrow(/pattern is required/);
  });

  it('refuses passing the relay key to anything it runs', () => {
    expect(bad({ commands: [{ id: 'a', description: 'a', executable: 'git', env: ['OPAFEX_RELAY_KEY'] }] })).toThrow(/relay's own key/);
    expect(bad({ mcpServers: [{ id: 'a', command: 'node', env: ['opafex_relay_key'] }] })).toThrow(/relay's own key/);
  });

  it('refuses duplicate ids and more entries than the platform takes', () => {
    expect(bad({ commands: [{ id: 'a', description: 'a', executable: 'git' }, { id: 'a', description: 'b', executable: 'git' }] })).toThrow(/used twice/);
    const many = Array.from({ length: 101 }, (_, i) => ({ id: `c${i}`, description: 'x', executable: 'git' }));
    expect(bad({ commands: many })).toThrow(/limit is 100/);
  });
});
