// =============================================================
// guidance.js: one switch for the advice Ravenseat gives about the project itself: CI, gates, kickstart, lockfiles,
// the daily budget.
//
// Why: an experienced user with their own flow should not have to turn the same message off in six places. "quiet" stops
// the advice, the light review, the intake triage and the gate proposals. It never stops a guard: the secret scan, the
// merge guard, the base gate and the limits on agents stay on, and facts stay true (a task with no checks is still stored
// as unverified, and the merge still says so, without the pointer).
//
// Stored in queue.json (`guidance`, ignored by git), like the helper switches: one person's quiet does not silence a
// colleague. Written only by `ravenseat guidance` and the board. A helper's own switch wins over this one.
// Tested in lib/__tests__/guidance.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MODES = ['guided', 'quiet'];
/** The helpers that are off in quiet unless their own switch says otherwise. */
const QUIET_HELPERS = ['reviewer-light', 'triage'];
/** The doctor lines that are advice. Only their WARN and INFO rows go: a FAIL is a real fault and always shows. */
// `instructions` (the size of Claude's instructions) is advice; `instructions-cut` is not on the list: that a file is cut is a
// fact of Claude Code, so it shows in quiet too.
const ADVICE_CHECKS = ['ci', 'ci-cost', 'gates', 'lockfile', 'budget', 'instructions'];

const modeOf = (queue) => (queue?.guidance === 'quiet' ? 'quiet' : 'guided');
const isQuiet = (queue) => modeOf(queue) === 'quiet';

/** For the places that have no queue at hand (the push hook, push-check, doctor). Unreadable: guided, so advice shows. */
function readQuiet(folder) {
  try {
    return isQuiet(JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')));
  } catch {
    return false;
  }
}

/**
 * Is the Checks tab on (`ravenseat checks`, stored as queue.checksPanel.mode)? Its own switch wins, as a helper's does: without
 * one it follows the guidance, so someone who runs their own setup does not get suggestions.
 */
function checksPanelOn(queue) {
  const mode = queue?.checksPanel?.mode;
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  return !isQuiet(queue);
}

/** Doctor lines nobody asked for: tuning of the project's CI bill. Only `ravenseat doctor --all` shows them, in every mode. */
const ON_REQUEST_CHECKS = ['ci-cost'];

/**
 * The doctor rows split into what shows and how many advice rows quiet took. A line shown only on request is not counted:
 * it is off, not hidden. --all shows every row.
 */
function filterDoctor(rows, quiet, { all = false } = {}) {
  if (all) return { rows, hidden: 0 };
  const asked = rows.filter((c) => !(ON_REQUEST_CHECKS.includes(c.name) && c.status !== 'FAIL'));
  if (!quiet) return { rows: asked, hidden: 0 };
  const shown = asked.filter((c) => !(ADVICE_CHECKS.includes(c.name) && (c.status === 'WARN' || c.status === 'INFO')));
  return { rows: shown, hidden: asked.length - shown.length };
}

module.exports = { MODES, QUIET_HELPERS, ADVICE_CHECKS, ON_REQUEST_CHECKS, modeOf, isQuiet, readQuiet, checksPanelOn, filterDoctor };
