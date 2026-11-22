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
//   category       one of CATEGORIES (the sixteen groups, each with its basic settings first, the advanced ones under)
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
//   protects, whyNot, changes  the three texts of the warning dialog, the CLI warning and doctor; required with weakens.
//                  protects (one short sentence) is also set on a guard with no weakening value, and the board ("Protects
//                  against: ...") and `ravenseat settings <key>` show it for every row that has it (finding M1); an
//                  advice row has none
//   requires       the rows this one needs to have any effect, or null: "key" (that row must be on: not false, off, none,
//                  0 or empty) or "key=value" (it must have that value, as the CLI writes it: "push.mode=owner"). Only where
//                  the code really ignores the row while the parent is off, read in the code (finding M3 of
//                  plans/gjennomgang-friksjon-innstillinger-2026-11-17.md, owner decision). The board and `ravenseat
//                  settings` show it ("Has effect only when ...", [needs ...]) and mark the row while it has no effect
//                  (lib/settingsView.js); it is never hidden, and no default or behavior follows from it. A parent in
//                  another group is named in the explanation (the registry test checks it, and that there are no cycles).
//
// INTERNAL lists keys in STANDARD that are not settings a person changes (today only board.updateCheck, the old name of
// updates.check that is still read). QUEUE_ONLY lists the queue.json
// keys that have no counterpart in STANDARD. The coverage test (lib/__tests__/settingsRegistry.test.ts) fails when a key
// in STANDARD, a limit, a cloud setting, a board switch or a module has no row.
//
// Owner decisions B1-B5 (plans/ROADMAP.md): B1 (agentPushBlock.enabled), B2 (gateEvidence.mode, .external: gates,
// advanced, both modes, choices own/external/off, external and off weaken) and B3 (agentGuard.enabled, .except) have
// their rows, and so does B4 (ownership.sharedPatchCollides: files, advanced, full only because shared_patch is the full
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

/**
 * The sixteen categories, in the order they are shown. `note` (optional) is one line shown under the title, on the board
 * and in `ravenseat settings`, for what the rows of a group share and no single row can say.
 *
 * Owner decision 2026-11-17 (plans/gjennomgang-friksjon-innstillinger-2026-11-17.md, H2, L1, M7): "Gates and checks"
 * held 55 rows and "Review and agents" 32, so they were split into Gates, Tests and evidence, Checks tab and learning,
 * and Scope and catalog. No key changed (learning.* stays the name space of the learning loop); only the group a row is
 * shown in. The three sources of guard proposals share the learning group and its note, and keep their defaults.
 * Owner decision 2026-11-18: "Agent guards" (29 rows, all Advanced) was split the same way into File and read guards
 * (what a track may write, read and change: protected paths, control files, git hooks, read limits) and Command and
 * secret guards (what an agent may run or send out: push, network, deploy, approvals, the secret scans and the opt-in
 * checks). Each has its main switch under Basic (controlFiles.guard, agentGuard.enabled). No key changed.
 */
const CATEGORIES = Object.freeze([
  { id: 'project', title: 'Project and git' },
  { id: 'limits', title: 'Limits and cost' },
  { id: 'load', title: 'Machine load' },
  { id: 'gates', title: 'Gates' },
  { id: 'tests', title: 'Tests and evidence' },
  {
    id: 'learning',
    title: 'Checks tab and learning',
    note:
      'Three sources can propose a task that builds a new guard: a failure that keeps repeating (inspection.mode, on), ' +
      'a known bug (gates.fromKnownBugs, propose) and the finding log (learning.proposals, off). Together they keep at ' +
      'most three proposals open, and each one waits for your approval, so none of them starts work by itself. The ' +
      'finding log source is an opt-in check, off until you turn it on, since its proposals ask for your time.',
  },
  { id: 'files', title: 'File and read guards' },
  { id: 'guards', title: 'Command and secret guards' },
  { id: 'push', title: 'Merge and push' },
  { id: 'private', title: 'Private and sharing' },
  { id: 'review', title: 'Review and agents' },
  { id: 'scope', title: 'Scope and catalog' },
  { id: 'board', title: 'Board and advice' },
  { id: 'cloud', title: 'Cloud' },
  { id: 'plans', title: 'Plans and focus' },
  { id: 'history', title: 'History and storage' },
]);

/** Keys in STANDARD that are not settings (none today; a key goes here only with a comment saying why). */
// board.updateCheck: the old name of updates.check (0u3). Still read (false turns the check off), but not shown as a
// setting of its own, so the board and `ravenseat settings` show one switch.
const INTERNAL = Object.freeze(['board.updateCheck']);

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

/**
 * The `requires` of each row that has one (see the header), kept in one table so each entry can name the code that
 * ignores the row while its parent is off. A key here that is no row fails the registry test. Read in the code, not
 * guessed; left out on purpose (the code still reads them with the parent off): gates.redOnBaseStrict (stops every fix
 * without red on base, which doctor warns about), limits.nightWindow (the Statistics night share), scopeNotes.ignoreNames
 * (the catalog's near names), instructionSize.maxLines/maxChars (`ravenseat instructions`), baseGate.timeoutSec (the
 * receive and merge budget), testWeakening.testPaths (red on base), migrations.pushCommand, environmentFile and
 * allowedEnvironment (the push guard), learning.proposals (the catalog rule gates need no learning.repeats) and the
 * cloud.* rows (the cloud commands do not read features.cloud).
 */
const REQUIRES = Object.freeze({
  // lib/fixRound.js: continueWithinMin 0 turns continuation off before the context cap is read.
  'fixRound.continueMaxContextK': ['fixRound.continueWithinMin'],
  // lib/gateEvidence.js: the names are read only in mode external.
  'gateEvidence.external': ['gateEvidence.mode=external'],
  // lib/gateClean.js decide: with gates.runner worktree no run uses a clean copy (only a one-off --clean reads them).
  'gates.clean.dependencies': ['gates.runner=clean'],
  'gates.clean.copy': ['gates.runner=clean'],
  'gates.clean.include': ['gates.runner=clean'],
  'gates.clean.kinds': ['gates.runner=clean'],
  'gates.clean.keepOnRed': ['gates.runner=clean'],
  // lib/baseHealth.js setup: enabled false turns the base gate off, with its commands, output tail and rerun.
  'baseGate.commands': ['baseGate.enabled'],
  'baseGate.tailLines': ['baseGate.enabled'],
  'baseGate.flakyRerun': ['baseGate.enabled'],
  // cli/merge.mjs: the test weakening check (and its focus stop, finding row and markers) is skipped when off.
  'testWeakening.focusStop': ['testWeakening.enabled'],
  'testWeakening.findingLog': ['testWeakening.enabled'],
  'testWeakening.markers': ['testWeakening.enabled'],
  // cli/merge.mjs: no decision signal is read when off, so the thresholds have nothing to count.
  'decisionSignals.deleteMin': ['decisionSignals.enabled'],
  'decisionSignals.bigDiffLines': ['decisionSignals.enabled'],
  // lib/fixTests.js receiveLine: red on base off gives no verdict, so the default mode prints no fix line.
  'gates.fixWithoutTestWarning': ['gates.redOnBase'],
  // board/checks.js drawChecksTab: the dot sits on the tab, which is hidden with the tab off.
  'checksPanel.marker': ['checksPanel.mode'],
  // cli/inspection.mjs: with inspection.mode off nothing is scanned or proposed.
  'inspection.minRepeats': ['inspection.mode'],
  'inspection.windowDays': ['inspection.mode'],
  // lib/findingRepeats.js scan and facts: learning.repeats off returns no entries, nothing due and no guard failed.
  'learning.windowDays': ['learning.repeats'],
  'learning.areaRepeats': ['learning.repeats'],
  'learning.projectRepeats': ['learning.repeats'],
  'learning.guardFailedMarker': ['learning.repeats'],
  // checks-catalog/suggestions/ledger-recipes.md (when: inspection-on, ledger-due): the recipes, the database ones and
  // their damping (lib/checksCatalog.js, lib/recipePrecision.js) are only on that card.
  'learning.dbProbes': ['inspection.mode', 'learning.repeats'],
  'learning.recipeDamping': ['inspection.mode', 'learning.repeats'],
  'learning.recipeMinProposals': ['learning.recipeDamping'],
  'learning.recipeMinProposalsDb': ['learning.recipeDamping', 'learning.dbProbes'],
  'learning.recipeMinAccepted': ['learning.recipeDamping'],
  // lib/agentGuard.js: with enabled false the other types are not guarded, so there is nothing to leave out.
  'agentGuard.except': ['agentGuard.enabled'],
  // lib/pushBatch.js ownerAskOn: only in push mode owner.
  'push.ownerAsk': ['push.mode=owner'],
  // cli/ciWatch.mjs: with push.ciWatch off nothing is watched.
  'push.ciWatchIntervalSec': ['push.ciWatch=github'],
  'push.ciWatchTimeoutMin': ['push.ciWatch=github'],
  // lib/logic/merge.js migrFiles and lib/logic/select.js migrTens: no folder, no migration files and no blocks.
  'migrations.filePattern': ['migrations.folder'],
  'migrations.blockSize': ['migrations.folder'],
  // lib/queueProposals.js: auto-accept off approves nothing, whatever the rules say.
  'proposals.autoAccept.classes': ['proposals.autoAccept.enabled'],
  'proposals.autoAccept.maxEstimateMin': ['proposals.autoAccept.enabled'],
  'proposals.autoAccept.maxValue': ['proposals.autoAccept.enabled'],
  // lib/scopeNotes.js: the depth is read only for the new folder note, the two numbers only for the gap review.
  'scopeNotes.folderDepth': ['scopeNotes.newFolders'],
  'scopeNotes.driftGapFiles': ['scopeNotes.driftGap'],
  'scopeNotes.driftGapShare': ['scopeNotes.driftGap'],
  // lib/catalogChecks.js: checks off tries no rule, so there is nothing to stop on and nothing broken again; the lint
  // proposal also needs learning.proposals (cli/catalog.mjs proposeRuleGates).
  'catalog.checkStop': ['catalog.checks'],
  'catalog.gateAfter': ['learning.proposals', 'catalog.checks'],
  // board/top.js applyFeatures: the Cloud tab comes with the cloud module.
  'board.showCloud': ['features.cloud'],
  // board/timeline.js: with the Timeline tab off nothing is fetched or drawn, so its horizon and rows are not read.
  'board.timelineHorizonDays': ['board.timeline'],
  'board.timelineRows': ['board.timeline'],
  // cli/checks.mjs canaryFacts: with the canary off no transcript is read, so no shape is logged.
  'client.shapeLog': ['client.canary'],
  // lib/queueConfig.js features: a part is off while its parent is off.
  'features.plans.legal': ['features.plans'],
  'features.plans.launch': ['features.plans'],
  'features.plans.documents': ['features.plans'],
  'features.plans.inbox': ['features.plans'],
  // The Roadmap rows: without the Plans room there is no roadmap, and queue-board.mjs plans() reads no plan document.
  'plans.startView': ['features.plans'],
  'plans.roadmapLayout': ['features.plans'],
  'plans.roadmapFoldAfter': ['features.plans'],
  'plans.leadFromDocument': ['features.plans'],
  'plans.searchDocuments': ['features.plans'],
  // lib/loadSlots.js: adaptive off keeps every slot open, so the scaling numbers are not read.
  'loadGuard.minSlots': ['loadGuard.adaptive'],
  'loadGuard.allSlotsFreeMemoryPct': ['loadGuard.adaptive'],
  'loadGuard.allSlotsCpuPct': ['loadGuard.adaptive'],
  'loadGuard.minSlotsCpuPct': ['loadGuard.adaptive'],
  // lib/gateQueue.js isHeavy: with the gate queue off no run counts as heavy or waits for a slot.
  'gateQueue.slots': ['gateQueue.enabled'],
  'gateQueue.heavyAfterSec': ['gateQueue.enabled'],
  'gateQueue.agingMin': ['gateQueue.enabled'],
  // lib/stateSnapshots.js tiersFrom: enabled false gives no tiers.
  'stateSnapshots.tiers': ['stateSnapshots.enabled'],
  // lib/silentSnapshot.js: enabled false writes no snapshot, so neither the count nor the cap is read.
  'silentSnapshot.keep': ['silentSnapshot.enabled'],
  'silentSnapshot.maxKB': ['silentSnapshot.enabled'],
});

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
    // What the row guards against, in one short sentence (finding M1): required with weakens, and also set on the guards
    // that have no weakening value (a list, a number or a choice that stops, asks or checks). Advice rows have none.
    protects: o.protects ?? null,
    whyNot: o.weakens ? o.whyNot : null,
    changes: o.weakens ? o.changes : null,
    // A number that also takes none (null) although its default is a number (parseValue).
    nullable: o.nullable === true,
    requires: REQUIRES[key] ? Object.freeze([...REQUIRES[key]]) : null,
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
  // Tidy (lib/tidy.js, cli/tidy.mjs, roadmap 1b). Friction: none for doctor, display only (one INFO row when there is
  // something to remove; never WARN or FAIL), so on. afterMerge deletes by itself after a merge, and a delete cannot be
  // undone even when the branch is merged (an ignored file, a local note, a build left in the folder is gone), so it is
  // off and the owner turns it on. minAgeHours: none in practice (a worktree waits a few hours longer); it keeps a fresh
  // worktree with no commits yet, which looks merged, from being deleted.
  row('tidy.doctor', 'project', 'onoff', 'Tidy row in doctor',
    'Doctor shows one INFO row with how many merged, clean worktrees and merged branches ravenseat tidy --execute would ' +
    'remove, their size and the command. Only when there is something; it never warns or stops anything.'),
  row('tidy.afterMerge', 'project', 'onoff', 'Tidy after merge',
    'After a merge, the task\'s worktrees anywhere on disk (not only .claude/worktrees) are removed by the tidy rules: ' +
    'merged, clean, not locked, links first, then the folder, git worktree prune, git branch -d. Off by default, ' +
    'because a delete cannot be undone, even when the branch is merged.'),
  row('tidy.minAgeHours', 'project', 'number', 'Tidy minimum age (hours)',
    'ravenseat tidy leaves a worktree changed more recently than this, since a new worktree with no commits yet looks ' +
    'merged. 0 = no minimum.'),
  // GitHub issues (GH-1, GH-2: cli/issues.mjs, lib/issueLink.js). Friction: none for refsTrailer, one local line in a
  // merge commit, no network call, and it never closes the issue (Refs, not Closes), so on. labelMap: none while empty
  // (every import is a plan in the Inbox); a map only changes where an import lands, and an imported task is still
  // proposed and never auto-accepted, so it cannot start work. Empty by default, the owner fills it.
  row('issues.refsTrailer', 'project', 'onoff', 'Refs trailer on merge',
    'A task linked to a GitHub issue gets a "Refs: #12" line in its merge commit. Local only: it never closes the ' +
    'issue and makes no network call.'),
  row('issues.labelMap', 'project', 'object', 'Issue label map',
    'Routes `ravenseat issues import` by label, for example { "ready-for-agent": "task", "bug": "K" }. Empty = off: ' +
    'every import is a plan in the Inbox. An imported task is always proposed, never accepted for you.'),
  // Friction (GH-3): none while off. On, two commands after a push (the preview, then --post) and one y/N, with the
  // approval dialog in a Claude Code session. Off by default: it posts on GitHub under your login, often in public, and a
  // post stays. Not a weakening: it opens no guard, it adds an outbound write behind the outbound guard (lib/ghOutbound.js).
  row('issues.onPush', 'project', 'choice', 'Issues after a push',
    'What `ravenseat issues report --post` does to the issues your pushed tasks link to: off, comment (task, title, ' +
    'merge commit, checks) or close (the same comment, then close). Always a preview first and your yes; a secret blocks it.', {
      choices: ['off', 'comment', 'close'],
      protects: 'Posts on GitHub, often public and permanent, that you did not see first.',
    }),

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
  row('gateQueue.slots', 'load', 'integer', 'Heavy gate slots',
    'How many heavy gate runs the whole machine runs at once (1 by default), so parallel tracks do not slow each other ' +
    'down. Raise it when the machine has room.'),
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
  // Friction: none, it never stops work: when a track turns SILENT, the command that noticed it (show, state, pulse)
  // writes one local file once per silence (the transcript tail, background jobs that never reported back, the
  // processes that name the worktree), redacted before writing and size-capped; any failure is skipped. The process
  // list costs a few seconds once per silence (about 4 s measured on a loaded Windows machine). On by default by the owner's decision of 16.11.2026 (roadmap 0y Y4,
  // plans/projectarchitect-vurdering-2026-11-16.md): the evidence is gone by the time someone looks.
  row('silentSnapshot.enabled', 'load', 'onoff', 'Evidence snapshot at SILENT',
    'When a running track turns SILENT, write one local file (in the queue\'s data folder, never pushed) with the tail ' +
    'of its transcript, background jobs that never reported back and the processes that name its worktree, with ' +
    'secrets, env values and URL credentials redacted first. The SILENT line says where it is. Off: nothing is written.'),
  row('silentSnapshot.keep', 'load', 'integer', 'Evidence snapshots kept',
    'How many SILENT snapshots to keep; the oldest beyond this are removed when a new one is written (20 by default).'),
  row('silentSnapshot.maxKB', 'load', 'integer', 'Evidence snapshot size (KB)',
    'The most one SILENT snapshot may hold; the oldest transcript rows are left out first (64 by default).'),
  row('limits.noAgentMin', 'load', 'integer', 'No agent after (minutes)',
    'Minutes before a track marked running, with no agent on its branch and no report, counts as NO AGENT. 0 = off.', QUEUE),
  // Friction: none, it never stops work: a line in show and the pulse, and after an hour a Decisions card with the
  // same choices as SILENT. On by default (the owner's decision of 18.11.2026, roadmap 0æ N3): a track that burns
  // tokens without progress is the costliest quiet failure, and SILENT cannot see it.
  row('limits.spinMin', 'load', 'integer', 'Spinning after (minutes)',
    'Minutes a busy track may go without real work (only to-do lists, tool loading, sleeps or the same reads again, no ' +
    'write, command or commit) before it counts as SPINNING. Shown only; after an hour also a Decisions card. 0 = off.', QUEUE),

  // ---- 4. Gates ----
  row('gates.quick', 'gates', 'list', 'Quick gate',
    'The commands a track runs before delivery. Set them up with `ravenseat kickstart gates --apply`.', {
      ...BASIC,
      protects: 'A track that delivers work its own quick checks would have failed.',
    }),
  row('gates.full', 'gates', 'list', 'Full gate',
    'The full set of commands receive and merge run. Empty = nothing runs and the gate counts as green, so set it up ' +
    'with `ravenseat kickstart gates --apply`.', {
      ...BASIC,
      protects: 'Broken code merged into the base branch, since receive and merge run these commands before it goes in.',
    }),
  row('maxFixRounds', 'gates', 'integer', 'Fix rounds before an owner question',
    'At this many fix rounds a task becomes an owner question instead of another round.',
    { protects: 'A task that loops through fix rounds without end instead of coming to you.' }),
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
  // Friction: none. A hidden window changes no output, exit code or stdio; it only stops a console window opening for
  // each git, cmd or npm call below a detached run (a test run made the screen blink). On by default for that reason;
  // off only as an escape hatch if the preload ever gets in a project's way. Windows only; off weakens no guard.
  row('windows.hideConsoles', 'gates', 'onoff', 'Hide console windows (Windows)',
    'Detached runs (the wait mode, gates, the tree guard, the update check) start everything below them with hidden ' +
    'windows, so a test run opens no console window per git call. Off: the windows show as before.'),
  row('gates.flakyRerun', 'gates', 'onoff', 'Rerun red gate commands once',
    'A red gate in a track reruns only its red commands once on the same commit. Green then counts as flaky.'),
  // Friction: it stops a fix round, but only one that could never help (the gate's own program is missing on this
  // machine, on the tip and on the base), and replaces it with one owner question. On by default for that reason; the
  // rule is narrow (first program only, never "Cannot find module"), so a code failure still gets its fix round.
  row('gates.brokenVerdict', 'gates', 'onoff', 'Ask when a gate cannot run',
    'A red quick gate whose own program is not installed here (also on the base branch) is a setup problem: receive ' +
    'asks you once instead of starting a fix round. A changed gates setup forgets the verdict. Off: a fix round as before.'),
  // Friction: off by default, since clean can stop work: a project whose tests need an ignored local file (a .env, a
  // local config) is red in the copy until that file is listed in gates.clean.include. On: about 2 s more per full gate
  // with linked dependencies (measured 2026-11-20, plans/gos1-clean-gate-analyse-2026-11-20.md), no extra model tokens
  // beyond a wait turn now and then. Only the full gate before merge uses it, never the quick checks.
  row('gates.runner', 'tests', 'choice', 'Where the full gate runs',
    'Worktree: the full gate before merge runs in the track\'s worktree, where untracked and ignored files and the shared ' +
    'node_modules can change the result (the evidence line says so). Clean: it runs in a fresh copy of the exact commit ' +
    'with dependencies linked (or installed) from the lockfile, so a green gate means this commit passed. Clean adds ' +
    'about 2 seconds with linked dependencies and can turn red when tests need an ignored local file; list those in ' +
    'gates.clean.include.', {
      choices: ['worktree', 'clean'],
      protects: 'A green full gate that passed only because of files or packages the commit does not have.',
    }),
  // Friction: none while gates.runner is worktree. Link is the default: about 2 s, and no install script runs at the
  // orchestrator's gate. Install closes the lockfile gap too but takes 25 to 60 s and runs postinstall scripts; auto
  // installs only when the commit's lockfile differs from the linked folder's.
  row('gates.clean.dependencies', 'tests', 'choice', 'Dependencies in the clean copy',
    'Link: the shared folders (sharedLinks, such as node_modules) are linked into the copy, about 2 seconds. Install: ' +
    'a frozen install from the commit\'s lockfile (npm ci, pnpm, yarn or bun), 25 to 60 seconds, and it runs install ' +
    'scripts. Auto: install only when the commit\'s lockfile differs from the one the linked folder was installed from.', {
      choices: ['link', 'install', 'auto'],
    }),
  // Friction: none while gates.runner is worktree. A git worktree copy keeps .git, so tests that call git still work;
  // archive is for a project that wants no .git in the copy.
  row('gates.clean.copy', 'tests', 'choice', 'How the clean copy is made',
    'Worktree: git worktree add --detach, which keeps .git for tests that call git and handles Git LFS. Archive: git ' +
    'archive, a plain copy of the files with no .git.', { choices: ['worktree', 'archive'] }),
  // Friction: it removes friction (the escape hatch for a false red). Empty by default: nothing outside the commit.
  row('gates.clean.include', 'tests', 'list', 'Ignored files copied into the clean copy',
    'Ignored files or folders the tests need, copied from the worktree into the clean copy (for example .env.test). ' +
    'Never an absolute path, .., .git, a key or token file, or an env file that may hold real keys: the gate runs with ' +
    'secrets taken out of its environment, and a file must not bring them back.'),
  // Friction: none while gates.runner is worktree. Only the full gate before merge by default, never a track's quick
  // checks: base and push add the same 2 s to the merge and the push checks.
  row('gates.clean.kinds', 'tests', 'list', 'Which gate runs use the clean copy',
    'full: the gate on the delivered tip before merge (receive). base: the gate on the merge commit. push: the full gate ' +
    'in the main checkout before a batch push. A track\'s own run in its worktree never uses it.'),
  // Friction: off: a kept copy takes disk until the sweep. On only while you look into a red clean run.
  row('gates.clean.keepOnRed', 'tests', 'onoff', 'Keep a red clean copy',
    'Keep the copy of a red clean run for inspection. The next clean run or the doctor removes it after ' +
    'gates.clean.sweepAfterHours.'),
  // Friction: none. One hour, as for the gate temp folders: a running gate is never touched (its process is alive).
  row('gates.clean.sweepAfterHours', 'tests', 'integer', 'Remove old clean copies after (hours)',
    'A clean copy whose run has ended is removed after this many hours by the next clean run or the doctor, links ' +
    'first. A copy that cannot be removed stays and the doctor warns.'),
  row('gateEvidence.mode', 'gates', 'choice', 'Gate evidence',
    'Who is trusted that the checks passed: Ravenseat running them itself (own), your CI (external), or the track\'s own ' +
    'word (off). Own is the default, because a track could write a green result it never got. Own: receive and merge ' +
    'run the gates themselves and check your answers and edits against the owner log. External: a green CI check on ' +
    'the same commit counts as the full gate. Off: the track\'s own word counts.', {
      choices: ['own', 'external', 'off'],
      weakens: rankWeakens(['own', 'external', 'off']),
      protects: 'A track that writes a green gate result or an owner row it never got, and has it believed at receive and merge.',
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
  row('baseGate.timeoutSec', 'gates', 'integer', 'Base gate budget (seconds)',
    'The time budget for the whole base gate that runs after a merge, shared by its commands (900 by default). Raise it ' +
    'when your full gate is slower than that.'),
  row('baseGate.tailLines', 'gates', 'integer', 'Base gate output lines kept',
    'The output lines kept for the fix task. Empty = the done command\'s value.'),
  row('baseGate.flakyRerun', 'gates', 'onoff', 'Rerun a red base gate once',
    'A red base gate reruns only the failed commands once on the same commit; green then is a flaky finding.'),

  // ---- 5. Tests and evidence ----
  // What makes a green gate worth something: the tests a track adds or removes, red on base and the QA evidence. Split
  // out of Gates by the owner decision of 2026-11-17 (H2); the keys stayed. The two test weakening switches are basic.
  row('gates.redOnBase', 'tests', 'object', 'Prove that new tests catch the bug',
    'Off until you set a test command, since Ravenseat must know how to run one test file. On: at receive, a track\'s ' +
    'new tests must pass with the change and at least one must fail without it, which shows the test really catches ' +
    'the bug. Only a warning, because a pure refactor rightly has no failing test. The two fix rows in this group need it.',
    { protects: 'A new test that passes with or without the change, so it proves nothing about the bug.' }),
  row('gates.redOnBaseStrict', 'tests', 'onoff', 'A fix needs a proven red test',
    'Off by default: a fix task without a test that fails on the base gets one warning at receive. On: merge stops on it, ' +
    'and the owner can merge past it with --allow-no-test, which is logged. Needs gates.redOnBase.', {
      weakens: offWeakens,
      protects: 'A fix merged with no test that fails without it, so the same bug can come back unnoticed.',
      whyNot: 'Fixes without a proven red test are only warned about and logged as fixed without test.',
      changes: 'Merge no longer stops on a fix without a proven red test; receive still warns.',
    }),
  row('gates.fixWithoutTestWarning', 'tests', 'onoff', 'Warn about a fix without a red test',
    'Needs gates.redOnBase, which is off until you set a test command. A fix task whose red on base check proves no ' +
    'test gets one FIX WITHOUT TEST line at receive, so you see that the bug may come back. On by default: it is one ' +
    'line and stops nothing.', {
      weakens: offWeakens,
      protects: 'A fix that comes in with a test that would pass without it, read past as one more red on base line.',
      whyNot: 'The fix-specific line names the task it fixes, so the owner sees the bug may come back.',
      changes: 'Receive prints only the plain red on base line; the finding log still marks the row fixed without test.',
    }),
  row('testWeakening.enabled', 'tests', 'onoff', 'Test weakening warning',
    'Receive warns about deleted or moved test files and added skip or focus markers.', {
      ...BASIC,
      weakens: offWeakens,
      protects: 'A track that gets green by deleting, moving or skipping tests.',
      whyNot: 'A green gate means little when the tests that would fail were taken away in the same change.',
      changes: 'Receive no longer reports deleted tests or added skip markers. Doctor will report it.',
    }),
  row('testWeakening.focusStop', 'tests', 'onoff', 'Stop on a focus marker',
    'A focus marker (.only, fit, fdescribe) on an added line stops the merge, since the other tests never ran.', {
      ...BASIC,
      weakens: offWeakens,
      protects: 'A merge where only the focused tests ran.',
      whyNot: 'With .only in place the rest of the suite is skipped, so the gate says green without checking it.',
      changes: 'A focus marker gives only a warning, and the merge goes on. Doctor will report it.',
    }),
  // A log row only: the warning and the focus stop are their own rows, so off weakens no guard (owner decision 2026-11-17).
  row('testWeakening.findingLog', 'tests', 'onoff', 'Log test weakening as a finding',
    'What the test weakening check finds also becomes a finding log row, classed as a weak test. Nothing is printed. ' +
    'Off: no such row; the warning and the focus stop stay, so no guard is weaker.'),
  // Friction: none. It appends about 250 bytes to a local, gitignored file after a run that has already ended, the file
  // is cut to its newest 1000 rows past 512 KB, and a failed write is ignored, so it can never slow or stop a run. On by
  // default (TC-1, 2026-11-19): the pick of test:changed and the time a run takes can only be judged from rows that were
  // there all along. A log row only, so off weakens no guard.
  row('testRuns.log', 'tests', 'onoff', 'Log test runs',
    'Each test:changed and plain npm test run in this repo is one row in a local file (time, mode, picked and total ' +
    'files, run time, exit, test and failed counts), read with node scripts/test-changed.mjs --stats. Off: no rows.'),
  row('testWeakening.testPaths', 'tests', 'list', 'More test paths',
    'More file patterns that count as test files for the test weakening warning, on top of the usual ones (the same ' +
    'pattern rules as protectedPaths).'),
  row('testWeakening.markers', 'tests', 'list', 'More skip markers',
    'More regular expressions for an added line in a test file.'),
  row('qa.evidenceTypes', 'tests', 'list', 'Evidence types',
    'The kinds of QA evidence a track may report on an EVIDENCE line, such as a screenshot or a test run. Receive asks ' +
    'for evidence on the labels in qa.evidenceLabels.'),
  row('qa.autoTypes', 'tests', 'list', 'Automatic evidence types',
    'Evidence types closed by `ravenseat qa auto --run` when the auto command is green.'),
  row('qa.manualTypes', 'tests', 'list', 'Manual evidence types',
    'Evidence types a person gathers by hand. They are collected in one manual round for many tasks, not one at a time.'),
  row('qa.autoCommand', 'tests', 'object', 'Automatic evidence command',
    'The command `qa auto --run` runs, with {refs} and {id}. Empty = qa auto only lists.'),
  row('qa.evidenceLabels', 'tests', 'list', 'Labels that need evidence',
    'Receive warns when a task with one of these labels delivers without evidence.'),

  // ---- 6. Checks tab and learning ----
  // The Checks tab and everything that suggests a guard: the inspection queue, known bugs and the learning loop over the
  // finding log (learning.* stays the key space). The category's note explains the shared cap of three proposals (M7).
  row('checksPanel.mode', 'learning', 'onoff', 'Show the Checks tab',
    'The Checks tab with suggested checks. Not set, it follows the guidance switch.', { ...BASIC, ...QUEUE }),
  row('checksPanel.marker', 'learning', 'onoff', 'Red dot on the Checks tab',
    'A small red dot on the Checks tab while an important suggestion is open, so you notice it without opening the ' +
    'tab. Off hides the dot for every reason; the suggestions stay. learning.guardFailedMarker only decides whether a ' +
    'guard that did not hold lights it.', { ...BASIC, ...QUEUE }),
  row('gates.fromKnownBugs', 'learning', 'choice', 'Gates from known bugs',
    'A known bug that can happen again becomes a gate task: propose (you approve), auto or off.', {
      choices: ['propose', 'auto', 'off'],
      weakens: (v, std) => v === 'auto' && std !== 'auto',
      protects: 'Tasks, and the tokens they use, that start without your approval.',
      whyNot: 'Auto approves every proposed gate task at once; each one runs an agent and uses tokens without asking.',
      changes: 'Gate tasks from known bugs are approved by the queue itself. Doctor will report it.',
    }),
  row('inspection.mode', 'learning', 'choice', 'Propose a guard for a failure that repeats',
    'When the same failure shows up in the gates or CI again and again, Ravenseat proposes one task to build a guard ' +
    'for it; you approve or decline. On by default, since a proposal only waits for your answer. Off: no such ' +
    'proposals, and the Checks card with recipes for failures that keep coming back (and its Build as gate button) is ' +
    'hidden too. Nothing is stopped either way.', {
      ...BASIC,
      choices: ['on', 'off'],
    }),
  row('inspection.minRepeats', 'learning', 'integer', 'Repeats before a proposal',
    'How many separate tasks, branch days or CI commits must fail the same way before it is proposed.'),
  row('inspection.windowDays', 'learning', 'integer', 'Inspection window (days)',
    'Only failures from this many recent days count toward a proposal (30 by default), so a failure fixed for good ' +
    'long ago is not proposed again.'),
  row('inspection.registryFile', 'learning', 'text', 'Guard registry file',
    'The tracked list of guards and what each one guards against, relative to the project root.', { edit: 'file' }),
  // The repeat count on class and area (lib/findingRepeats.js). The count and the guard failed marker are on: they cost
  // no tokens, print nothing and stop nothing. The proposals are off: each one asks for the owner's time.
  row('learning.repeats', 'learning', 'onoff', 'Count failures that come back',
    'Counts failures of the same kind in the same part of the code, across tasks, from the finding log. It prints ' +
    'nothing and stops nothing; the Checks tab uses it to say that a guard did not hold and to suggest recipes. On by ' +
    'default, since it costs no tokens. Off also hides those.', {
      weakens: offWeakens,
      protects: 'A kind of failure that keeps coming back in one place, or past a guard, going unseen because each one ' +
        'was fixed alone.',
      whyNot: 'Without the count the Checks tab cannot say that a guard did not hold, and no guard is proposed.',
      changes: 'The guard failed card, its red marker and the guard proposals from the finding log are gone.',
    }),
  row('learning.windowDays', 'learning', 'integer', 'Repeat window (days)',
    'Only findings this recent count toward a repeat. A guard can be older.'),
  row('learning.areaRepeats', 'learning', 'integer', 'Repeats in one area',
    'How many incidents of a class in one area (separate tasks) make it due. A fix without a proven test counts twice.'),
  row('learning.projectRepeats', 'learning', 'integer', 'Repeats across the project',
    'How many incidents of a class in the whole project make it due when no single area is. An untested fix counts twice.'),
  row('learning.guardFailedMarker', 'learning', 'onoff', 'Red marker when a guard did not hold',
    'A failure class back where a guard for it was in place lights the red marker on the Checks tab, until a new ' +
    'guard or a fix with a proven test is in place there. It stops nothing. On by default: it is rare, and a guard ' +
    'that no longer holds is worth seeing. checksPanel.marker hides the dot for every reason.', {
      weakens: offWeakens,
      protects: 'A guard everyone trusts that no longer catches its own class.',
      whyNot: 'It is the one gap that always gets the red marker, and it is rare, so it does not nag.',
      changes: 'The guard failed card stays on the Checks tab at medium priority, without the red marker.',
    }),
  row('learning.proposals', 'learning', 'onoff', 'Propose guards from the finding log',
    'A class that keeps coming back in one area becomes one proposed gate task (you approve it). It shares one cap ' +
    'of three open proposals with the inspection queue and the gate lines. Off by default, like every opt-in check, ' +
    'since each proposal asks for your time.'),
  // The database probe recipes (0i section 3.8). Off by default: a probe gate is heavy, needs a running database, and
  // is the one kind of gate that can change data elsewhere when it points at the wrong host. On, it only shows a recipe;
  // building one still takes the owner's click and approve, and the mission demands the host check and the rollback.
  row('learning.dbProbes', 'learning', 'onoff', 'Database probe recipes',
    'Off by default: a probe gate is heavy, needs a running database and can change data when it points at the wrong ' +
    'one. On: for access control and migration failures that keep coming back, the Checks tab shows a recipe for ' +
    'database probes (pgTAP, supabase test db, testcontainers), only when a local or throwaway database is found. A ' +
    'gate built from it must check that its database host is local before it writes, and roll back. Turn on ' +
    'dbGuard.localOnly too, so such a gate is refused when it points at a shared database.'),
  // Recipe precision (0i step 9, lib/recipePrecision.js). On by default, as the plan says (damped automatically): it only
  // moves a recipe the owner keeps declining from the card to the list, never stops work or hides a class, and the owner
  // can show one recipe again (ravenseat checks recipe <id> show). Off, every recipe whose `when` holds is offered.
  row('learning.recipeDamping', 'learning', 'onoff', 'Stop offering recipes you keep declining',
    'A recipe whose gate proposals are seldom accepted is listed on the Checks tab with its numbers, but no longer ' +
    'offered on the card. On by default, so a recipe you keep saying no to stops asking. It stops nothing, and ' +
    'ravenseat checks recipe <id> show offers one again. Off: every recipe that fits is offered.'),
  row('learning.recipeMinProposals', 'learning', 'integer', 'Decided proposals before damping',
    'How many of a recipe\'s proposals must be accepted or declined before it can be damped. Waiting ones do not count.'),
  row('learning.recipeMinProposalsDb', 'learning', 'integer', 'Decided proposals before damping a database recipe',
    'The same for a database probe recipe. Higher, since they are few and often declined for their cost.'),
  row('learning.recipeMinAccepted', 'learning', 'integer', 'Accepted share that keeps a recipe (percent)',
    'A recipe below this share of accepted proposals, after enough are decided, is damped. 1 to 100.'),
  // CI parity for a built gate guard (0i step 9b, lib/quickGate.js). All on: the card only offers, and its write takes
  // the owner's click, only ADDS a command to gates.quick and is refused from a track worktree; the lift only orders the
  // CI cards (never the red marker, section 3.9); the idle line is INFO. None of them stops work or runs a command, so
  // off is less advice, not a weaker guard: no weakens (owner decision 2026-11-17), like scopeNotes.* and client.canary.
  row('learning.quickGateCard', 'learning', 'onoff', 'Suggest adding a built guard to the quick gate',
    'A gate guard in the registry whose command is not in gates.quick gets a card on the Checks tab: one click (or ' +
    'ravenseat checks quick-add <G-n>) adds that command at the end of gates.quick, so every track runs it. Nothing ' +
    'runs from the card, and the write can only add a command, never remove or replace one. On by default, since you ' +
    'still decide. Off: no card, and no guard is weaker.'),
  row('learning.ciParityLift', 'learning', 'onoff', 'Point out a guard that CI skips',
    'When a gate guard\'s kind of check (tests, types, lint) is not run in CI, the cards tests-in-ci and quality-in-ci ' +
    'are put first in their priority and name the guard. They are never raised to the red marker. On by default, ' +
    'since it only changes the order. Off: the usual order, and no guard is weaker.'),
  // One row for the idle guard line (0x L2): the number of days, 0 for off. The old switch learning.idleGuardInfo is
  // no row; false in a file still turns the line off (lib/queueConfig.js resolveOwn), and setting the number turns that
  // switch on with it (cli/settings.mjs).
  row('learning.idleGuardDays', 'learning', 'integer', 'Note a guard that has never run (days)',
    'ravenseat guards and ravenseat doctor give one INFO line for a gate guard with 0 runs since it was built, this ' +
    'many days after it was built. 7 by default, since a guard that never runs protects nothing. It is INFO only and ' +
    'never stops anything. 0 turns it off: no line (the registry still shows 0 runs), and no guard is weaker. The old ' +
    'learning.idleGuardInfo false in queue.config.json still turns it off.'),

  // ---- 7. Agent guards: File and read guards ('files') and Command and secret guards ('guards'), mixed in this list ----
  row('protectedPaths', 'files', 'list', 'Protected paths',
    'Paths a track may only change when its task owns them: hooks, settings, agents, the queue scripts and test configs. ' +
      'A list replaces the defaults; { "add": [...], "remove": [...] } changes them (the floor is never removed).', {
      weakens: listLosesEntries,
      protects: 'Agents changing hooks, settings and test configs without the task owning those files.',
      whyNot: 'These files run code or give instructions with your rights in the orchestrator session.',
      changes: 'The merge guard no longer stops changes to the paths left out (the floor holds). Doctor will report it.',
    }),
  row('dependencyFiles', 'files', 'choice', 'Dependency files',
    'A task that changes a dependency file it does not own: stop like a protected path, or warn.', {
      choices: ['stop', 'warn'],
      defaultByMode: { lite: 'warn', full: 'stop' },
      weakens: rankWeakens(['stop', 'warn']),
      protects: 'A track that adds or changes a library without the task owning the dependency file.',
      whyNot: 'A new library runs its install scripts on your machine and becomes part of what you ship.',
      changes: 'Such a change gives a warning, and the merge goes on. Doctor will report it.',
    }),
  row('gitSurface', 'files', 'choice', 'Git hooks and config',
    'Git hooks and git settings that run code (core.hooksPath and similar) are compared with what you accepted. Stop: ' +
    'a change stops receive and merge until you accept it. Warn: only a warning. Off: no check. The default is stop in ' +
    'full mode, since a hook runs with your rights on your next commit or push, and warn in lite, where a first try ' +
    'should not meet a hard stop.', {
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
  // Friction: none, it never stops work: one line in the mission frame, and a SUSPICIOUS CONTENT line at receive plus a
  // section in the review package. On by default (the owner's decision of 18.11.2026, roadmap 0æ N4): a file a track
  // reads must not be able to speak as the owner. A false hit costs one line; a report can always quote the mark.
  row('injection.ownerMark', 'guards', 'onoff', 'Owner mark on missions',
    'Each mission gets a mark of its own on the owner answers and orchestrator additions in it. Receive flags, as ' +
    'Suspicious content, a report that claims owner approval without that mark. A warning, never a stop. Off: no mark.'),
  // The opt-in checks (lib/optInChecks.js): off by default, so switching one off again never weakens the standard.
  row('secretScan.atReceive', 'guards', 'onoff', 'Secret scan at receive',
    'Off by default. On: receive scans the track\'s own commits for secrets; a hit blocks the merge until a clean receive or merge --allow-secret.', {
      weakens: offWeakens,
      protects: 'A key a track committed being merged into the base branch, where its history keeps it.',
      whyNot: 'Once merged, the key is in the base branch\'s history; the push check only stops it from leaving the machine.',
      changes: 'Receive no longer scans the track\'s commits, and merge does not stop on a key.',
    }),
  row('secretScan.allowlist', 'guards', 'onoff', 'Keys in approved commands and .mcp.json',
    'Looks for keys (tokens, passwords) in the commands Claude Code has approved (.claude/settings*.json) and in the ' +
    'MCP servers in .mcp.json (env, headers, args, url), also in the agents\' worktrees. Off by default, like every ' +
    'opt-in check; on, doctor does this on each run.', {
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
    'The time limit per git or gitleaks call in the secret scan. A scan that does not finish in time makes the push ' +
    'ask you first; it is never let through unchecked.'),
  row('deployCommands', 'guards', 'list', 'Deploy commands',
    'The push guard asks before any command that starts with one of these. Empty = off.',
    { protects: 'An agent that starts a deploy without asking you first.' }),
  row('claudeFingerprint', 'files', 'onoff', 'Claude setup fingerprint',
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
  row('controlFiles.guard', 'files', 'onoff', 'Control file write guard',
    'Queue agents may not write the main tree\'s queue.config.json, .claude/, CLAUDE*.md, .git/hooks/, .git/config or ' +
    'the plugin\'s scripts, with the file tools or the shell. Their own worktree copies stay free; the main session is not affected.', {
      ...BASIC,
      weakens: offWeakens,
      protects: 'A track switching off a guard, adding a hook or rewriting the instructions by writing the main tree\'s control files directly.',
      whyNot: 'Every override flag is denied to the agents, but a direct write to these files gets around all of them.',
      changes: 'Queue agents can write the main tree\'s control files again. Doctor will report it.',
    }),
  row('controlFiles.fingerprint', 'files', 'onoff', 'Control file fingerprint',
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
  // Friction: none at "log" (the default): the read goes on and one row lands in the time log. "block" can stop work
  // (a track that needs a value to debug a connection), so it is a choice, never the default (roadmap 1c SEC-T).
  row('guards.secretReads', 'guards', 'choice', 'Agents reading secrets',
    'A guarded agent that prints secrets in a shell command (cat, type, Get-Content, head, tail or less of a .env file or ' +
    'a .pem/.key file, printenv, env or set with no arguments, Get-ChildItem env:): log (allowed, one row in the time ' +
    'log, shown on the Checks tab), block (denied, the agent is told to reference the variable instead, for example ' +
    'psql "$DATABASE_URL"), or off. The value would also land in the transcript (~/.claude/projects).', {
      choices: ['block', 'log', 'off'],
      weakens: rankWeakens(['block', 'log', 'off']),
      protects: 'A key printed into an agent\'s transcript without anyone seeing that it happened.',
      whyNot: 'Off leaves no trace when an agent prints a .env file or the environment into its transcript.',
      changes: 'Agents can print secrets into their transcripts and nothing is logged.',
    }),
  // Friction: a false hit replaces harmless text with [REDACTED:env-value] in a stored log; values under 6 characters
  // and plain ones (true, localhost, numbers) are skipped to keep that rare. It stops nothing, so it is on (SP-1).
  row('redact.envValues', 'guards', 'onoff', 'Redact the project\'s own .env values',
    'Everything Ravenseat stores from transcripts and commands (gate and done tails, the review package, the SILENT ' +
    'snapshot, the time log\'s remark) also loses the exact values in the main tree\'s .env files (.env, .env.local, ' +
    '.env.*; never .env.example), held in memory only. Catches a short password no pattern knows.', {
      level: 'basic',
      weakens: offWeakens,
      protects: 'A database password or short token from your .env printed in a gate log or a transcript and stored by Ravenseat.',
      whyNot: 'The pattern redaction misses values without a known format or shorter than 16 characters.',
      changes: 'Only the patterns redact stored text; your own .env values can be stored in clear text.',
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
      ...BASIC,
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
  row('ownership.sharedPatchCollides', 'files', 'onoff', 'Shared patch collides with owned files',
    'A path in a task\'s shared_patch collides with another active task\'s owned_files: the second task waits to start, ' +
    'and a merge that patches a file another active task owns stops. Off: shared_patch is compared only with shared_patch.', {
      fullWhy: 'shared_patch is a field of the full task format',
      weakens: offWeakens,
      protects: 'Two tasks changing the same file at once because one lists it in shared_patch and the other owns it.',
      whyNot: 'The owner builds on the file while the other task patches it, and the merge goes in under it with no stop.',
      changes: 'Both tasks can start, and the merge no longer stops on a shared_patch path another active task owns. ' +
        'Doctor will report it.',
    }),
  row('readGuard.agentTypes', 'files', 'list', 'More guarded agent types',
    'More agent types the read guard applies to (tracks and reviewers are always included).'),
  row('readGuard.autoLoaded', 'files', 'list', 'Auto-loaded files',
    'Files Claude Code loads itself, which must never be read again with Read.'),
  row('readGuard.largeFiles', 'files', 'list', 'Large files', 'Patterns for files that must always be read in excerpts.'),
  row('readGuard.maxLines', 'files', 'integer', 'Read warning (lines)',
    'A read of more lines than this gets a warning (300 by default); the stop comes at readGuard.blockLines.'),
  row('readGuard.blockLines', 'files', 'integer', 'Read stop (lines)',
    'A read of more lines than this is stopped (2000 by default), so one large file cannot fill an agent\'s context.',
    { protects: 'One large file read whole that fills an agent\'s context.' }),
  // Friction: none, it stops nothing and only adds up to about 60 lines to a denial that happens anyway; the scan reads
  // at most 1 MiB for at most 200 ms and fails open to the old text. On by default by the owner's decision of 16.11.2026
  // (roadmap 0y Y1, plans/projectarchitect-vurdering-2026-11-16.md): it saves the agent a Grep round per denial.
  row('readGuard.outline', 'files', 'onoff', 'Outline in the read denial',
    'A denied whole-file Read of a large file also lists the file\'s headings and top-level declarations with their line ' +
    'numbers (Markdown, JS/TS, SQL; at most 60), so the agent can read with offset and limit straight away. Off: the ' +
    'denial text without it.'),
  row('reads.mode', 'files', 'choice', 'Read ownership',
    'A task that reads a file an active task changes: wait until it is done, or start and name the overlap.',
    {
      choices: ['wait', 'warn'],
      fullWhy: 'read ownership uses the reads field of the full task format',
      protects: 'A task that reads a file while another task is changing it.',
    }),
  row('hotspots', 'files', 'list', 'Hotspots',
    'Shared config blocks parallel tracks break each other on; only an agreed change gets through. Empty = off.',
    {
      fullWhy: 'hotspot changes are agreed in the full task format (hotspot_patch)',
      protects: 'Parallel tracks that break each other in a shared config block.',
    }),
  row('contextGuard.blockOtherChats', 'files', 'onoff', 'Stop other chats at 400k',
    'Chats that are not the orchestrator are stopped at 400k context instead of only getting the notice.',
    { protects: 'A chat other than the orchestrator that keeps going past 400k context.' }),

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

  // ---- 10. Review and agents ----
  row('helpers', 'review', 'object', 'Helper agents',
    'Optional reviewers on top of the fixed ones, switched with `ravenseat helpers on|off` (their conditions are in ' +
    'queue.config.json). In lite, reviewer-light reviews class K tasks when CI or gates are missing.',
    { ...BASIC, ...QUEUE, edit: 'set' }),
  // DR-3 (plans/drift-vurdering-2026-11-21.md). Friction: one gap reviewer run per task that has acceptance criteria; a
  // NOT MET leads to a normal fix round, never a stop. On: the owner opted in per task by writing the criteria, so the
  // cost follows the owner's intent, and with reviewer-gap off by default the criteria were otherwise never checked.
  row('helpers.reviewer-gap.acceptance', 'review', 'onoff', 'Gap review for acceptance criteria',
    'A task with acceptance criteria gets the gap reviewer at receive, even while reviewer-gap is off, with one reason ' +
    'line ("acceptance: 3 criteria"). It checks each criterion MET or NOT MET. Off: only the helper\'s own conditions.'),
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
  row('triage.minAgeDays', 'review', 'integer', 'Triage tasks older than (days)',
    'A task added or last edited this long ago is checked against the current code before it starts. Empty = no age rule.',
    { fullWhy: 'the intake triage is off in lite' }),
  row('triage.agentAdded', 'review', 'onoff', 'Triage tasks agents added',
    'A task an agent added is checked once against the code before it starts, since you did not write it yourself. ' +
    'Off: only the age rule applies.', { fullWhy: 'the intake triage is off in lite' }),
  row('triage.maxPerFill', 'review', 'integer', 'Triage steps per fill',
    'At most this many triage steps start per fill, so a large queue is checked a few tasks at a time.',
    { fullWhy: 'the intake triage is off in lite' }),
  row('triage.askAgainMin', 'review', 'integer', 'Triage asks again after (minutes)',
    'A printed triage step is not printed again for this long.', { fullWhy: 'the intake triage is off in lite' }),
  // DR-1 (plans/drift-vurdering-2026-11-21.md). Friction: advisory adds no wait beyond one short read-only agent run on
  // the triage's step, only for risky tasks (class D+ by default, or a task in an accepted zone, none by default); its
  // notes go into the mission. Block can stop a start (an "ask" becomes an owner question), so it is off. Advisory is the
  // default: D+ is rare, it is where a wrong plan costs most, and advisory never stops work.
  row('planReview.mode', 'review', 'choice', 'Plan review before a risky task',
    'Before a risky task starts, the triage step also checks the plan against the code: data model and migrations, ' +
    'public interfaces, irreversible steps, file boundaries, assumptions the code contradicts (file:line or no note). ' +
    'Advisory: the notes go into the mission and the task starts. Block: a point for you becomes a question before the ' +
    'start. Off: no plan review.', { choices: ['block', 'advisory', 'off'] }),
  row('planReview.classes', 'review', 'list', 'Plan review for classes',
    'The task classes that get the plan review (default D+). A task in an accepted sensitive zone (catalog kind zone) ' +
    'gets it whatever its class.'),
  // DR-2. Friction: none for a task without risk_first (the mission is unchanged); with one, the track checks it first
  // and stops with PARTIAL and one owner question when it fails, the PARTIAL path the owner already handles. On: the
  // block appears only when the field is set (or the task is in an accepted zone, none by default).
  row('mission.riskFirst', 'review', 'onoff', 'Riskiest assumption first',
    'A task\'s risk_first (the assumption that would sink the plan) is checked first in the track, before other code; ' +
    'if it fails, the track stops with PARTIAL and one question for you. A task in a sensitive zone without one is told ' +
    'to prove the choice can be reversed. Off: no such block in the mission.'),
  // PS-1..4 (roadmap 3c, plans/drift-vurdering-2026-11-21.md). Friction: one line per task at add and at start, only when
  // the check finds something, and never a stop, so all four are on. Off: the line is gone and add behaves as before.
  row('planChecks.missionPaths', 'review', 'onoff', 'Warn about paths the mission names',
    'At add and start, a repo path the mission names that the task does not own, share or read gets one warning line ' +
    '(at most five paths named). Only real paths count: a file with an extension or something in the tree, not links ' +
    'or prose. Off: only a protected path is named, and the rest shows up as drift at the merge.',
    { fullWhy: 'lite has no task ownership' }),
  row('planChecks.emptyOwnership', 'review', 'onoff', 'Warn about a task with no files',
    'At add and start, a K, D or D+ task with no owned_files gets a warning: nothing is promised, so the merge reports ' +
    'no drift and parallel tracks are not kept off its files.', { fullWhy: 'lite has no task ownership' }),
  row('planChecks.sizeNotSet', 'review', 'onoff', 'Say when a D task has no size',
    'A D or D+ task added without content_min gets a warning and shows "size not set"; the estimate still counts 30 ' +
    'minutes for planning. Off: add fills in 30 without a word, as before.', { fullWhy: 'lite has one task type (class K)' }),
  row('planChecks.ownerQuestionCount', 'review', 'onoff', 'Check the owner question count',
    'At receive, the ownerQuestions number on the track\'s RESULT line is compared with the items under its owner ' +
    'question heading; a mismatch is one note, so a question the count left out is still read.'),
  // Friction: none. Read from the diff receive already has (no tokens, at most two git show calls per manifest), one
  // SIGNALS line and rows in Decided for you, which are not counted in the Decisions tab; it never stops a merge. On by
  // default: a new package or a migration nobody asked about is what the owner most needs to see. A display and a log
  // row only, so off weakens no guard (the merge guard on dependency files and migrations has its own rows).
  row('decisionSignals.enabled', 'review', 'onoff', 'Spot choices at receive',
    'Receive reads the diff for a new package, a migration or schema file, deleted files and choices with no ' +
    'Assumptions, and marks each one not asked when no owner question names it. One line, a time log row and an entry ' +
    'in Decided for you. Never a stop. Off: none of it.'),
  // Friction: none, a threshold for a hint. 3: one or two deleted files are a normal cleanup, three is a choice worth a look.
  row('decisionSignals.deleteMin', 'review', 'integer', 'Deleted files before a signal',
    'Deleted files outside the tests that make a deletion signal at receive. A hint only.'),
  // Friction: none, a threshold for a hint. 300 lines: below it a missing Assumptions section is usual for small work.
  row('decisionSignals.bigDiffLines', 'review', 'integer', 'Big change without Assumptions',
    'Changed lines outside tests and lockfiles at which a delivery with no Assumptions section gets an unstated choices signal.'),
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

  // ---- 11. Scope and catalog ----
  // What a delivery adds beside its task (the scope notes) and the project catalog of design choices. Split out of Review
  // and agents by the owner decision of 2026-11-17 (H2, L1: catalog.planLinks came from Plans); the keys stayed.
  // The reuse and scope facts at receive (lib/scopeNotes.js). On by default in both modes (owner decision 16.11): each
  // is one NOTE line and a line in the package, costs no tokens and stops nothing. Off is no weakening, as for
  // guidance quiet: a fact goes, no guard does.
  row('scopeNotes.reuse', 'scope', 'onoff', 'Note a helper written again',
    'A name the delivery defines (JS/TS) that the base already defines in another file gets one NOTE line at receive ' +
    'with both places, and a line in the review package. It stops nothing.', BASIC),
  row('scopeNotes.newFolders', 'scope', 'onoff', 'Note a new folder',
    'A file added in a folder the base does not have (the first levels, scopeNotes.folderDepth) gets one NOTE line: a ' +
    'new module boundary is an architecture choice. It stops nothing.', BASIC),
  row('scopeNotes.dependencies', 'scope', 'onoff', 'Note a second library for the same job',
    'A new package in package.json or requirements.txt whose job the manifest already has a package for (dates, HTTP, ' +
    'validation, helpers, test runner ...) gets one NOTE line. It stops nothing.', BASIC),
  row('scopeNotes.drift', 'scope', 'onoff', 'Count changed files outside the task',
    'How many changed files lie outside the task\'s files and reads, and in which folders; a task with no files named ' +
    'gets the number of folders it touches. One NOTE line, it stops nothing. On in full mode. Off in lite, where a ' +
    'task names no files, so every changed file would count as outside it.', { ...BASIC, defaultByMode: { lite: false, full: true } }),
  row('scopeNotes.ignoreNames', 'scope', 'list', 'Names a helper note skips',
    'More names the helper note never reports (main, run, setup and a few others are skipped already).'),
  row('scopeNotes.folderDepth', 'scope', 'integer', 'New folder depth',
    'How deep the new folder note looks: 1 = only new top folders, 2 (default) or 3.'),
  // The opt-in scope drift guards (bolk B7, V6 and V7). Off by default: V6 costs a reviewer run, V7 may make a track
  // stop and ask when owned_files was a rough guess. Full mode only: a lite task names no files, so nothing drifts.
  // Off is the default, so it is no weakening.
  row('scopeNotes.driftGap', 'scope', 'onoff', 'Gap review on large drift',
    'At receive, the gap reviewer is added when at least scopeNotes.driftGapFiles changed files, and over ' +
    'scopeNotes.driftGapShare percent of them, lie outside the task\'s files and reads. One reason line; costs one ' +
    'reviewer run when it fires.', { fullWhy: 'a lite task names no files, so there is no drift to measure' }),
  row('scopeNotes.driftGapFiles', 'scope', 'integer', 'Gap review: files outside',
    'How many changed files must lie outside the task\'s files before the gap reviewer is added (1 to 100, default 4).',
    { fullWhy: 'a lite task names no files, so there is no drift to measure' }),
  row('scopeNotes.driftGapShare', 'scope', 'integer', 'Gap review: share outside (%)',
    'The share of the changed files outside the task\'s files that must be passed (1 to 99, default 40).',
    { fullWhy: 'a lite task names no files, so there is no drift to measure' }),
  row('scopeNotes.driftWarn', 'scope', 'onoff', 'Write warning for drift',
    'While a track writes a file outside its files and reads, it gets one note per file (never a denial) saying it ' +
    'need not stop for it, and to name the file in its report.', { fullWhy: 'a lite task names no files, so there is no drift to measure' }),
  // The project catalog (lib/catalog.js, docs/queue/catalog/). Both are on in both modes: each states a fact, stops
  // nothing and does nothing without the folder. Off is no weakening: the owner lock on accepted and the protected path
  // (protectedPaths) are not these switches.
  row('catalog.doctor', 'scope', 'onoff', 'Catalog problems in doctor',
    'Doctor shows one WARN row when `ravenseat catalog check` finds an error in docs/queue/catalog/, such as a design ' +
    'choice set to accepted without the owner. It stops nothing.'),
  row('catalog.planLinks', 'scope', 'onoff', 'Check plan links to design choices',
    'A plan entry\'s `decisions` link to an id that is not in docs/queue/catalog/decisions is a warning on plan new and ' +
    'plan edit. The shape of the link is always checked. It stops nothing.'),
  // The catalog excerpt (lib/catalogExcerpt.js, bolk B4). On in both modes by owner decision 16.11: it is only text,
  // nothing without a catalog, capped, and its heading says what it cost. Off is no weakening: no guard reads it, and
  // the owner lock and the protected path stay. Roadmap 0å KD-6 (entries by category, `applies`) adds no setting:
  // Friction: none, a wrong hit costs a few lines inside the same cap and category hits are cut before file hits.
  row('catalog.missionExcerpt', 'scope', 'onoff', 'Catalog excerpt in the mission',
    'A track\'s mission gets the part of docs/queue/catalog/ that meets its files: the design choices that hold, the ' +
    'proposed ones as suggestions, the prefer lines and the reuse rows in its folders, under catalog.excerptTokens. ' +
    'Nothing without a catalog.'),
  row('catalog.reviewExcerpt', 'scope', 'onoff', 'Catalog excerpt in the review package',
    'The review package gets the same excerpt, so the reviewer checks the delivery against the choices that hold and ' +
    'the reuse rows (findings duplication and scope-drift). Nothing without a catalog.'),
  row('catalog.excerptTokens', 'scope', 'integer', 'Catalog excerpt cap (tokens)',
    'The most tokens the excerpt may use, 200 to 6000 (default 1500, a token counted as 4 characters). The reuse rows ' +
    'are cut first; the heading says what was cut.'),
  // The generated index (lib/catalogIndex.js, bolk B5). Off by default: the plan's opt-in list (it builds and stores a
  // file in the data folder, and its worth grows with the project). It stops nothing either way, and off weakens no
  // guard: `catalog find` still works on request.
  row('catalog.index', 'scope', 'onoff', 'Code index for the catalog excerpt',
    'Builds an index of the code\'s exports (JS/TS) at receive and for each mission, cached by file sha in the data ' +
    'folder. The excerpt then gets the helpers tagged `@shared` in the task\'s folders, and the review package the new ' +
    'names that are close to an existing export (V1b). `ravenseat catalog find` works without it.'),
  // The check rules of the design choices (lib/catalogChecks.js, bolk B6). checks is on: a rule exists only when the
  // owner writes one, and a hit is one line at receive. Off weakens: an accepted choice's rule is then not checked.
  // checkStop is off: it is the one part that can stop work. gateAfter only matters with learning.proposals on.
  row('catalog.checks', 'scope', 'onoff', 'Check rules of the design choices',
    'Receive tries the `check:` rule of each design choice on the delivery\'s added lines in the choice\'s paths. An ' +
    'accepted choice gives a CATALOG line, a proposed one a NOTE. It stops nothing unless catalog.checkStop is on.', {
      weakens: offWeakens,
      protects: 'A delivery that breaks a design choice the owner accepted, where the rule says so line by line.',
      whyNot: 'The rule is the owner\'s own, written narrow with examples; without the check only the reviewer can see it.',
      changes: 'The rules are not tried at receive or merge, and no gate is proposed from them. Doctor will report it.',
    }),
  row('catalog.checkStop', 'scope', 'onoff', 'Stop the merge on a rule in mode stop',
    'A rule with `mode: stop` of a choice the owner accepted stops the merge when an added line breaks it ' +
    '(`merge --allow-catalog` overrides, logged). Off by default: the rule is then a warning.',
    { protects: 'A merged line that breaks a catalog rule you accepted with mode stop.' }),
  // The way into the catalog (roadmap 0z Z-A, plans/decision-keeper-vurdering-2026-11-17.md). Friction: none at the
  // default; explicit writes a draft only when the owner asks (resolve --keep, the board's button), and a draft is only
  // proposed, never accepted. suggest adds a hint on questions that read like a lasting rule, which can be noise, so it is
  // not the default. off makes resolve --keep, the button and catalog propose refuse. No guard reads it: no weakening.
  row('catalog.captureAnswers', 'scope', 'choice', 'Owner answers into the catalog',
    'explicit: `resolve --keep` and "Keep as design choice" in Decisions turn your answer into a proposed design choice ' +
    'that you accept yourself. suggest: also marks the questions that read like a lasting rule. off: never, and ' +
    '`catalog propose` refuses too.', { choices: ['off', 'explicit', 'suggest'] }),
  // "Not building" (roadmap 0f, lib/notBuilding.js). Friction: none; one INFO line at add, receive and plan capture when
  // a new item reads like an entry the owner chose not to build, and a doctor row when a revisit date has passed. It
  // stops nothing and asks for nothing, so it is on in lite and full. Off hides the lines; no guard reads it, so it is
  // no weakening.
  row('notBuilding.match', 'scope', 'onoff', 'Match new work against "not building"',
    'A new task, a track\'s proposal or a captured plan that reads like an entry in the catalog you chose not to build ' +
    'gets one INFO line with the date and the reason. Doctor names entries whose revisit date has passed. Advice only.'),
  // Stack entries into the Checks tab (roadmap 0å KD-2). Friction: it can change which cards show (a `stack:<word>`
  // recipe, the dep-audit card's command) and stops nothing. Only the owner's accepted stack entries count, so a track
  // cannot turn a card on or off. Off gives today's cards from the manifests alone. No guard reads it: no weakening.
  row('catalog.stackFacts', 'scope', 'onoff', 'Stack entries in the Checks tab',
    'The tools and words of the stack entries you accepted in the catalog join the stack the Checks tab sees, so ' +
    'recipes for that stack apply and the dependency audit card names its command (pnpm audit, cargo audit). Off: ' +
    'the cards follow the manifests alone.'),
  // Dependency rows in the excerpt (roadmap 0å KD-3). Friction: only text, inside the same token cap, and cut before
  // the reuse rows, so it never pushes out a binding decision; versions come from the lockfile and the installed
  // packages on disk, never the network. Off gives the excerpt as before. No guard reads it: no weakening.
  row('catalog.depsExcerpt', 'scope', 'onoff', 'Dependency versions in the catalog excerpt',
    'Each task\'s catalog excerpt lists the libraries its files import, with the version locked here, the local ' +
    'types or README to read and the docs link from the Dependencies table in stack.md, so the model writes code for ' +
    'the version you have, not one it remembers. Off: the excerpt without those rows.'),
  row('catalog.gateAfter', 'scope', 'integer', 'Separate tasks before a lint proposal',
    'Only with learning.proposals on, which is off by default. Then a rule broken in this many separate tasks (2 to ' +
    '20, default 3) becomes one proposed gate task to put it in the project\'s own lint. It shares the cap of three ' +
    'open proposals.'),

  // ---- 12. Board and advice ----
  row('guidance', 'board', 'choice', 'Guidance',
    'guided: advice about CI, gates and checks. quiet: no advice; guards and facts stay. Only for you.',
    { ...BASIC, ...QUEUE, choices: ['guided', 'quiet'] }),
  // Track hdr. Friction: bubbles show only when a viewer switches the mascot on (the gear); the default logo never talks,
  // which removes a talking element from the default view. No guard is weakened, and the default (chatty) is unchanged
  // for people who turn the mascot on.
  row('board.mascot', 'board', 'choice', 'Mascot bubbles',
    'How much the mascot talks once it is switched on in the gear (the logo never talks): chatty, events (only ' +
    'events and clicks) or off, for every viewer.', { ...BASIC, choices: ['chatty', 'events', 'off'] }),
  row('board.blockedColumn', 'board', 'onoff', 'Blocked column',
    'Tasks with an open blocker that needs action get a column after In queue.', { ...BASIC, ...QUEUE }),
  // QA-1c Q5. Friction: float removes the reflow, since a docked panel narrowed the board and rewrapped the focus line
  // and the Dependencies view's top row every time a task, Settings or the help opened; the cost is that the panel
  // covers the right side of the board while it is open, and a click outside closes it. beside is kept as an option for
  // those who want to read the cards next to the panel. Not a guard, so neither value weakens anything.
  row('board.panelMode', 'board', 'choice', 'Side panel',
    'float: on a wide screen the panel opens over the board, so nothing moves, and a click outside closes it. ' +
    'beside: the board makes room for the panel and rewraps while it is open. Below 1200 px it covers the board in ' +
    'both.', { ...BASIC, choices: ['float', 'beside'] }),
  // Roadmap 0ø J1. Friction: none; the board often sits in a background tab, and the count is a quiet signal instead of
  // desktop notifications (which stay off). It counts only what waits on the owner. Off: the plain title.
  // Demo mode (owner decision 22.11). Friction: none for the work. It costs zero tokens and cannot stop or start
  // anything; it is one dismissible card on an empty board that never had a task ("Not now", "Don't show again"), and
  // the demo itself lives in its own folder, locked down on the server. On in lite and full because a first-time (lite)
  // user gets the most from seeing a board with work on it. Off: no card; Settings > Show demo board still opens it.
  row('board.demoOffer', 'board', 'onoff', 'Demo board offer',
    'An empty board that has never had a task offers a made-up demo board with work in every column. It lives in its ' +
    'own folder and nothing done there reaches your queue. Off: no offer; the Show demo board row at the bottom of ' +
    'Settings still opens it.', BASIC),
  row('board.titleCount', 'board', 'onoff', 'Count in the tab title',
    'The browser tab title starts with the number of decisions that wait on you, "(3) Queue board". Running tracks ' +
    'are not counted. Off: the plain title.'),
  // J3. Friction: none for most; a screen reader user may meet a clash with their own keys, so the shortcuts can be
  // turned off here or from the ? overview. They never fire in text fields or dialogs, or with Ctrl, Alt or Cmd held,
  // so the browser's own shortcuts are untouched. Not a guard.
  row('board.shortcuts', 'board', 'onoff', 'Keyboard shortcuts',
    'One-key shortcuts on the whole board: ? lists them, / goes to the search, g and a letter opens a tab, j and k ' +
    'move between cards. Never in text fields or dialogs. Off: only the keys on a focused card and in Decisions.',
    BASIC),
  // J7. Friction: none for the work; it only navigates and copies a command, never changes anything (owner answer 4).
  // While the board has focus it takes Ctrl+K from the browser (which would focus its own search bar), never inside a
  // text field. On by default since it is the fast way to a card or one of the many settings. Needs board.shortcuts.
  row('board.palette', 'board', 'onoff', 'Command palette (Ctrl+K)',
    'Ctrl+K opens one field that finds a view, a card (id or title) or a setting and goes there, with the ravenseat ' +
    'command behind each to copy. It changes nothing itself. Needs the keyboard shortcuts on. Off: Ctrl+K is the ' +
    "browser's again.", BASIC),
  // J6. Friction: none; plain words search exactly as before, and an unknown field is shown as a hint, never emptying
  // the board. On by default since it only adds meaning to words with a colon or a > or <. Off: every word is plain text.
  row('board.structuredSearch', 'board', 'onoff', 'Structured search',
    'The search box also understands fields: class:D, status:blocked, project:x, block:gate-red, label:visual, age>2d, ' +
    'cost>1, and -class:K to leave out, with suggestions while you type. Plain words search as before. Off: every ' +
    'word is searched as plain text.'),
  // J4. Friction: a row of three buttons over the columns takes a little room; off in lite so the first board stays
  // simple (owner answer 6). They only filter what is shown, never what the queue does.
  row('board.quickFilters', 'board', 'onoff', 'Quick filter buttons',
    'Buttons over the columns: Changed 24 h, Older than usual and Red gate. Each filters the cards; several combine. ' +
    'On in full mode, off in lite.', { defaultByMode: { lite: false, full: true } }),
  // Roadmap TIDSLINJE T-A (gantt investigation 18.11, section 6). Friction: none for the work; it is one more tab that
  // only reads the schedule (the same simulation as ravenseat schedule) and never changes the queue, costs no tokens.
  // On in full since it answers "when is this step done"; off in lite, where there are no focus steps to show.
  row('board.timeline', 'board', 'onoff', 'Timeline tab',
    'A Timeline tab: what ran in the last day and what runs now, then the plan played forward as rough bars per focus ' +
    'step (or per project), with a now line, a table view, and the tasks that cannot start with the reason. Read only. ' +
    'On in full mode, off in lite.', { defaultByMode: { lite: false, full: true } }),
  // T-A. Friction: none; it only sets how far the chart reaches. 3 days by default because beyond a few days new tasks
  // rank in ahead and the plan is mostly noise (investigation section 2). 1 to 14; a value outside is clamped.
  row('board.timelineHorizonDays', 'board', 'integer', 'Timeline: days ahead',
    'How many days ahead the Timeline shows, 1 to 14 (3 by default). Tasks that start later are listed in the table ' +
    'and counted on their row. The plan gets weaker the further out it goes.'),
  // T-A. Friction: none; it only picks the rows. step by default because the focus steps are what decide the order;
  // project is how many owners think. A viewer can switch on the tab for their own browser.
  row('board.timelineRows', 'board', 'choice', 'Timeline: rows',
    'step: one row per focus step, in the focus order (what decides what runs first). project: one row per project. ' +
    'The ran and running part is always first. Each browser can switch on the tab itself; this is the default.',
    { choices: ['step', 'project'] }),
  // Roadmap 3e AW-2 (owner answers 21.11 as recommended). Friction: display only, it never stops or slows work; it takes
  // some height at the top of Decisions, hidden when nothing happened and closable for the visit. On by default since
  // it answers the first question after a pause. Not a guard.
  row('board.sinceLast', 'board', 'onoff', 'Since you left',
    'A short summary at the top of Decisions: merged, recovered without you, blocked, waiting on you and spend since ' +
    'you last looked, with the latest events. Hidden when nothing happened. Off: no band.', BASIC),
  // AW-2/AW-3. Friction: none; it only picks the window. last-seen is the default because "what happened while I was
  // away" is the question; it falls back to 24 h without a mark. A browser can pick another one for itself on the band.
  row('board.sinceLastWindow', 'board', 'choice', 'Since you left: window',
    'last-seen: since your seen mark (Decisions on screen a few seconds, "Mark seen", or ravenseat since --mark); ' +
    '24 h without one. 24h or 7d: a fixed window. "Decided" in Decisions follows it.', { choices: ['last-seen', '24h', '7d'] }),
  row('limits.autocompact', 'board', 'onoff', 'Automatic compaction',
    'On: Claude Code compacts the orchestrator session itself and the queue continues. Off: a ready /compact line; ' +
    'then also turn off auto-compaction in Claude Code ("autoCompactEnabled": false), or it compacts anyway.',
    { ...BASIC, ...QUEUE }),
  row('board.port', 'board', 'integer', 'Board port',
    'The local port the board listens on (2000 by default). Change it when another program already uses that port.'),
  row('board.title', 'board', 'text', 'Board title', 'The title in the board\'s header and browser tab.'),
  row('board.hideKey', 'board', 'onoff', 'Keep the board key from Claude',
    'The board opens itself in your browser with its key and prints the link without it; ravenseat board open opens ' +
    'it again. A write without the Origin of the board (a script, not the browser) is refused.', {
      weakens: offWeakens,
      protects: 'Claude reading the key from the start line and then doing owner actions on the board with curl or fetch.',
      whyNot: 'The key is in the output Claude reads when it starts the board, and the board takes a script call as yours.',
      changes: 'The start line prints the link with the key, and a write with the key but no Origin is let through.',
    }),
  row('updates.check', 'board', 'onoff', 'Update check',
    'Ravenseat looks for a newer version on GitHub at most once a day (a plain GET that sends nothing about you): the ' +
    'board shows a banner, and ravenseat show and doctor one line. It never stops any work. The old name ' +
    'board.updateCheck still works; DISABLE_UPDATES and CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC also turn it off.'),
  row('board.showCloud', 'board', 'onoff', 'Show the Cloud tab',
    'The Cloud tab, when cloud sessions are on (features.cloud).', QUEUE),
  row('features.statistics', 'board', 'onoff', 'Statistics tab',
    'The Statistics tab on the board. On by default; off only hides the tab, and the time log is written as before.'),
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
  row('client.canary', 'board', 'onoff', 'Notice when Claude Code changes its log format',
    'Doctor reads the tail of the newest Claude Code transcript and says when the version is newer than the formats ' +
    'Ravenseat was tested on, or rows read differently (new row types, turns without usage, unknown API errors); the ' +
    'Checks tab shows one card while such rows are seen. Type names and counts only, never content. It stops nothing. ' +
    'On by default, so a change that could make the cost and time numbers wrong is seen early. Off: no row and no card.'),
  row('client.shapeLog', 'board', 'onoff', 'Log new API error forms',
    '`ravenseat checks` writes the shape of each new API error form (keys and value types, short codes, no text) to ' +
    'client-shapes.jsonl in the data folder, so the form can be confirmed and reported. Off by default.'),

  // ---- 13. Cloud ----
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
  row('cloud.bundleMax', 'cloud', 'integer', 'Tasks per session',
    'At most this many tasks in one cloud session, run one after another (4 by default).'),
  row('cloud.start', 'cloud', 'choice', 'How a session starts',
    'terminal: cloud-start in your terminal. routine: a scheduled task (see `ravenseat cloud setup`).',
    { choices: ['terminal', 'routine'] }),
  row('cloud.fireUrl', 'cloud', 'text', 'Routine URL',
    'The scheduled task `cloud send` fires with start routine. The token is only ever in the environment.',
    { edit: 'file' }),
  row('cloudHidden', 'cloud', 'list', 'Paths hidden from the cloud',
    'Paths a cloud session cannot see (for example gitignored folders); a mission that points there is stopped.'),

  // ---- 14. Plans and focus ----
  row('features.plans', 'plans', 'onoff', 'Plans room',
    'The Plans room on the board. On by default in both modes; the CLI plan register always works.', BASIC),
  row('features.focus', 'plans', 'onoff', 'Focus tab',
    'The Focus tab on the board, with the focus steps and their tasks. On in full mode. Off in lite, which has no ' +
    'focus steps, so the tab would stay empty. The ravenseat focus command works either way.',
    { ...BASIC, defaultByMode: { lite: false, full: true } }),
  row('features.plans.legal', 'plans', 'onoff', 'Legal surface',
    'The Legal surface in Plans, with the legal points of the plan register. Off by default: turn it on when the ' +
    'project keeps legal points. It shows only while features.plans is on.', { fullWhy: WHY_PLANS }),
  row('features.plans.launch', 'plans', 'onoff', 'Launch surface',
    'The Launch surface in Plans, with what stands between the plan and launch. Off by default; it shows only while ' +
    'features.plans is on.', { fullWhy: WHY_PLANS }),
  row('features.plans.documents', 'plans', 'onoff', 'Documents surface',
    'The Documents and agreements surface in Plans, with the documents the plan register tracks. Off by default; it ' +
    'shows only while features.plans is on.', { fullWhy: WHY_PLANS }),
  // Quick capture (plans-tab-ux-review-2026-11-19.md P6, owner decision 2026-11-19 "as recommended").
  // Friction: none added; it removes the step of writing a plan entry file for an idea (only a title is asked for, and
  // Undo takes a capture back). It stops nothing and weakens no guard. Default on, because it only adds a button and
  // the Inbox section; off for a board where nobody should add plans (ravenseat plan capture still works).
  row('features.plans.inbox', 'plans', 'onoff', 'New plan (quick capture)',
    'The "+ New plan" button and form in Plans: a title (and, if you like, a few sentences) goes straight into the ' +
    'Inbox, with Undo. On by default; it shows only while features.plans is on. The CLI ravenseat plan capture ' +
    'always works.'),
  // The Roadmap (plans/plans-tab-ux-review-2026-11-19.md P1 to P3, owner decision 2026-11-19: concept B "as
  // recommended", with columns on a wide screen). None of the four can stop work or weaken a guard: they choose what the
  // board shows first, so none has a weakening value.
  // Friction: none for a reader; the roadmap removes the three or four clicks it took to see a plan's own words. The
  // Overview and the maps are one click further (More views), which is the cost. Default roadmap, because the owner
  // found the plans unreadable from the Overview; overview and list stay for those who want the old start.
  row('plans.startView', 'plans', 'choice', 'Plans opens on',
    'Where Plans opens: roadmap (default: the plans in horizons, in plain words), overview (the area cards) or list ' +
    '(Plan entries). The other pages stay one click away under More views.',
    { ...BASIC, choices: ['roadmap', 'overview', 'list'] }),
  // Friction: none; a viewer switches the layout on the board with one click and the board remembers it per browser,
  // so this row is only the project's starting point. Default auto, because five columns do not fit below about 1200 px
  // and a phone must never scroll sideways; on a wide screen columns show the most plans per screen.
  row('plans.roadmapLayout', 'plans', 'choice', 'Roadmap layout',
    'auto (default): the horizons side by side as columns from 1200 px, one list below. columns or list: always that. ' +
    'A viewer\'s own choice on the board wins, and below 700 px it is always one list.',
    { choices: ['auto', 'columns', 'list'] }),
  // Friction: one click ("Show n more") to see the rest of a long section. Default 8, so a register of 300+ plans still
  // fits each section on one screen; Inbox and Waiting on you never fold (they need the owner), Done is folded until
  // opened, and nothing folds while a search or filter is active. 0 never folds.
  row('plans.roadmapFoldAfter', 'plans', 'integer', 'Rows before a section folds',
    'How many plans a long roadmap section shows before "Show n more" (default 8; 0 = never fold). Inbox and ' +
    'Waiting on you always show every plan, Done is folded until opened, and a search shows every match.'),
  // Friction: none; it only adds text. The server reads each plan document once per change (cached by time and size,
  // through the /api/doc guard, at most 512 KB), so the cost is a stat per plan per minute. On by default because two
  // thirds of real plans have no summary and would show "No summary yet". Off for a project whose documents are huge
  // or slow to read.
  row('plans.leadFromDocument', 'plans', 'onoff', 'Lead from the plan document',
    'A plan without a summary shows the first lines of its plan document on the roadmap, marked "From the plan ' +
    'document". Off: no document is read for the roadmap; the reader still opens them.'),
  // P5. Friction: none; it only adds plans to a search, below the ones whose title or summary match, with the matching
  // sentence under the row. The server reads each plan document once per change (the /api/doc guard, at most 512 KB,
  // passages cached per file by time and size), so a repeated search costs a stat per plan. On by default (owner answer
  // 8 of the plan, "as recommended"). Off for a very large document folder, where the first search after many changes
  // has to read every plan document; the search then covers the register's own words only.
  row('plans.searchDocuments', 'plans', 'onoff', 'Search the plan documents',
    'On: the plan search also looks in each plan\'s document and shows the matching sentence under the row, after the ' +
    'plans whose title or summary match. Off: the search covers the register only (for a very large document folder).'),
  // P7 (plans-tab-ux-review-2026-11-19.md section 8, owner answer 5 "as recommended"). Sorting costs tokens, so it is
  // not automatic by default.
  // Friction: on-request means a captured idea waits until someone runs /plans inbox (the INBOX line in the pulse and
  // show reminds). idle lets the orchestrator spend free slots on it; off stops new proposals (the owner sorts by hand
  // on the board with Edit). Nothing here changes a plan: a proposal still waits for the owner's Accept.
  row('plans.inboxTriage', 'plans', 'choice', 'When Claude sorts the inbox',
    'on-request (default): Claude writes proposals for the Inbox only when /plans runs or you ask. idle: the ' +
    'orchestrator also does it when the queue has free slots (costs tokens). off: no proposals; you sort on the board.',
    { choices: ['on-request', 'idle', 'off'] }),
  // Friction: off (default) means one click per Inbox item (Accept, with Undo). On saves that click for the quiet ones,
  // but it changes plans without the owner seeing them first, so it is off; even on, only a captured plan whose proposal
  // keeps the priority later and names no merge is applied, anything else still waits.
  row('plans.inboxAutoApply', 'plans', 'onoff', 'Apply quiet proposals by themselves',
    'Off (default): every proposal for the Inbox waits for your Accept on the board. On: a proposal that keeps a ' +
    'captured plan at Later and merges nothing is applied at once (it still shows in the plan\'s History, and plan ' +
    'undo takes it back).',
    {
      weakens: onWeakens,
      protects: 'A plan changed by Claude without the owner seeing the change first.',
      whyNot: 'Claude\'s project, maturity and summary for your idea go in unseen, and a wrong guess is only found later.',
      changes: 'Proposals that keep Later are applied without your Accept. Doctor will report it.',
    }),
  // The light plan gate (plans/plan-gate-vurdering-2026-11-21.md PG-1..PG-3, owner decision 2026-11-21 "as
  // recommended"; lib/planGate.js). None of the defaults can stop work.
  // PG-2. Friction: one question, only for a request with no plan entry that splits into more than shape.threshold tasks
  // or meets an accepted zone; "Build it all now" is one answer and is recorded (shaped: skipped). About 50 tokens in the
  // always-loaded instructions. Offer is the default: it never stops work and it reaches the user who would never open
  // /plans. always-shape is for those who want to be asked more; off is today's behaviour.
  row('shape.nudge', 'plans', 'choice', 'Shape large requests first',
    'When a request with no plan entry would become more than shape.threshold tasks, or touches a sensitive zone, ' +
    '/add-to-queue asks once: shape it first (recommended: up to three questions and a one-page note), the smallest ' +
    'version first, or build it all now. offer (default): that question. always-shape: shape without asking first. ' +
    'off: no question.', { choices: ['offer', 'always-shape', 'off'] }),
  // Friction: none by itself; it sets where the question above starts. Default 5: about a week of tracks, and a request
  // of up to five tasks is usually clear enough to build as asked.
  row('shape.threshold', 'plans', 'integer', 'Tasks before the shape question',
    'The shape-first question comes when a request would split into more than this many tasks (default 5). A zone ' +
    'hit asks whatever the count.'),
  // PG-1. Friction: 10 to 20 minutes of agent writing and a page of reading per large plan (L, XL or a zone); nothing for
  // small ones. On by default: it is text the owner reads in the report anyway, with the parts people skip (non-goals,
  // stop criteria, the case against) made explicit. Off: no section is expected and the ready check is silent.
  row('plans.decisionNote', 'plans', 'onoff', 'Decision section for large plans',
    'A plan of size L or XL, or one in a sensitive zone, gets a one-page decision section from /plans (need, success ' +
    'measure, non-goals, alternatives, cost, stop criteria, the case against, the cheapest test), linked as a source ' +
    'with role decision; plan get shows missing, skipped or done. Off: no section is expected.'),
  // PG-3. Friction: one WARNING line in advisory mode, only when a large plan is set to ready without a complete
  // section. Block stops the edit, so it is off by default: a solo owner who lifts their own block learns to lift it.
  row('plans.readyCheck', 'plans', 'choice', 'Check at ready',
    'Setting a large plan to ready without a complete decision section: advisory (default) prints one warning naming ' +
    'what is missing; block refuses the edit; off says nothing. plan edit <id> --skip-decision "<reason>" records a ' +
    'skip, shown on the plan, and lets it through.', { choices: ['advisory', 'block', 'off'] }),
  // PG-4 (lib/checkpoint.js). Friction: the rest of a staged plan waits for one owner answer (Continue, Adjust or Stop)
  // once stage 1 is merged. That stops work, so the default only offers it, as the recommended answer for a gated plan
  // (L, XL or a zone) and for "smallest version first"; nothing is held without that choice. always stages every gated
  // plan without asking; off queues it all startable, as before.
  // The board says "step" only for a focus step (queueFocusB17.test.ts), so this text says "first part".
  row('plans.checkpoint', 'plans', 'choice', 'Queue large plans in parts',
    'A large plan (L, XL or a sensitive zone), or "smallest version first": /add-to-queue offers to queue the first ' +
    'part and the rest waiting on one checkpoint question, which opens when the first part is done (Continue, Adjust ' +
    'or Stop). offer (default): offered, you choose per plan. always: without asking. off: all tasks start as usual.',
    { choices: ['offer', 'always', 'off'] }),
  // PG-5 (lib/catalogZones.js). Friction: none while no zone is accepted (Ravenseat ships none; `catalog zones` only
  // proposes). With accepted zones: one NOTE line at add and a card badge, never a stop. On by default for that reason.
  row('zones.detect', 'plans', 'onoff', 'Match tasks against sensitive zones',
    'Tasks are matched against the zones you accepted in the catalog (data model, public contracts, sign-in, keys): ' +
    'a NOTE line at add, a badge on the card, and the plan gate, plan review and riskiest assumption cover them. It ' +
    'does nothing until a zone is accepted. Off: no task is ever in a zone.'),
  // PG-6 (lib/planPostCheck.js). Friction: one Statistics row per built plan (display), and for a plan with a decision
  // section one owner question that holds no task, so nothing waits on it. On by default: it is the only way the
  // estimates learn, and the question asks for one click.
  row('plans.postCheck', 'plans', 'onoff', 'Follow up built plans',
    'When every queue task of a plan is done: a Statistics row (size estimate against the tasks and fix rounds, ' +
    'estimate against the measured time, cost), and for a plan with a decision section one question "Success measure: ' +
    '... Met, partly, not met?" that holds no task. Off: neither.'),
  // PG-7 (lib/devilsAdvocate.js). Friction: one agent run (tokens) per use and a few minutes of reading, so it is off by
  // default; when on it is only offered for XL or zone plans, never run without a yes.
  row('plans.devilsAdvocate', 'plans', 'onoff', 'Devil\'s advocate for big plans',
    'On: /plans offers a challenger run for an XL or sensitive-zone plan. It reads only the decision section and the ' +
    'code (not the investigation) and adds the three strongest objections and the cheapest test under the section. ' +
    'Off (default): no offer.'),
  // PG-8 (lib/planGate.js largeBatchLine). Friction: one WARNING line at add, never a stop. Default 5: the same size the
  // shape-first question starts at (shape.threshold), so a batch that skipped /add-to-queue still hears it once.
  row('add.largeBatchWarn', 'plans', 'integer', 'Warn about a large unplanned batch',
    'ravenseat add with at least this many tasks that have no plan entry (or fewer, whose estimate is over a week at ' +
    'the measured pace) prints one warning to consider /plans first. Nothing is refused. 0: no warning.'),
  row('focus.continueWhenEmpty', 'plans', 'onoff', 'Continue when the focus ends',
    'Off: the queue pauses and asks you when a focus has ended. On: it continues with the regular queue.',
    { fullWhy: 'lite has no focus steps to end' }),
  // B22 (owner decision 2026-11-19, owner question 3 of plans/fokus-vurdering-2026-11-18.md). Default fill (STANDARD in
  // lib/queueConfig.js): wait can stop work without anything saying so, and anything that can stop work is off by
  // default. Friction: someone who wants a strict focus picks wait once. Only a new focus reads it (`focus set` without
  // --rest, a new focus from the Focus tab); an explicit --rest or the board's choice wins, a stored focus keeps its rest.
  row('focus.restDefault', 'plans', 'choice', 'Outside focus',
    'What happens to tasks outside a new focus. fill (default): they start when the focus leaves a slot free. ' +
    'wait: they do not start until the focus changes, so slots can stay empty.',
    { fullWhy: 'lite has no focus steps', choices: ['fill', 'wait'] }),
  row('modules', 'plans', 'list', 'Areas', 'The areas of the product in the plan register.', { fullWhy: WHY_PLANS }),
  row('projectModuleSuggestion', 'plans', 'object', 'Suggested area per project',
    'A suggested area for each project id ({ "<project>": "<area>" }), used only by `plan modules --link` for projects ' +
    'that have no area yet. Empty = no suggestions.', { fullWhy: WHY_PLANS }),
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
  // Task links (lib/taskLinks.js, cli/taskLinksCheck.mjs, roadmap 0p2 B2, guards V1 and V2). On in both modes: each
  // only states a fact and stops nothing, so off is no weakening. The rows are worded as in the plan (§ 4).
  row('links.addWarn', 'plans', 'onoff', 'Warn on broken task links',
    'add and edit print one WARNING line when a task link (plan sources, sources, a path in source) is dead, its ' +
    'anchor finds no heading, or the file is gitignored. The task is added anyway. It stops nothing.'),
  row('links.doctor', 'plans', 'onoff', 'Task links in doctor',
    'Doctor shows one INFO row with counts for open tasks: dead links, anchors without a heading, gitignored sources ' +
    'and tasks with nothing to read. Counts only, never content. It stops nothing.'),

  // ---- 15. History and storage (private and sharing, 9, are in it) ----
  row('stateSnapshots.enabled', 'history', 'onoff', 'Snapshots of the queue',
    'Rolling copies of queue.json at a few ages, kept in the data folder.'),
  row('stateSnapshots.tiers', 'history', 'list', 'Snapshot ages',
    'The ages of the rolling copies of queue.json, two to eight such as "1h", "1d", "7d". An older age lets you go ' +
    'further back after a bad change.'),
  row('metrics.idleGapMin', 'history', 'integer', 'Idle gap (minutes)',
    'A gap longer than this between two transcript entries is idle and not counted as active time.'),
  // Friction: low, a CPU reading twice per sample and one time log row; only while the board runs. Off by default: the
  // load rows at fill and start and the gate rows' memory samples already answer how many tracks and gate slots fit.
  row('metrics.machineSampleMin', 'history', 'integer', 'Machine sample (minutes)',
    'While the board runs, free memory and CPU are written to the time log every this many minutes, for the Machine ' +
    'section of Statistics. 0 = off. A measurement only: it never limits or stops work.'),
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
    'Folders (trailing /) and files of your own that stay out of git: the .gitignore, the push and merge guard and the cloud\'s hidden paths all read this list. { "path": ..., "read": false } also keeps the queue\'s agents from reading it. ravenseat private add|remove|list.',
    { protects: 'Your own private files reaching git, a push or the cloud.' }),
  // The dependency audit (roadmap 0å KD-4, lib/osv.js). Friction: a network call to api.osv.dev, only when the owner runs
  // `ravenseat catalog deps --audit` and confirms it (--yes the first time); nothing automatic, no polling. Default
  // manual: nothing leaves without the owner's command. off refuses the command and hides the card and the doctor line;
  // no guard reads it, so it is no weakening.
  row('deps.audit', 'private', 'choice', 'Dependency audit against OSV.dev',
    'manual: `ravenseat catalog deps --audit` asks OSV.dev about the public packages in your lockfiles (ecosystem, name ' +
    'and version only), when you run it, and the Checks tab shows a card for what it found. off: the command refuses ' +
    'and there is no card. Nothing is ever checked automatically.', { choices: ['manual', 'off'] }),
  // Friction: none; a list of names that are never sent. Empty: the lockfile already shows what is private (workspace,
  // file:, link:, git, a path, another registry), and only the owner knows their own scopes. No guard reads it.
  row('deps.privateScopes', 'private', 'list', 'Private package names the audit never sends',
    'Names or prefixes that never leave this machine, besides what the lockfile shows is private (workspace, file:, ' +
    'link:, git, a local path, another registry): "@acme" holds back @acme/ui, "github.com/acme" a Go module path, ' +
    '"acme-*" a prefix. Use it for internal packages published under a public registry name.'),
  // Friction: it would stop a merge, so it is off. KD-5: registered now so the name is known, wired to nothing yet. On
  // is stronger, so off is no weakening.
  row('deps.auditStop', 'private', 'onoff', 'Stop a merge on a vulnerable package (later)',
    'Reserved for a later step: a merge that adds or changes a package with a known high hole would stop. Not wired ' +
    'yet, so it does nothing today. Off, since it can stop work.'),
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
  // Roadmap 2c3 (lib/missionInline.js): performance, not a guard. It stops nothing (the text moves to a file the agent
  // reads as before), so it is on by default, and 0 (off) weakens no guard.
  row('queue.missionInlineMax', 'history', 'integer', 'Longest inline mission (characters)',
    'add and edit move an inline mission longer than this to mission/<id>.md in the data folder and store the path, ' +
    'so queue.json stays small. The agent reads the file as before. It stops nothing. 0 keeps every mission inline.'),
]);

/** The row for a key, or null. */
function rowFor(key) {
  return SETTINGS.find((r) => r.key === key) ?? null;
}

module.exports = { LABELS, CATEGORIES, INTERNAL, QUEUE_ONLY, SETTINGS, REQUIRES, rowFor };
