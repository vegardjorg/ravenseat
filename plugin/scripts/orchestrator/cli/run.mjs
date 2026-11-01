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
  a, autoCleanFocus, BASE, branchFor, branchInfo, CE, CH, cut, die, edit, focusCleanOut, git, HERE, L, MIGR,
  missionFile, parallelWarning, positional, pulseCursor, read, readCursor, require, TK, uncommittedPaths, val, values,
  WIDTH, writeExternalWarning,
} from './context.mjs';
import {
  dailyUsageFor, loadSlotsLine, logStart, makeTrackBlocks, markStarted, measureLoad, readTimeLog, scratchpadFor,
  takenForMigr, trackRoots,
} from './tracks.mjs';

/** `cq next` (the usage is at the top of queue.mjs). */
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
  // With the load: fewer slots under load (lib/loadSlots.js), and the line says why.
  const selected = L.selectNext(queue, Date.now(), { uncommitted, load });
  const loadLine = loadSlotsLine(queue, load);
  if (loadLine) console.log(loadLine);
  // The calibrated cost estimate per task (lib/costEstimate.js); the order is selectNext's, unchanged.
  const costModel = CE.costModel(queue);
  const costFor = (v) => CE.calibratedCost(queue.tasks.find((o) => o.id === v.id), costModel);
  if (!selected.length) console.log('Nothing can start now (see `show` and `state`).');
  for (const v of selected)
    console.log(
      `${v.id.padEnd(12)} ${v.class.padEnd(3)} ${v.domain.padEnd(14)} ${v.estimate} min ${CE.costText(costFor(v))}  priority ${v.score}` +
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
      '  Wait, ask the session to commit or register itself (cq external add), or start --force on the owner\'s word.',
    );
  }
  if (b.active) console.log(b.message);
  if (b.active) console.log(CE.budgetOutlook(b, selected.reduce((x, v) => x + costFor(v).usd, 0)).message);
}

/** `cq start` (the usage is at the top of queue.mjs). */
export function cmdStart() {
  const id = a[1];
  if (!id) die('start <id>');
  // The usage is read before the lock (the log is large enough that this should not happen with the queue file locked). The same applies to
  // git status (uncommitted files in the main tree).
  const usage = dailyUsageFor(read());
  const uncommitted = uncommittedPaths();
  const load = a.includes('--force') ? null : measureLoad();
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
          `${id} belongs to the project ${pid}, which is paused (cq project ${pid} --continue, or start --force).`,
        );
      }
      if (space.out)
        die(
          `${id} cannot be started: ${space.reason}. Edit the focus (cq focus set ...), or start --force on the owner's word.`,
        );
      const u = L.uncommittedCollision(o, uncommitted);
      if (u)
        die(
          `${id} cannot be started: file ${u.path} is uncommitted in the main tree (another session is working in it). Wait, ask the session ` +
            'to commit or register itself (cq external add), or start --force on the owner\'s word.',
        );
      const loadLine = loadSlotsLine(queue, load);
      die(
        `${id} is not among those that can start now (the limits for concurrent, D+ or domain are reached). See \`next\`.` +
          (loadLine ? ` ${loadLine}` : ''),
      );
    }
    return markStarted(queue, o, {
      agent: val('--agent'),
      head: git(['rev-parse', BASE]),
      scratchpad: scratchpadFor(),
    });
  });
  logStart(r);
  console.log(
    `Started ${id}: branch ${r.branch}${r.migr_block ? `, migration block ${r.migr_block}` : ''}, estimate ${L.estimate(r)} min.`,
  );
  // Thinking level by class: K and U on `track` (medium), D and D+ on `track-d` (high).
  console.log(
    L.agentTypeFor(r.class) === 'track-d'
      ? `Agent: subagent_type ${require('./lib/projectRoot.js').agentRef('track-d')}${L.modelPart('track-d')} (thinkingLevel high).`
      : `Agent: subagent_type ${require('./lib/projectRoot.js').agentRef('track')}${L.modelPart('track')} (thinkingLevel medium).`,
  );
  // Only the orchestrator starts tasks: the cursor says it is active.
  pulseCursor(`start ${id}`);
  writeExternalWarning(r);
}

/** `cq trackFile` (the usage is at the top of queue.mjs). */
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
      `A warning about changes outside the queue is in the track block for: ${withWarning.join(', ')} (cq external).`,
    );
}

/** `cq fill` (the usage is at the top of queue.mjs). */
export function cmdFill() {
  // ---- next -> start -> trackFile -> make-queue-common -> make-mission in one call ----
  const scratch = scratchpadFor();
  if (!scratch)
    die('fill --scratchpad <folder> (or QUEUE_SCRATCHPAD): the prompt files are written there.');
  const max = val('--max') != null ? Number(val('--max')) : Infinity;
  if (!(max >= 0)) die('--max must be a number >= 0');
  const ids = values('--ids');
  // Without --ids fill only starts new ones; during windDown that is refused before anything else (exit 6).
  if (!ids.length) {
    const by = L.windDownGuard(readCursor());
    if (by.stop) die(by.message, 6);
  }
  const head = git(['rev-parse', BASE]);
  if (!head) die(`Could not find baseBranch ${BASE} in the main tree (git rev-parse ${BASE}).`);
  const usage = dailyUsageFor(read());
  const uncommitted = uncommittedPaths();
  // Measured before the lock; --over-load (the owner's word) overrides the load guard.
  const load = a.includes('--over-load') ? null : measureLoad();
  let quotaMessage = null;
  let loadMessage = null;
  // Under the lock: select (selectNext, or --ids) and mark started. With --ids a task that is already running gets
  // only new prompt files (e.g. after make-mission failed); a pending one must be startable now (otherwise start --force
  // on the owner's word first).
  const selected = edit((queue) => {
    // Done focus stages are taken out before the selection (does not change the order: a done stage has no tasks).
    autoCleanFocus(queue, 'fill');
    const out = [];
    if (ids.length) {
      const can = L.selectNext(queue, Date.now(), { uncommitted, load }).map((v) => v.id);
      for (const id of ids) {
        const o = queue.tasks.find((x) => x.id === id);
        if (!o) die(`Unknown task ${id}. Nothing was started.`);
        if (o.status === 'running') out.push({ o, new: false });
        else if (o.status === 'waiting' && can.includes(id)) {
          // The wind-down also stops new starts via --ids (new prompt files for running ones still work).
          const by = L.windDownGuard(readCursor());
          if (by.stop) die(`${by.message} Nothing was started.`, 6);
          // The load guard also stops new starts via --ids (--over-load overrides).
          const lg = L.loadGuard(queue, load);
          if (lg.stop) die(`${lg.message} Nothing was started.`, 7);
          out.push({ o, new: true });
        } else {
          const loadLine = o.status === 'waiting' ? loadSlotsLine(queue, load) : null;
          die(
            `${id} (${o.status}) cannot be started now (see next and show --full; start --force only on the owner's word). ` +
              (loadLine ? `${loadLine} (fill --over-load overrides.) ` : '') +
              'Nothing was started.',
          );
        }
      }
    } else {
      const guard = L.startGuard(queue, usage, { cursor: readCursor(), load });
      if (guard) die(guard.message, guard.code);
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
        quotaMessage = `(The quota forecast failed: ${e?.message ?? e}; cq capacity)`;
      }
      // Load-aware slots (lib/loadSlots.js): under load selectNext opens fewer slots; the line says why.
      loadMessage = loadSlotsLine(queue, load);
      for (const v of L.selectNext(queue, Date.now(), { uncommitted, load }).slice(
        0,
        Math.min(max, quotaMax),
      ))
        out.push({ o: queue.tasks.find((x) => x.id === v.id), new: true });
    }
    for (const x of out) if (x.new) markStarted(queue, x.o, { head, scratchpad: scratch });
    return out.map((x) => ({ id: x.o.id, new: x.new }));
  });
  // A check at every fill: loose waits (the owner does not see them, or an answer blocks anyway).
  const resolveWarning = () => {
    for (const l of L.resolveWaitsLines(L.resolveWaits(read()), { max: 10 })) console.log(l);
  };
  if (quotaMessage) console.log(quotaMessage);
  if (loadMessage) console.log(loadMessage);
  focusCleanOut();
  if (!selected.length) {
    console.log('Nothing can start now (see show and state).');
    resolveWarning();
    parallelWarning();
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
          `When the error is fixed: cq fill --ids ${selected.map((v) => v.id).join(' ')} --scratchpad "${scratch}"`,
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
  const track = selected.map((v) => {
    const o = queue.tasks.find((x) => x.id === v.id);
    const prompt = path.join(scratch, `prompt-${o.id}.md`);
    return {
      id: o.id,
      class: o.class,
      // cq:track in a plugin install, track in a vendored one (lib/projectRoot.js agentRef).
      subagent_type: require('./lib/projectRoot.js').agentRef(L.agentTypeFor(o.class)),
      // config().models; null = the agent file's model.
      model: L.modelFor(L.agentTypeFor(o.class)),
      prompt,
      message: L.trackMessage(o.id, prompt),
      branch: o.branch,
      migr_block: o.migr_block ?? null,
      new: v.new,
      warning: withWarning.includes(o.id),
    };
  });
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
  for (const s of track)
    console.log(
      `${s.id}  subagent_type=${s.subagent_type}${s.model ? `  model=${s.model}` : ''}  migr ${s.migr_block ?? '-'}${s.new ? '' : '  (was already running)'}` +
        `${s.warning ? '  WARNING in the track file (changed outside the queue)' : ''}` +
        `  (${fillEstimate(s.id)})`,
    );
  resolveWarning();
  // Tracks that were just started count as active (they are running in the queue file now).
  parallelWarning();
  // All the agents are started in the SAME turn (parallel Agent calls), not one per turn.
  for (const l of L.concurrentBlock(track)) console.log(l);
}

/** `cq pickable` (the usage is at the top of queue.mjs). */
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
      `${p.id.padEnd(12)} ${p.class.padEnd(2)} ${`${p.estimate} min`.padEnd(7)} prio ${String(p.score).padEnd(7)} ` +
      `${p.project}${p.feature ? ` / ${p.feature}` : ''}${badges.length ? ` [${badges.join(', ')}]` : ''}`;
    console.log(cut(header, WIDTH));
    console.log(`  ${cut(p.title, WIDTH - 2)}`);
  }
  if (list.length)
    console.log(`\n${list.length} can be picked. Pick: cq pick <id> --by "<who>"`);
}

/** `cq pick` (the usage is at the top of queue.mjs). */
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
  console.log(`Mission: ${file ?? `the text is in the queue (cq trackFile ${id} --out <file>)`}`);
  console.log(
    [
      'Next step (the same protocol as a queue track: own worktree, common protocol, gates and review by class):',
      g.exists
        ? `  1. Worktree on the existing branch (${g.commits} commit(s) ahead of ${BASE}): git worktree add ${wt} ${o.branch}`
        : `  1. Worktree: git worktree add ${wt} -b ${o.branch} ${BASE}`,
      `  2. The mission: cq trackFile ${id} --out <scratch>/queue-track.md; make-queue-common.mjs --out <scratch>/queue-common.md;`,
      `     make-mission.mjs --common <scratch>/queue-common.md --track <scratch>/queue-track.md --head <HEAD>`,
      `  3. In the worktree: ${require('./lib/projectRoot.js').cqCommand({ fromWorktree: true })} prepare-track ${id} --branch ${o.branch} --scratchpad "<scratch>"`,
      `  4. Done: orchestrator active -> cq deliver ${id} (it merges). No orchestrator -> merge yourself`,
      `     (merge-track.mjs ${o.branch})${MIGR.folder ? ', push the migrations' : ''}, then cq set ${id} done.`,
      '     Never git push without the owner\'s "push".',
      `  If you give up: cq release ${id} (the branch and the migration block are kept).`,
    ].join('\n'),
  );
}

/** `cq resume` (the usage is at the top of queue.mjs). */
export function cmdResume() {
  // ---- Adoption: the mission for a NEW agent that continues a track on the same branch (fix round or continuation) ----
  // The same template as fill (make-queue-common + make-mission), with the track block from queueLogic.resumeBlock and
  // --continue in the setup. The track id is <id>-r<N>, so the agent's report lands in <scratchpad>/<id>-r<N>/ (receive
  // finds it).
  const id = positional(1, ['--reason', '--round', '--scratchpad', '--findings-file'])[0];
  const reason = val('--reason') ?? 'fix';
  const use =
    'resume <id> [--reason fix|context] [--round N] [--findings-file <file>] [--scratchpad <folder>]';
  if (!id || !L.RESUME_REASONS.includes(reason)) die(use);
  const queue = read();
  const o = queue.tasks.find((x) => x.id === id);
  if (!o) die(`Unknown task ${id}`);
  if (!['running', 'review'].includes(o.status))
    die(`${id} has status ${o.status}; resume applies to running and review (a new start is fill or start).`);
  const scratch = scratchpadFor(o.scratchpad ?? null);
  if (!scratch) die(`${use}\nNeeds --scratchpad <folder> (or QUEUE_SCRATCHPAD).`);
  const branch = o.branch ?? branchFor(id);
  if (!branchInfo(branch).exists)
    die(`Branch ${branch} does not exist; resume continues a branch that exists (otherwise fill --ids).`);
  const found = L.findTrackReport(id, trackRoots(o));
  const round = val('--round') != null ? Number(val('--round')) : found.nextRound;
  if (!Number.isInteger(round) || round < 1) die('--round must be an integer >= 1');
  const findingsFile = val('--findings-file') ? path.resolve(val('--findings-file')) : null;
  if (findingsFile && !fs.existsSync(findingsFile)) die(`Could not find --findings-file ${findingsFile}`);
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
      reviewFolder,
      reviewFiles,
      findingsFile,
      original,
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
  edit((q) => {
    const x = q.tasks.find((y) => y.id === id);
    if (found.report) x.report_seen = Math.max(Number(x.report_seen ?? 0), found.report.mtimeMs);
    (x.resumed ??= []).push({ round, reason, time: new Date().toISOString() });
  });
  pulseCursor(`resume ${id} r${round}`);
  console.log(
    `RESUME ${trackId} (${reason}): prompt ${prompt}` +
      `${adjusted.swapped ? '' : '  WARNING: could not find the setup line to add --continue to; check the prompt'}`,
  );
  console.log(
    `Agent: subagent_type ${require('./lib/projectRoot.js').agentRef(L.agentTypeFor(o.class))}${L.modelPart(L.agentTypeFor(o.class))}, ` +
      `message: ${L.trackMessage(trackId, prompt)}`,
  );
  // If the branch is still checked out in a worktree, prepare-track --continue refuses: the old agent must be done.
  const holder = (git(['worktree', 'list', '--porcelain']) ?? '')
    .split(/\r?\n\r?\n/)
    .find((b) => b.split(/\r?\n/).includes(`branch refs/heads/${branch}`));
  if (holder) {
    const where = holder.split(/\r?\n/)[0].replace(/^worktree /, '');
    console.log(
      `NOTE: ${branch} is checked out in ${where}. If the old agent is done: git -C "${where}" switch --detach ` +
        'before the new agent starts (otherwise prepare-track --continue refuses).',
    );
  }
}
