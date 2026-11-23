// =============================================================
// hookFailure.test.ts: C2 (Code Mode candidates, owner 23.11). The push guard and the write guard fail CLOSED when the
// hook process itself fails: `"onFailure": "block"` on their PreToolUse command hooks (Claude Code v2.1.295+; since
// v2.1.329 a call from Code Mode runs by default after a hook failure, https://code.claude.com/docs/en/code-mode).
// The read guard and the measurement hooks keep no onFailure. guards.onHookFailure (block | allow, default block) picks
// the value; allow writes the documented "continue".
// =============================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const HF = require('../hookFailure.js');
const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(PLUGIN, f), 'utf8'));

/** script name -> onFailure (undefined when unset), over every event. */
function onFailureByScript(hooks: Record<string, any[]>) {
  const out: Record<string, string | undefined> = {};
  for (const groups of Object.values(hooks ?? {}))
    for (const g of groups ?? [])
      for (const h of g.hooks ?? []) {
        const s = HF.scriptOf(h);
        if (s) out[s] = h.onFailure;
      }
  return out;
}

describe('the shipped hook files', () => {
  it.each(['hooks/hooks.json', 'settings.queue.json'])('%s: push and write guard block on failure, nothing else sets it', (f) => {
    const by = onFailureByScript(readJson(f).hooks);
    expect(by['hook-push-guard.mjs']).toBe('block');
    expect(by['hook-write-guard.mjs']).toBe('block');
    for (const [script, v] of Object.entries(by)) if (!HF.GUARD_SCRIPTS.includes(script)) expect(v, script).toBeUndefined();
    expect(by['hook-read-guard.mjs']).toBeUndefined();
  });
});

describe('the setting', () => {
  it('defaults to block, and anything but allow reads as block', () => {
    expect(HF.settingOf({})).toBe('block');
    expect(HF.settingOf({ guards: { onHookFailure: 'allow' } })).toBe('allow');
    expect(HF.settingOf({ guards: { onHookFailure: 'continue' } })).toBe('block');
    expect(HF.settingOf(null)).toBe('block');
  });

  it('maps block to "block" and allow to the documented "continue"', () => {
    expect(HF.onFailureFor('block')).toBe('block');
    expect(HF.onFailureFor('allow')).toBe('continue');
  });
});

describe('applyOnFailure (the vendored install, setup writes it)', () => {
  const hooks = () => ({
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/scripts/orchestrator/hook-push-guard.mjs'] }] },
      { matcher: 'Read', hooks: [{ type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/scripts/orchestrator/hook-read-guard.mjs'] }] },
      { matcher: 'Write', hooks: [{ type: 'command', command: 'node scripts/orchestrator/hook-write-guard.mjs', onFailure: 'continue' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] },
    ],
  });

  it('block: sets "block" on the two guards only and names what changed', () => {
    const h = hooks();
    expect(HF.applyOnFailure(h, 'block')).toEqual(['hook-push-guard.mjs', 'hook-write-guard.mjs']);
    const by = onFailureByScript(h);
    expect(by).toEqual({ 'hook-push-guard.mjs': 'block', 'hook-read-guard.mjs': undefined, 'hook-write-guard.mjs': 'block' });
    expect(h.PreToolUse[3].hooks[0]).toEqual({ type: 'command', command: 'my-own-hook.sh' });
    expect(HF.applyOnFailure(h, 'block')).toEqual([]);
  });

  it('allow: "continue" on the two guards', () => {
    const h = hooks();
    expect(HF.applyOnFailure(h, 'allow')).toEqual(['hook-push-guard.mjs']);
    expect(onFailureByScript(h)['hook-push-guard.mjs']).toBe('continue');
    expect(onFailureByScript(h)['hook-write-guard.mjs']).toBe('continue');
  });

  it('mismatches names a guard whose onFailure differs from the setting, or is missing', () => {
    expect(HF.mismatches(hooks(), 'block')).toEqual(['hook-push-guard.mjs', 'hook-write-guard.mjs']);
    expect(HF.mismatches(readJson('hooks/hooks.json').hooks, 'block')).toEqual([]);
    expect(HF.mismatches(readJson('hooks/hooks.json').hooks, 'allow')).toEqual(['hook-push-guard.mjs', 'hook-write-guard.mjs']);
  });
});

describe('the doctor line', () => {
  const plugin = readJson('hooks/hooks.json').hooks;
  it('nothing when the hooks match the setting', () => {
    expect(HF.doctorLine({ hooks: plugin, setting: 'block', mode: 'plugin' })).toBeNull();
  });
  it('a vendored install whose guards do not match: WARN with the fix', () => {
    const l = HF.doctorLine({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node', args: ['x/scripts/orchestrator/hook-push-guard.mjs'] }] }] }, setting: 'block', mode: 'vendored' });
    expect(l.status).toBe('WARN');
    expect(l.message).toContain('hook-push-guard.mjs');
    expect(l.fix).toMatch(/install\.mjs/);
  });
  it('a plugin install with allow: INFO, the plugin file stays at block', () => {
    const l = HF.doctorLine({ hooks: plugin, setting: 'allow', mode: 'plugin' });
    expect(l.status).toBe('INFO');
    expect(l.message).toMatch(/plugin/);
  });
});
