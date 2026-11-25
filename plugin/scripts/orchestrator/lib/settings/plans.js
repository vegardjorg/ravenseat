// =============================================================
// settings/plans.js: the rows of Plans and focus, and History and storage with Private and sharing (sections 14, 15).
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

const { row, BASIC, onWeakens, WHY_PLANS } = require('./rowKit.js');

/** The rows of this area, in the order they are shown. */
const ROWS = Object.freeze([
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
    // Full only in lite (friction review 22.11): the lite path of /add-to-queue skips the planning steps, staging too.
    { choices: ['offer', 'always', 'off'], fullWhy: 'the lite /add-to-queue adds one task per thing asked and skips staged queueing' }),
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
  // Friction: none for auto. It runs only when a journal is left (a crash, a kill or a full disk between the writes of
  // one store transaction), takes a few renames under locks the command already holds and costs no tokens. A write
  // never goes past a journal that can still be finished (fix round jrn-r1): with auto that stops a write only when the
  // recovery itself does not get through (a file held open twice in a row), and a journal nothing can finish any more
  // is kept for doctor while writes go on. Default auto: it only finishes a write the user already asked for, and it is
  // the setting that stops the fewest commands. report is for an owner who wants to look first: a write to those files
  // then stops until doctor --fix (reads go on).
  row('store.journalRecover', 'history', 'choice', 'Finish a stopped store commit',
    'When a command that writes several files as one unit stopped part way (a crash, a kill, a full disk), auto finishes ' +
    'it or puts the state before it back, the next time a command takes the same lock; report only says so, a command on ' +
    'those files stops until then, and ' +
    '`ravenseat doctor --fix` finishes it. Doctor names every journal left behind either way; one that cannot be finished is marked failed, never tried again, and `ravenseat store journal drop <id>` sets it aside.', { choices: ['auto', 'report'] }),
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

module.exports = { ROWS };
