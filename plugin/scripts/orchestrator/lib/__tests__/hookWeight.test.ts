// =============================================================
// hookWeight.test.ts: the hooks that run on every tool call of a track do not load the whole queue logic (review
// 2026-11-11, E1).
//
// Why: hook-track-context.mjs runs on PostToolUse for every tool call, hook-track-end.mjs at every track stop, and each
// starts a fresh node. lib/contextGuard.js required lib/queueLogic.js at the top for one function the track hooks never
// call (orchestratorBinding), which loaded about 35 modules and cost some 70 ms per call, times the tool calls of every
// parallel track. Each case loads, in a fresh process, the modules such a hook requires before its work, and fails when
// queueLogic.js ends up in require.cache.
// =============================================================
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..', '..');

/** The modules loaded in a fresh node, as paths relative to the orchestrator folder. */
function loaded(modules: string[]): string[] {
  const code =
    `for (const m of ${JSON.stringify(modules)}) require(require('node:path').join(${JSON.stringify(ROOT)}, m));` +
    `process.stdout.write(JSON.stringify(Object.keys(require.cache)));`;
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  expect(r.status, r.stderr).toBe(0);
  return (JSON.parse(r.stdout) as string[]).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
}

describe('a hot track hook stays light', () => {
  it('hook-track-context.mjs (every tool call): its modules do not load queueLogic.js', () => {
    const mods = loaded([
      'lib/productNames.js',
      'lib/projectRoot.js',
      'lib/trackGuard.js',
      'lib/contextGuard.js',
      'readHint.js',
      'lib/queueConfig.js',
      'lib/timeCost.js',
      'lib/timeLogRows.js',
      'lib/stateSweep.js',
    ]);
    expect(mods).not.toContain('lib/queueLogic.js');
  });

  it('hook-track-end.mjs (every track stop): the same', () => {
    expect(loaded(['lib/projectRoot.js', 'lib/contextGuard.js', 'lib/trackGuard.js', 'lib/queueConfig.js', 'lib/stateSweep.js'])).not.toContain(
      'lib/queueLogic.js',
    );
  });

  it('the instruction notice (hook-context.mjs, every prompt) loads no other module of ours', () => {
    // A cache hit is only a stat per path (instructionNotice.test.ts counts the measurements); the modules stay built-ins.
    expect(loaded(['lib/instructionNotice.js', 'lib/instructionSize.js']).sort()).toEqual([
      'lib/instructionNotice.js',
      'lib/instructionSize.js',
    ]);
  });

  it('the hook payload reader (every hook asks clientFor().hooks) loads only the registry, the adapter and hookInput.js', () => {
    // 0w W2c: the adapter loads dispatch.js (and lib/logic/base.js) on first use, so a hook does not pay for them.
    const code =
      `require(require('node:path').join(${JSON.stringify(ROOT)}, 'lib/clients/index.js')).clientFor().hooks.read({});` +
      `process.stdout.write(JSON.stringify(Object.keys(require.cache)));`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    expect(r.status, r.stderr).toBe(0);
    const mods = (JSON.parse(r.stdout) as string[]).map((f) => path.relative(ROOT, f).replace(/\\/g, '/')).sort();
    expect(mods).toEqual(['lib/clients/claude/hookInput.js', 'lib/clients/claude/index.js', 'lib/clients/index.js']);
  });

  it('the transcript row reader (clientFor().entries, 0w W2b1) loads only the registry, the adapter and entries.js', () => {
    const code =
      `require(require('node:path').join(${JSON.stringify(ROOT)}, 'lib/clients/index.js')).clientFor().entries.entry({});` +
      `process.stdout.write(JSON.stringify(Object.keys(require.cache)));`;
    const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    expect(r.status, r.stderr).toBe(0);
    const mods = (JSON.parse(r.stdout) as string[]).map((f) => path.relative(ROOT, f).replace(/\\/g, '/')).sort();
    expect(mods).toEqual(['lib/clients/claude/entries.js', 'lib/clients/claude/index.js', 'lib/clients/index.js']);
  });

  it('orchestratorBinding still works when it loads the queue logic itself', () => {
    const KV = require(path.join(ROOT, 'lib', 'contextGuard.js'));
    // A cursor and a session: the binding reaches orchestratorStatus, which lives in queueLogic.js.
    expect(KV.orchestratorBinding({ cursor: {}, sessionId: 's', lastCall: null })).toEqual({
      orchestrator: false,
      cursor: {},
      changed: false,
    });
  });
});
