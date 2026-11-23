// =============================================================
// settings/review.js: the rows of Review and agents, and Scope and catalog (sections 10 and 11).
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

const { row, BASIC, QUEUE, offWeakens, onWeakens, fewerReviewers, WHY_PLAN_REVIEW } = require('./rowKit.js');

/** The rows of this area, in the order they are shown. */
const ROWS = Object.freeze([
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
      weakens: (v) => require('../reviewSignals.js').weakens(v),
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
  // Full only in lite (friction review 22.11): the review runs on the intake triage's step (lib/queueTriage.js, off in
  // lite) and lite has no D+, so the rows would do nothing there.
  row('planReview.mode', 'review', 'choice', 'Plan review before a risky task',
    'Before a risky task starts, the triage step also checks the plan against the code: data model and migrations, ' +
    'public interfaces, irreversible steps, file boundaries, assumptions the code contradicts (file:line or no note). ' +
    'Advisory: the notes go into the mission and the task starts. Block: a point for you becomes a question before the ' +
    'start. Off: no plan review.', { choices: ['block', 'advisory', 'off'], fullWhy: WHY_PLAN_REVIEW }),
  row('planReview.classes', 'review', 'list', 'Plan review for classes',
    'The task classes that get the plan review (default D+). A task in an accepted sensitive zone (catalog kind zone) ' +
    'gets it whatever its class.', { fullWhy: WHY_PLAN_REVIEW }),
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
]);

module.exports = { ROWS };
