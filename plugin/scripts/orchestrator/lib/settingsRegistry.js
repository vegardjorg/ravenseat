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
// Where the parts live (SPLIT-1, 2026-11-23): the rows were one list in this file, which nearly every task added a row
// to, so it was the main merge-conflict spot. They now sit in one file per settings area, and this file puts them back
// together in the same order (AREAS below), with the same exports:
//   this file              the contract above, LABELS, CATEGORIES, INTERNAL, QUEUE_ONLY, SETTINGS (assembled), rowFor
//   settings/rowKit.js     row() and its defaults, the weakens builders, BOTH/FULL, BASIC, QUEUE, the full-only reasons
//   settings/requires.js   REQUIRES (one table, so each entry names the code that ignores the row)
//   settings/project.js    Project and git, Limits and cost, Machine load
//   settings/gates.js      Gates, Tests and evidence, Checks tab and learning
//   settings/guards.js     File and read guards, Command and secret guards
//   settings/push.js       Merge and push
//   settings/review.js     Review and agents, Scope and catalog
//   settings/board.js      Board and advice, Cloud
//   settings/plans.js      Plans and focus, History and storage, Private and sharing
// A new setting: its row goes into the area file of its category, inside that category's section, with its "Friction:"
// comment; a `requires` goes into settings/requires.js. Nothing in this file changes for a new row.
//
// Pure data and small pure functions. Used by lib/settingsView.js (the CLI, the board's panel and doctor),
// cli/settings.mjs, lib/queueBoard.js and queue-board.mjs. Tested in lib/__tests__/settingsRegistry.test.ts (coverage, complete rows) and
// lib/__tests__/settingsRegistrySplit.test.ts (the assembled list equals the one from before the split).
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

const { REQUIRES } = require('./settings/requires.js');

/**
 * The area files, in the order their rows are shown (lib/settings/). Each holds the rows of one or a few categories,
 * in the sections the single list had (the numbers are the CATEGORIES order; Private and sharing, 9, sits in History).
 */
const AREAS = Object.freeze([
  require('./settings/project.js'), // sections 1, 2, 3
  require('./settings/gates.js'), // sections 4, 5, 6
  require('./settings/guards.js'), // section 7
  require('./settings/push.js'), // section 8
  require('./settings/review.js'), // sections 10, 11
  require('./settings/board.js'), // sections 12, 13
  require('./settings/plans.js'), // sections 14, 15
]);

/** Every row, the area files one after the other. */
const SETTINGS = Object.freeze(AREAS.flatMap((area) => area.ROWS));

/** The row for a key, or null. */
function rowFor(key) {
  return SETTINGS.find((r) => r.key === key) ?? null;
}

module.exports = { LABELS, CATEGORIES, INTERNAL, QUEUE_ONLY, SETTINGS, REQUIRES, rowFor };
