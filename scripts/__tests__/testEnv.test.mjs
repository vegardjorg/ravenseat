// =============================================================
// testEnv.test.mjs: the environment the vitest config adds for the test run (scripts/test-env.mjs).
//
// Why: the tests start thousands of node and git processes. A compile cache lets the node children reuse compiled code,
// and a few git settings keep git from doing background work. Both are set ONLY through the environment of the test run,
// never in anyone's git config, and never over a value the developer set. These tests pin that.
// =============================================================
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { testEnv } from '../test-env.mjs';

const TMP = path.join('/tmp', 'x');

describe('testEnv', () => {
  it('node 22.1 and later: NODE_COMPILE_CACHE in a folder under the temp folder', () => {
    const add = testEnv({}, { nodeVersion: '22.1.0', tmpdir: TMP });
    expect(add.NODE_COMPILE_CACHE).toBe(path.join(TMP, 'ravenseat-node-compile-cache'));
    expect(testEnv({}, { nodeVersion: '24.16.0', tmpdir: TMP }).NODE_COMPILE_CACHE).toBeDefined();
  });

  it('older node (20, 22.0): no compile cache', () => {
    expect(testEnv({}, { nodeVersion: '20.19.0', tmpdir: TMP }).NODE_COMPILE_CACHE).toBeUndefined();
    expect(testEnv({}, { nodeVersion: '22.0.0', tmpdir: TMP }).NODE_COMPILE_CACHE).toBeUndefined();
  });

  it('a compile cache the developer set (or switched off) is kept', () => {
    expect(testEnv({ NODE_COMPILE_CACHE: '/mine' }, { nodeVersion: '22.5.0', tmpdir: TMP }).NODE_COMPILE_CACHE).toBeUndefined();
    expect(testEnv({ NODE_DISABLE_COMPILE_CACHE: '1' }, { nodeVersion: '22.5.0', tmpdir: TMP }).NODE_COMPILE_CACHE).toBeUndefined();
  });

  it('git settings through GIT_CONFIG_COUNT/KEY/VALUE only: no gc, no maintenance, no signing', () => {
    const add = testEnv({}, { nodeVersion: '22.5.0', tmpdir: TMP });
    expect(add.GIT_CONFIG_COUNT).toBe('3');
    const pairs = Object.fromEntries([0, 1, 2].map((i) => [add[`GIT_CONFIG_KEY_${i}`], add[`GIT_CONFIG_VALUE_${i}`]]));
    expect(pairs).toEqual({ 'gc.auto': '0', 'maintenance.auto': 'false', 'commit.gpgsign': 'false' });
  });

  it('settings the developer already passes through GIT_CONFIG_COUNT are kept; ours come after them', () => {
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.editor', GIT_CONFIG_VALUE_0: 'vi' };
    const add = testEnv(env, { nodeVersion: '22.5.0', tmpdir: TMP });
    expect(add.GIT_CONFIG_COUNT).toBe('4');
    expect(add.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(add.GIT_CONFIG_KEY_1).toBe('gc.auto');
    expect(add.GIT_CONFIG_KEY_3).toBe('commit.gpgsign');
  });

  it('a git key the developer already sets is not set twice', () => {
    const env = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'true' };
    const add = testEnv(env, { nodeVersion: '22.5.0', tmpdir: TMP });
    expect(add.GIT_CONFIG_COUNT).toBe('3');
    expect(Object.entries(add).filter(([k, v]) => k.startsWith('GIT_CONFIG_KEY_') && v === 'commit.gpgsign')).toEqual([]);
  });

  it('RAVENSEAT_TEST_ENV=off adds nothing', () => {
    expect(testEnv({ RAVENSEAT_TEST_ENV: 'off' }, { nodeVersion: '22.5.0', tmpdir: TMP })).toEqual({});
  });

  it('never touches the system or global git config (no GIT_CONFIG_NOSYSTEM, no GIT_CONFIG_GLOBAL)', () => {
    const add = testEnv({}, { nodeVersion: '22.5.0', tmpdir: TMP });
    expect(add.GIT_CONFIG_NOSYSTEM).toBeUndefined();
    expect(add.GIT_CONFIG_GLOBAL).toBeUndefined();
  });
});
