// =============================================================
// settings/push.js: the rows of Merge and push (section 8; Private and sharing, 9, sit in plans.js with History).
//
// Part of the settings registry (SPLIT-1): lib/settingsRegistry.js puts the area files together, in the order of
// AREAS there, into SETTINGS. A new row goes into the area file of its category, inside the section of that category,
// with its "Friction:" comment, as row(key, category, type, title, explanation, options) from ./rowKit.js; its default
// goes into lib/queueConfig.js STANDARD and its table row into plugin/docs/queue.md. A `requires` goes into
// ./requires.js. The row's place in this list is its place on the board and in `ravenseat settings`.
//
// Used by: lib/settingsRegistry.js.
// Tested in: lib/__tests__/settingsRegistry.test.ts (coverage, complete rows) and
// lib/__tests__/settingsRegistrySplit.test.ts (no row lost, moved or changed by the split).
// =============================================================
'use strict';

const { row, BASIC, offWeakens, rankWeakens } = require('./rowKit.js');

/** The rows of this area, in the order they are shown. */
const ROWS = Object.freeze([
  // ---- 8. Merge and push ----
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
  // Friction (GH-4): none while off. On, one branch push and `ravenseat pr` (preview, then --post and a y/N) per batch;
  // the branch must be in push.allowBranches ("ravenseat/batch-*"), so the push guard judges its push as any other.
  // Off by default: it posts on GitHub. One PR per batch, never one per track.
  row('push.pr', 'push', 'choice', 'Draft PR per batch',
    'draft: `ravenseat pr` opens one draft pull request per batch from ravenseat/batch-<date>, after a preview and your ' +
    'yes. The branch must be in push.allowBranches. off: the command refuses.', {
      choices: ['off', 'draft'],
      protects: 'A pull request on GitHub, with your login, that you did not see first.',
    }),
  // Friction: one extra question per push while CI or gates are missing, and in owner mode it comes after the owner already
  // said push. Owner decision 18.11.2026: `ravenseat controls dismiss` stops it for this one project (state in queue.json,
  // lib/controls.js, not a setting), and it asks again if something else goes missing. The default stays on: a new user
  // with no checks still hears it once, and the dismissal is one command away in the question itself.
  row('push.controlsWarning', 'push', 'onoff', 'Ask on push without checks',
    'A push asks first when the project has no CI config or no gates. `ravenseat controls dismiss` stops the question ' +
    'for this project until something else goes missing (undo: `ravenseat controls restore`); off here stops it everywhere.', {
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
    'waits until each is closed with a commit or rejected with a reason. On in full mode. Off in lite, the same as ' +
    'reviewItems.stop, since a first try should not meet a hard stop; done then still names the open items.', {
      weakens: offWeakens,
      defaultByMode: { lite: false, full: true },
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
  row('push.ciWatchIntervalSec', 'push', 'integer', 'CI watch interval (seconds)',
    'How often the CI watch asks GitHub how the runs are going. Lower answers sooner and makes more calls.'),
  row('push.ciWatchTimeoutMin', 'push', 'integer', 'CI watch limit (minutes)',
    'The CI watch stops with a timeout when CI has not finished after this many minutes, so it never waits forever. A ' +
    'timeout gives no fix task.'),
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
    'The environments a migration push may go to. Merge pushes migrations only when the linked environment file names ' +
    'one of them, so a wrong link cannot reach the wrong database.',
    { protects: 'A migration pushed to the wrong database because the wrong environment is linked.' }),
  // MS-1 (lib/mergeDanger.js; the switch lib/doorShow.js; friction review 22.11 Top 4). Friction: a few tokens per track
  // report and per review (two lines each) and one DOOR line per receive; display only, it never stops, blocks or
  // approves anything. On by default in both modes because it is what makes a one-way door visible before a merge.
  // Here, not under Review and agents (at its cap of 25 rows): it is about how hard a merge is to undo.
  row('mergeDanger.show', 'push', 'onoff', 'Door and blast radius',
    'Tracks and reviewers write two lines: a one-way or two-way door (one-way: hard to undo once merged) and a one-word ' +
    'blast radius. Receive prints them, and Decisions, decide and the PR body show them; a one-way door is marked. ' +
    'Never a stop. Off: the agents are told to leave the lines out, and nothing is shown.'),
]);

module.exports = { ROWS };
