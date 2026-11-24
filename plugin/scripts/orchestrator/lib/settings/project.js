// =============================================================
// settings/project.js: the rows of Project and git, Limits and cost, and Machine load (sections 1 to 3).
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

const { row, BASIC, QUEUE, offWeakens, rankWeakens, WHY_ONE_TYPE, WHY_ONE_DOMAIN } = require('./rowKit.js');

/** The rows of this area, in the order they are shown. */
const ROWS = Object.freeze([
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
  // Friction: none for a live run, it touches one file every 30 s; it only decides how soon a slot whose holder hung
  // (alive but stuck, or a pid reused) is taken over. 5 min by default (roadmap 0s V11): the old fixed 3 h kept the whole
  // machine waiting behind one stuck run, and 10 missed beats is far past any pause of a healthy process. A 6 h ceiling
  // always holds. 0 = no heartbeat (the 3 h rule of older versions).
  row('gateQueue.staleMin', 'load', 'integer', 'Slot stale after (minutes)',
    'A run holding a slot touches it every 30 s. A slot whose heartbeat has stopped this long is taken over by the next ' +
    'run, also when the holder\'s process still exists. 0 = no heartbeat, a slot is taken over after 3 hours.'),
  // Friction: warn adds one short note to the agent's context and stops nothing; deny stops an unwrapped test command in
  // a track until it is run as `ravenseat heavy -- <command>`, which can make a track wait for a slot. Warn by default
  // (roadmap 0s V10): the agent learns the wrapper without a hard stop, and deny is never the default. Tracks only; the
  // hook itself never waits.
  row('processGuard.heavyQueue', 'load', 'choice', 'Heavy commands in tracks',
    'A track agent running a test suite, vitest, playwright or a red team run without `ravenseat heavy --` in front: ' +
    'deny stops it with the wrapped command to use, warn lets it run with a note, off says nothing.', {
      choices: ['deny', 'warn', 'off'],
      weakens: rankWeakens(['deny', 'warn', 'off']),
      protects: 'Parallel tracks running heavy test commands at once, which slows each into timeouts and false reds.',
      whyNot: 'Without the note an agent does not learn to take a machine queue slot for its test runs.',
      changes: 'Track agents get no note when they run a heavy command outside the machine queue.',
    }),
  row('gateTemp.enabled', 'load', 'onoff', 'Temp folder per gate run',
    'Each gate run gets its own temp folder, removed afterwards, so what the tests leave goes with it.'),
  // The process guard (lib/processGuard.js, roadmap 0s, owner 16.11).
  // Friction: none. One small file per running gate, done, base or wait run in the data folder, removed when it ends;
  // it never stops or slows a run. On: the sweep has nothing to read without it.
  row('processGuard.register', 'load', 'onoff', 'Register the processes Ravenseat starts',
    'Every gate command, done command, base gate and wait run writes one small file (pid, owner, start, max time) in ' +
    'the data folder\'s processes/ folder while it runs, and removes it when it ends. It stops nothing. Off: no file, ' +
    'so doctor and the pulse cannot name leftovers.'),
  // Friction: none, display only. A doctor row, a pulse line and a Checks card for leftovers; it removes register files
  // of dead pids. On: a leftover that holds memory and CPU for days is otherwise never seen (0o: 21 for two days).
  row('processGuard.sweep', 'load', 'onoff', 'Show leftover processes',
    'Doctor, the pulse check and the Checks tab name each registered process that outlived the process that started ' +
    'it or ran past its time budget, with its pid, owner, age and the command that ends it and what it started; long ' +
    'heavy runs without a track are shown too. It never touches a process Ravenseat did not start. Off: no row, line or card.'),
  // Friction: HIGH when on, it can end work: a run that looks over its time but would have finished. Off by default
  // (owner 16.11). Even on, a pid is ended only after its command line confirms it is a Ravenseat guard.
  row('processGuard.autoKill', 'load', 'onoff', 'Stop leftover processes by itself',
    'Doctor and the pulse check also end each leftover the sweep finds (the whole tree), after confirming from its ' +
    'command line that it is a Ravenseat guard; a pid it cannot confirm is only shown. Off by default: it can stop a ' +
    'run that would still have finished. The check is read only, but on Windows it takes a few seconds.'),
  // Friction: high on a saturated Windows machine. A BELOW_NORMAL run gets next to no CPU while normal-priority work
  // (track agents' own test runs, the owner's tools) fills every core, so gate, done and base runs reach their time
  // budget and go red: measured 23.11, the base gate tests timed out at 240 s lowered and passed at normal priority.
  // That can stop work, so it is off by default; on suits a machine with free cores, where it only slows the heavy runs.
  row('processGuard.lowerPriority', 'load', 'onoff', 'Lower priority for heavy runs',
    'Gate commands, done commands and the base gate run at BELOW_NORMAL priority (nice 10 on Linux and macOS), and ' +
    'what they start inherits it. Never IDLE. Dev servers, wait runs and the main session\'s own commands are not ' +
    'touched. Off by default: when other work fills every core, a lowered run gets almost no CPU and can run out of ' +
    'its time budget. Off: they run at normal priority.'),
  // Friction: none, a warning only: a doctor WARN row and a Checks card, never a stop. 2 by owner decision 16.11: a
  // track at twice its estimate is worth a look; earlier would warn on the normal spread of estimates.
  row('tracks.overtimeFactor', 'load', 'number', 'Overtime warning (x estimate)',
    'A running track that has run longer than this many times its estimate gets a WARN row in doctor and a card on ' +
    'the Checks tab. It is never stopped. 0 = off.'),
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
]);

module.exports = { ROWS };
