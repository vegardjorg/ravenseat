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
//   category       one of CATEGORIES (the eleven groups, each with its basic settings first, the advanced ones under)
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

/** The eleven categories, in the order they are shown. */
const CATEGORIES = Object.freeze([
  { id: 'project', title: 'Project and git' },
  { id: 'limits', title: 'Limits and cost' },
  { id: 'load', title: 'Machine load' },
  { id: 'gates', title: 'Gates and checks' },
  { id: 'guards', title: 'Agent guards' },
  { id: 'push', title: 'Merge and push' },
  { id: 'review', title: 'Review and agents' },
  { id: 'board', title: 'Board and advice' },
  { id: 'cloud', title: 'Cloud' },
  { id: 'plans', title: 'Plans and focus' },
  { id: 'history', title: 'History and storage' },
]);

/** Keys in STANDARD that are not settings (none today; a key goes here only with a comment saying why). */
const INTERNAL = Object.freeze([]);

/** queue.json keys with no counterpart in STANDARD (the limits are checked against LIMIT_NAME and LIMIT_EXTRA instead). */
const QUEUE_ONLY = Object.freeze(['guidance', 'checksPanel.mode']);

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
  row('gateTemp.enabled', 'load', 'onoff', 'Temp folder per gate run',
    'Each gate run gets its own temp folder, removed afterwards, so what the tests leave goes with it.'),
  row('limits.parallelThreshold', 'load', 'number', 'Low parallelism threshold',
    'The share of concurrent tracks below which fill, receive and pulse write a short queue diagnosis. 0 = off.', QUEUE),
  row('limits.silentMin', 'load', 'integer', 'Silent after (minutes)',
    'Minutes without a sign of life before a running track counts as silent. 0 = off.', QUEUE),

  // ---- 4. Gates and checks ----
  row('gates.quick', 'gates', 'list', 'Quick gate',
    'The commands a track runs before delivery. Set them up with `ravenseat kickstart gates --apply`.', BASIC),
  row('gates.full', 'gates', 'list', 'Full gate', 'The full set of commands receive and merge run.', BASIC),
  row('checksPanel.mode', 'gates', 'onoff', 'Show the Checks tab',
    'The Checks tab with suggested checks. Not set, it follows the guidance switch.', { ...BASIC, ...QUEUE }),
  row('maxFixRounds', 'gates', 'integer', 'Fix rounds before an owner question',
    'At this many fix rounds a task becomes an owner question instead of another round.'),
  row('fixPlateau', 'gates', 'onoff', 'Ask when a fix round stalls',
    'Before a fix round, ask when the previous one committed nothing or the check fails the same way.'),
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
  row('gates.flakyRerun', 'gates', 'onoff', 'Rerun red gate commands once',
    'A red gate in a track reruns only its red commands once on the same commit. Green then counts as flaky.'),
  row('gates.redOnBase', 'gates', 'object', 'Red on base check',
    'At receive, the track\'s new tests must pass on the tip and at least one must fail without the change. A warning.'),
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
