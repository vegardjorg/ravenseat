// =============================================================
// guidance.js: one switch for the advice Ravenseat gives about the project itself: CI, gates, kickstart, lockfiles.
//
// Why: an experienced user with their own flow should not have to turn the same message off in six places. "quiet" stops
// the advice, the light review, the intake triage and the gate proposals. It never stops a guard: the secret scan, the
// merge guard, the base gate and the limits on agents stay on, and facts stay true (a task with no checks is still stored
// as unverified, and the merge still says so, without the pointer).
//
// Stored in queue.json (`guidance`, ignored by git), like the helper switches: one person's quiet does not silence a
// colleague. Written only by `cq guidance` and the board. A helper's own switch wins over this one.
// Tested in lib/__tests__/guidance.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MODES = ['guided', 'quiet'];
/** The helpers that are off in quiet unless their own switch says otherwise. */
const QUIET_HELPERS = ['reviewer-light', 'triage'];
/** The doctor lines that are advice. Only their WARN and INFO rows go: a FAIL is a real fault and always shows. */
const ADVICE_CHECKS = ['ci', 'ci-cost', 'gates', 'lockfile'];

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

/** The doctor rows split into what shows and how many advice rows went. */
function filterDoctor(rows, quiet) {
  if (!quiet) return { rows, hidden: 0 };
  const shown = rows.filter((c) => !(ADVICE_CHECKS.includes(c.name) && (c.status === 'WARN' || c.status === 'INFO')));
  return { rows: shown, hidden: rows.length - shown.length };
}

module.exports = { MODES, QUIET_HELPERS, ADVICE_CHECKS, modeOf, isQuiet, readQuiet, filterDoctor };
