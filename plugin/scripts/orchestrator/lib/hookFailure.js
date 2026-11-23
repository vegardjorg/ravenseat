// =============================================================
// hookFailure.js: what Claude Code does when the push guard or the write guard ITSELF fails (C2 of the Code Mode
// candidates, owner 23.11; setting guards.onHookFailure).
//
// Why: Claude Code's command hooks take `onFailure` ("continue" or "block", v2.1.295+; docs: code.claude.com/docs/en/
// hooks, "Block the action when a hook fails"). Unset, the action goes ahead on most events when the hook fails or
// times out. Since v2.1.329 that also holds for a call made from Code Mode (code.claude.com/docs/en/code-mode, "Tool
// call refused by a hook"), and the docs say to set "block" on a hook that guards calls. With "block" on a PreToolUse
// hook a failure does what exit code 2 does: the call is refused, with the reason shown to Claude.
//
// A failure here is Claude Code's notion of it: the hook could not start (node missing gives 127), was killed, exited
// with a code other than 0 or 2, timed out (10 s for both guards) or printed invalid output. Both guards already fail
// OPEN on their own internal errors (exit 0, the push guard keeps a no-require fallback deny for forced pushes), so
// "block" changes only the case where the guard process itself breaks. That is the case a guard must not wave through.
//
// The setting: guards.onHookFailure "block" (default) or "allow" ("continue" in the hook). Only the two guards get it;
// the read guard and the measurement hooks (track context, time, effort, ...) keep no onFailure: a broken measurement
// hook must not stop work. The plugin's hooks/hooks.json and settings.queue.json ship "block". A vendored install gets
// the project's value written by setup (setup.mjs mergeSettings). A plugin's hooks.json cannot be changed per project,
// so "allow" in a plugin install has no effect there; doctor says so (doctorLine).
//
// Friction: a broken guard (node missing, a crash before its own catch, a 10 s timeout) now stops Bash, PowerShell,
// Monitor, Write, Edit and NotebookEdit calls with the hook's error instead of letting them run, until the guard is
// fixed. Owner exception to "can stop work = off" (23.11): a guard that fails open guards nothing.
//
// Pure functions, no I/O. Tested in lib/__tests__/hookFailure.test.ts and __tests__/setup.test.ts.
// =============================================================
'use strict';

/** The hook scripts that guard calls: they get onFailure. */
const GUARD_SCRIPTS = Object.freeze(['hook-push-guard.mjs', 'hook-write-guard.mjs']);
/** The setting's values, strongest first. */
const VALUES = Object.freeze(['block', 'allow']);
const DEFAULT = 'block';

/** The queue hook script a hook runs (shell form or exec form), or null. */
function scriptOf(h) {
  const line = [h?.command ?? '', ...(Array.isArray(h?.args) ? h.args : [])].join(' ').replace(/\\/g, '/');
  return /scripts\/orchestrator\/(hook-[\w-]+\.mjs)/.exec(line)?.[1] ?? null;
}

/** guards.onHookFailure from a config object: "allow" or "block" (anything else, or nothing, is block). */
function settingOf(cfg) {
  return cfg?.guards?.onHookFailure === 'allow' ? 'allow' : DEFAULT;
}

/** The hook field value for a setting value: block -> "block", allow -> "continue" (the documented values). */
function onFailureFor(setting) {
  return setting === 'allow' ? 'continue' : 'block';
}

/** Each guard hook in a hooks object ({ Event: [{ hooks: [...] }] }), with its script. */
function* guardHooks(hooks) {
  for (const groups of Object.values(hooks ?? {}))
    for (const g of Array.isArray(groups) ? groups : [])
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        const s = scriptOf(h);
        if (s && GUARD_SCRIPTS.includes(s)) yield [h, s];
      }
}

/**
 * Sets onFailure on the guard hooks to the setting's value. Changes the object in place; returns the scripts whose
 * value changed (sorted, once each), so a second run returns [].
 */
function applyOnFailure(hooks, setting) {
  const want = onFailureFor(setting);
  const changed = new Set();
  for (const [h, s] of guardHooks(hooks))
    if (h.onFailure !== want) {
      h.onFailure = want;
      changed.add(s);
    }
  return [...changed].sort();
}

/** The guard scripts whose onFailure is not the setting's value (or that are missing it), sorted, once each. */
function mismatches(hooks, setting) {
  const want = onFailureFor(setting);
  const out = new Set();
  for (const [h, s] of guardHooks(hooks)) if (h.onFailure !== want) out.add(s);
  return [...out].sort();
}

/**
 * The doctor row, or null when the hooks match the setting.
 *   plugin + allow   INFO: the plugin's hooks.json blocks; allow only takes effect in a vendored install
 *   other mismatch   WARN: the named guards do not block (or continue) as the setting says, with the fix
 * @param {{ hooks: object, setting: string, mode: 'plugin'|'vendored' }} x
 */
function doctorLine({ hooks, setting, mode }) {
  const off = mismatches(hooks, setting);
  if (!off.length) return null;
  if (mode === 'plugin' && setting === 'allow')
    return {
      status: 'INFO',
      message:
        'guards.onHookFailure is allow, but the plugin\'s hooks/hooks.json always blocks a call when the push or write ' +
        'guard itself fails (a plugin cannot change its hooks per project)',
      fix: 'nothing to do; allow only takes effect in a vendored install',
    };
  const want = onFailureFor(setting);
  return {
    status: 'WARN',
    message: `onFailure is not "${want}" (guards.onHookFailure ${setting}) on: ${off.join(', ')}`,
    fix:
      mode === 'plugin'
        ? 'reinstall or update the plugin'
        : 'run node scripts/install.mjs again (setup writes onFailure on the guard hooks in .claude/settings.json)',
  };
}

module.exports = { GUARD_SCRIPTS, VALUES, DEFAULT, scriptOf, settingOf, onFailureFor, applyOnFailure, mismatches, doctorLine };
