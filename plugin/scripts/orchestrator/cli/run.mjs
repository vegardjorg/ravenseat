// =============================================================
// cli/run.mjs: the commands that start work: next, start, trackFile, fill, resume, pickable and pick.
//
// next and start (with the budget, night pause, windDown and load guard exit codes), trackFile (the blocks for a track),
// fill (next -> start -> trackFile for as many slots as are free), resume (a new agent on the same branch, for a fix
// round or a full context), and pickable/pick (a task done by a person or session instead of an agent).
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueLoadLimit.test.ts, queueNight.test.ts, loadSlots.test.ts, contextGuard.test.ts, queueQuestion.test.ts,
//   queueOrchestrator.test.ts, queueBoard.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  a, autoCleanFocus, BASE, branchFor, branchInfo, CE, CH, CONFIG, CLI, cut, die, edit, focusCleanOut, FOLDER, git, GIT_ROOT, HERE, L, MIGR,
  missionFile, parallelWarning, positional, pulseCursor, read, readCursor, require, TK, uncommittedPaths, val, values,
  WIDTH, writeExternalWarning,
} from './context.mjs';
import {
  attemptRows, dailyUsageFor, loadSlotsLine, logStart, makeTrackBlocks, markStarted, measureLoad, readTimeLog,
  reserveAttempt, runningAttempt, scratchpadFor, takenForMigr, trackReport, trackRoots,
} from './tracks.mjs';
import { askedLine, triageReason, triageState, writeTriageSteps } from './triage.mjs';
import { detectPushes, logEvent, logLoad } from './events.mjs';

// The accepted git baseline: recorded silently on first use, before anything starts (lib/gitSurfaceBaseline.js).
const GB = require('./lib/gitSurfaceBaseline.js');
const GI = require('./lib/gitIdentity.js');

const ER = require('./lib/eventRows.js');
// The client-neutral mission descriptor and the client adapters: fill, start and resume build the descriptor first,
// and the task's client adapter (Claude when the task names none) turns it into its own format.
const MD = require('./lib/logic/missionDescriptor.js');
const CL = require('./lib/clients/index.js');
// The attempt: start, fill and resume reserve one under the lock, and its id goes into the descriptor.
const AT = require('./lib/logic/attempt.js');

/** The adapter for a task's client, or die with the registry's error (an unknown client starts nothing). */
function adapterFor(o) {
  try {
    return CL.clientFor(o.client);
  } catch (e) {
    return die(`${o.id}: ${e.message}`);
  }
}

/** `ravenseat next` (the usage is at the top of queue.mjs). */
export function cmdNext() {
  const queue = read();
  // Budget guard: over the daily budget nothing is proposed (exit 4, so a loop does not take it for "empty queue").
  // Night guard: nightRun off and inside the night window gives exit 5 for the same reason.
  // Wind-down guard: the orchestrator in windDown (hook-context, about 350k) gives exit 6.
  // Load guard: the machine is full gives exit 7.
  const usage = dailyUsageFor(queue);
  const load = measureLoad();
  const guard = L.startGuard(queue, usage, { cursor: readCursor(), load });
  if (guard) die(guard.message, guard.code);
  const b = L.budgetGuard(queue, usage);
  // Tasks that own an uncommitted file in the main tree are skipped (another session is working in the file).
  const uncommitted = uncommittedPaths();
  // Tasks waiting on an intake triage verdict (lib/queueTriage.js) are left out; fill prints their triage step.
  const triage = triageState(queue, { uncommitted });
  // With the load: fewer slots under load (lib/loadSlots.js), and the line says why.
  const selected = L.selectNext(queue, Date.now(), { uncommitted, load, skip: triage.skip });
  const loadLine = loadSlotsLine(queue, load);
  if (loadLine) console.log(loadLine);
  // The calibrated cost estimate per task (lib/costEstimate.js); the order is selectNext's, unchanged.
  const costModel = CE.costModel(queue);
  const costFor = (v) => CE.calibratedCost(queue.tasks.find((o) => o.id === v.id), costModel);
  if (!selected.length) console.log('Nothing can start now (see `show` and `state`).');
  if (triage.list.length)
    console.log(
      `Needs an intake triage verdict first (fill prints the step): ${triage.list.map((x) => `${x.id} (${x.reason})`).join(', ')}`,
    );
  for (const v of selected)
    console.log(
      `${v.id.padEnd(12)} ${String(v.class ?? '?').padEnd(3)} ${String(v.domain ?? '?').padEnd(14)} ${v.estimate} min ${CE.costText(costFor(v))}  priority ${v.score}` +
        (v.project !== L.WITHOUT_PROJECT ? `  (${v.project})` : '') +
        ('step' in v ? `  ${L.stepText(v)}` : ''),
    );
  // Warning when the focus period is over or the focus has nothing ready.
  const focusSt = L.focusStatus(queue, { canStart: selected.map((v) => v.id) });
  if (focusSt?.notice) console.log(`NOTICE: ${focusSt.notice}`);
  const skipped = L.uncommittedSkipped(queue, uncommitted);
  if (skipped.length) {
    console.log(
      `Skipped ${skipped.length} (owned file uncommitted in the main tree; another session is working in it):`,
    );
    for (const h of skipped.slice(0, 10)) console.log(`  ${h.id.padEnd(12)} file ${h.path}`);
    if (skipped.length > 10) console.log(`  ... and ${skipped.length - 10} more`);
    console.log(
      '  Wait, ask the session to commit or register itself (ravenseat external add), or start --force on the owner\'s word.',
    );
  }
  if (b.active) console.log(b.message);
  if (b.active) console.log(CE.budgetOutlook(b, selected.reduce((x, v) => x + costFor(v).usd, 0)).message);
}

/**
 * The base branch must have a commit before a task starts: the agent makes its worktree from it, and in a repo with no
 * commit yet `git worktree add` fails ("invalid reference"). Without this the task was marked running and the agent
 * stopped at its first step (red team finding 12). Returns the commit, or stops with the way forward.
 */
function baseCommitOrDie() {
  const head = git(['rev-parse', '--verify', '-q', `${BASE}^{commit}`]);
  if (head) return head;
  const anyCommit = git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (!anyCommit)
    die(
      `This repo has no commit yet, so an agent has nothing to start from (its worktree is made from ${BASE}). ` +
        'Ask Claude to make a first commit (with a .gitignore that keeps secrets and build output out), then start again. Nothing was started.',
    );
  die(`Could not find baseBranch ${BASE} in the main tree (git rev-parse ${BASE}). Set baseBranch in queue.config.json to an existing branch. Nothing was started.`);
}

/** `ravenseat start` (the usage is at the top of queue.mjs). */
export function cmdStart() {
  const id = a[1];
  if (!id) die('start <id>');
  GB.ensure(FOLDER, GIT_ROOT);
  baseCommitOrDie();
  // The usage is read before the lock (the log is large enough that this should not happen with the queue file locked). The same applies to
  // git status (uncommitted files in the main tree).
  const usage = dailyUsageFor(read());
  const uncommitted = uncommittedPaths();
  const load = a.includes('--force') ? null : measureLoad();
  // One load row per start (cli/events.mjs), before the guards can stop it, so a stop (exit 7) is recorded too.
  logLoad({ command: 'start', queue: read(), load });
  const attemptLog = attemptRows(read().tasks.filter((x) => x.id === id));
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    const h = L.blockers(o, queue.tasks, queue.resolved);
    if (h.length) die(`${id} cannot be started: ${h.join(' · ')}`);
    // Budget guard (exit 4), night guard (exit 5) and load guard (exit 7): --force (the owner's word) overrides, as
    // for the other limits.
    const guard = L.startGuard(queue, usage, {
      force: a.includes('--force'),
      cursor: readCursor(),
      load,
    });
    if (guard) die(guard.message, guard.code);
    // Intake triage (lib/queueTriage.js): an old or agent-added task needs a verdict first; --force overrides.
    const why = a.includes('--force') ? null : triageReason(queue, o);
    if (why)
      die(
        `${id} needs an intake triage verdict before it starts (${why}): ravenseat fill prints the step, or ` +
          `ravenseat triage ${id} --prompt --scratchpad <dir>. Or start --force on the owner's word.`,
      );
    // --force: the owner has asked for the task to go first. Overrides only the priority order in selectNext and
    // the pause on the project, never the blockers above (dependencies, ownership, owner questions).
    if (
      !a.includes('--force') &&
      !L.selectNext(queue, Date.now(), { uncommitted, load }).some((v) => v.id === id)
    ) {
      const register = queue.projects ?? {};
      // Parked and outside focus (rest waiting) stop like a pause; --force (the owner's word) overrides.
      const space = L.focusSpace(o, L.rankingContext(queue));
      if (space.parked)
        die(`${id} cannot be started: ${space.reason}. Or start --force on the owner's word.`);
      if (L.projectPaused(o, register)) {
        const pid = L.projectFor(o, register);
        die(
          `${id} belongs to the project ${pid}, which is paused (ravenseat project ${pid} --continue, or start --force).`,
        );
      }
      if (space.out)
        die(
          `${id} cannot be started: ${space.reason}. Edit the focus (ravenseat focus set ...), or start --force on the owner's word.`,
        );
      const u = L.uncommittedCollision(o, uncommitted);
      if (u)
        die(
          `${id} cannot be started: file ${u.path} is uncommitted in the main tree (another session is working in it). Wait, ask the session ` +
            'to commit or register itself (ravenseat external add), or start --force on the owner\'s word.',
        );
      const loadLine = loadSlotsLine(queue, load);
      die(
        `${id} is not among those that can start now (the limits for concurrent, D+ or domain are reached). See \`next\`.` +
          (loadLine ? ` ${loadLine}` : ''),
      );
    }
    // The client is checked before the start, so an unknown one never leaves a running task without an agent.
    adapterFor(o);
    return markStarted(queue, o, {
      agent: val('--agent'),
      head: git(['rev-parse', BASE]),
      scratchpad: scratchpadFor(),
      rows: attemptLog,
    });
  });
  logStart(r);
  console.log(
    `Started ${id}: branch ${r.branch}${r.migr_block ? `, migration block ${r.migr_block}` : ''}, estimate ${L.estimate(r)} min.`,
  );
  // The agent line from the descriptor: the effort by class (K and U medium, D and D+ high) and the adapter's agent.
  const d = MD.missionDescriptor(r, { client: adapterFor(r).id, baseSha: r.head_start ?? null, attemptId: AT.current(r)?.id });
  console.log(CL.clientFor(d.client).startLine(d));
  // Only the orchestrator starts tasks: the cursor says it is active.
  pulseCursor(`start ${id}`);
  writeExternalWarning(r);
}

/** `ravenseat trackFile` (the usage is at the top of queue.mjs). */
export function cmdTrackFile() {
  const out = val('--out');
  const idList = a.slice(1).filter((x, i, arr) => x !== '--out' && arr[i - 1] !== '--out');
  if (!out || !idList.length) die('trackFile <id> [...] --out <file>');
  const queue = read();
  const { blocks, withWarning } = makeTrackBlocks(queue, idList);
  fs.writeFileSync(out, blocks.join('\n'));
  console.log(
    `Wrote ${blocks.length} track block(s) to ${out}. Next: make-mission.mjs --common <queue-common.md> --track ${out} --head <sha>`,
  );
  if (withWarning.length)
    console.log(
      `A warning about changes outside the queue is in the track block for: ${withWarning.join(', ')} (ravenseat external).`,
    );
}

/** `ravenseat fill` (the usage is at the top of queue.mjs). */
export function cmdFill() {
  // ---- next -> start -> trackFile -> make-queue-common -> make-mission in one call ----
  const scratch = scratchpadFor();
  if (!scratch)
    die('fill --scratchpad <folder> (or QUEUE_SCRATCHPAD): the prompt files are written there.');
  GB.ensure(FOLDER, GIT_ROOT);
  const max = val('--max') != null ? Number(val('--max')) : Infinity;
  if (!(max >= 0)) die('--max must be a number >= 0');
  const ids = values('--ids');
  // Without --ids fill only starts new ones; during windDown that is refused before anything else (exit 6).
  if (!ids.length) {
    const by = L.windDownGuard(readCursor());
    if (by.stop) die(by.message, 6);
  }
  const head = baseCommitOrDie();
  // Said before the work starts, not after it at the merge. A warning: the tracks themselves can run.
  const identity = GI.readIdentity(GIT_ROOT);
  if (identity.refused)
    console.log(`WARNING: ravenseat merge will refuse this git identity (${identity.ident || 'none'}): a test or missing address would end up in every merge commit. Fix it now: ${GI.IDENTITY_FIX}`);
  const usage = dailyUsageFor(read());
  const uncommitted = uncommittedPaths();
  // Measured before the lock; --over-load (the owner's word) overrides the load guard.
  const load = a.includes('--over-load') ? null : measureLoad();
  // One load row per fill (before the load guard can stop it with exit 7), and the pushes made since the last fill
  // (the reflog of the remote tracking ref). Both fail open (cli/events.mjs).
  logLoad({ command: 'fill', queue: read(), load });
  detectPushes();
  const attemptLog = attemptRows(read().tasks.filter((x) => x.status === 'waiting' || x.status === 'running'));
  let quotaMessage = null;
  let loadMessage = null;
  // The intake triage (lib/queueTriage.js): the tasks that need a verdict are skipped (others take the slots), and the
  // first few get a triage step instead (set under the lock, so two fills never ask for the same one twice).
  let triageSteps = [];
  let triageWaiting = [];
  // Under the lock: select (selectNext, or --ids) and mark started. With --ids a task that is already running gets
  // only new prompt files (e.g. after make-mission failed); a pending one must be startable now (otherwise start --force
  // on the owner's word first).
  const selected = edit((queue) => {
    // Done focus stages are taken out before the selection (does not change the order: a done stage has no tasks).
    autoCleanFocus(queue, 'fill');
    const out = [];
    const triage = triageState(queue, { uncommitted });
    if (ids.length) {
      const can = L.selectNext(queue, Date.now(), { uncommitted, load, skip: triage.skip }).map((v) => v.id);
      for (const id of ids) {
        const o = queue.tasks.find((x) => x.id === id);
        if (!o) die(`Unknown task ${id}. Nothing was started.`);
        if (o.status === 'running') out.push({ o, new: false });
        else if (o.status === 'waiting' && triage.skip.has(id))
          die(
            `${id} needs an intake triage verdict before it starts (${triage.list.find((x) => x.id === id).reason}): ` +
              `ravenseat triage ${id} --prompt --scratchpad <dir>, or start --force on the owner's word. Nothing was started.`,
          );
        else if (o.status === 'waiting' && can.includes(id)) {
          // The wind-down also stops new starts via --ids (new prompt files for running ones still work).
          const by = L.windDownGuard(readCursor());
          if (by.stop) die(`${by.message} Nothing was started.`, 6);
          // The load guard also stops new starts via --ids (--over-load overrides).
          const lg = L.loadGuard(queue, load);
          if (lg.stop) die(`${lg.message} Nothing was started.`, 7);
          // The usage limit also stops new starts via --ids.
          const ul = L.usageLimitGuard();
          if (ul) die(`${ul.message} Nothing was started.`, ul.code);
          out.push({ o, new: true });
        } else {
          const loadLine = o.status === 'waiting' ? loadSlotsLine(queue, load) : null;
          const blocks = o.status === 'waiting' ? L.blockers(o, queue.tasks, queue.resolved) : [];
          const why = blocks.length
            ? `: ${blocks.join('; ')}`
            : o.status === 'waiting'
              ? ': nothing blocks it directly, but other tasks rank ahead of it for the free slots, or a limit is full'
              : '';
          die(
            `${id} (${o.status}) cannot be started now${why} (see next and show --full; start --force only on the owner's word). ` +
              (loadLine ? `${loadLine}${blocks.length ? '' : ' (fill --over-load overrides.)'} ` : '') +
              'Nothing was started.',
          );
        }
      }
    } else {
      const guard = L.startGuard(queue, usage, { cursor: readCursor(), load });
      if (guard) {
        for (const l of L.heldBackLines(L.uncommittedSkipped(queue, uncommitted))) console.log(l);
        die(guard.message, guard.code);
      }
      // The quota forecast (soft). Mode notice: just a line. Mode cap: at most so many new ones that the number of concurrent
      // tracks keeps the quota until the next reset; --over-quota overrides. An error in the forecast never stops fill.
      let quotaMax = Infinity;
      try {
        const activeOnes = queue.tasks.filter((x) => x.status === 'running').length;
        const t = CH.quotaCap(
          CH.forecast({ queue, events: TK.usageEvents(readTimeLog()) }),
          activeOnes,
        );
        if (t.message) quotaMessage = t.message;
        if (t.limit != null && !a.includes('--over-quota')) quotaMax = t.limit;
      } catch (e) {
        quotaMessage = `(The quota forecast failed: ${e?.message ?? e}; ravenseat capacity)`;
      }
      // Load-aware slots (lib/loadSlots.js): under load selectNext opens fewer slots; the line says why.
      loadMessage = loadSlotsLine(queue, load);
      for (const v of L.selectNext(queue, Date.now(), { uncommitted, load, skip: triage.skip }).slice(
        0,
        Math.min(max, quotaMax),
      ))
        out.push({ o: queue.tasks.find((x) => x.id === v.id), new: true });
      // The triage steps: the first few that were not asked for recently (maxPerFill), in ranked order.
      const now = new Date().toISOString();
      triageSteps = triage.list.filter((x) => !x.asked).slice(0, triage.setup.maxPerFill);
      for (const x of triageSteps) queue.tasks.find((o) => o.id === x.id).triage_asked = now;
      triageWaiting = triage.list.filter((x) => x.asked);
    }
    // Every client is checked before anything is marked started (an unknown one stops the whole fill).
    for (const x of out) adapterFor(x.o);
    // A task the selection chose but whose attempt is still running gets no second agent. Without --ids the rest go on;
    // --ids stops in reserveAttempt below, as --ids does for anything that cannot start.
    const go = ids.length
      ? out
      : out.filter((x) => {
          const live = runningAttempt(x.o, attemptLog);
          if (live) console.error(AT.blockMessage(x.o.id, live, CLI));
          return !live;
        });
    for (const x of go) {
      if (x.new) markStarted(queue, x.o, { head, scratchpad: scratch, rows: attemptLog });
      // Already running (new prompt files, for example after make-mission failed): a live reservation is kept.
      else reserveAttempt(x.o, { head, scratch, rows: attemptLog });
    }
    return go.map((x) => ({ id: x.o.id, new: x.new }));
  });
  // A check at every fill: loose waits (the owner does not see them, or an answer blocks anyway).
  const resolveWarning = () => {
    for (const l of L.resolveWaitsLines(L.resolveWaits(read()), { max: 10 })) console.log(l);
  };
  if (quotaMessage) console.log(quotaMessage);
  if (loadMessage) console.log(loadMessage);
  focusCleanOut();
  // The triage prompt files and lines (cli/triage.mjs); the agents join the same-turn block below.
  const triageOut = writeTriageSteps(read(), triageSteps, { scratch, head });
  const waitLine = askedLine(triageWaiting);
  if (!selected.length) {
    console.log('Nothing can start now (see show and state).');
    const inBatch = read().tasks.filter((o) => o.status === 'waiting' && L.isBatched(o)).map((o) => o.id);
    if (inBatch.length)
      console.log(`In the batch queue, not started alone: ${inBatch.join(', ')}. ravenseat batch packs them; ravenseat edit <id> --json '{"batched":false}' lets one start by itself.`);
    const holding = read().tasks.filter((o) => ['running', 'review', 'picked'].includes(o.status));
    if (loadMessage && holding.length)
      console.log(`The slots are held by: ${holding.map((o) => `${o.id} (${o.status})`).join(', ')}. A task in review holds its slot until it is merged or cancelled.`);
    for (const l of L.heldBackLines(L.uncommittedSkipped(read(), uncommitted))) console.log(l);
    for (const l of triageOut.lines) console.log(l);
    if (waitLine) console.log(waitLine);
    if (triageOut.agents.length) pulseCursor(`fill triage ${triageOut.agents.map((x) => x.id).join(' ')}`);
    resolveWarning();
    parallelWarning();
    for (const l of CL.sameTurnLines([], triageOut.agents)) console.log(l);
    process.exit(0);
  }
  const queue = read();
  for (const v of selected.filter((x) => x.new)) logStart(queue.tasks.find((x) => x.id === v.id));
  pulseCursor(`fill ${selected.map((v) => v.id).join(' ')}`);
  fs.mkdirSync(scratch, { recursive: true });
  const trackFile = path.join(scratch, 'queue-track-fill.md');
  const commonFile = path.join(scratch, 'queue-common.md');
  const { blocks, withWarning } = makeTrackBlocks(
    queue,
    selected.map((v) => v.id),
  );
  fs.writeFileSync(trackFile, blocks.join('\n'));
  const newIds = selected.filter((v) => v.new).map((v) => v.id);
  const runScript = (name, args) => {
    try {
      execFileSync(process.execPath, [path.join(HERE, name), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (e) {
      die(
        `${name} failed: ${String(e?.stderr ?? e?.message ?? e).trim()}\n` +
          (newIds.length ? `Started (running): ${newIds.join(', ')}. ` : '') +
          `When the error is fixed: ravenseat fill --ids ${selected.map((v) => v.id).join(' ')} --scratchpad "${scratch}"`,
      );
    }
  };
  // The common protocol is made every time (cheap), so a changed mission template is always included.
  runScript('make-queue-common.mjs', ['--out', commonFile, '--scratchpad', scratch]);
  runScript('make-mission.mjs', [
    '--common',
    commonFile,
    '--track',
    trackFile,
    '--head',
    head,
    '--out',
    scratch,
  ]);
  // One client-neutral descriptor per track (lib/logic/missionDescriptor.js); the client format (for Claude:
  // subagent_type, model and the agent message) is derived from it by the task's adapter (lib/clients/).
  const descriptors = selected.map((v) => {
    const o = queue.tasks.find((x) => x.id === v.id);
    return MD.missionDescriptor(o, {
      client: adapterFor(o).id,
      promptFile: path.join(scratch, `prompt-${o.id}.md`),
      baseSha: head,
      attemptId: AT.current(o)?.id,
      isNew: v.new,
      warning: withWarning.includes(o.id),
    });
  });
  const track = descriptors.map((d) => CL.clientFor(d.client).fillEntry(d));
  const jsonFile = path.join(scratch, 'queue-fill.json');
  fs.writeFileSync(
    jsonFile,
    JSON.stringify({ time: new Date().toISOString(), head, track }, null, 2) + '\n',
  );
  console.log(`FILLED ${track.length} track(s) (head ${head.slice(0, 8)}); the details are in ${jsonFile}.`);
  // The minute estimate and the calibrated cost estimate (lib/costEstimate.js) per track, for the budget at a glance.
  const fillModel = CE.costModel(queue);
  const fillEstimate = (id) => {
    const o = queue.tasks.find((x) => x.id === id);
    return `${L.estimate(o)} min ${CE.costText(CE.calibratedCost(o, fillModel))}`;
  };
  for (const d of descriptors)
    console.log(
      `${d.task_id}  ${CL.clientFor(d.client).agentLabel(d)}  migr ${d.migr_block ?? '-'}${d.new ? '' : '  (was already running)'}` +
        `${d.warning ? '  NB: files it owns changed since it was added (the track is told to read the diff)' : ''}` +
        `  (${fillEstimate(d.task_id)})`,
    );
  for (const l of triageOut.lines) console.log(l);
  if (waitLine) console.log(waitLine);
  resolveWarning();
  // Tracks that were just started count as active (they are running in the queue file now).
  parallelWarning();
  // All the agents are started in the SAME turn (parallel Agent calls), not one per turn: the tracks and the triage
  // helpers.
  for (const l of CL.sameTurnLines(descriptors, triageOut.agents)) console.log(l);
}

/** `ravenseat pickable` (the usage is at the top of queue.mjs). */
export function cmdPickable() {
  // ---- Picking ----
  const queue = read();
  const max = val('--max-min');
  if (max != null && !(Number(max) > 0)) die('--max-min must be a number > 0');
  const list = L.pickable(queue, {
    label: val('--label'),
    project: val('--project'),
    maxMin: max == null ? undefined : Number(max),
    uncommitted: uncommittedPaths(),
  });
  if (!list.length) console.log('Nothing can be picked now with this filter (see `show`).');
  for (const p of list) {
    const badges = [
      ...p.labels,
      ...(p.migr ? ['migr'] : []),
      ...(p.paused ? ['project paused'] : []),
      ...(p.uncommitted ? [`uncommitted in the main tree: ${p.uncommitted}`] : []),
      // The stage when focus applies (outside focus is last and can still be picked).
      ...('step' in p ? [p.outside_focus ? 'outside focus' : L.stepText(p)] : []),
    ];
    const header =
      `${p.id.padEnd(12)} ${String(p.class ?? '?').padEnd(2)} ${`${p.estimate} min`.padEnd(7)} prio ${String(p.score).padEnd(7)} ` +
      `${p.project}${p.feature ? ` / ${p.feature}` : ''}${badges.length ? ` [${badges.join(', ')}]` : ''}`;
    console.log(cut(header, WIDTH));
    console.log(`  ${cut(p.title, WIDTH - 2)}`);
  }
  if (list.length)
    console.log(`\n${list.length} can be picked. Pick: ravenseat pick <id> --by "<who>"`);
}

/** `ravenseat pick` (the usage is at the top of queue.mjs). */
export function cmdPick() {
  const id = a[1];
  if (!id || id.startsWith('--')) die('pick <id> --by "<who>" [--force]');
  const r = edit((queue) => {
    const s = L.pick(queue, id, {
      by: val('--by'),
      force: a.includes('--force'),
      // Past blocks that are already taken (a file, a task that is not finished, an active prompt file).
      taken: takenForMigr(queue, { scratch: scratchpadFor(), except: id }),
    });
    if (s.error) die(s.error);
    return s;
  });
  const o = r.task;
  const g = branchInfo(o.branch);
  const file = missionFile(o);
  const wt = `.claude/worktrees/queue-${id}`;
  console.log(
    `Picked ${id} (by ${o.picked_by}): branch ${o.branch}, migration block ${o.migr_block ?? 'none'}, class ${o.class}, estimate ${L.estimate(o)} min.`,
  );
  if (r.overridden.length) console.log(`--force overrode: ${r.overridden.join(' · ')}`);
  // The owned files changed outside the queue since the task was added, or commits that mention the id.
  writeExternalWarning(o);
  console.log(`Mission: ${file ?? `the text is in the queue (ravenseat trackFile ${id} --out <file>)`}`);
  console.log(
    [
      'Next step (the same protocol as a queue track: own worktree, common protocol, gates and review by class):',
      g.exists
        ? `  1. Worktree on the existing branch (${g.commits} commit(s) ahead of ${BASE}): git worktree add ${wt} ${o.branch}`
        : `  1. Worktree: git worktree add ${wt} -b ${o.branch} ${BASE}`,
      `  2. The mission: ravenseat trackFile ${id} --out <scratch>/queue-track.md; make-queue-common.mjs --out <scratch>/queue-common.md;`,
      `     make-mission.mjs --common <scratch>/queue-common.md --track <scratch>/queue-track.md --head <HEAD>`,
      `  3. In the worktree: ${require('./lib/projectRoot.js').cliCommand({ fromWorktree: true })} prepare-track ${id} --branch ${o.branch} --scratchpad "<scratch>"`,
      `  4. Done: orchestrator active -> ravenseat deliver ${id} (it merges). No orchestrator -> merge yourself`,
      `     (merge-track.mjs ${o.branch})${MIGR.folder ? ', push the migrations' : ''}, then ravenseat set ${id} done.`,
      '     Never git push without the owner\'s "push".',
      `  If you give up: ravenseat release ${id} (the branch and the migration block are kept).`,
    ].join('\n'),
  );
}

/** `ravenseat resume` (the usage is at the top of queue.mjs). */
export function cmdResume() {
  // ---- Adoption: the mission for a NEW agent that continues a track on the same branch (fix round or continuation) ----
  // The same template as fill (make-queue-common + make-mission), with the track block from queueLogic.resumeBlock and
  // --continue in the setup. The track id is <id>-r<N>, so the agent's report lands in <scratchpad>/<id>-r<N>/ (receive
  // finds it).
  const id = positional(1, ['--reason', '--round', '--scratchpad', '--findings-file', '--from', '--answer', '--by'])[0];
  const reason = val('--reason') ?? 'fix';
  const use =
    'resume <id> [--reason fix|context] [--round N] [--findings-file <file>] [--from <reviewer,...>] [--answer "<text>" [--by owner]] [--scratchpad <folder>]';
  if (!id || !L.RESUME_REASONS.includes(reason)) die(use);
  // --answer: the owner's answer to what the track asked. First in the brief, and saved as an addition to the mission.
  const answer = a.includes('--answer') ? String(val('--answer') ?? '').trim() : null;
  if (answer === '') die(`${use}\n--answer is empty.`);
  // --by owner: the owner answered (the board, ravenseat decide), so nobody may be reading this output. ravenseat wait wakes on it.
  const answerFields = answer
    ? { answer, answered_at: new Date().toISOString(), ...(val('--by') ? { by: String(val('--by')).trim() } : {}) }
    : {};
  GB.ensure(FOLDER, GIT_ROOT);
  // --from: the reviewer types whose findings caused this fix round (the reviewer hit rate, lib/eventStatistics.js).
  // Saved in `resumed` and the fixRound row; a name that is not a known reviewer type is kept, with a warning.
  const fromList = [...new Set(String(val('--from') ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
  if (fromList.some((x) => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/.test(x)))
    die('--from takes agent type names separated by commas (e.g. --from reviewer,reviewer-security)');
  const queue = read();
  const o = queue.tasks.find((x) => x.id === id);
  if (!o) die(`Unknown task ${id}`);
  if (!['running', 'review'].includes(o.status))
    die(`${id} has status ${o.status}; resume applies to running and review (a new start is fill or start).`);
  // At the usage limit a new agent would only fail, and a fix round would be used up for nothing (exit 12).
  const usageStop = L.usageLimitGuard();
  if (usageStop) die(usageStop.message, usageStop.code);
  adapterFor(o); // an unknown client stops before any round file is written
  // A running attempt stops the round before any file is written; the reservation at the end checks again under the lock.
  const running = runningAttempt(o, attemptRows([o]));
  if (running) die(AT.blockMessage(id, running, CLI));
  const scratch = scratchpadFor(o.scratchpad ?? null);
  if (!scratch) die(`${use}\nNeeds --scratchpad <folder> (or QUEUE_SCRATCHPAD).`);
  const branch = o.branch ?? branchFor(id);
  if (!branchInfo(branch).exists)
    die(`Branch ${branch} does not exist; resume continues a branch that exists (otherwise fill --ids).`);
  const found = trackReport(o);
  // ravenseat receive makes the round for a red check itself, and ravenseat decide then says to run resume. No agent has run that
  // round (its attempt is still only reserved, and it has no report), so this is the same round: same number, no new count.
  const last = (o.resumed ?? []).at(-1);
  const again =
    // Only that case: a second receive or a reviewer's findings (--from) is a real next round, and the cap must see it.
    val('--round') == null && !fromList.length && last?.reason === reason && (reason === 'context' || last.from?.includes('done_when')) && found.report?.round !== last.round &&
    (o.attempts ?? []).some((x) => x.state === 'reserved' && x.round === last.round);
  const round = val('--round') != null ? Number(val('--round')) : again ? last.round : found.nextRound;
  // The same round written again keeps the answer it was made with, first in the brief (a new --answer replaces it).
  const briefAnswer = answer ?? (again ? (last.answer ?? null) : null);
  if (!Number.isInteger(round) || round < 1) die('--round must be an integer >= 1');
  const findingsFile = val('--findings-file') ? path.resolve(val('--findings-file')) : null;
  if (findingsFile && !fs.existsSync(findingsFile)) die(`Could not find --findings-file ${findingsFile}`);
  // The fix-round cap (lib/doneCheck.js): at max_fix_rounds (task) or maxFixRounds (config, default 3) the queue stops
  // retrying by itself. The task becomes an owner question the existing way: a registered question, the id in
  // waiting_on (the answer reaches the next brief) and an open blocker owner-question. Exit 8. The owner answers with
  // `ravenseat resolve <question> --answer "…"`, which allows exactly one more round (the next one asks again).
  const DC = require('./lib/doneCheck.js');
  if (reason === 'fix' && !again) {
    const cap = DC.fixCap(o, queue, CONFIG);
    if (!cap.allowed) {
      const last = o.done_check && !o.done_check.ok
        ? `the done command was red (${o.done_check.timed_out ? 'time budget' : `exit ${o.done_check.exit ?? '?'}`})`
        : null;
      edit((q) => {
        const x = q.tasks.find((y) => y.id === id);
        const s = L.setQuestion(q, DC.capQuestion(x, cap, { lastFailure: last }));
        if (s.error.length) die(`Could not register the owner question: ${s.error.join('; ')}`);
        if (!(x.waiting_on ?? []).includes(cap.questionId)) x.waiting_on = [...(x.waiting_on ?? []), cap.questionId];
        L.openBlock(x, 'owner-question', { note: `fix-round cap ${cap.used}/${cap.max} (${cap.questionId})` });
      });
      pulseCursor(`resume ${id} fix cap`);
      console.log(
        `FIX-ROUND CAP: ${id} has had ${cap.used} fix round(s) (cap ${cap.max}); no new round is started by the queue.\n` +
          `Owner question ${cap.questionId} registered (ravenseat question; blocker owner-question). Ask the owner at the end of the ` +
          `round. The owner's answer allows one more round: ravenseat resolve ${cap.questionId} --answer "…", then ` +
          `ravenseat resume ${id} --reason fix again. A higher cap: ravenseat edit ${id} --json '{"max_fix_rounds": N}'.`,
      );
      process.exit(8);
    }
    if (cap.byOwner) console.log(`Fix round beyond the cap (${cap.used}/${cap.max}): allowed by the owner's answer to ${cap.questionId}.`);
  }
  // A red done command (receive or merge saved it on the task): its tail goes into the brief (lib/doneCheck.js).
  let doneCheck = null;
  if (reason === 'fix' && o.done_check && !o.done_check.ok) {
    let tail = [];
    try {
      // The tail sits between the two ~~~~ fences in the file doneCheckReport wrote.
      const inside = (fs.readFileSync(o.done_check.file, 'utf8').split('~~~~')[1] ?? '').replace(/^\r?\n/, '');
      tail = DC.tailOf(inside, DC.doneCheckSetup(CONFIG).tailLines);
    } catch {
      tail = ['(the done command output file is gone; run the command yourself to see it)'];
    }
    doneCheck = {
      ok: false,
      command: o.done_check.command ?? o.done_when,
      exit: o.done_check.exit,
      timedOut: !!o.done_check.timed_out,
      tail,
    };
  }
  // Red quick gates at receive: the same, from the file receive wrote (ravenseat merge refuses until they are green).
  let gateCheck = null;
  if (reason === 'fix' && o.gate_check && !o.gate_check.ok) {
    let text = '';
    try {
      text = fs.readFileSync(o.gate_check.file, 'utf8');
    } catch {
      /* the file is gone: the brief says so */
    }
    const inside = (text.split('~~~~')[1] ?? '').replace(/^\r?\n/, '');
    gateCheck = {
      exit: o.gate_check.exit,
      commands: /^- Commands: (.*)$/m.exec(text)?.[1]?.trim() ?? null,
      tail: inside ? DC.tailOf(inside, DC.doneCheckSetup(CONFIG).tailLines) : ['(the output file is gone; run the gates yourself to see it)'],
    };
  }
  // The review package: the saved one (receive), otherwise rev-<id> in one of the roots. Files beyond the package's own are
  // the reviewers'.
  const reviewFolder =
    [o.review_package, ...trackRoots(o).map((r) => path.join(r, `rev-${id}`))].find(
      (m) => m && fs.existsSync(m),
    ) ?? null;
  const PACKAGE = new Set([
    '00-package.md',
    'diff.patch',
    'files',
    'trackReply.md',
    'trackReport.md',
    'handover.md',
  ]);
  const reviewFiles = reviewFolder
    ? fs.readdirSync(reviewFolder).filter((n) => !PACKAGE.has(n) && !n.startsWith('reviewer-'))
    : [];
  const packageToRead = reviewFolder && (reviewFiles.length || fs.existsSync(path.join(reviewFolder, '00-package.md'))) ? reviewFolder : null;
  const sourcePath = missionFile(o);
  const original = L.trackBlock(o, queue, {
    text: sourcePath ? fs.readFileSync(sourcePath, 'utf8') : o.mission,
  });
  const trackId = `${id}-r${round}`;
  const head = git(['rev-parse', BASE]);
  if (!head) die(`Could not find baseBranch ${BASE} in the main tree (git rev-parse ${BASE}).`);
  fs.mkdirSync(scratch, { recursive: true });
  const trackFile = path.join(scratch, `queue-track-${trackId}.md`);
  const commonFile = path.join(scratch, 'queue-common.md');
  fs.writeFileSync(
    trackFile,
    L.resumeBlock({
      o,
      round,
      reason,
      reportPath: found.report?.path ?? null,
      handoverPath: found.handover?.path ?? null,
      reviewFolder: packageToRead,
      reviewFiles,
      findingsFile,
      original,
      doneCheck,
      gateCheck,
      answer: briefAnswer,
    }),
  );
  for (const [name, args] of [
    ['make-queue-common.mjs', ['--out', commonFile, '--scratchpad', scratch]],
    ['make-mission.mjs', ['--common', commonFile, '--track', trackFile, '--head', head, '--out', scratch]],
  ]) {
    try {
      execFileSync(process.execPath, [path.join(HERE, name), ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (e) {
      die(`${name} failed: ${String(e?.stderr ?? e?.message ?? e).trim()}`);
    }
  }
  const prompt = path.join(scratch, `prompt-${trackId}.md`);
  const adjusted = L.resumePromptAdjust(fs.readFileSync(prompt, 'utf8'), { trackId, branch, base: BASE });
  fs.writeFileSync(prompt, adjusted.text);
  // The report that exists now has already been reported; only a NEW report from the new agent is reported by pulse.
  const attemptLog = attemptRows([read().tasks.find((y) => y.id === id)]);
  const attempt = edit((q) => {
    const x = q.tasks.find((y) => y.id === id);
    const reserved = reserveAttempt(x, { round, head, scratch, rows: attemptLog });
    if (found.report) x.report_seen = Math.max(Number(x.report_seen ?? 0), found.report.mtimeMs);
    // The new round is the answer to what the track asked.
    if (L.openBlockOf(x)?.code === 'track-question') L.closeBlock(x);
    if (answer) {
      const t = L.addToBonus(x, `The owner's answer: ${answer}`, new Date().toISOString());
      if (t) die(`Invalid answer: ${t}`);
    }
    if (!again) (x.resumed ??= []).push({ round, reason, time: new Date().toISOString(), ...(fromList.length ? { from: fromList } : {}), ...answerFields });
    else if (answer) Object.assign(x.resumed.at(-1), answerFields);
    return reserved;
  });
  // The fixRound row (lib/eventRows.js): the same round as `resumed`, countable per week (fail open).
  if (!again) logEvent(ER.fixRoundRow({ task: id, reason, round, from: fromList }));
  else console.log(`Round ${round} was made but never started, so this is the same round (it counts once).`);
  // done_when is what ravenseat receive and ravenseat merge pass for a red done command (not a reviewer, but a known cause).
  const unknownFrom = fromList.filter((x) => x !== 'done_when' && !L.REVIEWER_TYPES.includes(x));
  if (unknownFrom.length)
    console.log(`WARNING: --from ${unknownFrom.join(', ')} is not a reviewer type here (${L.REVIEWER_TYPES.join(', ')}); saved as given.`);
  pulseCursor(`resume ${id} r${round}`);
  if (git(['rev-parse', '-q', '--verify', 'MERGE_HEAD']) != null)
    console.log(
      'WARNING: the main tree has an unfinished merge. Undo it first with git merge --abort: the fix round merges the base on ' +
        'its own branch, and until then the main tree is dirty for every other task.',
    );
  console.log(
    `RESUME ${trackId} (${reason}): prompt ${prompt}` +
      `${adjusted.swapped ? '' : '  WARNING: could not find the setup line to add --continue to; check the prompt'}`,
  );
  // The agent line from the round's descriptor (track id <id>-r<N>, the round prompt), in the task's client format.
  const d = MD.missionDescriptor(o, { client: adapterFor(o).id, trackId, branch, promptFile: prompt, baseSha: head, attemptId: attempt.id });
  console.log(CL.clientFor(d.client).resumeLine(d));
  // If the branch is still checked out in a worktree, prepare-track --continue refuses: the old agent must be done.
  const worktrees = (git(['worktree', 'list', '--porcelain']) ?? '').split(/\r?\n\r?\n/);
  const holder = worktrees.find((b) => b.split(/\r?\n/).includes(`branch refs/heads/${branch}`));
  if (holder) {
    const where = holder.split(/\r?\n/)[0].replace(/^worktree /, '');
    // Only the continuation of a PARTIAL delivery: that agent has stopped and said so, and with a clean worktree nothing
    // can be lost (the branch keeps the commits and no file moves). Not a fix round: it may be fixed right there, and a
    // commit on a detached HEAD would miss the branch. Never the main checkout (the first in the list).
    const freed =
      reason === 'context' && o.delivered_partial && holder !== worktrees[0] && git(['-C', where, 'status', '--porcelain']) === '' &&
      git(['-C', where, 'switch', '--detach']) != null;
    console.log(
      freed
        ? `${branch} was checked out in ${where}, where the old agent is done: freed for the new agent (git switch --detach).`
        : `NOTE: ${branch} is checked out in ${where}. If the old agent is done: git -C "${where}" switch --detach ` +
            'before the new agent starts (otherwise prepare-track --continue refuses).',
    );
    // An agent that died (killed, a crash, a closed laptop) can leave work it never committed. The new agent starts from the
    // branch in a worktree of its own and never sees that work, so say so here, where the orchestrator decides (RT-24). git
    // never removes a worktree with changes in it, so leaving them loses nothing. Never about the main checkout: changes
    // there are the user's, not an agent's.
    const dirty =
      freed || holder === worktrees[0] ? 0 : (git(['-C', where, 'status', '--porcelain']) ?? '').split(/\r?\n/).filter(Boolean).length;
    if (dirty)
      console.log(
        `WARNING: ${where} has ${dirty} uncommitted change(s) the old agent left; the new agent will not see them. ` +
          `To keep them on the branch: git -C "${where}" add -A, then git -C "${where}" commit -m "wip: ${id} (interrupted agent)", ` +
          'before the switch --detach. Left as they are, they stay in that worktree (it is never removed with changes in it).',
      );
  }
}
