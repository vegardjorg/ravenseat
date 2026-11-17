// =============================================================
// settingsRegistry.js: one row per setting, the single list the board, the CLI, the docs and doctor are meant to read.
//
// Why: the settings live in five places (queue.config.json, queue.json limits and switches, environment variables,
// browser storage) with explanations in three (code comments, the example file, queue.md), and those had drifted. The
// design is plans/innstillinger-vurdering-2026-11-12.md (owner decision 2026-11-12: as recommended). This file is step
// 3 of it: the rows. lib/settingsView.js reads them for `ravenseat settings` (cli/settings.mjs, with the shared writer
// `settings set`) and for the board's grouped panel (/api/settings, /api/setting); the doctor row comes later.
//
// A row:
//   key            the path inside the file `store` names: "push.mode" in queue.config.json, "limits.maxConcurrent" or
//                  "guidance" in queue.json. A key under features keeps its dot ("features.plans.legal").
//   category       one of CATEGORIES (the twelve groups, each with its basic settings first, the advanced ones under)
//   level          'basic' | 'advanced' (advanced shows the visible label LABELS.advanced, folded in its category)
//   modes          ['lite', 'full'] or ['full'] (full only: lite hides it behind one line, LABELS.fullOnly)
//   fullWhy        one line why a full-only row means nothing in lite; null otherwise
//   store          'config' (queue.config.json, the project's, committed) | 'queue' (queue.json, one person's).
//                  Where the board and the CLI write it; for helpers, board switches and auto-accept the queue.json value
//                  wins over the one in queue.config.json.
//   edit           'set' (a command or the board can write it) | 'file' (lists, objects, commands: edit the file)
//                  | 'read' (shown, never written)
//   type           'onoff' | 'integer' | 'number' | 'text' | 'choice' | 'list' | 'object' (covers its subtree)
//   title, explanation  the short name and one or two sentences, in English
//   defaultByMode  { lite, full } when the default follows the mode (gitSurface, dependencyFiles); else null
//   choices        the values of a choice row, strongest first; else null
//   weakens        (value, standard) => true when the value gives less protection than the standard; else null
//   protects, whyNot, changes  the three texts of the warning dialog, the CLI warning and doctor; required with weakens
//
// INTERNAL lists keys in STANDARD that are not settings a person changes (empty today). QUEUE_ONLY lists the queue.json
// keys that have no counterpart in STANDARD. The coverage test (lib/__tests__/settingsRegistry.test.ts) fails when a key
// in STANDARD, a limit, a cloud setting, a board switch or a module has no row.
//
// Owner decisions B1-B5 (plans/ROADMAP.md): B1 (agentPushBlock.enabled), B2 (gateEvidence.mode, .external: gates,
// advanced, both modes, choices own/external/off, external and off weaken) and B3 (agentGuard.enabled, .except) have
// their rows, and so does B4 (ownership.sharedPatchCollides: guards, advanced, full only because shared_patch is the full
// task format, weakens when false). Owner decision 2026-11-12 also made `mode lite` (switching a full project) and
// `cloud.collect auto` confirmed weakenings; `guidance quiet` and `kickstart gates` are not. The rest get their rows in
// the same task that adds the key to STANDARD (the coverage test turns red until it does). B5 (history.rotateTimeLog,
// .archiveDoneAfterDays: history, advanced, both modes) has its rows too: performance, not a guard, so turning either
// off is an INFO line in doctor (lib/settingsView.js historyLines), never a weakening.
// Also later: the environment variables (QUEUE_LOAD_ADAPTIVE, QUEUE_GATE_QUEUE, CONTEXT_BLOCK_OTHERS, the context limits,
// DISABLE_UPDATES, TZ) as read-only rows, and the per-viewer browser choices (theme, mascot) if the board lists them.
//
// Pure data and small pure functions. Tested in lib/__tests__/settingsRegistry.test.ts.
// =============================================================
'use strict';

/** The visible labels (the owner wants advanced marked, inside each category, not in a pile of its own). */
const LABELS = Object.freeze({ advanced: 'Advanced', fullOnly: 'Full mode only' });

/** The twelve categories, in the order they are shown. */
const CATEGORIES = Object.freeze([
  { id: 'project', title: 'Project and git' },
  { id: 'limits', title: 'Limits and cost' },
  { id: 'load', title: 'Machine load' },
  { id: 'gates', title: 'Gates and checks' },
  { id: 'guards', title: 'Agent guards' },
  { id: 'push', title: 'Merge and push' },
  { id: 'private', title: 'Private and sharing' },
  { id: 'review', title: 'Review and agents' },
  { id: 'board', title: 'Board and advice' },
  { id: 'cloud', title: 'Cloud' },
  { id: 'plans', title: 'Plans and focus' },
  { id: 'history', title: 'History and storage' },
]);

/** Keys in STANDARD that are not settings (none today; a key goes here only with a comment saying why). */
const INTERNAL = Object.freeze([]);

/** queue.json keys with no counterpart in STANDARD (the limits are checked against LIMIT_NAME and LIMIT_EXTRA instead). */
const QUEUE_ONLY = Object.freeze(['guidance', 'checksPanel.mode', 'checksPanel.marker']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- weakens: small builders ----------------------------------------------------------------------

/** Weakens when the value is false and the standard is not (a guard switched off). */
const offWeakens = (v, std) => v === false && std !== false;

/** Weakens when the value is true and the standard is not (something that skips the owner switched on). */
const onWeakens = (v, std) => v === true && std !== true;

/** Weakens when the value is later than the standard in `order` (strongest first). Unknown values never weaken here. */
const rankWeakens = (order) => (v, std) => {
  const a = order.indexOf(v);
  const b = order.indexOf(std);
  return a >= 0 && b >= 0 && a > b;
};

/**
 * Weakens when the paths leave out an entry of the standard list that is not in the floor (lib/mergeGuard.js
 * CORE_PROTECTED, which holds whatever the list says). The value is a list or the object form { add, remove }, read as
 * config() reads it; a malformed object gives the defaults, so it weakens nothing. Compared without case.
 */
function listLosesEntries(v, std) {
  if (!Array.isArray(std)) return false;
  const MG = require('./mergeGuard.js'); // lazily: mergeGuard reads queueConfig, which this file must not load first
  const list = Array.isArray(v) ? v : isObject(v) ? MG.resolveProtectedPaths(v, std).list : null;
  if (!list) return false;
  const have = new Set(list.map((p) => String(p).toLowerCase()));
  return std.some((p) => !have.has(String(p).toLowerCase()) && !MG.inFloor(p));
}

/** Weakens when a class gets fewer of its default reviewers (a class left out keeps the default, as merge() does). */
function fewerReviewers(v, std) {
  if (!isObject(std)) return false;
  const own = isObject(v) ? v : {};
  return Object.entries(std).some(([cls, names]) => {
    const list = Array.isArray(own[cls]) ? own[cls] : names;
    return (Array.isArray(names) ? names : []).some((n) => !list.includes(n));
  });
}

// ---- the rows -----------------------------------------------------------------------------------

const BOTH = Object.freeze(['lite', 'full']);
const FULL = Object.freeze(['full']);

/** One row with the defaults filled in: advanced, both modes, queue.config.json, settable, no warning texts. */
function row(key, category, type, title, explanation, o = {}) {
  return Object.freeze({
    key,
    category,
    level: o.level ?? 'advanced',
    modes: o.fullWhy ? FULL : BOTH,
    fullWhy: o.fullWhy ?? null,
    store: o.store ?? 'config',
    edit: o.edit ?? (['list', 'object'].includes(type) ? 'file' : 'set'),
    type,
    title,
    explanation,
    defaultByMode: o.defaultByMode ?? null,
    choices: o.choices ?? null,
    weakens: o.weakens ?? null,
    protects: o.weakens ? o.protects : null,
    whyNot: o.weakens ? o.whyNot : null,
    changes: o.weakens ? o.changes : null,
    // A number that also takes none (null) although its default is a number (parseValue).
    nullable: o.nullable === true,
  });
}

const BASIC = { level: 'basic' };
const QUEUE = { store: 'queue' };
const WHY_ONE_TYPE = 'lite has one task type (class K)';
const WHY_ONE_DOMAIN = 'lite has one domain (general)';
const WHY_PLANS = 'lite uses the plan register as a plain list; areas, documents and rules are full mode structure';

const SETTINGS = Object.freeze([
  // ---- 1. Project and git ----
  // Owner decision 2026-11-12: switching a full project to lite is a confirmed weakening (lite softens gitSurface and
  // dependencyFiles, lib/queueConfig.js resolveOwn). A new project's first lite (`ravenseat init`) is not a switch and
  // never asks (cli/tasks.mjs cmdInit). The lite state itself is named by doctor's lite INFO line, not as a weakened
  // guard (lib/settingsView.js SWITCH_ONLY), so a new user is not told on day one that a guard is weakened.
  row('mode', 'project', 'choice', 'Mode',
    'Lite runs the core loop with one task type; full adds classes, focus, the batch queue and deeper review. ' +
    'Switch with `ravenseat mode lite|full`.', {
      ...BASIC,
      choices: ['full', 'lite'],
      weakens: rankWeakens(['full', 'lite']),
      protects: 'A changed git hook or git setting and a changed dependency file going through with only a warning.',
      whyNot: 'Lite softens gitSurface and dependencyFiles from stop to warn, unless queue.config.json sets them, so a hook ' +
        'or a new library a track added no longer stops receive and merge.',
      changes: 'gitSurface and dependencyFiles warn instead of stop (unless the file sets them), and the full task format ' +
        'is put away. Doctor will report what lite softens.',
    }),
  row('projectName', 'project', 'text', 'Project name', 'The name used in missions, agent messages and on the board.',
    BASIC),
  row('baseBranch', 'project', 'text', 'Base branch',
    'The integration branch: every track is merged here, and this is what is pushed in batches.',
    { ...BASIC, edit: 'read' }),
  row('remote', 'project', 'text', 'Remote', 'The remote used for push and for cloud sessions.'),
  row('branchPrefix', 'project', 'text', 'Branch prefix', 'Queue tasks run on branches named <prefix><task id>.'),
  row('productionBranch', 'project', 'text', 'Production branch',
    'The branch that goes live. Doctor warns when it is the same as the base branch. Empty = unknown.'),
  row('sharedLinks', 'project', 'list', 'Shared folders',
    'Folders linked into each agent worktree instead of being installed again (node_modules by default).'),
  row('excludeBranches', 'project', 'list', 'Branches outside the queue',
    'Branches never counted as queue branches, in addition to the base branch.'),
  row('identity.allow', 'project', 'list', 'Accepted test-like identities',
    'Git addresses the identity guard accepts although they look like a test identity. A missing identity is refused.'),
  row('dataFolder', 'project', 'text', 'Data folder',
    'Where the queue, the plan register and the logs live, relative to the project root (gitignored).', { edit: 'file' }),
  row('timeLog', 'project', 'text', 'Time log', 'The file the time hook writes usage per agent to.', { edit: 'file' }),
  row('largeFileMb', 'project', 'number', 'Large file limit (MB)', 'Doctor warns about tracked files larger than this.'),

  // ---- 2. Limits and cost ----
  row('limits.maxConcurrent', 'limits', 'integer', 'Concurrent tracks',
    'How many agents the queue runs at once. Picked tasks do not count.', { ...BASIC, ...QUEUE }),
  row('limits.dailyBudget', 'limits', 'text', 'Daily quota (USD)',
    'When today\'s usage (API equivalent) reaches the quota, no new tasks start. "off" = no quota.',
    { ...BASIC, ...QUEUE }),
  row('limits.nightRun', 'limits', 'onoff', 'Night run',
    'Off: no new tasks start in the night window. What is running runs to completion.', { ...BASIC, ...QUEUE }),
  row('limits.nightWindow', 'limits', 'text', 'Night window (local time)',
    'The hours the night pause applies, like "23-06" (from 23:00 to 06:00).', { ...BASIC, ...QUEUE }),
  row('limits.maxDPlus', 'limits', 'integer', 'Concurrent D+ tracks',
    'The heaviest tracks (D+, two reviewers each). At most as many as concurrent tracks.',
    { ...QUEUE, fullWhy: WHY_ONE_TYPE }),
  row('limits.maxPerDomain', 'limits', 'integer', 'Tracks per domain',
    'At most this many tracks at once in the same domain.', { ...QUEUE, fullWhy: WHY_ONE_DOMAIN }),
  row('limits.maxDb', 'limits', 'integer', 'Tracks with migrations',
    'Tracks with migrations at once, the load on the database. Only shown with migrations.folder set.', QUEUE),
  row('usageLimit.pause', 'limits', 'onoff', 'Pause at the usage limit',
    'At the subscription\'s usage limit, no new tracks or fix rounds start until the reset time.', {
      weakens: offWeakens,
      protects: 'Tracks and fix rounds that start into a usage limit and stop half done.',
      whyNot: 'A track cut off by the limit leaves a worktree with partial work that has to be picked up by hand.',
      changes: 'New tracks and fix rounds start even after the limit is hit. Doctor will report it.',
    }),
  row('capacity.resetDay', 'limits', 'integer', 'Weekly quota reset day',
    'The day the weekly quota resets, 0-6 with 0 = Sunday. Empty = Tuesday.'),
  row('capacity.resetClock', 'limits', 'text', 'Weekly quota reset time', 'The time the weekly quota resets, "HH:MM".'),
  row('capacity.timeZone', 'limits', 'text', 'Weekly quota time zone',
    'The IANA time zone of the reset, like "Europe/Berlin". Empty = the machine\'s own.'),
  row('capacity.planName', 'limits', 'text', 'Subscription name', 'The subscription name used in the capacity text.'),
  row('models', 'limits', 'object', 'Model per agent',
    'Agent name to model (opus, sonnet, haiku, fable). Empty = the model in each agent\'s own file.'),
  row('prices', 'limits', 'object', 'Price list',
    'List prices per model for the cost measurement, in USD per million tokens. Empty = the built-in table.'),
  row('cost.contextThresholdK', 'limits', 'integer', 'Context threshold (thousand tokens)',
    'In ravenseat cost, the share of cost from turns whose context is above this many thousand tokens. A measurement only.'),

  // ---- 3. Machine load ----
  row('limits.minFreeMemoryPct', 'load', 'integer', 'Minimum free memory (%)',
    'No new starts while free memory is below this share. Overrides loadGuard.minFreeMemoryPct for this queue.', QUEUE),
  row('loadGuard.minFreeMemoryPct', 'load', 'integer', 'Minimum free memory (%), project',
    'The project default for the hard load limit. Empty = off (the default on macOS, which counts the cache as used).'),
  row('loadGuard.adaptive', 'load', 'onoff', 'Load-aware slots',
    'Above the hard limit, the number of parallel slots follows the load instead of always being the maximum.'),
  row('loadGuard.minSlots', 'load', 'integer', 'Slots at the load limit',
    'The number of slots kept open at the hard limit.'),
  row('loadGuard.allSlotsFreeMemoryPct', 'load', 'integer', 'Free memory for all slots (%)',
    'At or above this much free memory every slot is open; between it and the hard limit the slots scale down.'),
  row('loadGuard.allSlotsCpuPct', 'load', 'integer', 'CPU for all slots (%)',
    'With minSlotsCpuPct also set, CPU load scales the slots too. Empty = CPU is not measured.'),
  row('loadGuard.minSlotsCpuPct', 'load', 'integer', 'CPU at the load limit (%)',
    'The CPU load at which only the minimum slots stay open. Empty = CPU is not measured.'),
  row('gateQueue.enabled', 'load', 'onoff', 'Queue for heavy gates',
    'A heavy gate run waits for a slot shared by the whole machine, across worktrees and projects.'),
  row('gateQueue.slots', 'load', 'integer', 'Heavy gate slots', 'How many heavy gate runs the machine runs at once.'),
  row('gateQueue.heavyAfterSec', 'load', 'integer', 'Heavy after (seconds)',
    'A gate whose last run of the same kind took at least this long counts as heavy.'),
  row('gateQueue.agingMin', 'load', 'integer', 'Wait before it counts as base (minutes)',
    'Base runs go first in the gate queue. A run that has waited this long counts as a base run, so it is never starved.'),
  row('gateTemp.enabled', 'load', 'onoff', 'Temp folder per gate run',
    'Each gate run gets its own temp folder, removed afterwards, so what the tests leave goes with it.'),
  row('limits.parallelThreshold', 'load', 'number', 'Low parallelism threshold',
    'The share of concurrent tracks below which fill, receive and pulse write a short queue diagnosis. 0 = off.', QUEUE),
  row('limits.silentMin', 'load', 'integer', 'Silent after (minutes)',
    'Minutes without a sign of life before a running track counts as silent. 0 = off.', QUEUE),
  row('limits.noAgentMin', 'load', 'integer', 'No agent after (minutes)',
    'Minutes before a track marked running, with no agent on its branch and no report, counts as NO AGENT. 0 = off.', QUEUE),

  // ---- 4. Gates and checks ----
  row('gates.quick', 'gates', 'list', 'Quick gate',
    'The commands a track runs before delivery. Set them up with `ravenseat kickstart gates --apply`.', BASIC),
  row('gates.full', 'gates', 'list', 'Full gate', 'The full set of commands receive and merge run.', BASIC),
  row('checksPanel.mode', 'gates', 'onoff', 'Show the Checks tab',
    'The Checks tab with suggested checks. Not set, it follows the guidance switch.', { ...BASIC, ...QUEUE }),
  row('checksPanel.marker', 'gates', 'onoff', 'Red dot on the Checks tab',
    'A small red dot on the Checks tab while an important suggestion is open. Off hides only the dot, the suggestions stay.', { ...BASIC, ...QUEUE }),
  row('maxFixRounds', 'gates', 'integer', 'Fix rounds before an owner question',
    'At this many fix rounds a task becomes an owner question instead of another round.'),
  row('fixPlateau', 'gates', 'onoff', 'Ask when a fix round stalls',
    'Before a fix round, ask when the previous one committed nothing or the check fails the same way.'),
  row('fixRound.continueWithinMin', 'gates', 'integer', 'Continue the agent for a fix round (minutes)',
    'A fix round goes to the agent that delivered when it stopped at most this many minutes ago (warm cache). 0 = always a new agent.'),
  row('fixRound.continueMaxContextK', 'gates', 'integer', 'Continue only under this context (thousand tokens)',
    'A fix round goes to a new agent when the one that delivered had more context than this at its last stop. 0 = no cap.'),
  row('doneCheck.timeoutSec', 'gates', 'integer', 'Done command time budget (seconds)',
    'A run of the task\'s done command that takes longer is red.'),
  row('doneCheck.tailLines', 'gates', 'integer', 'Done command output lines kept',
    'How many of the last output lines are kept for the fix brief (only the tail, so early secrets are not copied).'),
  row('gates.precheck', 'gates', 'list', 'Precheck',
    'The fail-fast checks before the full gate. Empty = the standard checks the project has; [] = no precheck.'),
  row('gates.precheckBudgetSec', 'gates', 'integer', 'Precheck budget (seconds)',
    'The time budget per precheck when the check sets none.'),
  row('gates.timeoutSec', 'gates', 'integer', 'Track gate budget (seconds)',
    'The time budget for the gate run a track starts itself; a gate over it is red. Empty = the base gate budget; 0 = no budget.'),
  row('wait.blockSec', 'gates', 'integer', 'Longest blocking call (seconds)',
    'Gates, receive and merge wait at most this long, then print RUNNING with the command that waits on. At most 590; 0 = wait until done.'),
  row('gates.flakyRerun', 'gates', 'onoff', 'Rerun red gate commands once',
    'A red gate in a track reruns only its red commands once on the same commit. Green then counts as flaky.'),
  row('gates.redOnBase', 'gates', 'object', 'Red on base check',
    'At receive, the track\'s new tests must pass on the tip and at least one must fail without the change. A warning.'),
  row('gates.redOnBaseStrict', 'gates', 'onoff', 'A fix needs a proven red test',
    'Off by default: a fix task without a test that fails on the base gets one warning at receive. On: merge stops on it, ' +
    'and the owner can merge past it with --allow-no-test, which is logged. Needs gates.redOnBase.', {
      weakens: offWeakens,
      protects: 'A fix merged with no test that fails without it, so the same bug can come back unnoticed.',
      whyNot: 'Fixes without a proven red test are only warned about and logged as fixed without test.',
      changes: 'Merge no longer stops on a fix without a proven red test; receive still warns.',
    }),
  row('gates.fixWithoutTestWarning', 'gates', 'onoff', 'Warn about a fix without a red test',
    'A fix task whose red on base check proves no test gets one FIX WITHOUT TEST line at receive. It stops nothing.', {
      weakens: offWeakens,
      protects: 'A fix that comes in with a test that would pass without it, read past as one more red on base line.',
      whyNot: 'The fix-specific line names the task it fixes, so the owner sees the bug may come back.',
      changes: 'Receive prints only the plain red on base line; the finding log still marks the row fixed without test.',
    }),
  row('gateEvidence.mode', 'gates', 'choice', 'Gate evidence',
    'Own: receive and merge run the gates themselves and check your answers and edits against the owner log. External: ' +
    'a green CI check on the same commit counts as the full gate. Off: the track\'s own word counts.', {
      choices: ['own', 'external', 'off'],
      weakens: rankWeakens(['own', 'external', 'off']),
      protects: 'A track that writes a green gate result or an owner row (an answer, an edit, an approval) it never got ' +
        'into the queue file, and has it believed at receive and merge.',
      whyNot: 'External trusts a CI run you do not see, under the check names you list. Off believes the track\'s ' +
        'gates=OK and every owner row in the queue file. A project with empty gates.quick and gates.full runs nothing ' +
        'under own anyway, so off saves no time there; it only removes the owner row check.',
      changes: 'External: a green listed check on the same commit counts as the full gate; the quick gates still run ' +
        'here and owner rows are checked. Off: receive and merge take gates=OK as given and owner rows are not checked. ' +
        'Doctor will report it.',
    }),
  row('gateEvidence.external', 'gates', 'list', 'External checks that count',
    'The GitHub check names (workflow or job) whose green run on the same commit counts as the full gate in mode ' +
    'external. Empty = none counts, and the full gate runs here.'),
  row('gates.fromKnownBugs', 'gates', 'choice', 'Gates from known bugs',
    'A known bug that can happen again becomes a gate task: propose (you approve), auto or off.', {
      choices: ['propose', 'auto', 'off'],
      weakens: (v, std) => v === 'auto' && std !== 'auto',
      protects: 'Tasks, and the tokens they use, that start without your approval.',
      whyNot: 'Auto approves every proposed gate task at once; each one runs an agent and uses tokens without asking.',
      changes: 'Gate tasks from known bugs are approved by the queue itself. Doctor will report it.',
    }),
  row('baseGate.enabled', 'gates', 'choice', 'Base gate after merge',
    'After a merge the base branch\'s new tip is checked; a red base stops further merges until it is green again.', {
      choices: ['auto', true, false],
      weakens: offWeakens,
      protects: 'Merging more tracks on top of a base branch that is already red.',
      whyNot: 'A red base hides which merge broke it, and every later track is checked against broken code.',
      changes: 'The tip is not checked after a merge, and a red base does not stop the next one. Doctor will report it.',
    }),
  row('baseGate.commands', 'gates', 'list', 'Base gate commands',
    'Empty = the quick gates. A list runs after the quick gates (for example the full gate).'),
  row('baseGate.timeoutSec', 'gates', 'integer', 'Base gate budget (seconds)', 'The time budget for the whole base gate.'),
  row('baseGate.tailLines', 'gates', 'integer', 'Base gate output lines kept',
    'The output lines kept for the fix task. Empty = the done command\'s value.'),
  row('baseGate.flakyRerun', 'gates', 'onoff', 'Rerun a red base gate once',
    'A red base gate reruns only the failed commands once on the same commit; green then is a flaky finding.'),
  row('inspection.mode', 'gates', 'choice', 'Inspection queue',
    'The same failure in the gates or CI, again and again, becomes one proposal to build a guard. You decide. ' +
    'Off also hides the Checks card with recipes for failure classes that keep coming back, and its Build as gate button.', {
      choices: ['on', 'off'],
    }),
  row('inspection.minRepeats', 'gates', 'integer', 'Repeats before a proposal',
    'How many separate tasks, branch days or CI commits must fail the same way before it is proposed.'),
  row('inspection.windowDays', 'gates', 'integer', 'Inspection window (days)', 'Only failures this recent count.'),
  row('inspection.registryFile', 'gates', 'text', 'Guard registry file',
    'The tracked list of guards and what each one guards against, relative to the project root.', { edit: 'file' }),
  // The repeat count on class and area (lib/findingRepeats.js). The count and the guard failed marker are on: they cost
  // no tokens, print nothing and stop nothing. The proposals are off: each one asks for the owner's time.
  row('learning.repeats', 'gates', 'onoff', 'Count repeats in the finding log',
    'The same class of failure in the same part of the code, in separate tasks, is counted from the finding log. ' +
    'It prints nothing and stops nothing; the Checks tab reads it.', {
      weakens: offWeakens,
      protects: 'A kind of failure that keeps coming back in one place, or past a guard, going unseen because each one ' +
        'was fixed alone.',
      whyNot: 'Without the count the Checks tab cannot say that a guard did not hold, and no guard is proposed.',
      changes: 'The guard failed card, its red marker and the guard proposals from the finding log are gone.',
    }),
  row('learning.windowDays', 'gates', 'integer', 'Repeat window (days)',
    'Only findings this recent count toward a repeat. A guard can be older.'),
  row('learning.areaRepeats', 'gates', 'integer', 'Repeats in one area',
    'How many incidents of a class in one area (separate tasks) make it due. A fix without a proven test counts twice.'),
  row('learning.projectRepeats', 'gates', 'integer', 'Repeats across the project',
    'How many incidents of a class in the whole project make it due when no single area is. An untested fix counts twice.'),
  row('learning.guardFailedMarker', 'gates', 'onoff', 'Red marker when a guard did not hold',
    'A failure class back where a guard for it was in place lights the red marker on the Checks tab, until a new ' +
    'guard or a fix with a proven test is in place there. It stops nothing.', {
      weakens: offWeakens,
      protects: 'A guard everyone trusts that no longer catches its own class.',
      whyNot: 'It is the one gap that always gets the red marker, and it is rare, so it does not nag.',
      changes: 'The guard failed card stays on the Checks tab at medium priority, without the red marker.',
    }),
  row('learning.proposals', 'gates', 'onoff', 'Propose guards from the finding log',
    'A class that keeps coming back in one area becomes one proposed gate task (you approve it). It shares one cap ' +
    'of three open proposals with the inspection queue and the gate lines. Off by default.'),
  // The database probe recipes (0i section 3.8). Off by default: a probe gate is heavy, needs a running database, and
  // is the one kind of gate that can change data elsewhere when it points at the wrong host. On, it only shows a recipe;
  // building one still takes the owner's click and approve, and the mission demands the host check and the rollback.
  row('learning.dbProbes', 'gates', 'onoff', 'Database probe recipes',
    'Off by default. On: for access control and migration failures that keep coming back, the Checks tab shows a ' +
    'recipe for database probes (pgTAP, supabase test db, testcontainers), only when a local or throwaway database is ' +
    'found. A gate built from it must check that its database host is local before it writes, and roll back.'),
  // Recipe precision (0i step 9, lib/recipePrecision.js). On by default, as the plan says (damped automatically): it only
  // moves a recipe the owner keeps declining from the card to the list, never stops work or hides a class, and the owner
  // can show one recipe again (ravenseat checks recipe <id> show). Off, every recipe whose `when` holds is offered.
  row('learning.recipeDamping', 'gates', 'onoff', 'Damp recipes that are seldom accepted',
    'A recipe whose gate proposals are seldom accepted is listed on the Checks tab with its numbers, but no longer ' +
    'offered on the card. It stops nothing. ravenseat checks recipe <id> show offers one again.'),
  row('learning.recipeMinProposals', 'gates', 'integer', 'Decided proposals before damping',
    'How many of a recipe\'s proposals must be accepted or declined before it can be damped. Waiting ones do not count.'),
  row('learning.recipeMinProposalsDb', 'gates', 'integer', 'Decided proposals before damping a database recipe',
    'The same for a database probe recipe. Higher, since they are few and often declined for their cost.'),
  row('learning.recipeMinAccepted', 'gates', 'integer', 'Accepted share that keeps a recipe (percent)',
    'A recipe below this share of accepted proposals, after enough are decided, is damped. 1 to 100.'),
  // CI parity for a built gate guard (0i step 9b, lib/quickGate.js). All on: the card only offers, and its write takes
  // the owner's click, only ADDS a command to gates.quick and is refused from a track worktree; the lift only orders the
  // CI cards (never the red marker, section 3.9); the idle line is INFO. None of them stops work or runs a command, so
  // off is less advice, not a weaker guard: no weakens (owner decision 2026-11-17), like scopeNotes.* and client.canary.
  row('learning.quickGateCard', 'gates', 'onoff', 'Offer to add a guard\'s command to gates.quick',
    'A gate guard in the registry whose command is not in gates.quick gets a card on the Checks tab: one click (or ' +
    'ravenseat checks quick-add <G-n>) adds that command at the end of gates.quick. Nothing runs from the card, and the ' +
    'write can only add a command, never remove or replace one. Off: no card, and no guard is weaker.'),
  row('learning.ciParityLift', 'gates', 'onoff', 'Put the CI cards first when a guard is not in CI',
    'When a gate guard\'s kind of check (tests, types, lint) is not run in CI, the cards tests-in-ci and quality-in-ci ' +
    'are put first in their priority and name the guard. They are never raised to the red marker. Off: the usual ' +
    'order, and no guard is weaker.'),
  row('learning.idleGuardInfo', 'gates', 'onoff', 'INFO for a gate guard that has not run',
    'ravenseat guards and ravenseat doctor give one INFO line for a gate guard with 0 runs since it was built, after ' +
    'the set number of days. It is INFO only and never stops anything. Off: no line (the registry still shows 0 ' +
    'runs), and no guard is weaker.'),
  row('learning.idleGuardDays', 'gates', 'integer', 'Days before a gate guard counts as not run',
    'How many days after it was built a gate guard with 0 runs gets the INFO line. 7 by default, as the plan says.'),
  row('testWeakening.enabled', 'gates', 'onoff', 'Test weakening warning',
    'Receive warns about deleted or moved test files and added skip or focus markers.', {
      weakens: offWeakens,
      protects: 'A track that gets green by deleting, moving or skipping tests.',
      whyNot: 'A green gate means little when the tests that would fail were taken away in the same change.',
      changes: 'Receive no longer reports deleted tests or added skip markers. Doctor will report it.',
    }),
  row('testWeakening.focusStop', 'gates', 'onoff', 'Stop on a focus marker',
    'A focus marker (.only, fit, fdescribe) on an added line stops the merge, since the other tests never ran.', {
      weakens: offWeakens,
      protects: 'A merge where only the focused tests ran.',
      whyNot: 'With .only in place the rest of the suite is skipped, so the gate says green without checking it.',
      changes: 'A focus marker gives only a warning, and the merge goes on. Doctor will report it.',
    }),
  // A log row only: the warning and the focus stop are their own rows, so off weakens no guard (owner decision 2026-11-17).
  row('testWeakening.findingLog', 'gates', 'onoff', 'Log test weakening as a finding',
    'What the test weakening check finds also becomes a finding log row, classed as a weak test. Nothing is printed. ' +
    'Off: no such row; the warning and the focus stop stay, so no guard is weaker.'),
  row('testWeakening.testPaths', 'gates', 'list', 'More test paths', 'More test file patterns for the warning.'),
  row('testWeakening.markers', 'gates', 'list', 'More skip markers',
    'More regular expressions for an added line in a test file.'),
  row('qa.evidenceTypes', 'gates', 'list', 'Evidence types', 'The kinds of QA evidence a track may write.'),
  row('qa.autoTypes', 'gates', 'list', 'Automatic evidence types',
    'Evidence types closed by `ravenseat qa auto --run` when the auto command is green.'),
  row('qa.manualTypes', 'gates', 'list', 'Manual evidence types', 'Evidence types gathered in one manual round.'),
  row('qa.autoCommand', 'gates', 'object', 'Automatic evidence command',
    'The command `qa auto --run` runs, with {refs} and {id}. Empty = qa auto only lists.'),
  row('qa.evidenceLabels', 'gates', 'list', 'Labels that need evidence',
    'Receive warns when a task with one of these labels delivers without evidence.'),

  // ---- 5. Agent guards ----
  row('protectedPaths', 'guards', 'list', 'Protected paths',
    'Paths a track may only change when its task owns them: hooks, settings, agents, the queue scripts and test configs. ' +
      'A list replaces the defaults; { "add": [...], "remove": [...] } changes them (the floor is never removed).', {
      weakens: listLosesEntries,
      protects: 'Agents changing hooks, settings and test configs without the task owning those files.',
      whyNot: 'These files run code or give instructions with your rights in the orchestrator session.',
      changes: 'The merge guard no longer stops changes to the paths left out (the floor holds). Doctor will report it.',
    }),
  row('dependencyFiles', 'guards', 'choice', 'Dependency files',
    'A task that changes a dependency file it does not own: stop like a protected path, or warn.', {
      choices: ['stop', 'warn'],
      defaultByMode: { lite: 'warn', full: 'stop' },
      weakens: rankWeakens(['stop', 'warn']),
      protects: 'A track that adds or changes a library without the task owning the dependency file.',
      whyNot: 'A new library runs its install scripts on your machine and becomes part of what you ship.',
      changes: 'Such a change gives a warning, and the merge goes on. Doctor will report it.',
    }),
  row('gitSurface', 'guards', 'choice', 'Git hooks and config',
    'Git hooks and executing git config compared with the accepted baseline: stop, warn or off.', {
      choices: ['stop', 'warn', 'off'],
      defaultByMode: { lite: 'warn', full: 'stop' },
      weakens: rankWeakens(['stop', 'warn', 'off']),
      protects: 'A git hook or git setting added while a track ran, which then runs on your next commit or push.',
      whyNot: 'Hooks and settings like core.hooksPath run code with your rights, outside every other guard.',
      changes: 'A changed hook or setting no longer stops receive, merge and the push check. Doctor will report it.',
    }),
  row('secretScan.enabled', 'guards', 'onoff', 'Secret scan before push',
    'The added lines of a push are scanned for secrets, and a hit asks first, naming the file and line.', {
      weakens: offWeakens,
      protects: 'Pushing a key, token or password that a track wrote into the code.',
      whyNot: 'A pushed secret stays in the remote\'s history and must be rotated, even after the commit is removed.',
      changes: 'Pushes go out without a secret scan. Doctor will report it.',
    }),
  // The opt-in checks (lib/optInChecks.js): off by default, so switching one off again never weakens the standard.
  row('secretScan.atReceive', 'guards', 'onoff', 'Secret scan at receive',
    'Off by default. On: receive scans the track\'s own commits for secrets; a hit blocks the merge until a clean receive or merge --allow-secret.', {
      weakens: offWeakens,
      protects: 'A key a track committed being merged into the base branch, where its history keeps it.',
      whyNot: 'Once merged, the key is in the base branch\'s history; the push check only stops it from leaving the machine.',
      changes: 'Receive no longer scans the track\'s commits, and merge does not stop on a key.',
    }),
  row('secretScan.allowlist', 'guards', 'onoff', 'Keys in approved commands and .mcp.json',
    'Off by default. On: doctor looks for keys in the commands Claude Code has approved (.claude/settings*.json) and in the MCP servers in .mcp.json (env, headers, args, url), also in the agents\' worktrees.', {
      weakens: offWeakens,
      protects: 'A token typed in a command that "Yes, and don\'t ask again" stored in clear text, or pasted into a tracked .mcp.json.',
      whyNot: 'A key in the tracked .claude/settings.json or .mcp.json is in the repo and its history.',
      changes: 'Doctor no longer reads the approved commands or .mcp.json.',
    }),
  row('permissionsCheck.enabled', 'guards', 'onoff', 'Broad permissions check',
    'Off by default. On: doctor names the broad rules in the tracked .claude/settings.json: any shell command, network tools, rm, git push, WebFetch without a domain, and defaultMode bypassPermissions or acceptEdits.', {
      weakens: offWeakens,
      protects: 'A shared rule that lets every session on every clone run any command, send data over the network or push without a question.',
      whyNot: 'A rule in the tracked settings.json applies to everyone who opens the repo and to every agent.',
      changes: 'Doctor no longer reads the shared permissions.',
    }),
  row('dbGuard.localOnly', 'guards', 'onoff', 'Probe gates only against a local database',
    'Off by default. On: a database probe gate (pg_prove, supabase test db, sqlx test) whose database URL or host is not localhost, 127.0.0.1, ::1 or a Docker service name is refused, red with one line.', {
      weakens: offWeakens,
      protects: 'Probes that write and test refusals running against a shared or remote database, for example a DATABASE_URL left on staging.',
      whyNot: 'A probe that does not roll back changes data other people use.',
      changes: 'Probe gates run against whatever database their command or environment names.',
    }),
  row('gitignoreCheck.enabled', 'guards', 'onoff', 'Project .gitignore check',
    'Off by default. On: doctor checks that the project\'s own .gitignore, not only your global one, ignores what Ravenseat keeps local.', {
      weakens: offWeakens,
      protects: 'Your personal settings or the queue\'s data committed from a teammate\'s clone or CI, which has no global gitignore of yours.',
      whyNot: 'What only your global gitignore ignores is one `git add .` from the repo elsewhere.',
      changes: 'Doctor no longer checks the project\'s .gitignore.',
    }),
  row('secretScan.maxBytes', 'guards', 'integer', 'Secret scan size limit (bytes)',
    'A larger diff is not scanned, and the push asks instead.'),
  row('secretScan.timeoutMs', 'guards', 'integer', 'Secret scan time limit (ms)',
    'The time limit per git or gitleaks call.'),
  row('deployCommands', 'guards', 'list', 'Deploy commands',
    'The push guard asks before any command that starts with one of these. Empty = off.'),
  row('claudeFingerprint', 'guards', 'onoff', 'Claude setup fingerprint',
    'Receive warns when your own Claude setup (~/.claude) changed while a track ran. Only hashes are stored.', {
      weakens: offWeakens,
      protects: 'A track changing your own Claude settings, agents, skills or hooks outside the repository.',
      whyNot: 'Git does not see ~/.claude, so a change there would go unnoticed and apply to every later session.',
      changes: 'Receive no longer compares your Claude setup before and after a track. Doctor will report it.',
    }),
  // Friction: a track works in its own worktree and never needs the main tree's control files, so the guard only
  // stops what was never meant to happen; the shell reading can stop a copy out of a control file (cp <main>/... .),
  // which the denial explains. The fingerprint costs a few milliseconds at fill and receive and only warns. On by
  // default by the owner's decision of 16.11.2026 (plans/ekstern-saas-vurdering-2026-11-15.md, bolk 1).
  row('controlFiles.guard', 'guards', 'onoff', 'Control file write guard',
    'Queue agents may not write the main tree\'s queue.config.json, .claude/, CLAUDE*.md, .git/hooks/, .git/config or ' +
    'the plugin\'s scripts, with the file tools or the shell. Their own worktree copies stay free; the main session is not affected.', {
      weakens: offWeakens,
      protects: 'A track switching off a guard, adding a hook or rewriting the instructions by writing the main tree\'s control files directly.',
      whyNot: 'Every override flag is denied to the agents, but a direct write to these files gets around all of them.',
      changes: 'Queue agents can write the main tree\'s control files again. Doctor will report it.',
    }),
  row('controlFiles.fingerprint', 'guards', 'onoff', 'Control file fingerprint',
    'Fill and start record a short hash of each main tree control file; receive warns (CONTROL FILES CHANGED) about a ' +
    'change that no commit explains. Only hashes are stored.', {
      weakens: offWeakens,
      protects: 'A change to the main tree\'s control files while a track ran that the write guard did not see (a script the agent ran).',
      whyNot: 'Ignored files such as .claude/settings.local.json and .git/config never show in git, so a change there goes unnoticed.',
      changes: 'Receive no longer compares the main tree\'s control files before and after a track. Doctor will report it.',
    }),
  // Friction: none, it only appends a row when a guard has already decided. On by default by the owner's decision of
  // 16.11.2026 (bolk 6, measurement only): the overrides are measured for two weeks before approval with presence.
  // A log, not a guard, but it keeps weakens until that measuring is over (owner decision 2026-11-17).
  row('guardLog.enabled', 'guards', 'onoff', 'Guard decision log',
    'Every deny and ask from the push, write and read guard is one row in the time log: guard, rule, agent type, task ' +
    'and time, never the command. Doctor and the board count them per track.', {
      weakens: offWeakens,
      protects: 'Seeing afterwards how often the guards stopped or asked an agent, and which track kept trying.',
      whyNot: 'Without the rows a track that hits a guard again and again leaves no trace, and the overrides cannot be measured.',
      changes: 'The guards still decide, but their decisions are no longer logged. Doctor will report it.',
    }),
  // Friction: one click per override from the main session, which is rare (0 such rows in 312 when measured); the
  // orchestrator's ordinary commands never ask. On by default by the owner's decision of 16.11.2026 (bolk 3): the one
  // cheap thing that tells the owner apart from a misled model on the usual path (lib/approvalAsk.js).
  row('approvals.ask', 'guards', 'onoff', 'Ask before the main session overrides',
    'Claude Code asks you before the main session merges with --allow-* or --force*, passes --i-understand or --by owner, ' +
    'accepts the git surface, an owner row or a helper, calls the board\'s API or writes a control file directly. In ' +
    'dontAsk and bypassPermissions it is denied instead: run the command yourself in your terminal.', {
      weakens: offWeakens,
      protects: 'The model passing an override or acting as you because a report, a document or a compacted session said you agreed.',
      whyNot: 'Without the question an override from the main session cannot be told apart from yours: the CLI only sees the flag.',
      changes: 'The main session passes overrides and writes the control files without a question. Doctor will report it.',
    }),
  row('agentGuard.enabled', 'guards', 'onoff', 'Guard every agent type',
    'The push, network, queue command and state file guards apply to every subagent, also general-purpose, Explore and ' +
    'your own. Off: only the queue\'s own agent types, which are always guarded.', {
      weakens: offWeakens,
      protects: 'An agent the queue did not define (a builtin or your own subagent) pushing, fetching from the network or ' +
        'writing the queue\'s state files.',
      whyNot: 'Any subagent can read text that tells it to push or send something out; the guards are what stop it.',
      changes: 'Agent types outside the queue\'s own get no push, network or write guard. Doctor will report AGENT GUARD OFF.',
    }),
  row('agentGuard.except', 'guards', 'list', 'Agent types not guarded',
    'Agent types the guards leave out, without case and with or without a plugin prefix. The queue\'s own types stay guarded.', {
      weakens: (v) => Array.isArray(v) && v.some((x) => typeof x === 'string' && x.trim() !== ''),
      protects: 'The agent types named here pushing, fetching from the network or writing the queue\'s state files.',
      whyNot: 'A named type runs with the main session\'s rules: it can push and reach the network whatever it was told.',
      changes: 'The named agent types get no push, network or write guard. Doctor will list each one.',
    }),
  row('agentPushBlock.enabled', 'guards', 'onoff', 'Git push block in track worktrees',
    'A git pre-push hook stops a push from a track\'s worktree, also one the text guard never saw (a script the agent ran). ' +
    'It runs in front of any pre-push hook you have; your own pushes from the main checkout are not affected.', {
      weakens: offWeakens,
      protects: 'A track pushing through git itself, from a script or a command form the push guard cannot read.',
      whyNot: 'The push guard reads command text; a push started by a script or a tool runs past it unseen.',
      changes: 'The hook is removed at the next fill, start or resume, and agents can push from git itself when the text ' +
        'guard does not see the command. Doctor will report it.',
    }),
  row('ownership.sharedPatchCollides', 'guards', 'onoff', 'Shared patch collides with owned files',
    'A path in a task\'s shared_patch collides with another active task\'s owned_files: the second task waits to start, ' +
    'and a merge that patches a file another active task owns stops. Off: shared_patch is compared only with shared_patch.', {
      fullWhy: 'shared_patch is a field of the full task format',
      weakens: offWeakens,
      protects: 'Two tasks changing the same file at once because one lists it in shared_patch and the other owns it.',
      whyNot: 'The owner builds on the file while the other task patches it, and the merge goes in under it with no stop.',
      changes: 'Both tasks can start, and the merge no longer stops on a shared_patch path another active task owns. ' +
        'Doctor will report it.',
    }),
  row('readGuard.agentTypes', 'guards', 'list', 'More guarded agent types',
    'More agent types the read guard applies to (tracks and reviewers are always included).'),
  row('readGuard.autoLoaded', 'guards', 'list', 'Auto-loaded files',
    'Files Claude Code loads itself, which must never be read again with Read.'),
  row('readGuard.largeFiles', 'guards', 'list', 'Large files', 'Patterns for files that must always be read in excerpts.'),
  row('readGuard.maxLines', 'guards', 'integer', 'Read warning (lines)', 'A read of more lines than this gets a warning.'),
  row('readGuard.blockLines', 'guards', 'integer', 'Read stop (lines)', 'A read of more lines than this is stopped.'),
  row('reads.mode', 'guards', 'choice', 'Read ownership',
    'A task that reads a file an active task changes: wait until it is done, or start and name the overlap.',
    { choices: ['wait', 'warn'], fullWhy: 'read ownership uses the reads field of the full task format' }),
  row('hotspots', 'guards', 'list', 'Hotspots',
    'Shared config blocks parallel tracks break each other on; only an agreed change gets through. Empty = off.',
    { fullWhy: 'hotspot changes are agreed in the full task format (hotspot_patch)' }),
  row('contextGuard.blockOtherChats', 'guards', 'onoff', 'Stop other chats at 400k',
    'Chats that are not the orchestrator are stopped at 400k context instead of only getting the notice.'),

  // ---- 6. Merge and push ----
  row('push.mode', 'push', 'choice', 'Who pushes',
    'owner: only on your word. threshold: the orchestrator may push when the batch is ready.', {
      ...BASIC,
      choices: ['owner', 'threshold'],
      weakens: rankWeakens(['owner', 'threshold']),
      protects: 'Pushes, and the CI runs and deploys they start, that you did not ask for.',
      whyNot: 'Every push of the base branch runs the whole CI and may deploy; the orchestrator then decides when.',
      changes: 'The orchestrator pushes by itself when the batch is ready (never when blocked). Doctor will report it.',
    }),
  row('push.minTasks', 'push', 'integer', 'Batch ready at (tasks)',
    'The batch is ready at this many merged tasks. A push below it asks first. 0 = no lower limit.'),
  row('push.warnTasks', 'push', 'integer', 'Large batch at (tasks)',
    'From this many merged tasks the batch is large (a warning: a red CI is harder to bisect). 0 = off.'),
  row('push.maxAgeHours', 'push', 'integer', 'Batch ready after (hours)',
    'Unpushed work older than this makes the batch ready below the task count. Empty = off.'),
  row('push.allowBranches', 'push', 'list', 'Other branches the main session may push',
    'For pull request flows ("feat/*"). Queue agents never push.'),
  row('push.controlsWarning', 'push', 'onoff', 'Ask on push without checks',
    'A push asks first when the project has no CI config or no gates.', {
      weakens: offWeakens,
      protects: 'Pushing code that nothing automatic has checked.',
      whyNot: 'Without CI or gates, the push is the first time anyone can see the code fails.',
      changes: 'Pushes go out without the question even when there are no checks. Doctor will report it.',
    }),
  // Friction: one click per batch push, which in owner mode only happens on the owner's word anyway. On by default in
  // owner mode by the owner's decision of 16.11.2026 (bolk 7): it makes "push only on my word" a rule instead of an
  // instruction a compacted session can lose. No effect in threshold mode.
  row('push.ownerAsk', 'push', 'onoff', 'Owner mode: every push asks',
    'With push mode owner, every push of the base branch by the main session asks you first, also when the batch is ' +
    'ready. In dontAsk and bypassPermissions it is denied instead: push from your terminal. No effect in threshold mode.', {
      weakens: offWeakens,
      protects: 'A push you did not ask for, and the CI runs and deploys it starts, in the mode where only you decide.',
      whyNot: 'Without the question "only on your word" is an instruction: a ready batch with a green gate goes out unasked.',
      changes: 'In owner mode a ready batch is pushed without a question when the orchestrator decides to. Doctor will report it.',
    }),
  row('wiring.stop', 'push', 'onoff', 'Done waits for the wiring spec',
    'Each WIRE line in a track\'s report becomes an open item on the task, and done (set done, the done step of merge) ' +
    'waits until each is closed with a commit or rejected with a reason.', {
      weakens: offWeakens,
      protects: 'A built component that stays unwired because the wiring spec in the report was never carried out.',
      whyNot: 'The spec is only text in a report then, and nothing reminds anyone of it after the merge.',
      changes: 'Done passes with open wiring items; it says so, and the items stay open on the task. Doctor will report it.',
    }),
  row('reviewItems.stop', 'push', 'onoff', 'Done waits for the review findings',
    "Each finding on a reviewer's FINDINGS line becomes an item on the task, and done (set done, the done step of " +
    'merge) waits until each is fixed, moved to a task or a batch, or rejected with a reason.', {
      weakens: offWeakens,
      protects: 'A reviewer finding that is read once and then forgotten after the merge.',
      whyNot: 'The findings are only text in a transcript then, and nothing reminds anyone of them.',
      changes: 'Done passes with open review items; it says so, and the items stay open on the task.',
      defaultByMode: { lite: false, full: true },
    }),
  row('review.requireFindings', 'push', 'onoff', 'Merge needs the chosen reviews',
    'Merge stops when a reviewer chosen for the class has not reported FINDINGS after the review package, or reports H>0. ' +
    'The owner can merge past it with --allow-unreviewed, which is logged.', {
      weakens: offWeakens,
      protects: 'A merge of a D or D+ task that no reviewer looked at, or one with a high finding still open.',
      whyNot: 'The review becomes optional, and a forgotten reviewer is not noticed.',
      changes: 'Merge goes on without checking for the reviews; the findings that exist are still recorded.',
    }),
  row('push.ciWatch', 'push', 'choice', 'CI watch after push',
    'off, or github: after a batch push the CI runs are followed, and a failure gives a fix task.',
    { choices: ['off', 'github'] }),
  row('push.ciWatchIntervalSec', 'push', 'integer', 'CI watch interval (seconds)', 'How often the CI watch polls.'),
  row('push.ciWatchTimeoutMin', 'push', 'integer', 'CI watch limit (minutes)', 'When the CI watch gives up.'),
  row('migrations.folder', 'push', 'text', 'Migrations folder',
    'The folder with numbered migrations. Empty turns the whole migration flow off.'),
  row('migrations.filePattern', 'push', 'text', 'Migration file pattern',
    'A regular expression whose first group is the migration number.'),
  row('migrations.blockSize', 'push', 'integer', 'Migration numbers per task',
    'How many numbers a task that touches migrations reserves.'),
  row('migrations.pushCommand', 'push', 'text', 'Migration push command',
    'The command merge runs to push migrations. Empty = merge never pushes them.', { edit: 'file' }),
  row('migrations.environmentFile', 'push', 'text', 'Linked environment file',
    'The file that says which environment is linked, checked before a migration push.', { edit: 'file' }),
  row('migrations.allowedEnvironment', 'push', 'list', 'Allowed environments',
    'The environments a migration push may go to.'),

  // ---- 7. Review and agents ----
  row('helpers', 'review', 'object', 'Helper agents',
    'Optional reviewers on top of the fixed ones, switched with `ravenseat helpers on|off` (their conditions are in ' +
    'queue.config.json). In lite, reviewer-light reviews class K tasks when CI or gates are missing.',
    { ...BASIC, ...QUEUE, edit: 'set' }),
  row('reviewers', 'review', 'object', 'Reviewers per class',
    'The fixed reviewer agents that run after receive for each class (none for K and U by default).', {
      fullWhy: 'lite has no reviewers per class (every lite task is class K)',
      weakens: fewerReviewers,
      protects: 'Database and security changes merged without the reviewers their class gets by default.',
      whyNot: 'D and D+ tasks are the changes that are hardest to undo once merged.',
      changes: 'The classes with fewer reviewers are merged with less review. Doctor will report it.',
    }),
  row('review.signals', 'review', 'object', 'Review signals',
    'What a diff adds can lift a reviewer in on top of the class: sign-in and session changes, secrets, a request URL ' +
    'built from data, raw HTML (lib/reviewSignals.js). Add paths and words per signal, add your own, or switch one off. ' +
    '`ravenseat helpers` shows how often each signal hits.', {
      weakens: (v) => require('./reviewSignals.js').weakens(v),
      protects: 'A client change to sign-in, a secret, a URL from data or raw HTML merged without a security review.',
      whyNot: 'Class K and U tasks have no fixed reviewer, so the signal is the only thing that brings the security reviewer in.',
      changes: 'Tasks that hit the signal get no extra reviewer for it. Doctor will report it.',
    }),
  row('review.packs', 'review', 'list', 'Review signal packs for your stack',
    'Stack packs that add the risky calls of your stack to the review signals (lib/reviewPacks.js). The Checks tab ' +
    'suggests them from your manifests; `ravenseat checks packs --apply` writes them. The built-in ones follow plugin updates.'),
  // The reuse and scope facts at receive (lib/scopeNotes.js). On by default in both modes (owner decision 16.11): each
  // is one NOTE line and a line in the package, costs no tokens and stops nothing. Off is no weakening, as for
  // guidance quiet: a fact goes, no guard does.
  row('scopeNotes.reuse', 'review', 'onoff', 'Note a helper written again',
    'A name the delivery defines (JS/TS) that the base already defines in another file gets one NOTE line at receive ' +
    'with both places, and a line in the review package. It stops nothing.'),
  row('scopeNotes.newFolders', 'review', 'onoff', 'Note a new folder',
    'A file added in a folder the base does not have (the first levels, scopeNotes.folderDepth) gets one NOTE line: a ' +
    'new module boundary is an architecture choice. It stops nothing.'),
  row('scopeNotes.dependencies', 'review', 'onoff', 'Note a second library for the same job',
    'A new package in package.json or requirements.txt whose job the manifest already has a package for (dates, HTTP, ' +
    'validation, helpers, test runner ...) gets one NOTE line. It stops nothing.'),
  row('scopeNotes.drift', 'review', 'onoff', 'Note drift in numbers',
    'How many changed files lie outside the task\'s files and reads, and in which folders; a task with no files named ' +
    'gets the number of folders it touches. One NOTE line, it stops nothing.'),
  row('scopeNotes.ignoreNames', 'review', 'list', 'Names a helper note skips',
    'More names the helper note never reports (main, run, setup and a few others are skipped already).'),
  row('scopeNotes.folderDepth', 'review', 'integer', 'New folder depth',
    'How deep the new folder note looks: 1 = only new top folders, 2 (default) or 3.'),
  // The opt-in scope drift guards (bolk B7, V6 and V7). Off by default: V6 costs a reviewer run, V7 may make a track
  // stop and ask when owned_files was a rough guess. Full mode only: a lite task names no files, so nothing drifts.
  // Off is the default, so it is no weakening.
  row('scopeNotes.driftGap', 'review', 'onoff', 'Gap review on large drift',
    'At receive, the gap reviewer is added when at least scopeNotes.driftGapFiles changed files, and over ' +
    'scopeNotes.driftGapShare percent of them, lie outside the task\'s files and reads. One reason line; costs one ' +
    'reviewer run when it fires.', { fullWhy: 'a lite task names no files, so there is no drift to measure' }),
  row('scopeNotes.driftGapFiles', 'review', 'integer', 'Gap review: files outside',
    'How many changed files must lie outside the task\'s files before the gap reviewer is added (1 to 100, default 4).',
    { fullWhy: 'a lite task names no files, so there is no drift to measure' }),
  row('scopeNotes.driftGapShare', 'review', 'integer', 'Gap review: share outside (%)',
    'The share of the changed files outside the task\'s files that must be passed (1 to 99, default 40).',
    { fullWhy: 'a lite task names no files, so there is no drift to measure' }),
  row('scopeNotes.driftWarn', 'review', 'onoff', 'Write warning for drift',
    'While a track writes a file outside its files and reads, it gets one note per file (never a denial) saying it ' +
    'need not stop for it, and to name the file in its report.', { fullWhy: 'a lite task names no files, so there is no drift to measure' }),
  // The project catalog (lib/catalog.js, docs/queue/catalog/). Both are on in both modes: each states a fact, stops
  // nothing and does nothing without the folder. Off is no weakening: the owner lock on accepted and the protected path
  // (protectedPaths) are not these switches.
  row('catalog.doctor', 'review', 'onoff', 'Catalog problems in doctor',
    'Doctor shows one WARN row when `ravenseat catalog check` finds an error in docs/queue/catalog/, such as a design ' +
    'choice set to accepted without the owner. It stops nothing.'),
  row('catalog.planLinks', 'plans', 'onoff', 'Check plan links to design choices',
    'A plan entry\'s `decisions` link to an id that is not in docs/queue/catalog/decisions is a warning on plan new and ' +
    'plan edit. The shape of the link is always checked. It stops nothing.'),
  // The catalog excerpt (lib/catalogExcerpt.js, bolk B4). On in both modes by owner decision 16.11: it is only text,
  // nothing without a catalog, capped, and its heading says what it cost. Off is no weakening: no guard reads it, and
  // the owner lock and the protected path stay.
  row('catalog.missionExcerpt', 'review', 'onoff', 'Catalog excerpt in the mission',
    'A track\'s mission gets the part of docs/queue/catalog/ that meets its files: the design choices that hold, the ' +
    'proposed ones as suggestions, the prefer lines and the reuse rows in its folders, under catalog.excerptTokens. ' +
    'Nothing without a catalog.'),
  row('catalog.reviewExcerpt', 'review', 'onoff', 'Catalog excerpt in the review package',
    'The review package gets the same excerpt, so the reviewer checks the delivery against the choices that hold and ' +
    'the reuse rows (findings duplication and scope-drift). Nothing without a catalog.'),
  row('catalog.excerptTokens', 'review', 'integer', 'Catalog excerpt cap (tokens)',
    'The most tokens the excerpt may use, 200 to 6000 (default 1500, a token counted as 4 characters). The reuse rows ' +
    'are cut first; the heading says what was cut.'),
  // The generated index (lib/catalogIndex.js, bolk B5). Off by default: the plan's opt-in list (it builds and stores a
  // file in the data folder, and its worth grows with the project). It stops nothing either way, and off weakens no
  // guard: `catalog find` still works on request.
  row('catalog.index', 'review', 'onoff', 'Code index for the catalog excerpt',
    'Builds an index of the code\'s exports (JS/TS) at receive and for each mission, cached by file sha in the data ' +
    'folder. The excerpt then gets the helpers tagged `@shared` in the task\'s folders, and the review package the new ' +
    'names that are close to an existing export (V1b). `ravenseat catalog find` works without it.'),
  // The check rules of the design choices (lib/catalogChecks.js, bolk B6). checks is on: a rule exists only when the
  // owner writes one, and a hit is one line at receive. Off weakens: an accepted choice's rule is then not checked.
  // checkStop is off: it is the one part that can stop work. gateAfter only matters with learning.proposals on.
  row('catalog.checks', 'review', 'onoff', 'Check rules of the design choices',
    'Receive tries the `check:` rule of each design choice on the delivery\'s added lines in the choice\'s paths. An ' +
    'accepted choice gives a CATALOG line, a proposed one a NOTE. It stops nothing unless catalog.checkStop is on.', {
      weakens: offWeakens,
      protects: 'A delivery that breaks a design choice the owner accepted, where the rule says so line by line.',
      whyNot: 'The rule is the owner\'s own, written narrow with examples; without the check only the reviewer can see it.',
      changes: 'The rules are not tried at receive or merge, and no gate is proposed from them. Doctor will report it.',
    }),
  row('catalog.checkStop', 'review', 'onoff', 'Stop the merge on a rule in mode stop',
    'A rule with `mode: stop` of a choice the owner accepted stops the merge when an added line breaks it ' +
    '(`merge --allow-catalog` overrides, logged). Off by default: the rule is then a warning.'),
  row('catalog.gateAfter', 'review', 'integer', 'Separate tasks before a lint proposal',
    'A rule broken in this many separate tasks (2 to 20, default 3) becomes one proposed gate task to put it in the ' +
    'project\'s own lint. Only with learning.proposals on; it shares the cap of three open proposals.'),
  row('triage.minAgeDays', 'review', 'integer', 'Triage tasks older than (days)',
    'A task added or last edited this long ago is checked against the current code before it starts. Empty = no age rule.',
    { fullWhy: 'the intake triage is off in lite' }),
  row('triage.agentAdded', 'review', 'onoff', 'Triage tasks agents added',
    'A task an agent added is checked once before it starts.', { fullWhy: 'the intake triage is off in lite' }),
  row('triage.maxPerFill', 'review', 'integer', 'Triage steps per fill', 'At most this many triage steps per fill.',
    { fullWhy: 'the intake triage is off in lite' }),
  row('triage.askAgainMin', 'review', 'integer', 'Triage asks again after (minutes)',
    'A printed triage step is not printed again for this long.', { fullWhy: 'the intake triage is off in lite' }),
  row('proposals.autoAccept.enabled', 'review', 'onoff', 'Auto-accept proposals',
    'A proposal from an agent that fits the rules is approved by the queue itself, logged and can be undone.', {
      ...QUEUE,
      weakens: onWeakens,
      protects: 'Tasks proposed by agents that start without you seeing them first.',
      whyNot: 'An agent can propose work you would not choose, and each accepted task runs an agent and uses tokens.',
      changes: 'Proposals that fit the rules are approved without you (never D or D+). Doctor will report it.',
    }),
  row('proposals.autoAccept.classes', 'review', 'list', 'Auto-accept classes',
    'The classes auto-accept may approve (never D or D+).', QUEUE),
  row('proposals.autoAccept.maxEstimateMin', 'review', 'integer', 'Auto-accept size limit (minutes)',
    'Proposals estimated above this are left for you.', QUEUE),
  row('proposals.autoAccept.maxValue', 'review', 'integer', 'Auto-accept value limit',
    'Proposals valued above this are left for you. Empty = no limit.', QUEUE),
  row('architectureRules', 'review', 'list', 'Architecture rules',
    'Short rules written into every mission and cloud mission, in the project\'s own words.'),
  row('attempts.reservationTtlMin', 'review', 'integer', 'Reservation expires after (minutes)',
    'A reservation with no start for this long counts as expired, and the next start takes a new attempt.'),

  // ---- 8. Board and advice ----
  row('guidance', 'board', 'choice', 'Guidance',
    'guided: advice about CI, gates and checks. quiet: no advice; guards and facts stay. Only for you.',
    { ...BASIC, ...QUEUE, choices: ['guided', 'quiet'] }),
  row('board.mascot', 'board', 'choice', 'Mascot bubbles',
    'chatty, events (only events and clicks) or off for every viewer.', { ...BASIC, choices: ['chatty', 'events', 'off'] }),
  row('board.blockedColumn', 'board', 'onoff', 'Blocked column',
    'Tasks with an open blocker that needs action get a column after In queue.', { ...BASIC, ...QUEUE }),
  row('limits.autocompact', 'board', 'onoff', 'Automatic compaction',
    'On: Claude Code compacts the orchestrator session itself and the queue continues. Off: a ready /compact line; ' +
    'then also turn off auto-compaction in Claude Code ("autoCompactEnabled": false), or it compacts anyway.',
    { ...BASIC, ...QUEUE }),
  row('board.port', 'board', 'integer', 'Board port', 'The local port the board listens on.'),
  row('board.title', 'board', 'text', 'Board title', 'The title in the board\'s header and browser tab.'),
  row('board.updateCheck', 'board', 'onoff', 'Update check',
    'The board checks GitHub for a newer plugin version at most once a day (a plain GET that sends nothing about you).'),
  row('board.showCloud', 'board', 'onoff', 'Show the Cloud tab',
    'The Cloud tab, when cloud sessions are on (features.cloud).', QUEUE),
  row('features.statistics', 'board', 'onoff', 'Statistics tab', 'The Statistics tab on the board.'),
  row('features.follow', 'board', 'onoff', 'Follow-up entries',
    'The follow-up page, the follow commands and their lines in show and pulse.'),
  // Advice about the size of Claude's instructions (lib/instructionSize.js). Not a guard, so off never weakens; owner
  // decision 2026-11-12 puts all three under Advanced.
  row('instructionSize.mode', 'board', 'choice', 'Instruction size advice',
    'warn: doctor, the Checks tab and one chat message say when the instructions Claude loads in every session grow ' +
    'past the limits below. off: none of it. Quiet guidance hides the advice either way.', { choices: ['warn', 'off'] }),
  row('instructionSize.maxLines', 'board', 'integer', 'Lines per instruction file',
    'Advice when a file loaded in every session (CLAUDE.md, a rule without paths:, an import) has more lines than this. ' +
    '200 is the target in the Claude Code docs.'),
  row('instructionSize.maxChars', 'board', 'integer', 'Instruction characters in all',
    'Advice when everything loaded at the start of a session has more characters than this. 40,000 is where Claude ' +
    'Code itself warns.'),
  // The client format canary (lib/clientCanary.js, roadmap 0w W4). On by default in both modes: it only shows (one
  // doctor row, one medium card that never lights the red marker) and stops nothing, so off weakens no guard. The shape
  // log is off by default: it writes a file in the data folder that is only of use when someone reports a form.
  row('client.canary', 'board', 'onoff', 'Claude Code format canary',
    'Doctor reads the tail of the newest Claude Code transcript and says when the version is newer than the formats ' +
    'Ravenseat was tested on, or rows read differently (new row types, turns without usage, unknown API errors); the ' +
    'Checks tab shows one card while such rows are seen. Type names and counts only, never content. It stops nothing.'),
  row('client.shapeLog', 'board', 'onoff', 'Log new API error forms',
    '`ravenseat checks` writes the shape of each new API error form (keys and value types, short codes, no text) to ' +
    'client-shapes.jsonl in the data folder, so the form can be confirmed and reported. Off by default.'),

  // ---- 9. Cloud ----
  row('features.cloud', 'cloud', 'onoff', 'Cloud sessions',
    'Tracks in cloud sessions: the Cloud tab, the cloud filter and the cloud commands.', BASIC),
  row('cloud.maxSessions', 'cloud', 'integer', 'Sessions at once',
    'Cloud sessions at once. They all count against your plan\'s usage limits.'),
  row('cloud.offerOnLeave', 'cloud', 'onoff', 'Offer sessions when I leave',
    'The orchestrator offers cloud-go once when you say you are leaving.'),
  row('cloud.collect', 'cloud', 'choice', 'When a session has finished',
    'off: you run the steps. ask: the orchestrator asks. auto: it fetches and runs the local gates without asking.', {
      choices: ['off', 'ask', 'auto'],
      // Owner decision 2026-11-12: auto brings cloud work home without you looking first. off and ask never weaken.
      weakens: (v, std) => v === 'auto' && std !== 'auto',
      protects: 'Work from a cloud session being fetched and run on your machine before you have looked at it.',
      whyNot: 'A cloud session ran out of your sight; its branch runs its own code here (the gates and the done command) ' +
        'as soon as it is fetched.',
      changes: 'The orchestrator fetches each finished session and runs the local gates on it without asking. The merge ' +
        'still follows the usual rules. Doctor will report it.',
    }),
  row('cloud.deleteBranch', 'cloud', 'onoff', 'Remove the branch after the merge',
    'The session\'s branch is removed from the remote after the merge.'),
  row('cloud.bundleMax', 'cloud', 'integer', 'Tasks per session', 'Tasks in one session, one after another.'),
  row('cloud.start', 'cloud', 'choice', 'How a session starts',
    'terminal: cloud-start in your terminal. routine: a scheduled task (see `ravenseat cloud setup`).',
    { choices: ['terminal', 'routine'] }),
  row('cloud.fireUrl', 'cloud', 'text', 'Routine URL',
    'The scheduled task `cloud send` fires with start routine. The token is only ever in the environment.',
    { edit: 'file' }),
  row('cloudHidden', 'cloud', 'list', 'Paths hidden from the cloud',
    'Paths a cloud session cannot see (for example gitignored folders); a mission that points there is stopped.'),

  // ---- 10. Plans and focus ----
  row('features.plans', 'plans', 'onoff', 'Plans room',
    'The Plans room on the board. On by default in both modes; the CLI plan register always works.', BASIC),
  row('features.focus', 'plans', 'onoff', 'Focus tab', 'The Focus tab on the board.', BASIC),
  row('features.plans.legal', 'plans', 'onoff', 'Legal surface', 'The Legal surface in Plans.', { fullWhy: WHY_PLANS }),
  row('features.plans.launch', 'plans', 'onoff', 'Launch surface', 'The Launch surface in Plans.', { fullWhy: WHY_PLANS }),
  row('features.plans.documents', 'plans', 'onoff', 'Documents surface',
    'The Documents and agreements surface in Plans.', { fullWhy: WHY_PLANS }),
  row('focus.continueWhenEmpty', 'plans', 'onoff', 'Continue when the focus ends',
    'Off: the queue pauses and asks you when a focus has ended. On: it continues with the regular queue.',
    { fullWhy: 'lite has no focus stages to end' }),
  row('modules', 'plans', 'list', 'Areas', 'The areas of the product in the plan register.', { fullWhy: WHY_PLANS }),
  row('projectModuleSuggestion', 'plans', 'object', 'Suggested area per project',
    'Used by `plan modules --link`.', { fullWhy: WHY_PLANS }),
  row('priorityRules', 'plans', 'object', 'Priority rules',
    'The priority rules in the plan register. Empty = the generic default rules.', { fullWhy: WHY_PLANS }),
  row('documents.vendors', 'plans', 'list', 'Vendors',
    'Vendors and subprocessors checked against documents. Empty = off.', { fullWhy: WHY_PLANS }),
  row('documents.secretsManifest', 'plans', 'text', 'Vendors in use',
    'A file listing the vendors actually in use. Empty = no filtering.', { edit: 'file', fullWhy: WHY_PLANS }),
  row('documents.vendorSwitches', 'plans', 'list', 'Planned vendor switches',
    'Planned switches from one vendor to another.', { fullWhy: WHY_PLANS }),
  row('documentFolders', 'plans', 'list', 'Document folders',
    'The folders the plan register looks for documents in.', { fullWhy: WHY_PLANS }),
  row('indexFile', 'plans', 'text', 'Document index',
    'The index file make-index maintains. Empty turns the index off.', { edit: 'file', fullWhy: WHY_PLANS }),
  row('planBackup', 'plans', 'text', 'Plan backup script',
    'A script that backs up the plan register (`plan backup`).', { edit: 'file', fullWhy: WHY_PLANS }),

  // ---- 11. History and storage ----
  row('stateSnapshots.enabled', 'history', 'onoff', 'Snapshots of the queue',
    'Rolling copies of queue.json at a few ages, kept in the data folder.'),
  row('stateSnapshots.tiers', 'history', 'list', 'Snapshot ages', 'Two to eight ages such as "1h", "1d", "7d".'),
  row('metrics.idleGapMin', 'history', 'integer', 'Idle gap (minutes)',
    'A gap longer than this between two transcript entries is idle and not counted as active time.'),
  // Owner decision B5: performance, not a guard (lib/timeLogArchive.js, lib/queueArchive.js).
  // Private and sharing (H3, H4: lib/queueShare.js, lib/privatePaths.js). share.queueData and share.publicOk are read
  // only here: turning sharing on is `ravenseat share on`, which explains what becomes visible and needs --yes (and
  // --public-ok in a repo not known to be private), or the owner's "Turn on" on the Checks card in a private repo.
  row('share.queueData', 'private', 'onoff', 'Queue files in git',
    'Off by default. On: queue.json and the plan register (share.include) are kept in git as a backup; the rest of the data folder stays ignored. Turn it on with ravenseat share on, which explains first.',
    { edit: 'read' }),
  row('share.include', 'private', 'list', 'Shared queue files',
    'The data folder files share on puts in git (default queue.json and plans.json). The time log, missions, reports, answers, locks and evidence can never be listed.'),
  row('share.publicOk', 'private', 'onoff', 'Sharing confirmed for a public repo',
    'Set by share on --public-ok: the owner confirmed sharing in a repo that is public or of unknown visibility. Without it the push guard refuses a commit with the shared files once the repo is no longer known to be private.',
    { edit: 'read' }),
  row('privatePaths', 'private', 'list', 'Private paths',
    'Folders (trailing /) and files of your own that stay out of git: the .gitignore, the push and merge guard and the cloud\'s hidden paths all read this list. { "path": ..., "read": false } also keeps the queue\'s agents from reading it. ravenseat private add|remove|list.'),
  row('history.rotateTimeLog', 'history', 'choice', 'Time log rotation',
    'Monthly moves the time log to one archive per month next to it (times-2026-10.jsonl) on the first write of a new ' +
    'month; every reader that needs older rows reads the archives too. Off keeps one file that only grows.', {
      choices: ['monthly', 'off'],
    }),
  row('history.archiveDoneAfterDays', 'history', 'integer', 'Archive done tasks after (days)',
    'Done and cancelled tasks untouched for this many days move from queue.json to queue-archive.json in the data ' +
    'folder, where info, explain, plans and statistics still find them. None keeps them all in queue.json.', {
      nullable: true,
    }),
]);

/** The row for a key, or null. */
function rowFor(key) {
  return SETTINGS.find((r) => r.key === key) ?? null;
}

module.exports = { LABELS, CATEGORIES, INTERNAL, QUEUE_ONLY, SETTINGS, rowFor };
