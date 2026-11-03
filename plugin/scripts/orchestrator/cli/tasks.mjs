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
  a, autoAcceptIn, byName, CONFIG, CQ, die, edit, editLogged, FILE, FOLDER, FX, KK, L, lastEntry, LM, MIGR, P,
  positional, read, readPlans, undoHint, val, values, withLock, write,
} from './context.mjs';
import { highestMigr } from './tracks.mjs';

/**
 * Adds the data folder to the repo's .gitignore on a fresh init, so a new user does not have to. Does nothing outside a
 * git repo, when git already ignores the folder, or when the folder lies outside the repo. Never fails init: a .gitignore
 * that cannot be written only gives a hint.
 */
function ignoreDataFolder() {
  const git = (...args) => spawnSync('git', args, { cwd: FOLDER, encoding: 'utf8' });
  const top = git('rev-parse', '--show-toplevel');
  if (top.status !== 0) return;
  if (git('check-ignore', '-q', FOLDER).status === 0) return;
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
  if (!rel || rel.startsWith('..')) return;
  const file = path.join(repo, '.gitignore');
  try {
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const sep = before && !before.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, `${sep}# Ravenseat queue data (local state)\n${rel}/\n`);
    console.log(`Added ${rel}/ to .gitignore (the queue data is local state, not for git).`);
  } catch (e) {
    console.log(`Note: could not add ${rel}/ to .gitignore (${e.message}); add it yourself.`);
  }
}

/** `cq init` (the usage is at the top of queue.mjs). */
export function cmdInit() {
  // Creates the data folder and an empty queue with defaultLimits and the example project "example" (prefix EX-). An existing
  // queue is never touched, so init is safe to run several times.
  // The mode (lib/liteMode.js): --lite / --full write `mode` into queue.config.json, also for an existing queue. A FRESH
  // init (no queue yet) without a flag writes "lite" when the config has no `mode` of its own; an existing install is
  // never switched without a flag. Lite gets the project "tasks" (prefix T-) instead of "example".
  fs.mkdirSync(FOLDER, { recursive: true });
  const fresh = !fs.existsSync(FILE);
  const flagMode = a.includes('--lite') ? 'lite' : a.includes('--full') ? 'full' : null;
  if (a.includes('--lite') && a.includes('--full')) die('init takes --lite or --full, not both');
  const ownMode = LM.readOwnMode(KK.configFile());
  const initMode = flagMode ?? (fresh && ownMode == null ? 'lite' : LM.mode(CONFIG));
  if (flagMode || (fresh && ownMode == null)) {
    try {
      const w = LM.writeMode(KK.configFile(), initMode);
      if (w.changed) console.log(`Mode: ${initMode} (written to ${KK.configFile()}; switch with ${CQ} mode lite|full).`);
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
  if (initMode === 'lite') {
    console.log(`The queue is created: ${FILE} (lite mode).`);
    console.log(`Next: ${CQ} add "<what you want done>", then /cq:queue (or ${CQ} fill) to start it.`);
    console.log(LM.switchLine(CQ));
  } else
    console.log(
      `The queue is created: ${FILE}` +
        (queue.next_migr != null ? ` (next migration block from ${queue.next_migr})` : '') +
        '. The example project "example" (prefix EX-) can be renamed with cq project.',
    );
}

/** `cq mode` (the usage is at the top of queue.mjs). */
export function cmdMode() {
  // `mode` shows the mode; `mode lite|full` writes it into queue.config.json (only that key; lib/liteMode.js).
  const want = a[1];
  if (want == null) {
    console.log(`Mode: ${LM.mode(CONFIG)} (${KK.configFile()}).`);
    console.log(LM.isLite(CONFIG) ? LM.switchLine(CQ) : `Lite mode (the core loop only): ${CQ} mode lite.`);
    process.exit(0);
  }
  if (!LM.MODES.includes(want)) die(`mode takes ${LM.MODES.join(' or ')} (or nothing, to show it)`);
  let w;
  try {
    w = LM.writeMode(KK.configFile(), want);
  } catch (e) {
    die(`mode: could not write ${KK.configFile()} (${e.message}). Nothing changed.`);
  }
  console.log(w.changed ? `Mode: ${want} (written to ${KK.configFile()}).` : `Mode: ${want} already (nothing changed).`);
  if (want === 'lite') console.log(LM.switchLine(CQ));
}

/** `cq add` (the usage is at the top of queue.mjs). */
export function cmdAdd() {
  const LITE = LM.isLite(CONFIG);
  // Lite: `add "<title>" [--mission ...] [--priority N] [--files a,b] [--id X] [--by ...]` builds the task from the flags.
  const quickTitle = val('--title') ?? positional(1, [
    '--file', '--json', '--title', '--mission', '--priority', '--files', '--id', '--by', '--plan', '--accept',
  ])[0];
  let source = val('--file') ? fs.readFileSync(val('--file'), 'utf8') : val('--json');
  if (!source && quickTitle != null) {
    if (!LITE)
      die(
        `add requires --file <task.json> or --json '{...}' in full mode (a title alone works in lite mode: ${CQ} mode lite)`,
      );
    const q = LM.quickTask({
      title: quickTitle,
      mission: val('--mission'),
      priority: val('--priority'),
      files: val('--files'),
      id: val('--id'),
      by: val('--by'),
    });
    if (q.error.length) die(`Nothing added: ${q.error.join('; ')}`);
    source = JSON.stringify(q.task);
  }
  if (!source)
    die(LITE ? 'add requires a title: cq add "Fix the login bug" (or --file/--json)' : "add requires --file <task.json> or --json '{...}'");
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
  // --plan <id> links tasks (that do not have their own `plan`) to a plan entry. Set in the file or with --plan:
  // the plan entry must exist in the plan register (an unknown or merged entry is refused), and the entry becomes in-queue automatically.
  const planArg = a.includes('--plan') ? val('--plan') : null;
  if (a.includes('--plan') && (!planArg || planArg.startsWith('--')))
    die('--plan requires a plan entry id (cq plan show)');
  const liteNotes = [];
  const added = edit((queue) => {
    const error = [];
    let planWarnings = [];
    // Lite: fill id, class, domain, mission, project, feature, value and content_min when missing (under the lock, so
    // the generated ids are free). The given fields always win.
    if (LITE) {
      const d = LM.liteDefaults(newOnes, queue);
      newOnes.splice(0, newOnes.length, ...d.tasks);
      liteNotes.splice(0, liteNotes.length, ...d.notes);
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
      if (f.length) error.push(`${n.id ?? '(without id)'}: ${f.join('; ')}`);
    }
    if (new Set(newOnes.map((n) => n.id)).size !== newOnes.length)
      error.push('the same id twice in what is being added');
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
    for (const n of LITE ? [] : newOnes) {
      const f = L.batchedError({ status: 'waiting', ...n }, after, queue.resolved);
      if (f.length) error.push(`${n.id ?? '(without id)'}: ${f.join('; ')}`);
      // The small-task guard (fix now, batch queue, or ask the owner about the priority).
      const s = L.smallTaskError({ status: 'waiting', ...n }, after, queue.resolved);
      if (s.length) error.push(`${n.id ?? '(without id)'}: ${s.join('; ')}`);
    }
    if (error.length) die(`Nothing added:\n  ${error.join('\n  ')}`);
    const result = [];
    for (const n of newOnes) {
      // An agent (track, reviewer, fold/investigation agent) adds proposals, not work that starts by itself.
      // The status is computed against the queue BEFORE the new ones are added (a new task cannot make another one an agent source).
      const status = L.statusAtAdd(n, queue.tasks, { approved });
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
    console.log(`Auto-accepted ${x.id} by the owner's rules (${x.reason}); undo: ${CQ} proposals undo ${x.id}`);
  if (proposed.length)
    console.log(
      `Added as proposed (not started until the orchestrator or the owner approves: cq approve <id...>): ${proposed.join(', ')}`,
    );
  const { withoutProject, withoutFeature } = added.missing;
  if (withoutProject.length || withoutFeature.length)
    console.log(
      `WARNING: ${[
        withoutProject.length
          ? `without project (ends up in ${L.WITHOUT_PROJECT}): ${withoutProject.join(', ')}`
          : null,
        withoutFeature.length ? `without feature: ${withoutFeature.join(', ')}` : null,
      ]
        .filter(Boolean)
        .join(
          '; ',
        )}. Fix with cq edit-many --file <json> ([{ "id": "...", "project": "...", "feature": "..." }]).`,
    );
  for (const x of added.projectWarnings) console.log(`WARNING: ${x}`);
  for (const x of added.planWarnings) console.log(`WARNING: ${x}`);
  const linked = [...new Set(newOnes.map((n) => n?.plan).filter(Boolean))];
  if (linked.length) console.log(`Linked to plan entry: ${linked.join(', ')} (in-queue automatically)`);
  if (added.phaseEnded.length)
    console.log(`Phase plan removed (has queue tasks now): ${added.phaseEnded.join(', ')}`);
  if (added.question.length) console.log(`Question text set: ${added.question.join(', ')}`);
  if (added.withoutText.length)
    console.log(
      `WARNING: question without text (shown without text in "Waiting on you"): ${added.withoutText.join(', ')}. ` +
        'Add them in "question" in the add file, or: cq question <id> --text "..." --type <type>.',
    );
}

/** `cq classify` (the usage is at the top of queue.mjs). */
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
          `Proposed (${k.move.length}; set with cq classify --execute${filter.withoutProject ? ' --without-project' : ''}${filter.disagreeing ? ' --disagree' : ''}):`,
        );
        for (const x of k.move) console.log(rowText(x));
        console.log(
          `Sort (${k.sort.length}; uncertain or disagreeing, fix with cq edit-many --file <json> [{ "id", "project" }]):`,
        );
        for (const x of k.sort) console.log(`${rowText(x)} [${x.type}]`);
        const pre = L.prefixWarnings(read().projects ?? {});
        for (const x of pre) console.log(`WARNING: ${x}`);
      }
    }
  }
}
