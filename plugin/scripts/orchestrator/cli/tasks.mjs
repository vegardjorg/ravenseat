// =============================================================
// cli/tasks.mjs: the commands that create the queue and add tasks: init, mode, add and classify.
//
// init writes the data folder and an empty queue (never touches an existing one), mode reads or writes the lite/full
// mode, add takes one task, a list or a lite title (with the small-task guard, the batch queue and the plan links),
// and classify proposes (or with --execute sets) the project of tasks.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/liteMode.test.ts, queueSmall.test.ts, queueProposals.test.ts, queueBulk.test.ts (classify), fixLinks.test.ts
//   and the many tests that set up a queue with init and add.
// =============================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  a, autoAcceptContext, autoAcceptIn, byName, CONFIG, CLI, die, edit, editLogged, FILE, FOLDER, FX, KK, L, lastEntry, LM, MIGR, P,
  namedIds, positional, PR, queueBranchId, read, readPlans, restoreArchived, undoHint, val, values, withLock, write,
  require,
} from './context.mjs';
import { highestMigr } from './tracks.mjs';
import { guardWeakening, logWeakened } from './settings.mjs';

/**
 * Adds the data folder and the agents' worktrees to the repo's .gitignore on a fresh init, so a new user does not have to.
 * Does nothing outside a git repo, and skips what git already ignores or a data folder outside the repo. Never fails init:
 * a .gitignore that cannot be written only gives a hint.
 */
function ignoreDataFolder() {
  const git = (...args) => spawnSync('git', args, { cwd: FOLDER, encoding: 'utf8' });
  const top = git('rev-parse', '--show-toplevel');
  if (top.status !== 0) return;
  // Compare real paths: git prints the long, resolved path, while FOLDER may be a Windows 8.3 short name
  // (C:\Users\RUNNER~1\...) or go through a symlink (/var -> /private/var on macOS). Without this the folder looks
  // outside the repo and nothing is added.
  const real = (p) => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  const repo = real(top.stdout.trim());
  const rel = path.relative(repo, real(FOLDER)).split(path.sep).join('/');
  const lines = [];
  if (rel && !rel.startsWith('..') && git('check-ignore', '-q', FOLDER).status !== 0) lines.push(`${rel}/`);
  // A file inside the folder: an open track's worktree would otherwise show as untracked in git status.
  if (git('check-ignore', '-q', path.join(repo, '.claude', 'worktrees', 'x')).status !== 0) lines.push('.claude/worktrees/');
  if (!lines.length) return;
  const file = path.join(repo, '.gitignore');
  try {
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const sep = before && !before.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, `${sep}# Ravenseat (local state, not for git)\n${lines.join('\n')}\n`);
    console.log(`Added ${lines.join(' ')} to .gitignore (local state, not for git).`);
  } catch (e) {
    console.log(`Note: could not add ${lines.join(' ')} to .gitignore (${e.message}); add it yourself.`);
  }
}

/**
 * A fresh init on a repo without the default base branch (a repo on master): writes the current branch as baseBranch, or
 * every track would fail to start. A base branch the config names, or a default branch that exists, is left alone, so an
 * init on a feature branch does not make that branch the base. Never fails init: without an answer the default stays, and
 * ravenseat doctor names the missing branch.
 */
function pickBaseBranch() {
  const git = (...args) => spawnSync('git', args, { cwd: FOLDER, encoding: 'utf8' });
  try {
    const own = JSON.parse(fs.readFileSync(KK.configFile(), 'utf8'));
    if (Object.hasOwn(own, 'baseBranch')) return;
    const head = git('symbolic-ref', '--short', '-q', 'HEAD');
    if (head.status !== 0) return; // not git, or a detached HEAD
    if (git('rev-parse', '--verify', '-q', `refs/heads/${CONFIG.baseBranch}`).status === 0) return;
    const branch = head.stdout.trim();
    if (!branch || branch === CONFIG.baseBranch) return;
    fs.writeFileSync(KK.configFile(), `${JSON.stringify({ ...own, baseBranch: branch }, null, 2)}\n`);
    console.log(`Base branch: ${branch} (there is no ${CONFIG.baseBranch} here; written to ${KK.configFile()}).`);
  } catch (e) {
    console.log(`Note: could not set the base branch (${e.message}); ravenseat doctor checks it.`);
  }
}

/** `ravenseat init` (the usage is at the top of queue.mjs). */
export function cmdInit() {
  // Creates the data folder and an empty queue with defaultLimits and the example project "example" (prefix EX-). An existing
  // queue is never touched, so init is safe to run several times.
  // The mode (lib/liteMode.js): --lite / --full write `mode` into queue.config.json, also for an existing queue. A FRESH
  // init (no queue yet) without a flag writes "lite" when the config has no `mode` of its own; an existing install is
  // never switched without a flag. Lite gets the project "tasks" (prefix T-) instead of "example".
  if (require('./lib/projectRoot.js').noProjectFolder())
    die('This folder is not under git yet, so there is no project to set up. The queue needs git: ask Claude to run "git init" and make a first commit, then run init again.');
  fs.mkdirSync(FOLDER, { recursive: true });
  const fresh = !fs.existsSync(FILE);
  const flagMode = a.includes('--lite') ? 'lite' : a.includes('--full') ? 'full' : null;
  if (a.includes('--lite') && a.includes('--full')) die('init takes --lite or --full, not both');
  const ownMode = LM.readOwnMode(KK.configFile());
  // A new project: no queue yet and no mode of its own. Its first mode (lite by default, or the flag) is a choice, not a
  // switch, so it never asks. Anything else is an existing project: init --lite on one that runs in full (its own
  // "full", or no mode key, which means full) is the same switch as `mode lite`, a confirmed weakening (owner decision
  // 2026-11-12, cli/settings.mjs guardWeakening).
  const newProject = fresh && ownMode == null;
  const initMode = flagMode ?? (newProject ? 'lite' : LM.mode(CONFIG));
  if (!newProject && flagMode === 'lite') {
    const g = guardWeakening('mode', 'lite', { now: LM.mode(CONFIG), raw: 'lite', confirmWith: `${CLI} init --lite` });
    if (g.weak) logWeakened(g.row, g.now, 'lite', g.by);
  }
  if (flagMode || newProject) {
    try {
      const w = LM.writeMode(KK.configFile(), initMode);
      if (w.changed) console.log(`Mode: ${initMode} (written to ${KK.configFile()}; switch with ${CLI} mode lite|full).`);
    } catch (e) {
      die(`init: could not write the mode to ${KK.configFile()} (${e.message}). Nothing changed.`);
    }
  }
  if (!fresh) {
    console.log(`The queue already exists: ${FILE} (nothing changed).`);
    process.exit(0);
  }
  const queue = {
    created: new Date().toISOString(),
    limits: {
      maxConcurrent: Number(val('--max-concurrent') ?? L.DEFAULT_LIMITS.maxConcurrent),
      maxDPlus: Number(val('--max-dplus') ?? L.DEFAULT_LIMITS.maxDPlus),
      maxPerDomain: Number(val('--max-per-domain') ?? L.DEFAULT_LIMITS.maxPerDomain),
    },
    resolved: [],
    projects:
      initMode === 'lite'
        ? { [LM.LITE_PROJECT.id]: { title: LM.LITE_PROJECT.title, prefixes: [LM.LITE_PROJECT.prefix] } }
        : {
            example: {
              title: 'Example',
              prefixes: ['EX-'],
            },
          },
    tasks: [],
  };
  // Migration blocks only when the migration flow is enabled (config().migrations.folder).
  if (MIGR.folder) queue.next_migr = Number(val('--next-migr') ?? highestMigr() + 1);
  else if (val('--next-migr') != null)
    console.log('Note: --next-migr is ignored; the migration flow is off (migrations.folder in queue.config.json).');
  withLock(() => write(queue));
  ignoreDataFolder();
  pickBaseBranch();
  if (initMode === 'lite') {
    console.log(`The queue is created: ${FILE} (lite mode).`);
    console.log(`Next: ${CLI} add "<what you want done>", then /ravenseat:queue (or ${CLI} fill) to start it.`);
    console.log(LM.switchLine(CLI));
  } else
    console.log(
      `The queue is created: ${FILE}` +
        (queue.next_migr != null ? ` (next migration block from ${queue.next_migr})` : '') +
        '. The example project "example" (prefix EX-) can be renamed with ravenseat project.',
    );
}

/** `ravenseat mode` (the usage is at the top of queue.mjs). */
export function cmdMode() {
  // `mode` shows the mode; `mode lite|full` writes it into queue.config.json (only that key; lib/liteMode.js).
  const want = a[1];
  if (want == null) {
    console.log(`Mode: ${LM.mode(CONFIG)} (${KK.configFile()}).`);
    console.log(LM.isLite(CONFIG) ? LM.switchLine(CLI) : `Lite mode (the core loop only): ${CLI} mode lite.`);
    process.exit(0);
  }
  if (!LM.MODES.includes(want)) die(`mode takes ${LM.MODES.join(' or ')} (or nothing, to show it)`);
  // Full to lite softens gitSurface and dependencyFiles: the weakening rule of `settings set` (owner decision
  // 2026-11-12). Without --i-understand --by owner it prints the warning and exits 1; refused from a track worktree.
  const g = guardWeakening('mode', want, { now: LM.mode(CONFIG), raw: want, confirmWith: `${CLI} mode ${want}` });
  if (g.weak) logWeakened(g.row, g.now, want, g.by);
  let w;
  try {
    w = LM.writeMode(KK.configFile(), want);
  } catch (e) {
    die(`mode: could not write ${KK.configFile()} (${e.message}). Nothing changed.`);
  }
  console.log(w.changed ? `Mode: ${want} (written to ${KK.configFile()}; remember to commit it).` : `Mode: ${want} already (nothing changed).`);
  if (want === 'lite') console.log(LM.switchLine(CLI));
}

/** `ravenseat add` (the usage is at the top of queue.mjs). */
export function cmdAdd() {
  const LITE = LM.isLite(CONFIG);
  // Lite: `add "<title>" [--mission ...] [--priority N] [--files a,b] [--depends a,b] [--id X] [--by ...]` builds the task from the flags.
  const quickTitle = val('--title') ?? positional(1, [
    '--file', '--json', '--title', '--mission', '--priority', '--files', '--depends', '--id', '--by', '--plan', '--accept',
  ])[0];
  let source = val('--file') ? fs.readFileSync(val('--file'), 'utf8') : val('--json');
  if (!source && quickTitle != null) {
    if (!LITE)
      die(
        `add requires --file <task.json> or --json '{...}' in full mode (a title alone works in lite mode: ${CLI} mode lite)`,
      );
    const q = LM.quickTask({
      title: quickTitle,
      mission: val('--mission'),
      priority: val('--priority'),
      files: val('--files'),
      depends: val('--depends'),
      id: val('--id'),
      by: val('--by'),
    });
    if (q.error.length) die(`Nothing added: ${q.error.join('; ')}`);
    // A mistyped dependency would hold the task back for good, without a word.
    // An archived task (lib/queueArchive.js) is known too: it comes back to the queue in the write.
    const now = read();
    const known = new Set([...now.tasks.map((x) => x.id), ...Object.keys(now.archived ?? {})]);
    const unknown = (q.task.depends_on ?? []).filter((d) => !known.has(d));
    if (unknown.length) die(`Nothing added: --depends names unknown task(s): ${unknown.join(', ')}`);
    source = JSON.stringify(q.task);
  }
  if (!source)
    die(LITE ? 'add requires a title: ravenseat add "Fix the login bug" (or --file/--json)' : "add requires --file <task.json> or --json '{...}'");
  let content;
  try {
    content = JSON.parse(source);
  } catch (e) {
    die(`add: the task is not valid JSON (${e.message}). On Windows, write it to a file and use --file.`);
  }
  // { "tasks": [...], "question": {...} } adds tasks and the text of the questions they wait on in
  // the same write. An object without an id with one of these fields is that form; otherwise it is one task (as before).
  const combined =
    content &&
    typeof content === 'object' &&
    !Array.isArray(content) &&
    content.id === undefined &&
    ('tasks' in content || 'question' in content);
  const newOnes = combined ? [].concat(content.tasks ?? []) : [].concat(content);
  const newQuestion = combined ? (content.question ?? {}) : {};
  // A new task has no attempts: they are the queue's own record of what ran (lib/logic/attempt.js), never input.
  for (const n of newOnes) if (n && typeof n === 'object') delete n.attempts;
  if (combined && !newOnes.length && !Object.keys(newQuestion ?? {}).length)
    die('Nothing to add (both tasks and question are empty).');
  // --accept "<criterion>" (repeatable): the acceptance criteria of the ONE task added (lib/doneCheck.js; locked once
  // it starts). Several tasks, or a task with its own `acceptance`, take them in the file instead.
  const accepts = values('--accept');
  if (accepts.length) {
    if (newOnes.length !== 1) die('--accept sets the criteria of one task; with several, put "acceptance" in each task');
    if (newOnes[0]?.acceptance != null) die('--accept and "acceptance" in the task both set the criteria; use one');
    newOnes[0].acceptance = accepts;
  }
  const approved = a.includes('--approved');
  // From a track's own branch it is always a proposal from that track (the agents' rule is in lib/pushGuard.js agentAddReason).
  const track = queueBranchId();
  if (track && approved) die(`Nothing added: a track's task is a proposal, so --approved does not apply on ${track}'s branch.`);
  // --plan <id> links tasks (that do not have their own `plan`) to a plan entry. Set in the file or with --plan:
  // the plan entry must exist in the plan register (an unknown or merged entry is refused), and the entry becomes in-queue automatically.
  const planArg = a.includes('--plan') ? val('--plan') : null;
  if (a.includes('--plan') && (!planArg || planArg.startsWith('--')))
    die('--plan requires a plan entry id (ravenseat plan show)');
  const liteNotes = [];
  const added = edit((queue) => {
    const error = [];
    let planWarnings = [];
    // Lite: fill id, class, domain, mission, project, feature, value and content_min when missing (under the lock, so
    // the generated ids are free). The given fields always win.
    // Archived tasks (lib/queueArchive.js, history.archiveDoneAfterDays): an id there is taken, and an archived task the
    // new ones depend on, fix or are a QA fix of comes back to the queue first, so every check below sees it as it was.
    restoreArchived(queue, namedIds(newOnes.map((n) => ({ status: 'waiting', ...n }))));
    if (LITE) {
      const d = LM.liteDefaults(newOnes, queue);
      newOnes.splice(0, newOnes.length, ...d.tasks);
      liteNotes.splice(0, liteNotes.length, ...d.notes);
    }
    if (track) {
      for (const n of newOnes) L.asTrackProposal(n, track, queue.tasks);
      // A proposal is already a question to the owner, who decides its size on approval. In the batch queue it would
      // not be named as a decision and would not start when approved (test round 0.8.25).
      for (const n of newOnes) {
        if (n?.batched !== true) continue;
        delete n.batched;
        liteNotes.push(`${n.id}: a proposal does not go in the batch queue; the owner decides that when approving it.`);
      }
      const limit = L.trackLimitError(track, queue.tasks, newOnes.length);
      if (limit) die(`Nothing added: ${limit}`);
    }
    if (planArg || newOnes.some((n) => n?.plan != null)) {
      // Under the same lock as the queue, so the register does not change between the check and the write.
      const k = P.linkPlan(readPlans(), newOnes, planArg);
      error.push(...k.error);
      planWarnings = k.warnings;
      newOnes.splice(0, newOnes.length, ...k.tasks);
    }
    // The questions are validated together with the tasks: all or nothing.
    const sp = L.setQuestion(queue, newQuestion);
    error.push(...sp.error.map((f) => `question ${f}`));
    for (const n of newOnes) {
      // validate also checks that the id does not already exist in the queue, and (when the register has projects) that an
      // explicit project exists.
      const f = L.validate(n, queue.tasks, queue.projects);
      // No task owns a hotspot (shared config, lib/hotspots.js): an agreed change goes in hotspot_patch.
      const H = require('./lib/hotspots.js');
      f.push(...H.ownershipErrors(n, H.hotspotsOf(CONFIG)));
      if (f.length) error.push(`${n.id ?? '(without id)'}: ${f.join('; ')}`);
    }
    if (new Set(newOnes.map((n) => n.id)).size !== newOnes.length)
      error.push('the same id twice in what is being added');
    for (const n of newOnes)
      if (n?.id != null && queue.archived?.[n.id] !== undefined)
        error.push(`${n.id}: the id belongs to an archived task (${queue.archived[n.id]}; ${CLI} info ${n.id}); choose another id`);
    // Every waiting_on id must be a registered question (text and type), from before or in the same file
    // (setQuestion above has added them to queue.question; nothing is written when error is not empty). Free text is rejected.
    if (!sp.error.length)
      for (const n of newOnes) {
        const f = L.waitingOnError(n, queue);
        if (f.length) error.push(`${n.id ?? '(without id)'}: ${f.join('; ')}`);
      }
    // `fixes` must name tasks in the queue or in the same add (lib/fixLinks.js; validate above has checked the shape).
    const knownIds = [...queue.tasks.map((x) => x.id), ...newOnes.map((n) => n?.id)];
    for (const n of newOnes) {
      if (FX.fixesShapeError(n).length) continue;
      const f = FX.fixesError(n, knownIds);
      if (f.length) error.push(`${n.id ?? '(without id)'}: ${f.join('; ')}`);
    }
    // The batch queue rules against the queue as it will be (the new ones can depend on each other).
    // Lite mode has no batch queue and no small-task guard (lib/liteMode.js): nothing is refused for its size.
    const after = [...queue.tasks, ...newOnes.map((n) => ({ status: 'waiting', ...n }))];
    // A dependency cycle (X1 waits on X2, X2 on X1) would leave every task in it waiting forever, without a word.
    // Checked in lite mode too: a cycle stalls the queue whatever the mode.
    for (const n of newOnes) {
      const f = L.cycleError({ status: 'waiting', ...n }, after);
      if (f.length) error.push(`${n.id ?? '(without id)'}: ${f.join('; ')}`);
    }
    for (const n of LITE ? [] : newOnes) {
      const f = L.batchedError({ status: 'waiting', ...n }, after, queue.resolved);
      if (f.length) error.push(`${n.id ?? '(without id)'}: ${f.join('; ')}`);
      // The small-task guard (fix now, batch queue, or ask the owner about the priority).
      // Not for a track's proposal: the guard asks a question only the owner can answer, and the owner gets the proposal.
      const s = L.smallTaskError({ status: 'waiting', ...n, content_min: track ? undefined : n.content_min }, after, queue.resolved);
      if (s.length) error.push(`${n.id ?? '(without id)'}: ${s.join('; ')}`);
    }
    if (error.length) die(`Nothing added:\n  ${error.join('\n  ')}`);
    const result = [];
    for (const n of newOnes) {
      // An agent (track, reviewer, fold/investigation agent) adds proposals, not work that starts by itself.
      // The status is computed against the queue BEFORE the new ones are added (a new task cannot make another one an agent source).
      const status = track ? 'proposed' : L.statusAtAdd(n, queue.tasks, { approved });
      result.push({ id: n.id, status });
      // `fixes` is stored as a list (one id is accepted); an empty one is left out.
      const fixes = FX.fixesList(n.fixes);
      if (fixes !== undefined) {
        if (fixes.length) n.fixes = fixes;
        else delete n.fixes;
      }
      queue.tasks.push({
        value: 5,
        content_min: 30,
        migr_tens: 0,
        depends_on: [],
        waiting_on: [],
        owned_files: [],
        owner_db: [],
        shared_patch: [],
        ...n,
        status,
        added_at: new Date().toISOString(),
      });
    }
    // New tasks must have a project and a feature. If they lack them, that is reported now, not when a later fill stops
    // on them.
    const ids = new Set(newOnes.map((n) => n.id));
    const missing = L.missingProject(
      queue.tasks.filter((o) => ids.has(o.id)),
      queue.projects,
    );
    // A question without text cannot be shown in "Waiting on you" with something the owner can answer.
    const withoutText = L.questionWithoutText(newOnes, queue);
    // Project proposals (longest prefix, plan, fileRoot) and disagreement with an explicit project.
    const projectWarnings = L.addProjectWarnings(newOnes, queue.projects);
    // A project in phase plan has no queue tasks; if it gets tasks now, the phase is removed in the same write.
    const phaseEnded = P.phasePlanEnds(queue.projects, newOnes);
    for (const pid of phaseEnded) {
      const rest = { ...queue.projects[pid] };
      delete rest.phase;
      queue.projects[pid] = rest;
    }
    // Auto-accept (default off): the new proposals that fit the owner's rules are approved in the same write.
    const autoAccepted = autoAcceptIn(
      queue,
      result.filter((r) => r.status === 'proposed').map((r) => r.id),
    );
    for (const x of autoAccepted) {
      const r = result.find((y) => y.id === x.id);
      if (r) r.status = 'waiting';
    }
    return {
      result,
      autoAccepted,
      missing,
      question: sp.set,
      withoutText,
      projectWarnings,
      planWarnings,
      phaseEnded,
    };
  });
  const waiting = added.result.filter((r) => r.status === 'waiting').map((r) => r.id);
  const proposed = added.result.filter((r) => r.status === 'proposed').map((r) => r.id);
  if (waiting.length) console.log(`Added: ${waiting.join(', ')}`);
  for (const x of liteNotes) console.log(`Note: ${x}`);
  for (const x of added.autoAccepted)
    console.log(`Auto-accepted ${x.id} by the owner's rules (${x.reason}); undo: ${CLI} proposals undo ${x.id}`);
  if (proposed.length)
    console.log(
      `Added as proposed (not started until the orchestrator or the owner approves: ravenseat approve <id...>): ${proposed.join(', ')}`,
    );
  const { withoutProject, withoutFeature } = added.missing;
  // A track may not run edit-many, so it is not told to. Neither field is required to run.
  if (withoutProject.length || withoutFeature.length)
    console.log(
      `${track ? 'Note' : 'WARNING'}: ${[
        withoutProject.length
          ? `without project (ends up in ${L.WITHOUT_PROJECT}): ${withoutProject.join(', ')}`
          : null,
        withoutFeature.length ? `without feature: ${withoutFeature.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(
          '; ',
        )}. ${track ? 'It runs without them, and the owner can add them later; nothing for you to do.' : 'Fix with ravenseat edit-many --file <json> ([{ "id": "...", "project": "...", "feature": "..." }]).'}`,
    );
  // A field the queue does not read is kept without a word, so the task looks right and is not (test round 4: minutes).
  const WRONG_NAMES = { minutes: 'content_min', estimate: 'content_min', duration: 'content_min', priority: 'value', files: 'owned_files', depends: 'depends_on' };
  for (const n of newOnes)
    for (const [wrong, right] of Object.entries(WRONG_NAMES))
      if (Object.hasOwn(n, wrong)) console.log(`WARNING: ${n.id}: the queue does not read "${wrong}"; the field is ${right}.`);
  // Owning a protected path is what lets a change there past the merge guard, so it should not happen unnoticed.
  const protectedPaths = autoAcceptContext(read()).protectedPaths;
  for (const n of newOnes) {
    const owned = PR.ownsProtected(n, protectedPaths);
    if (owned)
      console.log(
        `WARNING: ${n.id} owns the protected path ${owned}, so the merge guard will not stop its changes there. Remove it from the task's files unless that is what you want.`,
      );
    const named = PR.missionNamesProtected(n, protectedPaths);
    if (named)
      console.log(
        `WARNING: ${n.id} names the protected path ${named} without owning it. If the task is to change it, add it with --files (ravenseat edit ${n.id} --files <files>): the agent will otherwise refuse, or the merge guard stops the change.`,
      );
  }
  // Better ownership from the start: files earlier tasks changed together with the new task's files (lib/ownershipHints.js).
  {
    const OH = require('./lib/ownershipHints.js');
    const all = read().tasks ?? [];
    for (const n of newOnes) for (const x of OH.hintLines(n, all, { ravenseat: CLI })) console.log(x);
  }
  // A track was just told it has nothing to do about the project; these are for whoever approves.
  if (!track) for (const x of added.projectWarnings) console.log(`WARNING: ${x}`);
  for (const x of added.planWarnings) console.log(`WARNING: ${x}`);
  const linked = [...new Set(newOnes.map((n) => n?.plan).filter(Boolean))];
  if (linked.length) console.log(`Linked to plan entry: ${linked.join(', ')} (in-queue automatically)`);
  if (added.phaseEnded.length)
    console.log(`Phase plan removed (has queue tasks now): ${added.phaseEnded.join(', ')}`);
  if (added.question.length) console.log(`Question text set: ${added.question.join(', ')}`);
  if (added.withoutText.length)
    console.log(
      `WARNING: question without text (shown without text in "Waiting on you"): ${added.withoutText.join(', ')}. ` +
        'Add them in "question" in the add file, or: ravenseat question <id> --text "..." --type <type>.',
    );
}

/** `ravenseat classify` (the usage is at the top of queue.mjs). */
export function cmdClassify() {
  // ---- Project proposals ----
  // The same proposals add prints (queueLogic.suggestProject): longest prefix, the plan in source/mission, fileRoot. Without
  // --execute nothing is changed.
  const json = a.includes('--json');
  const rowText = (r) => `  ${r.id.padEnd(14)} ${r.now} → ${r.proposed ?? '?'}  (${r.reason})`;
  if (val('--file')) {
    const content = JSON.parse(fs.readFileSync(val('--file'), 'utf8'));
    const newOnes =
      content && !Array.isArray(content) && content.id === undefined && 'tasks' in content
        ? [].concat(content.tasks ?? [])
        : [].concat(content);
    const register = read().projects ?? {};
    const rows = newOnes.map((n) => ({ id: n?.id ?? '(without id)', ...L.suggestProject(n, register) }));
    if (json) console.log(JSON.stringify({ ok: true, proposed: rows }));
    else
      for (const r of rows)
        console.log(
          `  ${String(r.id).padEnd(14)} ${r.pid ?? 'Sort'}${r.signal ? ` (${r.signal})` : ''}: ${r.reason}${r.safe ? '' : ' [uncertain]'}`,
        );
  } else {
    const filter = { withoutProject: a.includes('--without-project'), disagreeing: a.includes('--disagree') };
    if (a.includes('--execute')) {
      const r = editLogged('classify', (queue) => {
        const k = L.classifyQueue(queue, filter);
        if (!k.move.length) return { ...k, changed: [] };
        const s = L.editMany(
          queue,
          k.move.map((x) => ({ id: x.id, project: x.proposed })),
          { by: byName() },
        );
        if (s.error.length) die(`Nothing changed:\n  ${s.error.join('\n  ')}`);
        return { ...k, changed: s.changed };
      });
      if (json) console.log(JSON.stringify({ ok: true, ...r, log: lastEntry?.nr ?? null }));
      else {
        console.log(`Set project on ${r.changed.length} task(s).`);
        for (const x of r.move) console.log(rowText(x));
        if (r.sort.length)
          console.log(`Sort (${r.sort.length}; decided by the owner, not changed automatically):`);
        for (const x of r.sort) console.log(rowText(x));
        if (undoHint()) console.log(undoHint());
      }
    } else {
      const k = L.classifyQueue(read(), filter);
      if (json) console.log(JSON.stringify({ ok: true, ...k }));
      else {
        console.log(
          `Proposed (${k.move.length}; set with ravenseat classify --execute${filter.withoutProject ? ' --without-project' : ''}${filter.disagreeing ? ' --disagree' : ''}):`,
        );
        for (const x of k.move) console.log(rowText(x));
        console.log(
          `Sort (${k.sort.length}; uncertain or disagreeing, fix with ravenseat edit-many --file <json> [{ "id", "project" }]):`,
        );
        for (const x of k.sort) console.log(`${rowText(x)} [${x.type}]`);
        const pre = L.prefixWarnings(read().projects ?? {});
        for (const x of pre) console.log(`WARNING: ${x}`);
      }
    }
  }
}
